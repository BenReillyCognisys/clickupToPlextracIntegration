# Manual repair endpoints (`/tasks/*`)

The ClickUp webhook is the normal driver of the Plextrac automations. Two things go
wrong in practice:

- **A missed event.** ClickUp didn't fire, the service was down, or a run failed
  part-way (report created, auth form not). No report exists, or an incomplete one does.
- **A mis-mapped event.** A duplicate task was created and the automations latched
  onto the wrong one. The report exists, but every later automation is pointed at a
  task nobody is working on.

`POST /tasks/replay` fixes the first, `POST /tasks/remap` the second, and
`GET /tasks/:taskId` tells you which one you need.

All three require the `X-API-Key` header (`AVAILABILITY_API_KEY`, the same key the
`/jobs/*` triggers use) and are rate-limited to 60 requests/minute. Unlike `/jobs/*`,
these answer **synchronously** with what they did — the point of a manual repair is
knowing the outcome. Both write operations take the same per-task lock as the
webhook, so a manual call can never race a live event for the same task.

Implementation: `routes/task-admin.js` (HTTP) over `pipeline/task-admin.js` (logic).

---

## `GET /tasks/:taskId` — what does the system think about this task?

Read-only. Run it first: it confirms you have the right task id and shows whether a
mapping already exists.

```bash
curl -s -H "X-API-Key: $KEY" https://break.services/tasks/86abc1234 | jq
```

```json
{
  "ok": true,
  "status": "ok",
  "detail": "the task is handled by the pentest pipeline",
  "pipeline": "pentest",
  "monitored": true,
  "task": { "id": "86abc1234", "name": "Acme Corp | Black Box", "url": "https://app.clickup.com/t/86abc1234", "space": "Penetration Test", "status": "open", "start_date": "1786838400000", "due_date": "1787443200000" },
  "parsed": { "client_name": "Acme Corp", "testing_type": "Black Box" },
  "mapping": {
    "clickup_task_id": "86abc1234",
    "plextrac_client_id": 1254,
    "plextrac_report_id": 9871,
    "plextrac_report_cuid": "ckz…",
    "report_url": "https://cognisys.plextrac.com/client/1254/report/9871",
    "task_name": "Acme Corp | Black Box",
    "testing_type": "Black Box",
    "remapped_from": null,
    "remapped_at": null
  }
}
```

`"mapping": null` means no Plextrac report is linked to the task — the Plextrac →
ClickUp status sync, the QA automations and the start-date watcher all key off this
mapping, so a null here is why "nothing happens" for that task.

`"monitored": false` means the webhook would ignore the task too (wrong space, outside
the VMaaS folder, or a subtask); `detail` says which.

---

## `POST /tasks/replay` — process a task as if its webhook had just arrived

Runs the full create pipeline against the task's **current** name: find-or-create the
Plextrac client, create the report, generate the authorisation form and write its link
to the task's `authformlink` field. Exactly what `taskCreated` does, including the
Slack notice.

```bash
curl -s -X POST https://break.services/tasks/replay \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"taskId":"86abc1234"}' | jq
```

| Field | Default | Meaning |
|---|---|---|
| `taskId` | — | required |
| `force` | `false` | Re-run even when the task is already mapped. For a half-finished run — e.g. the report was created but the portal was down, so there's no auth form. |
| `adopt` | `false` | When the report already exists in Plextrac but the task isn't mapped to it, store the mapping. |

**Safe to re-run.** An already-mapped task returns `already_mapped` and nothing is
touched. Under `force`, the report is still protected by `createReport`'s name-based
duplicate check, and a report that was found rather than created is not announced in
Slack.

### Outcomes

