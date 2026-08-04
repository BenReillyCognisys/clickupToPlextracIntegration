# QA KPIs (`/report-kpis`)

A Slack slash command that shows a leaderboard of **how many QAs each consultant
has performed**, built from the Plextrac `ReportStatusChanged` webhook.

## Usage

```
/report-kpis                 last 31 days (default)   ── PM-only command
/report-kpis 90d             rolling last N days — e.g. 90d, 180d, 364d (1–3650)
/report-kpis q1|q2|q3|q4     a calendar quarter of the current year
/report-kpis q2 2025         that quarter of a specific year
/report-kpis @user           one person's stats for the last 30 & 90 days
/report-kpis help            show usage
```

### Per-user lookup (`/report-kpis @user`)

`@`-mention a Slack user to see just their stats over the last 30 and 90 days —
both the QA work they did **and** how late their own report submissions were:

```
*QA KPIs — Ben Reilly*

*Last 30 days:*
• QA'd *4* reports · 30 findings (avg 7.5/report)
• Submitted *5* reports · avg *6.3h* late (2 late)

*Last 90 days:*
• QA'd *11* reports · 88 findings (avg 8/report)
• Submitted *12* reports · avg *5h* late (4 late)
```

**Submission lateness** (this view only — never on the leaderboard): each time a
report is first submitted for QA (author moves it to "Ready For Review"), we compare
the submission time to the report's **ClickUp due date**. The due day itself is never
counted — the clock starts at **09:00 on the next working day** (a report due
Thursday starts Friday 09:00; due Friday starts Monday 09:00). Lateness is the
wall-clock hours from that start to submission, clamped at 0 (on-time/early = 0h).
The average is over submissions that had a due date; a report whose ClickUp task has
no due date still counts as submitted but is left out of the average. Only mapped
reports are tracked (a ClickUp task is needed for the due date).

The mention is resolved **Slack id → email (`users.info`) → Plextrac user (matched
on email) → cuid → stats**. Two requirements:

- The `/report-kpis` slash command must have **"Escape channels, users, and links
  sent to your app"** enabled (Slack app → Slash Commands → edit the command).
  Without it Slack sends the literal text `@Name`, which can't be resolved — the
  command replies with a hint to enable this.
- The bot token needs the **`users:read`** and **`users:read.email`** scopes so it
  can read the mentioned user's email to cross-reference against Plextrac.

Each hop that can't resolve (no visible email, no matching Plextrac account) returns
a specific, actionable message rather than a generic error.

Day counts accept `Nd`, `N`, or `N days` (`month` is an alias for 31 days).
Calendar quarters: **Q1** = 1 Jan–31 Mar, **Q2** = 1 Apr–30 Jun, **Q3** = 1 Jul–30
Sep, **Q4** = 1 Oct–31 Dec. The window filters on when each QA credit was earned
(`counted_at`); rolling day windows end at "now", quarter boundaries are UTC
midnight. An unrecognised or out-of-range argument returns an ephemeral usage hint.
The chosen window is shown in the leaderboard header.

## Who can run it

`/report-kpis` (all subcommands, including `@user` and `help`) is restricted to the
**same PM allowlist as `/reportqueueall`** — `SLACK_PM_USER_IDS` (falling back to the
built-in default list). A non-PM gets an ephemeral `:lock:` message and no data. The
check runs before any work, so unauthorised users never trigger a Plextrac lookup.

## Per-report log (`/qa-logs @user`)

Where `/report-kpis @user` gives a consultant's **aggregate** stats, `/qa-logs @user`
lists their **individual** recent QAs — one line per report, newest first:

```
/qa-logs @user        the consultant's last 30 QAs   ── PM-only command
/qa-logs @user 20     limit to their last N QAs (1–100)
/qa-logs help         show usage
```

```
*QA logs — Ben Reilly* — 2 most recent

1. 4 Aug, 15:32 - Web App Pentest - Acme Corp - 12 findings
2. 3 Aug, 11:04 - API Review - Globex - 1 finding
```

Each entry shows **when** the QA was performed (`counted_at`, formatted in UK local
time), the report **title** and **client**, and the report's **findings count** at QA
time. A report whose findings count wasn't recorded reads `findings unknown` (never a
misleading `0 findings`). It draws from the same `qa_kpi_events` store as the
leaderboard — so, like the KPIs, it only covers QAs recorded **from deployment
onward**, and it uses the identical **Slack id → email → Plextrac user → cuid**
resolution (and so needs the same "Escape…" option and `users:read` /
`users:read.email` scopes). It's restricted to the **same PM allowlist** as the other
commands.

## How a QA is attributed

Every webhook payload carries an **`actorCuid`** — the user who triggered the
status change (per Plextrac support). The Plextrac webhook
(`routes/plextrac-webhook.js`) records that actor against the report whenever the
report's status changes, and `/report-kpis` aggregates those records per consultant.

Plextrac's API only looks users up by **numeric id, not cuid**, so to turn an
`actorCuid` into a name we **enumerate every tenant user and match on their `cuid`
field** (`lib/plextrac-users.js`, cached for 10 min). Users who can't be resolved
(e.g. since removed from Plextrac) show as `Unknown user (<short cuid>)`.

## Report size (findings per report)

A raw QA count treats a 2-finding report the same as a 40-finding one. To surface
that, each credit also stores the report's **findings count at QA time** (fetched
once, when the credit is first earned — duplicate status flips cost no extra call).
The leaderboard then shows, per consultant, total findings and the **average
findings per report**:

