# Plextrac client merge

Merges a duplicate Plextrac client into the one being kept, from the SFE portal
(Admin → **Merge Clients**). break.services does all of it
(`pipeline/client-merge.js`); the portal is only the screen.

## What a merge does

1. **Snapshot** both clients and their reports.
2. **Back up every report of BOTH clients** to Drive, under
   `CLIENT_MERGE_DRIVE_FOLDER_ID` (default `1YxrZz42lKpbnrohi04je_RV60ESIZoWn`):

   ```
   <Removed> - <Kept> Merge - 2026-10-05 17-42-10/
     manifest.json                      the merge record (rewritten when it finishes)
     <Client> (<id>)/client.json        client record + report list
     <Client> (<id>)/<Report> (<id>)/
       <Report>.ptrac                   restorable copy (Plextrac → Import Report)
       Full-Pentest-Report-Tech-Details <timestamp>.pdf
       Executive Summary Report <timestamp>.pdf
       Letter of Attestation <timestamp>.pdf
       Artifacts/…                      files from the report's Artifacts tab
   ```

   Every file is checked against Drive's MD5. **Any** failure stops the merge here,
   with nothing changed in Plextrac.
3. **Move** the removed client's reports, one at a time: import the `.ptrac` read back
   from Drive → find the new report → re-export it and compare finding and screenshot
   counts → copy the Artifacts → check the original wasn't edited mid-merge →
   re-point break.services' records (ClickUp mapping, DeliveryFlow engagement, QA
   queue/KPIs) and send DeliveryFlow a `report_status` with the new link → delete the
   original. Any failure stops the merge where it is.
4. **Delete the removed client** once it has no reports, after recording its name as
   an alias of the kept client (`plextrac_client_aliases`), so new ClickUp/DeliveryFlow
   work under that name is filed under the kept client instead of recreating it.

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

## Following a merge

- SFE screen: progress, per-report state, step log, Drive link.
- `GET /api/plextrac/client-merges/:mergeId` (X-API-Key `BREAK_SERVICES_API_KEY`).
- Mongo `client_merges`: the full record, saved after every step.
- PM2 log lines start `Client merge:`; a Slack summary goes to `SLACK_WEBHOOK_URL`.

A merge running when break.services restarts is marked `interrupted` at startup. Check
its per-report states before re-running: a report in state `imported`/`verified`/
`artifacts`/`repointed` exists in **both** clients.

## Restoring a report from the backup

Plextrac → Reports → Import Report → choose the client → upload the `.ptrac`.
