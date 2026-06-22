# Automated QA Review (Plextrac → AI → Plextrac)

When a Plextrac report moves to **ready for QA**, Plextrac calls the existing
`/webhook/plextrac` endpoint. That single handler does two things: it syncs the
ClickUp task status (its original job) **and** kicks off the AI QA review. The
review corrects the report's **executive summary** and **findings**, writes
changes back to Plextrac, and logs every change to a log file and a Slack channel.

There is **no separate QA webhook** — it is integrated into the existing Plextrac
webhook, so only one webhook needs to be configured in Plextrac.

## Flow

```
Plextrac (status → QA)
   │  POST /webhook/plextrac        (HMAC-SHA256 signed — existing endpoint)
   ▼
routes/plextrac-webhook.js          verify signature → ack 200 → look up mapping by CUID → fetch report
   ├─ sync ClickUp task status (existing behaviour)
   └─ if report status === PLEXTRAC_QA_STATUS → runQaReview(mapping)  [fire-and-forget]
        ▼
        pipeline/qa-review/index.js
          1. fetch report; status gate (PLEXTRAC_QA_STATUS)
          2. resolve canonical client name (Plextrac client record)
          3. post parent msg "Client: {client} - {report} ready for first round of
             QA" to #pt-first-round-qa FIRST (client + report names hyperlinked);
             keep its thread anchor
          4. enable change tracking (best-effort — see below)
          5. executive summary:  strip formatting → client-name → de-jargon → flag incomplete sentences
          6. findings:           strip formatting → client-name → flag incomplete sentences
          7. log every change to LOG_FILE; once QA is fully complete, reply in the
             parent's thread with the AI QA feedback (changes + flags)
```

The QA review runs **fire-and-forget** so the (slower, billable) review never
blocks the fast ClickUp status sync. The report CUID → `{clientId, reportId}`
mapping reuses the existing MongoDB `task_mappings` collection
(`lib/task-store.findByCuid`).

### Pre-integration reports (no CUID mapping)