| `status` | HTTP | Meaning |
|---|---|---|
| `created` | 200 | Client, report and auth form are in place. |
| `already_mapped` | 200 | The task already drives a report; nothing done. Use `force` to re-run. |
| `report_exists` | 200 | The report already existed under that name and the task is mapped to it (the normal result of `force`). Any missing auth form was created. |
| `adopted` | 200 | The pre-existing report is now mapped to the task (`adopt: true`). |
| `report_exists_unmapped` | 422 | A report of that name exists but this task isn't mapped to it. Deliberately not resolved automatically — see below. |
| `placeholder_name` | 422 | Still called "Test Task"; the rename will drive it. |
| `unknown_testing_type` | 422 | The name doesn't yield a testing type. Fix the task name and replay. |
| `blacklisted` | 422 | The name contains a blacklisted word. |
| `client_failed` / `report_failed` | 422 | Plextrac rejected the call; `detail` carries the API error. |
| `not_monitored` | 409 | Subtask, or outside the monitored spaces. |
| `not_found` | 404 | ClickUp doesn't have that task. |

### `report_exists_unmapped`

The report is in Plextrac but nothing links it to the task — typically a run that
created the report and then failed to write the mapping (Mongo unreachable at that
moment). Replay alone can't resolve it, because "a report with this name under this
client" is not proof it belongs to *this* task: two tasks for the same client, testing
type and month produce the same report name.

So it reports the situation and waits for you:

```bash
# after checking in Plextrac that this really is the task's report
curl -s -X POST … -d '{"taskId":"86abc1234","adopt":true}'
```

Adoption refuses (`adopt_conflict`, 409) if another ClickUp task is already mapped to
that report — one report can only follow one task. That case is a remap, not an adopt.

### VMaaS tasks

A VMaaS task (SecOps space, VMaaS folder) has no Plextrac report — its pipeline is
just the authorisation form, and the portal is idempotent per task id, so a replay is
always safe. The response has `"pipeline": "vmaas"` and no report fields.

---

## `POST /tasks/remap` — point a report's automations at a different task

For duplicates: the report was created against task A, but the work is being tracked
on task B.

```bash
curl -s -X POST https://break.services/tasks/remap \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"fromTaskId":"86abc1234","toTaskId":"86def5678"}' | jq
```

What it does, in order:

1. Moves the `task_mappings` document to `toTaskId`, recording `remapped_from` /
   `remapped_at`. From here on, **every** later automation follows the new task: the
   Plextrac → ClickUp status sync, the QA queue and QA KPI tracking, reports-due
   cross-offs, the start-date watcher, and future renames.
2. Re-syncs Plextrac to the new task's name — the report is renamed if the testing
   type or start month differs, and the Plextrac client is renamed if the client name
   differs (subject to the same safety rules as a rename: never onto a name another
   client already uses, and never on a client holding more than one report).
3. Generates the new task's authorisation form and writes the link to its
   `authformlink` field. The portal keys forms on the ClickUp task id, so the new task
   gets its own — this happens even when both tasks have the identical name, which a
   rename-driven sync would skip as "nothing changed".
4. Posts one Slack notice summarising the move.

### Outcomes

| `status` | HTTP | Meaning |
|---|---|---|
| `remapped` | 200 | Done. `client_renamed` / `report_renamed` say whether Plextrac needed changing. |
| `source_not_mapped` | 404 | `fromTaskId` doesn't drive a report — there's nothing to move. If the report exists but was never mapped, replay the source with `adopt: true` first. |
| `target_already_mapped` | 409 | `toTaskId` already drives its own report. Both mappings are returned; decide which report survives and delete or remap the other in Plextrac first. |
| `target_not_eligible` | 409 | `toTaskId` isn't a Penetration Test task. VMaaS tasks have no report mapping — replay them instead. |
| `not_found` | 404 | ClickUp doesn't have the target task. |
| `invalid_request` | 400 | Missing ids, the same id twice, or a malformed task id. |

### What follows the remap, and what doesn't

The automations split into two families, keyed differently.

**Keyed on our `task_mappings` document — these follow the remap immediately:**

| Automation | Where |
|---|---|
| Plextrac → ClickUp status sync (report status drives the task status) | `routes/plextrac-webhook.js` |
| QA queue entries and QA KPI / late-submission records | `pipeline/qa-*`, `lib/qa-*-store.js` |
| Start-date watcher (corrects the report month once a start date is set) | `pipeline/start-date-watch.js` |
| Future ClickUp renames → Plextrac client/report renames | `pipeline/task-rename.js` |

