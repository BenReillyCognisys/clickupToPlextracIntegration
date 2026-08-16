# Auth-form re-scope on task rename (break.services → SFE portal)

When a ClickUp delivery task is renamed and its **testing type** changes — the
motivating case is `Acme Corp | Black Box` → `Acme Corp | External` —
break.services now tells the SFE portal to re-scope that task's authorisation
form: **remove the element for the old testing type, add the element for the new
one**. A client-name change is sent the same way, because the client name is
rendered on the form too.

Without this, the form keeps authorising the wrong test: a black-box form asks
for a web-app URL and carries black-box sign-off wording, none of which applies
once the job became an external infrastructure test.

## Flow

```
ClickUp (task renamed)
   │  POST /webhook/clickup            taskUpdated with a name change
   ▼
routes/clickup-webhook.js              serialise per task id → fetch full task
   ▼
pipeline/task-rename.js                handleTaskRename(task)
   ├─ read the OLD client + testing type from the stored mapping
   │  (mapping.testing_type, falling back to parsing mapping.task_name)
   ├─ sync the Plextrac client name         (existing behaviour)
   ├─ sync the Plextrac report name         (existing behaviour)
   ├─ syncAuthFormForRename(...)            ← NEW
   │    ▼
   │    pipeline/auth-form-rename.js
   │      1. diff old vs new client + type; nothing changed → stop (no portal call)
   │      2. POST {SECURE_PORTAL_URL}/api/clickup/auth-form/update
   │      3. write any refreshed formUrl back to the task's `authformlink` field
   │      4. Slack-notify the outcome (or the need for manual reissue)
   └─ persist the new name/type on the mapping
```

Everything in step 2–4 is best-effort: failures are logged (and Slack-notified
where a human must act) and never thrown, so a portal outage cannot wedge the
rename webhook or block the Plextrac sync.

Ordering note: the old client/type are read **before**
`store.updateMappingDetails` overwrites them, so the portal always receives the
values the form was originally generated against.

## Files changed on this side

| File | Change |
| --- | --- |
| `lib/secure-portal-api.js` | New `updateAuthForm()`; shared `portalPost()`; portal errors now carry `.status` so callers can branch on 404/409. |
| `pipeline/auth-form-rename.js` | **New.** Diffs the rename, calls the portal, handles every outcome. |
| `pipeline/auth-form-create.js` | Exports `setAuthFormLink` for reuse. |
| `pipeline/task-rename.js` | Captures the old client/type and calls `syncAuthFormForRename`. |
| `tests/auth-form-rename.test.js` | **New.** 11 tests against a stub portal. |

No new environment variables — it reuses `SECURE_PORTAL_URL` and
`BREAK_SERVICES_API_KEY`.

---

# What the SFE / auth-form application needs to implement

## 1. New endpoint: `POST /api/clickup/auth-form/update`

Same host, same auth as the existing `POST /api/clickup/auth-form`: the shared
secret in the **`X-API-Key`** header (`BREAK_SERVICES_API_KEY`), compared in
constant time. Reject with `401` when it's missing or wrong.

### Request body

```jsonc
{
  "clientName":         "Acme Corp",      // current (post-rename) client name
  "testType":           "External",       // current (post-rename) testing type
  "previousClientName": "Acme Corp",      // what the form was generated against
  "previousTestType":   "Black Box",      // ← the element to REMOVE
  "clickupTaskId":      "86abc1234",      // the idempotency key, same as on create
  "clickupTaskUrl":     "https://app.clickup.com/t/86abc1234",
  "plextracClientId":   1234,             // may be null
  "plextracReportId":   5678,             // may be null
  "startDate":          1755216000000,    // unix ms, may be null
  "endDate":            1755302400000     // unix ms, may be null
}
```

`previousClientName` / `previousTestType` may be `null` for very old tasks whose
mapping predates the stored testing type — treat that as "you decide which
element belongs to this task" and fall back to matching on `clickupTaskId`.

Either field can be unchanged: a pure client rename sends the same `testType` in
both fields, and vice versa. break.services never calls the endpoint when
*neither* changed (case- and whitespace-insensitive comparison), so you can
assume at least one is a real change.

### Response body

```jsonc
{
  "ok": true,
  "updated": true,                          // false = you deliberately left it alone
  "formUrl": "https://portal/f/abc123",     // current live form URL (new or unchanged)
  "formToken": "abc123",                    // optional
  "reason": "already signed",               // required when updated:false
  "mergedFormUrl": "https://portal/m/xyz"   // optional, if a merged form was rebuilt
}
```

