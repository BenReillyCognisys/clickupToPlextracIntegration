# Client documents (Executive Summary, Letter of Attestation)

When a Plextrac report is **released**, the service files everything that goes with it
(`pipeline/release-exports.js`):

```
Drive:  <reports folder>/<NNN. Month YYYY>/<Client>/
          Plextrac Full Report 2026-09-26 14-30-05.pdf      ← Plextrac's own export
          Executive Summary Report 2026-09-26 14-30-05.pdf  ← made here
          Letter of Attestation 2026-09-26 14-30-05.pdf     ← made here
Plextrac: the two made-here documents on the report's Artifacts tab
```

The full report is exported by Plextrac. The two **client documents** are made by
this service, entirely from Plextrac data, with no AI involved. Each one goes through
these steps:

1. **Plextrac data.** The report, the client and the findings are fetched fresh for this release.
2. **Template.** A reduced copy of that data goes into the document's Jinja2 template (`jinja2-export-templates/*.j2`), which fills itself from it. Real Jinja2 and WeasyPrint render it to PDF, in Python (`renderer/render.py`).
3. **Publish.** The PDF goes into the release's Drive folder and onto the report's Artifacts tab. The Artifacts tab is read back afterwards to confirm the file is attached to this report.

Success is silent in Slack. Anything that fails is listed in the release
announcement's thread, saying what needs doing by hand.

## What each document contains

**Executive Summary Report** (`cognisys-exec-summary.j2`) contains:

- a cover page
- the Introduction narratives: Overview, Scope, Caveats, Disclaimer and Confidentiality Notice
- the report's own **Executive Summary** narrative, printed in full as written in Plextrac

**Letter of Attestation** (`cognisys-letter-of-attestation.j2`) fills five placeholders:

| Placeholder | Filled from |
|---|---|
| (CLIENT NAME) | the Plextrac client's name, in all four places |
| (MONTH YEAR) | the month the letter is issued (the release date, UK time), e.g. `September 2026` |
| (LINKS and APP NAMES) | the **Scope** narrative's in-scope table, one row per host: the URL on the left, its notes (and any further columns, joined with " – ") on the right |
| (TOTAL ISSUE COUNT) | the number of findings, e.g. `4 issues` |
| (INSERT ISSUE COUNT HERE) | per severity, e.g. `1 Critical, 1 High, 1 Medium and 1 Informational`; a severity with no findings is left out |

How the Scope narrative is read is set at the top of the template:

- **`SCOPE_END`:** everything from "The following activities were out of scope for this engagement" onwards is dropped.
- **`SCOPE_DROP_LINES`:** the "In-Scope URLs" heading is removed.
- **`SCOPE_TABLE_HEADERS`:** each table's first row is its header (URL | Notes) and isn't a host.
- **Blank rows:** rows left blank in Plextrac's scope template are skipped.
- **`SCOPE_STOP_HEADINGS`:** a section starting at one of these headings is left out. It defaults to `["User Authentication"]`, because that table lists the test accounts (emails and roles), not hosts, and doesn't belong in a letter sent to third parties. Set it to `[]` to include it.
- **Scopes without a table:** a scope written as paragraphs or bullets gives one host per line.

Anything the template can't fill prints its original placeholder **in red**, so a
letter never goes out with a silent gap. This includes a report whose scope table was
left blank, and a report with no findings. The template deliberately doesn't claim
"no issues" for an empty list.

## Previewing on a real report

```
node scripts/preview-client-documents.js <clientId> <reportId>                   # both documents → preview/*.pdf
node scripts/preview-client-documents.js <clientId> <reportId> --doc letter-of-attestation
node scripts/preview-client-documents.js <clientId> <reportId> --html            # HTML instead; no WeasyPrint needed
```

A preview does exactly what a release does, except upload anything. For a look at
what a template receives, set `DEBUG_CONTEXT = true` at its top. The letter's debug
page also lists the host rows it read from the Scope narrative.

## Adding or changing a document

