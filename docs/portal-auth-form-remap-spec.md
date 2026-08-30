# Portal (SFE) spec — moving an authorisation form to a different ClickUp task

**Audience:** whoever (or whatever) is working on the secure portal / SFE codebase.
**Requester:** break.services (the ClickUp → Plextrac integration, `api.break.services`).
**Status:** break.services has already shipped its half. This spec describes the two
portal endpoints it needs in order to finish the job.

---

## 1. Background — what break.services just built

break.services now has a manual repair endpoint, `POST /tasks/remap`, for the case
where the automations attached themselves to the wrong ClickUp task. That happens
constantly with duplicates: someone creates the engagement task twice, the webhook
fires on the first one, and the real work is tracked on the second.

Remap moves everything break.services owns — the Plextrac report mapping, the report
and client names, the status sync, the QA queue, the start-date watcher — from the
source task to the target task.

**It cannot move the authorisation form**, because the form lives in the portal and
the portal's only write operations are keyed on `clickupTaskId` as an immutable
identity:

- `POST /api/clickup/auth-form` — create-or-return a form for a task id
- `POST /api/clickup/auth-form/update` — re-scope the form for a task id

So today, after a remap, break.services calls `/api/clickup/auth-form` for the target
task and gets a **brand new, unsigned form**, while the source task's form stays live
in the portal. Two bad consequences:

1. **The client's merged form keeps carrying an element for the abandoned task.** The
   client sees, and is asked to authorise, a duplicate engagement.
2. **If the client had already signed, the signature is stranded on the source task.**
   The target task gets a blank form. Nothing back-fills the signed PDF, so someone has
   to notice and fix it by hand — and the portal keeps sending the *source* task the
   signed form, the pre-reqs status advance, and (for a Free Black Box) the schedule.

Both need a portal-side operation. What follows is what break.services will call.

---

## 2. Existing contract (do not change) — for reference

**Auth on every call, both directions:** header `X-API-Key`, value shared between the
two services (`BREAK_SERVICES_API_KEY` on our side). break.services times outbound
calls out at `SECURE_PORTAL_TIMEOUT_MS`, default 15 s.

### break.services → portal (we are the caller)

Client code: `lib/secure-portal-api.js`. Base URL `SECURE_PORTAL_URL`.

```
POST {SECURE_PORTAL_URL}/api/clickup/auth-form
{
  clientName, testType,
  clickupTaskId, clickupTaskUrl,
  plextracClientId, plextracReportId,      // may be null
  startDate, endDate                       // unix ms numbers, may be null
}
→ 200 { ok: true, formUrl, formToken, created: boolean }
```

```
POST {SECURE_PORTAL_URL}/api/clickup/auth-form/update
{
  clientName, testType,
  previousClientName, previousTestType,     // what the form was generated against
  clickupTaskId, clickupTaskUrl,
  plextracClientId, plextracReportId,
  startDate, endDate
}
→ 200 { ok: true, formUrl, formToken, updated: boolean, reason?, mergedFormUrl? }
→ 404  no form exists for that task id  (we then create one)
→ 409  the portal refuses to re-scope, e.g. already signed  (we Slack-alert a human)
```

### portal → break.services (you are the caller)

Base URL `https://api.break.services`. Route code: `routes/clickup-actions.js`.

