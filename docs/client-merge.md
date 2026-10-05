# Plextrac client merge

Merges one or more duplicate Plextrac clients into the one being kept, from the SFE
portal (Admin → **Merge Clients**). break.services does all of it
(`pipeline/client-merge.js`); the portal is only the screen.

Pick the clients, choose the one to keep, preview, then type the **kept** client's name
to confirm. Up to `CLIENT_MERGE_MAX_CLIENTS` (default 25) clients can be removed in one
merge.

## What a merge does

1. **Snapshot** every client involved and its reports.
2. **Back up every report of EVERY client** to Drive, under
   `CLIENT_MERGE_DRIVE_FOLDER_ID` (default `1YxrZz42lKpbnrohi04je_RV60ESIZoWn`):

   ```
   <Removed> - <Kept> Merge - 2026-10-05 17-42-10/        (one client)
   <First removed> + 6 more - <Kept> Merge - .../         (several)
     manifest.json                      the merge record (rewritten when it finishes)
     <Client> (<id>)/client.json        client record + report list
     <Client> (<id>)/<Report> (<id>)/
       <Report>.ptrac                   restorable copy (Plextrac → Import Report)
       Full-Pentest-Report-Tech-Details <timestamp>.pdf
       Executive Summary Report <timestamp>.pdf
       Letter of Attestation <timestamp>.pdf
       Artifacts/…                      files from the report's Artifacts tab
   ```

   Every file is checked against Drive's MD5.
   - A report of the **kept** client failing to back up stops the whole merge here,
     with nothing changed in Plextrac.
   - A report of a client being **removed** failing means that client is **skipped**:
     nothing of it is touched, and the other clients go ahead.
3. **Move** each client's reports, client by client, one report at a time: import the
   `.ptrac` read back from Drive → find the new report → re-export it and compare
   finding and screenshot counts → copy the Artifacts → check the original wasn't
   edited mid-merge → re-point break.services' records (ClickUp mapping, DeliveryFlow
   engagement, QA queue/KPIs) and send DeliveryFlow a `report_status` with the new
   link → delete the original.
4. **Delete each removed client** once it has no reports, after recording its name as
   an alias of the kept client (`plextrac_client_aliases`), so new ClickUp/DeliveryFlow
   work under that name is filed under the kept client instead of recreating it.

A failure in 3 or 4 stops **that client** where it is: the report that failed and the
client's remaining reports stay on it, and the client is not deleted. The merge then
carries on with the next client.

The merge ends:

| status      | meaning                                                         |
|-------------|-----------------------------------------------------------------|
| `completed` | every client merged and deleted                                 |
| `partial`   | some merged; each other client says why (`merge_clients[].error`) |
| `failed`    | none merged (or the kept client's backup failed)                |

Each client in `merge_clients` has a `state`: `pending`, `moving`, `deleting`,
`merged`, `skipped` (backup failed, untouched) or `failed` (with `failed_at`). Re-run a
merge for the clients that weren't merged once the problem is fixed.

Imported reports get **new ids and cuids**. Report **comments are not carried** by a
`.ptrac`; the PDFs in the backup are the reference copy.

While a report is being moved, Plextrac webhooks for it are ignored
(`lib/webhook-suppression.js`), so the import can't start QA reviews, release exports or
announcements.

## Prerequisites

- The Drive service account (or `GOOGLE_DRIVE_SUBJECT`) can **write** to the backup folder.
- The Plextrac API role can export (`.ptrac`), import reports, upload/download
  artifacts, and delete reports and clients.
- The PDF renderer works (`npm run setup:renderer`) — every report needs all three PDFs.

## API

`X-API-Key: BREAK_SERVICES_API_KEY` (the portal sends it):

- `GET /api/plextrac/client-merges/preview?keepClientId=1&mergeClientIds=2,3,4`
- `POST /api/plextrac/client-merges` `{ keepClientId, mergeClientIds: [2, 3, 4], confirmClientName: "<kept name>", requestedBy }`

The single-client form the portal used before (`mergeClientId`, confirmed with the
removed client's name) is still accepted.

## Following a merge

- SFE screen: progress, per-client and per-report state, step log, Drive link.
- `GET /api/plextrac/client-merges/:mergeId`.
- Mongo `client_merges`: the full record, saved after every step.
- PM2 log lines start `Client merge:`; a Slack summary goes to `SLACK_WEBHOOK_URL`.

A merge running when break.services restarts is marked `interrupted` at startup. Check
its per-report states before re-running: a report in state `imported`/`verified`/
`artifacts`/`repointed` exists in **both** clients.

## Restoring a report from the backup

Plextrac → Reports → Import Report → choose the client → upload the `.ptrac`.