```
1. Alice — *8* QAs · 64 findings (avg 8/report)
2. Bob   — *8* QAs · 12 findings (avg 1.5/report)
```

Same QA count, but Bob is clearly QA'ing much shorter reports. Reports whose
findings count couldn't be determined are excluded from the total/average (never
shown as a misleading "0 findings").

## What counts (anti-abuse)

Two rules keep the numbers honest:

1. **One credit per consultant per report.** The KPI store
   (`lib/qa-kpi-store.js`) keys on a unique `{ report_id, actor_cuid }`, so a
   consultant flipping a report's status back and forth only ever earns **one**
   QA for that report. The first qualifying status change wins; every later one is
   a no-op.
2. **The initial "Ready For Review" is not counted.** That transition is an author
   submitting their **own** report for QA — not a QA performed on someone else's
   work. It's excluded before it reaches the store. Every other status change
   counts. Extend the exclusion list with `PLEXTRAC_KPI_EXCLUDED_STATUSES`
   (comma-separated) if your workflow needs it.

> KPIs accrue **from deployment onward** — they're built from live webhook events,
> so there is no historical backfill (past status changes carried no stored actor).

## Data flow

```
Plextrac (report status changes)
   │  POST /webhook/plextrac   (HMAC-signed; existing endpoint)
   ▼
routes/plextrac-webhook.js
   └─ recordQaKpi(status, actorCuid, ctx)
        • skip if status is excluded (initial "Ready For Review")
        • skip if actorCuid missing, or already credited (store.has)
        • count report findings (listReportFindings) — new credits only
        • qa-kpi-store.record()  → upsert on { report_id, actor_cuid }  (dedup)

/report-kpis  (Slack)
   │  POST /slack/commands
   ▼
routes/slack-command.js
   ├─ ack within 3 s (":bar_chart: Crunching QA KPIs…")
   ├─ parseWindow(text)                  → { label, since, until }  (or usage hint)
   └─ deliverKpis(response_url, window)   [async]
        • qa-kpi-store.aggregateByActor({since,until}) → counts per cuid in window
        • plextrac-users.cuidMap()                     → cuid → name/email
        • qa-kpi.renderKpis(entries, window.label)     → mrkdwn leaderboard
        • slack.postToResponseUrl(replace_original)
```

`/report-kpis` acks immediately and delivers the result over the command's
`response_url`, because enumerating Plextrac users can exceed Slack's 3-second
window.

## Slack setup

In the same Slack app that owns `/reportqueue`:

1. **Slash Commands → Create New Command**
   - Command: `/report-kpis`
   - Request URL: `https://api.break.services/slack/commands` (same URL as the
     queue commands — the handler routes on the `command` field)
   - Short description: "QAs performed per consultant"
   - **Tick "Escape channels, users, and links sent to your app"** — required for
     the `/report-kpis @user` lookup (so mentions arrive as `<@U…>`, not `@Name`).
   - Repeat for **`/qa-logs`** — same Request URL, short description "Recent QAs by a
     consultant", and the **same "Escape…" tick** (it also takes an `@user`).
2. **OAuth & Permissions → Bot Token Scopes** — add `users:read` and
   `users:read.email` (needed to resolve an `@user` mention to their email). The
   leaderboard commands themselves need no extra scopes.
3. Reinstall the app if prompted (scope changes require it).

## Config

See `.env.example` → "QA KPIs (/report-kpis)":

- `PLEXTRAC_KPI_EXCLUDED_STATUSES` — statuses that earn no credit (default
  `Ready For Review`).
- `PLEXTRAC_USERS_PATH` — tenant users endpoint (default
  `/api/v1/tenant/{tenantId}/user/list`; requires the "View Users" RBAC
  permission on the service account).
- `PLEXTRAC_USERS_CACHE_MS` — user-list cache TTL (default 600000).

## ⚠️ Confirm against the live Plextrac instance

The users endpoint path and response shape vary by Plextrac version and could not
be validated against the real API. Confirm with:

```
node scripts/inspect-users.js
```

It prints the raw first row and every normalised `cuid → name / email`. If no rows
have a usable `cuid`, adjust `PLEXTRAC_USERS_PATH` and/or `normaliseUser()` in
`lib/plextrac-users.js`.

## Files

- `routes/plextrac-webhook.js` — records the actor + findings count per QA, and report-submission lateness on "Ready For Review"
- `lib/qa-kpi-store.js` — MongoDB store; unique `{report_id, actor_cuid}` (dedup); `aggregateByActor` / `statsForActor` / `recentByActor` (the /qa-logs feed)
- `lib/qa-submission-store.js` — MongoDB store of first submissions + lateness; `lateStatsForActor`
- `lib/report-lateness.js` — pure DST-safe lateness math (next-working-day 09:00 start)
- `lib/plextrac-users.js` — enumerate users, cuid → name/email and `findByEmail` (cached)
- `lib/plextrac-api.js` — added `listTenantUsers()`
- `lib/qa-kpi.js` — aggregate, `parseWindow`, `renderKpis`, `parseUserMention` / `buildUserPeriods` / `renderUserStats`, `buildUserLogs` / `renderUserLogs` (pure)
- `routes/slack-command.js` — `/report-kpis` and `/qa-logs` handlers: leaderboard, `@user` lookup/log, ack + `response_url` delivery
- `lib/slack.js` — added `postToResponseUrl` and `lookupUserById`
- `scripts/inspect-users.js` — diagnostic for the users endpoint/shape
- `tests/qa-kpi.test.js` — unit tests for the deterministic pieces