Documents are listed in `config/client-documents.js`: a key, a name (the filename
prefix) and a template. A document whose template file is missing is **skipped with
a warning**, so an entry can be added before its template exists.

### What the templates receive

The templates get the variables Plextrac's own export gives them: `REPORT_INFO`,
`CLIENT_INFO`, `FINDINGS` and `FINDING_SUMMARY`. These are **deliberately reduced**
(`pipeline/client-documents/data.js`):

- **`REPORT_INFO` and `CLIENT_INFO`:** only the allow-listed keys (`REPORT_KEYS`, `CLIENT_KEYS`). `REPORT_INFO.export_datetime_us` carries the release time.
- **`FINDINGS`:** each finding's **title and severity only** (`FINDING_KEYS`), enough to count them. `FINDING_SUMMARY` holds the counts per severity.

Because this is done in code rather than left to the template, no template edit can
leak a finding write-up into a client document. That includes `DEBUG_CONTEXT`, which
dumps the whole context into the PDF. A template that needs another field must be
given it there, deliberately.

Plextrac's findings list returns each finding as a positional row (`data: [id,
severity, title, status, ...]`). `normaliseFindings` turns these into `{ severity,
title }` so the templates can read them.

## How the wrong-folder and double-filing problems are prevented

- **Details captured once.** A release's details (client, report, export time) are captured once, frozen, and passed to every step.
- **One folder for everything.** The Drive folder is resolved once per release, before any upload, and the same folder id is handed to the full report and to every client document. No step looks the folder up for itself.
- **One run per report at a time.** Runs for the same report are serialised, so a webhook delivered twice, or a quick re-release, waits for the first run to finish. Different reports run side by side.
- **No duplicate folders.** Drive allows duplicate folder names, so creating a folder of a given name under a given parent is serialised (`lib/google-drive.js`), and lookups take the oldest folder of a name. Two releases for one client can't create two client folders. If a duplicate exists anyway, everything still lands in the same, original folder. Different clients don't wait for each other.
- **No shared filenames.** Filenames carry the time to the second, and one client folder holds all of that client's reports. Each release therefore claims its timestamp within its folder (`claimFileTime` in `pipeline/report-export.js`). A second report for the same client released in the same second takes the next free second, and all three of its files use it, so each set stays together and distinct. Release uploads also never overwrite a file of the same name.
- **Right report in Plextrac.** Plextrac data and artifact uploads are addressed by the release's own client and report ids. The fetched report must belong to that client, and every uploaded artifact is read back from the report's Artifacts tab.

These locks and claims are in-process. The service runs as a single process; if it is
ever scaled to several, they need to move to MongoDB.

### Many releases at once

A burst of releases queues rather than piling up. At most `PDF_RENDER_CONCURRENCY`
(default 4) PDF renders run at a time, because each WeasyPrint process uses 100 MB or
more.

`tests/release-stress.test.js` releases 100 reports at once, plus 5 webhooks delivered
twice, across 30 clients with 3-4 reports each. Each report has its own hosts, its own
test accounts and its own mix of finding severities. The test then reads every filed
document back and checks:

- every document holds one report's data, including its hosts and finding counts
- no letter lists test accounts
- every document is in that report's client folder
- each release's three files share a timestamp
- nothing was overwritten or duplicated
- every artifact is on the right report

It runs the real code, including a separate Python renderer process per release on
both real templates. Only Drive and Plextrac are simulated, with random latency so the
releases interleave as badly as possible.

A re-release makes a new set of files with a new timestamp. Nothing is overwritten.

## Setup (Ubuntu)

```
sudo apt install python3-venv libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0
npm install
npm run setup:renderer        # creates renderer/.venv with the pinned Jinja2 + WeasyPrint
```

Check the Plextrac service account can upload artifacts. Like the report export, this
may need a permission granted to its role:

```
node scripts/inspect-artifacts.js <clientId> <reportId> --test-upload
```

`npm test` includes `tests/renderer.test.js`, which renders both real templates. Its
PDF checks are reported as SKIPPED where WeasyPrint isn't installed.