If the target task has **no start date**, remap re-arms the start-date watcher
(`start_date_pending`), because the report name's month then comes from a fallback —
the watcher renames it once ClickUp gets a real date. `start_date_pending` in the
response tells you this happened.

**Keyed on the ClickUp task id the *portal* holds against each auth form — the portal
decides which tasks these land on:**

| Automation | Where |
|---|---|
| Merged auth-form link comment | `POST /clickup/merged-auth-form` |
| Signed form attached + link prepended to the description + status advanced to `Waiting for Pre-reqs` | `POST /clickup/finalised-auth-form` |
| Extra-URLs comment and Slack alert | `POST /clickup/extra-urls` |
| Free Black Box auto-schedule (start/due dates + assignee) | `POST /clickup/schedule-task` |

Remap creates a form for the target task, so the target **is** in that set from then
on. But the source task's form is still live in the portal, so the source is still in
it too — both tasks receive these.

Timing matters for the signed form specifically:

- **Remap before the client signs** — the portal sends the signed form to whichever
  task ids its forms cover, so the target gets the PDF, the description link and the
  pre-reqs status advance. (So does the source.)
- **Remap after the client has signed** — the signature belongs to the source task's
  form. The target gets a *fresh, unsigned* form. **Nothing back-fills the signed PDF
  onto the target**; there's no portal API to transfer a form's signed state. Attach it
  by hand, or have the portal re-send `POST /clickup/finalised-auth-form` with the
  target's task id.

The pre-reqs advance only fires from the statuses in `CLICKUP_PRE_REQS_FROM_STATUSES`
(default `to do,open,scheduled`), so a task that has already moved on is skipped
rather than dragged backwards.

### Black box scheduling

Only the **Free** Black Box is scheduled automatically, and it isn't part of the
create pipeline: the portal calls `POST /clickup/schedule-task` on form submission and
that writes the dates and assignee onto the task id the *form* carries. So a remapped
task is auto-scheduled only if the submission that arrives is against its own form.
The "already scheduled, don't move it" guard is per task (it checks that task's
`start_date`), so a target with no dates will still be scheduled even when the source
already was.

A regular paid Black Box is never auto-scheduled — `POST /schedule/pentest` *creates* a
task from a chosen consultant and date range, and has nothing to do with either
endpoint here. A remapped task keeps whatever dates it already had in ClickUp.

### What remap deliberately leaves alone

The **source task is not modified**. Its `authformlink` field still points at its own
authorisation form, and that form still exists in the portal — there is no API to
withdraw one. If the source is a duplicate you're abandoning, withdraw its form in the
portal manually, or the client's merged form will keep carrying an element for it. The
response says so in `manual_followup`, and so does the Slack notice.

Two transient Slack messages are also left to self-heal rather than being rewritten:
the daily auth-form check list (reconciled every 5 minutes) and the weekly reports-due
message (rebuilt each Monday). Both re-derive from ClickUp on their next run.

---

## Typical sequences

**"No report was ever created for this task."**

```bash
curl -s -H "X-API-Key: $KEY" $BASE/tasks/86abc1234 | jq '.mapping, .parsed'   # confirm
curl -s -X POST $BASE/tasks/replay -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"taskId":"86abc1234"}' | jq
```

**"The report exists but the task has no auth form."**

```bash
… -d '{"taskId":"86abc1234","force":true}'
```

**"There are two tasks and the automations are on the wrong one."**

```bash
curl -s -H "X-API-Key: $KEY" $BASE/tasks/86abc1234 | jq '.mapping'   # the one holding the report
curl -s -H "X-API-Key: $KEY" $BASE/tasks/86def5678 | jq '.mapping'   # should be null
… -d '{"fromTaskId":"86abc1234","toTaskId":"86def5678"}'
```

**"The task name was wrong and has been fixed in ClickUp."** Nothing to do — the
rename webhook syncs Plextrac by itself. Replay only if that rename was also missed.
