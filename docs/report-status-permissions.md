# Report statuses: three rounds of QA, and who may release

| Status | Who may set it | What happens (posted to) |
|---|---|---|
| Draft | anyone | nothing |
| Ready For Review | anyone | first-round QA: AI review → first-round QA channel |
| In Review | anyone | second-round QA → second-round QA channel |
| Approved | Alice Elvin, Ben Reilly, Soham Bakore, Punit Sharma, Karan Luniyal, Rajveer Parmar | "approved — ready for release", pinging Alice and Ben → ready-for-release channel; "Ready for Release" in `/reportqueue` |
| Published | Alice Elvin, Ben Reilly | release announcement + j2 exports (Drive, Artifacts) → ready-for-release channel |

Matched on each person's **main** Plextrac account email (`config/report-status-permissions.js`,
or `PLEXTRAC_APPROVER_EMAILS` / `PLEXTRAC_PUBLISHER_EMAILS`).

## A change someone isn't allowed to make

`pipeline/status-guard.js` runs first on every status webhook. For a disallowed change:

1. The report is set back to its previous status, as last recorded in
   `plextrac_report_status`. If no status is on record, it goes to the highest status
   that person may set (In Review for most people).
2. The same message goes to the ready-for-release channel and to the status-violations
   channel (`SLACK_STATUS_VIOLATIONS_CHANNEL`, default `C0B6SN0023D`). It names the client and
   report (linked), the from and to statuses, and who may set it. It tags the person who
   made the change, looked up in Slack by their Plextrac email under either
   `cognisys.group` or `cognisys.co.uk`; if Slack doesn't know them, they are named instead.
   If the put-back itself fails, the message says to fix it by hand.
3. **Nothing else runs:** no QA posts, release announcement or j2 exports, and no QA queue, KPI, ClickUp or DeliveryFlow updates.

The put-back fires a webhook of its own. It is recognised as break.services' change
(its API account is the actor, or the one-shot expected-status mark) and ignored.

Fails closed: a restricted change is put back if Plextrac doesn't say who made it, or
the user list can't be read to check.

## Deploying

1. **Plextrac webhook:** it must fire on EVERY status: Draft, Ready For Review,
   In Review, **Approved** and Published. A missing Approved trigger means Approved
   changes are never checked. A missing Draft trigger means the previous status can be
   wrong.
2. Invite the Slack bot to the status-violations channel (`C0B6SN0023D`) and the ready-for-release channel (`SLACK_READY_FOR_RELEASE_CHANNEL`,
   default `C0C4ZAKA998`). Releases move there from the second-round channel.
3. `node scripts/seed-report-statuses.js` once: records every report's current status.

Plextrac itself still lets anyone pick any status. break.services undoes a disallowed
change within seconds, so for that moment the report shows the status that was set.
