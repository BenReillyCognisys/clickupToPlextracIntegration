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
this service. Each one runs through four steps:

1. **Plextrac data.** The report, the client and the findings are fetched fresh for this release.
2. **Claude.** The document's prompt (`prompts/*.md`) is filled in with that data and sent to Claude, which returns the document's text.
3. **Template.** Claude's text and a reduced copy of the report go into the document's Jinja2 template (`jinja2-export-templates/*.j2`). Real Jinja2 and WeasyPrint render it to PDF, in Python (`renderer/render.py`).
4. **Publish.** The PDF goes into the release's Drive folder and onto the report's Artifacts tab. The Artifacts tab is read back afterwards to confirm the file is attached to this report.

Success is silent in Slack. Anything that fails is listed in the release
announcement's thread, saying what needs doing by hand.

## Editing a prompt

Prompts live in `prompts/`, one Markdown file per document. **The file is re-read on
every release**, so saving a change is enough, with no restart or deploy. Comments
(`<!-- ... -->`) are notes for whoever edits the prompt and are removed before sending.

Data from the report goes in through placeholders:

| Placeholder | Value |
|---|---|
| `{{client_name}}` | the client's name |
| `{{report_name}}` | the Plextrac report's name |
| `{{start_date}}`, `{{end_date}}` | testing dates, e.g. `1 September 2026` |
| `{{export_date}}` | the release date |
| `{{narrative:<Label>}}` | any narrative, e.g. `{{narrative:Executive Summary}}`, `{{narrative:Scope}}` |
| `{{field:<Label>}}` | any report custom field, e.g. `{{field:Author 1}}` |
| `{{finding_counts}}` | findings per severity |
| `{{findings}}` | `- [Severity] Title` per finding: titles only, never the write-ups |

Claude only ever receives what the prompt references. A placeholder that is misspelt,
or whose data is missing on the report, **stops that document** and says so in
Slack, rather than sending Claude a blank. An automatic client document built from a
half-empty prompt is worse than one made by hand.

What Claude must *return* is fixed in `config/client-documents.js` (`outputs`), and
the request enforces it as a strict JSON schema. The prompt doesn't need to describe
an output format, and editing the prompt can't break the pipeline's ability to place
the text. Claude's text is cut down to basic HTML (paragraphs, lists, bold/italic)
before it reaches the template.

### Trying a prompt on a real report

```
node scripts/preview-client-documents.js <clientId> <reportId> --prompt            # show the filled prompt; no Claude call
node scripts/preview-client-documents.js <clientId> <reportId> --doc exec-summary  # full run; writes preview/*.pdf
node scripts/preview-client-documents.js <clientId> <reportId> --no-ai             # template work: no Claude, no cost
```

A preview does exactly what a release does, except upload anything. It prints
Claude's output and token usage, and writes the PDF plus a `.json` of Claude's reply
to `preview/`.

## Adding or changing a document

Documents are listed in `config/client-documents.js`. Each entry names:

- its template
- its prompt
- its `outputs`: what Claude returns, available in the template as `{{ AI.<key> }}`
- optionally, `replaceNarratives`, which puts an output in place of a Plextrac narrative's text

The executive summary uses `replaceNarratives` so the unchanged template prints Claude's Executive Summary.

A document whose template file is missing is **skipped with a warning**. The Letter
of Attestation is configured this way until `cognisys-letter-of-attestation.j2`
arrives. To switch it on, drop the template in `jinja2-export-templates/`, then
adjust its prompt and `outputs` to match.

### What the templates receive

The templates get the variables Plextrac's own export gives them (`REPORT_INFO`,
`CLIENT_INFO`, `FINDINGS`, `FINDING_SUMMARY`), plus `AI`. These are **deliberately
reduced** (`pipeline/client-documents/data.js`):

- **`REPORT_INFO` and `CLIENT_INFO`:** only the allow-listed keys (`REPORT_KEYS`, `CLIENT_KEYS`).
- **`FINDINGS`:** always empty. `FINDING_SUMMARY` holds counts only.

Because this is done in code rather than left to the template, no template edit can
leak a finding write-up into a client document. That includes `DEBUG_CONTEXT`, which
dumps the whole context into the PDF. A template that needs another field must be
given it there, deliberately.

## How the wrong-folder and double-filing problems are prevented

- **Details captured once.** A release's details (client, report, export time) are captured once, frozen, and passed to every step.
- **One folder for everything.** The Drive folder is resolved once per release, before any upload, and the same folder id is handed to the full report and to every client document. No step looks the folder up for itself.
- **One run per report at a time.** Runs for the same report are serialised, so a webhook delivered twice, or a quick re-release, waits for the first run to finish. Different reports run side by side.
- **No duplicate folders.** Drive allows duplicate folder names, so folder creation is serialised per parent folder (`lib/google-drive.js`), and lookups take the oldest folder of a name. Two releases for one client can't create two client folders. If a duplicate exists anyway, everything still lands in the same, original folder.
- **Right report in Plextrac.** Plextrac data and artifact uploads are addressed by the release's own client and report ids. The fetched report must belong to that client, and every uploaded artifact is read back from the report's Artifacts tab.

These locks are in-process. The service runs as a single process; if it is ever
scaled to several, the locks need to move to MongoDB.

A re-release makes a new set of files with a new timestamp. Nothing is overwritten.

## Setup (Ubuntu)

```
sudo apt install python3-venv libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0
npm install
npm run setup:renderer        # creates renderer/.venv with the pinned Jinja2 + WeasyPrint
```

Then, in `.env` (see `.env.example` → "Client documents"):

- `EXEC_SUMMARY_EDIT_API_KEY`: the Claude API key for these documents. Without it the client documents are skipped and the full report is still filed.
- Optional: `EXEC_SUMMARY_EDIT_MODEL` (default `claude-opus-5`), `EXEC_SUMMARY_EDIT_EFFORT` (default `high`).

Check the Plextrac service account can upload artifacts. Like the report export, this
may need a permission granted to its role:

```
node scripts/inspect-artifacts.js <clientId> <reportId> --test-upload
```

`npm test` includes `tests/renderer.test.js`, which renders the real template. Its PDF
checks are reported as SKIPPED where WeasyPrint isn't installed.