### Status codes break.services branches on

| Status | Meaning | What break.services does |
| --- | --- | --- |
| `200` + `updated: true` | Form re-scoped. | Writes `formUrl` to the task's `authformlink` custom field; posts a Slack confirmation. |
| `200` + `updated: false` + `reason` | You chose not to change it. | Logs a warning and Slack-notifies with your `reason` so a human can reissue. |
| `404` | No form exists for that `clickupTaskId`. | Falls back to `POST /api/clickup/auth-form` to create one **at the new scope**. |
| `409` | Form cannot be re-scoped (signed/locked). | Slack-notifies asking for a manual reissue. Not treated as an error. |
| `4xx` / `5xx` other | Failure. | Logged; the rename continues. Safe to retry-by-rename. |

Prefer `409` (or `200` + `updated:false`) over a `500` for the
already-signed case — it produces an actionable Slack message instead of an
error log.

**Idempotency:** the same rename can be delivered more than once (ClickUp retries,
a task edited twice in quick succession). Re-applying the same
`previousTestType → testType` transition must be a no-op that still returns `200`
with the current `formUrl`. Guard on the form's *current* test type: if it is
already `testType`, just return the existing form.

## 2. Element swap semantics

The core of the change, per task:

1. Find the form for `clickupTaskId`.
2. Remove the element/section that was added for `previousTestType`
   (e.g. the Black Box block: its scope wording, target-URL questions and
   black-box authorisation clauses).
3. Add the element for `testType` (e.g. the External Infrastructure block: IP
   range / host list questions and its authorisation clauses).
4. Re-render the client name from `clientName`.

Points worth deciding explicitly on your side:

- **Answers already given.** If the client has filled in black-box-only fields
  (a target URL), those answers no longer have a home. Recommended: drop the
  answers belonging to the removed element and keep any answers on shared fields
  (contact name, sign-off details, dates), so the client only re-answers what's
  genuinely new.
- **Signed / finalised forms.** Once signed, the document is a legal record —
  don't mutate it. Return `409`, or `200` + `updated:false` with a `reason`, and
  let a human reissue.
- **Partially completed but unsigned forms.** Safe to re-scope in place; keep the
  same token/URL if you can, so links already shared with the client still work.
- **New token or same token?** Either works. If you mint a new token, return the
  new `formUrl` and break.services rewrites the task's `authformlink` field.
  Consider keeping the old token as a redirect for links already emailed out.

## 3. Merged forms

A client with several ClickUp tasks gets a merged form
(`POST /clickup/merged-auth-form` back into break.services). When one of those
tasks changes testing type, the merged form is stale too:

1. Rebuild the merged form for that client after the per-task re-scope.
2. Call the existing `POST /clickup/merged-auth-form` on break.services with the
   new `mergedFormUrl`, `mergedFormToken`, the full `clickupTaskIds` array and
   the updated `testTypes` list.

That endpoint is already idempotent per token — it updates the existing ClickUp
comment in place rather than stacking a new one — so calling it again after a
rename is exactly the right move. Reusing the same `mergedFormToken` updates the
existing comment; a new token adds a second one, so prefer reusing it unless the
merged form is genuinely a new document.

## 4. Testing-type vocabulary

The `testType` values break.services sends are the canonical names from
`config/testing-types.js`:

```
Secure Build Review, Cloud Assessment, Mobile App, Code Review,
Grey Box, Black Box, Internal, External, CIS
```

Match these case-insensitively, and make sure every one of them maps to a form
element (or an explicit "no element" decision). An unrecognised `testType` should
be a `400` with a clear message rather than a silently half-updated form —
break.services logs the response body, so the message will surface.

Note that break.services never sends `Unknown`: a rename that no longer resolves
to a known testing type is left alone entirely (report and form untouched) and
flagged in the logs instead.

## 5. Suggested implementation order

1. Add the endpoint with auth + validation, returning `404` when no form exists
   for the task — break.services' create fallback covers that path immediately.
2. Implement the element swap for unsigned forms, returning `200` + `updated:true`.
3. Add the signed-form guard (`409` / `updated:false` + `reason`).
4. Add the merged-form rebuild and the call back to `/clickup/merged-auth-form`.

Steps 1–2 alone make the Black Box → External rename work end to end.