```
POST /clickup/merged-auth-form
{ clientName, mergedFormUrl, mergedFormToken, clickupTaskIds: [], testTypes: [], dayCount }
  → comments the merged link on every listed task, idempotent per mergedFormToken

POST /clickup/finalised-auth-form
{ clientName, driveUrl, clickupTaskId | clickupTaskIds: [] }
  → downloads the signed PDF from Drive, attaches it to each task's "Authorisation
    Forms" field, prepends the link to the description, and advances the task to
    "Waiting for Pre-reqs" (only from statuses: to do / open / scheduled)

POST /clickup/extra-urls
{ clientName, formToken, formUrl, clickupTaskId, urls: [], urlCount }
  → comments + Slack-alerts a Free Black Box that scoped several URLs

POST /clickup/schedule-task
{ clickupTaskId, startDate: "yyyy-mm-dd"|null, endDate: "yyyy-mm-dd"|null, consultant,
  testType, days, reportDeadline: "yyyy-mm-dd", note }
  → writes start/due dates + assignee, and records reportDeadline on the task's
    "Report Due" date field (as a comment when the task has no such field; a `note`
    is always commented, since a date field can't hold it). Requires clickupTaskId
    plus either both dates or reportDeadline — when availability found no slot before
    the deadline, send the deadline with null dates and nothing is booked. For a Free
    Black Box the dates are a no-op if that task already has a start_date (repeat
    submissions must not move a booking); the deadline is still refreshed

POST /clickup/test-files-uploaded
{ clickupTaskId, clientName, fileCount, archiveName, submittedAt }
  → the client uploaded their test files to the portal: ticks the task's completion
    box (the "testfilesstored" Checkbox custom field, or a checklist item of that
    name). Nothing else is written to the task — no comment; the upload itself is
    recorded in the portal, and the other fields are logged only. Called on EVERY
    upload, so a re-tick is a no-op and a repeat leaves no trace. Only clickupTaskId
    is required. A task with no box is 200 { marked: false, reason } — a ClickUp
    config problem, not an upload failure; a ClickUp error is a 502
```

break.services calls the portal for the upload link, on the same intake call that
creates the auth form (`POST /api/clickup/auth-form` now also returns `testFilesUrl` /
`testFilesToken`), and writes it to the task's `testfilesstorage` **short_text** field.
A task that needs a link but never gets an auth form uses the standalone
`POST /api/clickup/test-files` instead. Both are idempotent per ClickUp task — one
link for the life of the task — so either is safe to call on every sync. When the
portal returns no `testFiles*` keys the field is left alone and picked up next sync.

---

## 3. What to build

### 3.1 `POST /api/clickup/auth-form/remap` — move a form to another task

Transfers an existing form's ClickUp association from one task to another, **preserving
its signed state and its place in the client's merged form**. This is the operation the
current API lacks: `/update` can re-scope a form but cannot re-parent it.

**Request**

```json
{
  "fromClickupTaskId": "86abc1234",
  "toClickupTaskId":   "86def5678",
  "toClickupTaskUrl":  "https://app.clickup.com/t/86def5678",
  "clientName":        "Acme Corp",
  "testType":          "Black Box",
  "previousClientName":"Acme Corp",
  "previousTestType":  "Black Box",
  "plextracClientId":  1254,
  "plextracReportId":  9871,
  "startDate":         1786838400000,
  "endDate":           1787443200000
}
```

`clientName` / `testType` describe the **target** task; `previous*` describe what the
form was generated against. They differ when the duplicate was named differently — the
transfer must re-scope in the same move (drop the old testing type's element, add the
new one), exactly as `/update` does today.

**Response — 200**

```json
{
  "ok": true,
  "transferred": true,
  "formUrl": "https://portal…/f/tok",
  "formToken": "tok",
  "rescoped": false,
  "signed": true,
  "finalisedDriveUrl": "https://drive.google.com/file/d/…/view",
  "mergedFormUrl": "https://portal…/m/…"
}
```

| Field | Meaning |
|---|---|
| `transferred` | the form now belongs to `toClickupTaskId` and no longer to `fromClickupTaskId` |
| `formUrl` / `formToken` | the live form for the target. Keeping the same token is preferred — a link already sent to the client should keep working. Mint a new one if your scoping rules require it; break.services writes whatever it gets to the target task's field |
| `rescoped` | true if client/test-type differed and the form's elements were changed |
| `signed` | true if the form had already been signed. **Transfer it anyway** — do not 409 the way `/update` does. Moving completed paperwork onto the right task is the entire point |
| `finalisedDriveUrl` | when `signed`, the Drive link to the signed PDF, so it can be attached to the target task (see 3.3) |
| `mergedFormUrl` | the client's merged form after the move, if the move changed it |

**Errors**

