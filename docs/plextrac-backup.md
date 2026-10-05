# Weekly Plextrac backup

Every Friday at 22:00 UK time (BST in summer, GMT in winter) break.services backs up
the whole Plextrac tenant to Google Drive (`pipeline/plextrac-backup.js`). Each report
is backed up exactly as a client merge does it (`pipeline/report-backup.js`).

```
<PLEXTRAC_BACKUP_DRIVE_FOLDER_ID>/          default 1B9zPyVhLH7AvFdnHFIK-37v8M06COy5V
  0001. 2026-10-09 22-00-00/
    changes.md                              what's new / changed / removed since the last run
    manifest.json                           totals, every client and every report's record
    <Client> (<id>)/client.json
    <Client> (<id>)/<Report> (<id>)/
      <Report>.ptrac                        restore: Plextrac → Reports → Import Report
      Full-Pentest-Report-Tech-Details <timestamp>.pdf
      Executive Summary Report <timestamp>.pdf
      Letter of Attestation <timestamp>.pdf
      Artifacts/…
  0002. 2026-10-16 22-00-00/
```

- **Numbering** is one past the highest number already in the folder (or on record), so
  the folder is a running log. Test runs go in `TEST <timestamp>` folders and take no number.
- **Read-only** against Plextrac. Every file is MD5-checked against Drive.
- **A failing report doesn't stop the run.** It is listed under "Failed" in
  `changes.md` and the run ends `completed_with_errors`.
- **Resumable.** Each report's record is saved as it finishes. If break.services
  restarts mid-run, it resumes the run about a minute after startup, in the same
  folder, skipping the reports already filed.
- **Change log.** `changes.md` compares with the last finished numbered run:
  - new, removed and renamed clients;
  - new and removed reports;
  - for each changed report: status, name, findings added, removed or updated (by title), artifacts, or "content edited".
- **Slack:** a summary goes to `SLACK_WEBHOOK_URL` when a numbered run finishes.
- **SFE:** Admin → Scheduling → Weekly Plextrac Backup shows the last run (clients,
  reports, PDFs, .ptrac, artifacts, size, runtime, failures, changes), a run in
  progress, and the next run time.

## Running it by hand

```bash
node scripts/plextrac-backup.js --clients=39283,99371   # test run of a few clients
node scripts/plextrac-backup.js --full                  # full numbered run now (hours; use tmux/screen)
node scripts/plextrac-backup.js --status
curl -X POST -H "X-API-Key: $AVAILABILITY_API_KEY" https://api.break.services/jobs/plextrac-backup
```

## Configuration (.env.example → "Weekly Plextrac backup")

`PLEXTRAC_BACKUP_DRIVE_FOLDER_ID`, `PLEXTRAC_BACKUP_CRON` (blank = not scheduled),
`PLEXTRAC_BACKUP_TZ`, `PLEXTRAC_BACKUP_CONCURRENCY` (default 3).

## Storage

A full run is roughly (reports × (.ptrac + 3 PDFs + artifacts)). A screenshot-heavy
report's .ptrac alone can be 15 MB, so expect several GB per run. Nothing deletes old
runs: watch the Drive owner's quota (the service account's, or
`GOOGLE_DRIVE_SUBJECT`'s, or the shared drive's).

MongoDB keeps run records in `plextrac_backup_runs`, and per-report records for the last
8 numbered runs in `plextrac_backup_items` (every run's `manifest.json` keeps them all).