Reports created **before** the ClickUp integration existed have no row in
`task_mappings`, so the CUID lookup returns nothing. Rather than dropping these,
the handler falls back to identifiers carried directly in the Plextrac webhook
payload: it builds a synthetic mapping from `clientId`/`reportId`, runs the QA
review as normal, and **skips the ClickUp status sync** (there is no task to
update). It also posts `Client: {clientName} - {reportName}` to the main Slack
channel (`SLACK_WEBHOOK_URL`, the same channel used for "Report has been
created").

For this to work the Plextrac webhook payload must include these fields in
addition to the default `event` / `targetCuid` / `targetType`:

| Field        | Plextrac variable | Used for                          |
| ------------ | ----------------- | --------------------------------- |
| `clientId`   | `%CLIENT_ID%`     | fetch the report / run QA         |
| `reportId`   | `%REPORT_ID%`     | fetch the report / run QA         |
| `clientName` | `%CLIENT_NAME%`   | Slack notification text           |
| `reportName` | `%REPORT_NAME%`   | Slack notification text           |

If `clientId` or `reportId` is missing the handler logs a warning and stops
(it cannot fetch the report without them).

## The checks

| Check | Applies to | How | Auto-applied? |
|---|---|---|---|
| **Strip text formatting** | exec summary + findings | Deterministic HTML→plain-text (`lib/html-text.js`) | ⏸ **PAUSED** — being redefined (report fields are rich HTML; a blanket strip would flatten tables/headings). See `STRIP_FORMATTING_PAUSED` in `pipeline/qa-review/checks.js`. |
| **Correct client name** | exec summary + findings | Claude API — replaces wrong org names with the real client name. **Protected names** (the testing provider — Cognisys / Cognisys Group / Cognisys Group Limited, configurable via `QA_PROTECTED_NAMES` / `config/protected-names.js`) are never changed. | Yes |
| **De-jargon** (no TLS/SMB/etc.) | **exec summary only** | Claude API — rewrites for a non-technical audience | Yes |
| **Incomplete sentences** | exec summary + findings | Claude API — **detection only** | **No — flagged to Slack** |

**Placeholder guard.** Plextrac template variables (`%%CLIENT_SHORTNAME%%`,
`%%REPORT_START_DATE%%`, `%%Author_01%%`, …) must never be altered — Plextrac
substitutes them at render time. Two layers protect them: (1) the AI prompts are
instructed to leave `%%...%%` tokens byte-for-byte unchanged, and (2) a guard
(`lib/placeholders.js`) verifies every AI revision preserves the exact set of
placeholders — if an edit would add/remove/change one, it is **rejected** (not
applied) and flagged to Slack/log.

**Protected-name guard.** The same guard (`lib/protected-names.js`) also rejects
any revision that would remove or rename a protected organisation name (the
testing provider — Cognisys, etc.; see `config/protected-names.js`). This
deterministically prevents the client-name check from rewriting "Cognisys" into
the client's name.

**Why de-jargon is exec-summary-only:** findings are written for a technical
audience; removing acronyms there would be wrong.

**Why incomplete sentences are flagged, not fixed:** completing a half-written
sentence means inventing content the author never wrote. These are reported to
the author via Slack/log instead of auto-edited.

Each check is independently toggleable (`QA_CHECK_*` env vars, default on).

**Reduced-review sections.** Some executive-summary sections are templated/
boilerplate (e.g. **Methodology**, **Issue Matrix**, **Limitations**). These are
**not** skipped entirely — the **client-name check still runs** on them, because
an incorrect client name must be caught everywhere in the report. They only skip
the **de-jargon** and **incomplete-sentence** checks, which would wrongly rewrite
fixed structural content. Sections whose label/title matches
`config/excluded-sections.js` (override via `QA_EXCLUDED_SECTIONS`,
comma-separated) get this reduced review — matching is case-insensitive and
substring-based, so "Testing Methodology" also matches "Methodology".

## Claude Pro vs Claude API

This feature uses the **Claude API** (`@anthropic-ai/sdk`) with a billed
`ANTHROPIC_API_KEY` from console.anthropic.com.

A **Claude Pro/Max subscription will not work** — Pro is for interactive use
(claude.ai, Claude Code) and cannot be called from a server. An unattended
webhook handler needs the API.

## Cost

All enabled AI checks for one segment run as a **single** structured-output
request (`reviewSegment`), and the defaults are tuned for low cost:

- **Model: `claude-haiku-4-5`** (~5× cheaper per token than Opus). Override with
  `ANTHROPIC_MODEL`.
- **Extended thinking OFF** by default (`QA_AI_THINKING=true` to enable) — thinking
  tokens bill as output, and these bounded edit tasks don't need them.
- **No `effort`** sent by default (`QA_AI_EFFORT`; only valid on Opus/Sonnet).
- One merged call per segment instead of three, so the segment text and system
  prompt aren't re-sent per check.
- **Edits-only responses**: the model returns just the before→after spans to
  change (not the full rewritten text), and `checks.js` applies them in code.
  Output tokens are the expensive part (5× input), so for mostly-unchanged
  sections this is the largest saving — an unchanged segment returns ~empty
  instead of echoing hundreds of tokens.

If you need higher edit quality, raise `ANTHROPIC_MODEL` (e.g.
`claude-sonnet-4-6`) and/or set `QA_AI_THINKING=true` — at higher cost.

## Change tracking

Plextrac tracks changes at the report level via the boolean `isTrackChanges`
field on the report object (`true` = track changes across all rich-text fields).
The pipeline sets it `true` before editing via the standard report update
endpoint (`pipeline/qa-review/change-tracking.js`). It is **on by default**; set
`PLEXTRAC_CHANGE_TRACKING_ENABLED=false` to opt out.

Tracking is **intentionally left ON after the run** — the pipeline does not turn
it off, so the report keeps tracking any subsequent edits a reviewer makes.

The executive-summary write uses a **partial update** (only the changed
top-level fields) precisely so it doesn't reset `isTrackChanges` mid-edit by
PUT-ing back a stale full report object.

A failure to toggle tracking never aborts the review — the **internal audit
trail** (every change written to `LOG_FILE` and posted to Slack) always works and
does not depend on Plextrac.

## ⚠️ Assumptions to confirm against the live Plextrac instance

These were coded defensively but could not be validated against the real API:

1. **Findings endpoints** use Plextrac's v1 "flaw" routes
   (`/client/{c}/report/{r}/flaws`, `.../flaw/{id}`). Confirm with
   `node scripts/inspect-findings.js`.
2. **Executive-summary field shape.** `report-fields.js` tolerates a string
   field (`exec_summary` / `executive_summary`) or an array of section objects
   (`{title, text|value|custom_field|...}`). Confirm with
   `node scripts/inspect-report.js`; if a field isn't picked up it is logged as
   "No executive-summary segment found".
3. **Write-back.** The exec summary is written by PUT-ing the full (edited)
   report object; findings by PUT-ing the full (edited) finding object. If your
   instance rejects round-tripped fields, adjust `updateReport`/`updateFinding`
   payloads.

## Setup

1. `npm install` (adds `@anthropic-ai/sdk`).
2. Fill in the new `.env` values (see `.env.example` → "AI QA Review"): at minimum
   `ANTHROPIC_API_KEY`, `LOG_FILE`, `PLEXTRAC_QA_STATUS`.
2b. **Slack first-round QA** — create a Slack app with a bot token (`xoxb-...`)
   that has the `chat:write` scope, invite it to **#pt-first-round-qa**, and set
   `SLACK_BOT_TOKEN` + `SLACK_FIRST_ROUND_QA_CHANNEL` (defaults to the channel id
   `C0B9D6487HR`). A bot token is required because incoming webhooks can't thread.
3. **No new webhook needed** — the review runs from the existing
   `/webhook/plextrac` handler. Just ensure that webhook is configured to fire on
   the QA status (and that `PLEXTRAC_QA_STATUS` matches it exactly).
4. Run the diagnostics once to confirm field shapes:
   `node scripts/inspect-report.js` and `node scripts/inspect-findings.js`.
5. Recommended first run: set `QA_CHECK_*` to disable AI checks and verify
   formatting-only behaviour, then enable AI checks on a test report and review
   the Slack summary before relying on it.

## Files

- `routes/plextrac-webhook.js` — existing webhook; now also triggers `runQaReview` on the QA status
- `lib/slack.js` — Slack Web API helper (parent message + threaded reply for first-round QA)
- `pipeline/qa-review/index.js` — orchestrator
- `pipeline/qa-review/checks.js` — per-segment check runner
- `pipeline/qa-review/report-fields.js` — shape-tolerant field locate/read/write (tags reduced-review sections)
- `config/excluded-sections.js` — exec-summary sections that get client-name-only review (Methodology, Issue Matrix, Limitations, …)
- `pipeline/qa-review/change-tracking.js` — best-effort Plextrac tracking toggle
- `lib/ai-review.js` — Claude API calls (structured outputs)
- `lib/html-text.js` — deterministic formatting strip
- `lib/logger.js` — extended with file sink + QA Slack channel
- `lib/plextrac-api.js` — added `getClient`, findings calls, `raw` passthrough
- `scripts/inspect-findings.js` — diagnostic
- `tests/qa-review.test.js` — unit tests for the deterministic pieces
```