| Code | When | What break.services does |
|---|---|---|
| 404 | no form exists for `fromClickupTaskId` | falls back to `/api/clickup/auth-form` for the target (today's behaviour) |
| 409 | `toClickupTaskId` **already has its own form** | aborts the form step and reports it — do not merge or overwrite silently. Include which form in the body |
| 422 | the move is not permitted for a reason a human must resolve | surfaces `reason` verbatim to Slack; include a `reason` string |

Make it **idempotent**: replaying the same remap must return `200` with
`transferred: false` (already done) rather than erroring or duplicating anything.

### 3.2 `POST /api/clickup/auth-form/withdraw` — retire a task's form

Needed for the case where the source task is simply abandoned and there is nothing to
transfer, and as the cleanup half of a transfer. Stops a form counting toward a client's
merged form and stops the portal sending that task any further callbacks.

**Request**

```json
{ "clickupTaskId": "86abc1234", "reason": "duplicate task — automations remapped to 86def5678" }
```

**Response — 200**

```json
{ "ok": true, "withdrawn": true, "mergedFormUrl": "https://portal…/m/…", "wasSigned": false }
```

Requirements:

- Remove that task's element from the client's merged form and re-render it, so the
  client stops being asked to authorise the abandoned engagement.
- Make the individual form link inert (a clear "this form has been withdrawn" page, not
  a 500) so a link already emailed can't be filled in afterwards.
- **Never destroy a signed record.** If the form was signed, keep the record and the
  Drive file, return `wasSigned: true`, and withdraw only the *pending obligation* /
  merged-form membership. Signed authorisations are the evidence that a test was
  permitted; they get archived, not deleted.
- Stop sending that task id in `/clickup/merged-auth-form`, `/clickup/finalised-auth-form`,
  `/clickup/extra-urls` and `/clickup/schedule-task`.
- 404 when the task has no form. Idempotent: a second withdraw returns
  `withdrawn: false`, still 200.

### 3.3 Re-fire the outbound callbacks for the target task

After a successful transfer, the portal should re-drive the callbacks it already owns,
against the **target** task id, so the new task ends up in the state the source task
was in. Nothing new is needed on the break.services side — these are the same calls
you make today:

- **Signed form already exists** (`signed: true`) → `POST /clickup/finalised-auth-form`
  with `{ clientName, driveUrl, clickupTaskId: <target> }`. break.services attaches the
  PDF to the target's "Authorisation Forms" field, prepends the link to its description
  and advances it to "Waiting for Pre-reqs". Safe for a task that has never had one.
- **Merged form membership changed** → `POST /clickup/merged-auth-form` with the
  corrected `clickupTaskIds` (target in, source out).
- **A Free Black Box schedule was already resolved for the source** →
  `POST /clickup/schedule-task` with `clickupTaskId: <target>` and the same dates and
  consultant. Our guard is per task: a target with no `start_date` gets scheduled, and a
  target that somehow already has one is left alone.

Alternatively, return `finalisedDriveUrl` (3.1) and break.services will attach it. Doing
it from the portal is preferred — it keeps a single code path for "a form's paperwork
landed on a task".

---

## 4. Acceptance criteria

Test these four scenarios; they are the real ones.

1. **Unsigned form, identical task names** (the common duplicate). Remap →
   `transferred: true, signed: false, rescoped: false`. The target task's form is the
   *same* form (same token if you can). The source has no form. The client's merged form
   carries exactly one element for this engagement, not two.
2. **Unsigned form, target task has a different testing type.** Remap with
   `previousTestType: "Black Box"`, `testType: "External"` → `rescoped: true`. The form
   authorises an external test, and the black-box element is gone.
3. **Already-signed form.** Remap → `transferred: true, signed: true`, plus a
   `finalisedDriveUrl`. `POST /clickup/finalised-auth-form` fires for the target, so the
   signed PDF lands on the target task and it advances to "Waiting for Pre-reqs". The
   source task receives no further callbacks.
4. **Target already has its own form.** Remap → 409 naming the conflicting form. Neither
   form is modified.

Plus: replaying any of the above changes nothing further (idempotency), and a withdraw
of an already-withdrawn task returns 200 with `withdrawn: false`.

---

## 5. Notes on scope

- No new secrets or config: both endpoints use the existing shared `X-API-Key`.
- Do not change `/api/clickup/auth-form` or `/api/clickup/auth-form/update`.
  break.services still relies on their current behaviour, including the `404` → create
  and `409` → "signed, a human must reissue" paths.
- break.services calls `remap` at most a few times a week, by hand, from an
  authenticated admin endpoint. It does not need to be fast; it needs to be correct and
  to say clearly what it did.
