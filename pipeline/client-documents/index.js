// Client-facing documents for a released report — the full report, the executive
// summary and the letter of attestation (config/client-documents.js).
//
// For each document:
//   1. Plextrac data   report, client and findings, fetched fresh for THIS release;
//                      for a document with `findings: 'full'` (the full report) also
//                      every finding's full record, with its screenshots fetched from
//                      Plextrac and inlined (./images)
//   2. Template        a reduced copy of that data (./data) → the document's Jinja2
//                      template, which fills itself from it → PDF (lib/pdf-renderer)
//   3. Publish         into the release's Drive folder and onto the report's Artifacts
//                      tab in Plextrac (publishClientDocument)
//
// Documents are independent: one failing (a template error) never stops the other,
// and none waits for another. Each renders in its own renderer process as soon as its
// data is ready — the summary documents straight after step 1, while the full report's
// findings and screenshots are still arriving — so the documents of a release render
// on separate cores, and each can be published the moment it's made
// (startClientDocuments).
//
// Nothing here decides WHERE a document goes: the Drive folder is resolved once per
// release by pipeline/release-exports.js and passed in, and the Plextrac relations are
// built from the same clientId/reportId the data was fetched with.

const api = require('../../lib/plextrac-api');
const renderer = require('../../lib/pdf-renderer');
const drive = require('../../lib/google-drive');
const { documentFilename, looksLikePdf } = require('../report-export');
const data = require('./data');
const images = require('./images');
const { limiter } = require('../../lib/concurrency');
const DOCUMENTS = require('../../config/client-documents');
const log = require('../../lib/logger');

// Full finding records fetched from Plextrac at once, per release.
const FINDING_FETCH_CONCURRENCY = 4;

// Set to "false" to file the documents in Drive only.
const ARTIFACTS_ENABLED = process.env.CLIENT_DOCS_PLEXTRAC_ARTIFACTS !== 'false';

const PDF_MIME = 'application/pdf';
const TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

// Is this document switched on in .env (its `enabledBy` variable)? On unless the
// variable says false / 0 / off / no — so an unset variable leaves it on. Read on
// every release: .env changes take effect when PM2 restarts the app.
function isEnabled(doc) {
  const value = doc.enabledBy ? process.env[doc.enabledBy] : undefined;
  return !(value && OFF_VALUES.has(value.trim().toLowerCase()));
}

// The documents to make: switched on, and with their template present. An entry can
// sit in the config before its template is written; it is skipped, with a warning,
// until the file appears. `respectSwitches: false` (previews) ignores the switches.
function activeDocuments(documents = DOCUMENTS, { reportId, respectSwitches = true } = {}) {
  return documents.filter((doc) => {
    if (respectSwitches && !isEnabled(doc)) {
      log.info(`Release export: ${doc.name} skipped — switched off`, {
        report_id: reportId, switch: `${doc.enabledBy}=${process.env[doc.enabledBy]}`,
      });
      return false;
    }
    if (!renderer.templateExists(doc.template)) {
      log.warn(`Release export: ${doc.name} skipped — template not found`, {
        report_id: reportId, template: `jinja2-export-templates/${doc.template}`,
      });
      return false;
    }
    return true;
  });
}

/**
 * Fetches everything the documents are built from. Every request is addressed by the
 * release's clientId AND reportId, and the report is checked to belong to that client,
 * so a document can only ever be built from the report that was released.
 */
async function loadReportData({ clientId, reportId }) {
  const [report, clientRecord, rawFindings] = await Promise.all([
    api.getReport(clientId, reportId),
    api.getClient(clientId),
    api.listReportFindings(clientId, reportId),
  ]);
  if (!report || typeof report !== 'object') throw new Error(`Plextrac returned no report ${reportId}`);
  if (report.client_id != null && String(report.client_id) !== String(clientId)) {
    throw new Error(`report ${reportId} belongs to client ${report.client_id}, not ${clientId}`);
  }
  return { report, clientRecord, findings: data.normaliseFindings(rawFindings) };
}

// WeasyPrint logs one ".notdef glyph rendered ... (U+0008)" warning per character no
// font can draw, which for a pasted binary blob is thousands of lines. They become one
// line, counted by character; every other warning is kept, once each — except
// aspect-ratio, which Plextrac's editor puts on every pasted image and WeasyPrint
// doesn't support. Harmless (images keep their own proportions), so not logged at all.
// ./images drops it from finding screenshots; this catches any elsewhere (narratives).
const NOTDEF = /^\.notdef glyph rendered .*\((U\+[0-9A-F]+)\)$/;
const IGNORED = /^Ignored `aspect-ratio\s*:[^`]*` at \d+:\d+, unknown property\.$/;

function summariseWarnings(warnings = []) {
  const missing = new Map();
  const other = new Set();
  for (const w of warnings) {
    if (IGNORED.test(w)) continue;
    const m = NOTDEF.exec(w);
    if (m) missing.set(m[1], (missing.get(m[1]) || 0) + 1);
    else other.add(w);
  }
  if (!missing.size) return [...other];
  const total = [...missing.values()].reduce((a, b) => a + b, 0);
  const top = [...missing].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([cp, n]) => `${cp} x${n}`);
  const more = missing.size > 8 ? `, and ${missing.size - 8} more` : '';
  return [`${total} characters no font can draw were printed as boxes: ${top.join(', ')}${more}`, ...other];
}

// How much of each finding a document is given: 'full' or 'summary' (see ./data).
const detailOf = (doc) => (doc.findings === 'full' ? 'full' : 'summary');

/**
 * The full record of every finding, for the full report. Each is fetched
 * by the release's clientId AND reportId, and must say it belongs to that report.
 * Throws if any one can't be fetched: a full report missing a finding must not be
 * filed as if it were complete.
 *
 * `then` (optional) is applied to each finding as soon as it arrives, while the others
 * are still being fetched — the full report uses it to start on its screenshots.
 */
async function loadFullFindings({ clientId, reportId, findings, then = (full) => full }) {
  const slots = limiter(FINDING_FETCH_CONCURRENCY);
  return Promise.all(findings.map(async (listed) => then(await slots(async () => {
    if (listed.flaw_id == null) throw new Error(`finding "${listed.title}" has no id in Plextrac's list`);
    const full = await api.getFinding(clientId, reportId, listed.flaw_id);
    if (!full || typeof full !== 'object') throw new Error(`Plextrac returned no finding ${listed.flaw_id}`);
    if (full.report_id != null && String(full.report_id) !== String(reportId)) {
      throw new Error(`finding ${listed.flaw_id} belongs to report ${full.report_id}, not ${reportId}`);
    }
    return full;
  }))));
}

/**
 * The full report's template context: every finding in full, screenshots
 * inlined. `missing` lists the screenshots that could not be printed. Each finding's
 * screenshots are fetched as soon as that finding is, not after all of them.
 */
async function fullReportContext({ clientId, reportId, loaded, exportedAt }) {
  const fetcher = images.screenshotFetcher();
  const shots = await loadFullFindings({
    clientId, reportId, findings: loaded.findings,
    then: (full) => images.inlineScreenshots([data.reduceFullFinding(full)], { fetcher }),
  });
  return {
    context: data.templateContext({ ...loaded, findings: shots.flatMap((s) => s.findings), exportedAt, detail: 'full' }),
    screenshots: {
      inlined: shots.reduce((n, s) => n + s.inlined, 0),
      missing: shots.flatMap((s) => s.missing),
    },
  };
}

// Renders one document in its own renderer process, once its data is ready. Never
// rejects: any failure is the document's { ok: false, error }.
async function makeDocument({ doc, data: ready, reportId, exportedAt, output }) {
  let source;
  try {
    source = await ready;
  } catch (err) {
    return { doc, ok: false, error: `the findings could not be loaded from Plextrac: ${err.message}` };
  }

  let r;
  try {
    const rendered = await renderer.renderTemplates([{
      id: doc.key, template: doc.template, context: source.context, output,
      ...(doc.pdfOptions ? { pdf_options: doc.pdfOptions } : {}),
    }]);
    r = rendered.get(doc.key) || { ok: false, error: 'renderer returned no result' };
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  if (r.ok && output === 'pdf' && !looksLikePdf(r.buffer)) {
    r.ok = false;
    r.error = 'renderer output is not a PDF';
  }
  if (r.warnings?.length) r.warnings = summariseWarnings(r.warnings);
  if (r.warnings?.length) {
    log.warn('Client document rendered with warnings', { document: doc.key, report_id: reportId, warnings: r.warnings });
  }
  if (!r.ok) return { doc, ok: false, error: `Rendering failed: ${r.error}` };
  const made = {
    doc, ok: true, buffer: r.buffer, warnings: r.warnings,
    filename: documentFilename(doc.filename || doc.name, { date: exportedAt, tz: TZ, format: output }),
  };
  if (source.screenshots) {
    made.screenshots = { inlined: source.screenshots.inlined, missing: source.screenshots.missing.length };
    made.notices = source.screenshots.missing.map((m) => `a screenshot in "${m.title}" is missing from the PDF (${m.reason})`);
  }
  return made;
}

/**
 * Starts every active document for one release, each on its own: a document renders
 * as soon as its own data is ready, in its own renderer process (lib/pdf-renderer caps
 * how many run at once), so the summary documents don't wait for the full report's
 * findings and screenshots, and none waits for another to render.
 *
 * @param {object} args
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @param {Date}   args.exportedAt          the release's export time (issue date, filename)
 * @param {Array}  [args.documents]         defaults to config/client-documents.js
 * @param {'pdf'|'html'} [args.output='pdf']
 * @param {boolean} [args.respectSwitches=true]  false = make switched-off documents too (previews)
 * @returns {Promise<Array<Promise<{doc, ok: boolean, buffer?: Buffer, filename?: string,
 *   warnings?: string[], notices?: string[], screenshots?: object, error?: string}>>>}
 *   one promise per active document, in config order, each settling when that document
 *   is made (or has failed) — it never rejects. `notices` are things a person should
 *   check in a document that was made (a screenshot that couldn't be printed).
 *   Rejects only if the report itself can't be loaded; the full findings failing
 *   fails only the documents that need them. With every document switched off,
 *   resolves to [] without contacting Plextrac.
 */
async function startClientDocuments({
  clientId, reportId, exportedAt, documents, output = 'pdf', respectSwitches = true,
}) {
  const docs = activeDocuments(documents, { reportId, respectSwitches });
  if (!docs.length) return [];

  const loaded = await loadReportData({ clientId, reportId });
  const sources = { summary: Promise.resolve({ context: data.templateContext({ ...loaded, exportedAt }) }) };
  // The full findings only when a document needs them — they are one Plextrac call per
  // finding plus every screenshot.
  if (docs.some((doc) => detailOf(doc) === 'full')) {
    sources.full = fullReportContext({ clientId, reportId, loaded, exportedAt });
  }

  return docs.map((doc) => makeDocument({ doc, data: sources[detailOf(doc)], reportId, exportedAt, output }));
}

/**
 * Builds every active document for one release (see startClientDocuments), resolving
 * once all of them are made: one entry per active document, in config order.
 */
async function generateClientDocuments(args) {
  return Promise.all(await startClientDocuments(args));
}

// Uploads to the report's Artifacts tab, then reads the tab back to confirm the file
// really is attached to THIS report before calling it done.
async function uploadArtifactVerified({ clientId, reportId, document }) {
  const description = `${document.doc.name} - generated automatically on release`;
  const id = await api.uploadReportArtifact(clientId, reportId, {
    buffer: document.buffer, filename: document.filename, contentType: PDF_MIME, description,
  });
  const listed = await api.listReportArtifacts(clientId, reportId);
  if (!listed.some((a) => String(a.id) === String(id))) {
    throw new Error(`uploaded (artifact ${id}) but it does not list on report ${reportId} - check the Artifacts tab`);
  }
  return id;
}

/**
 * Files one generated document in Drive and on the report's Artifacts tab. The two
 * uploads run side by side and fail independently.
 *
 * @param {object} args
 * @param {object} args.document          an ok entry from generateClientDocuments
 * @param {string|null} args.folderId     the release's resolved Drive folder; null skips Drive
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @returns {Promise<{driveFile: object|null, artifactId: string|null, errors: string[]}>}
 */
async function publishClientDocument({ document, folderId, clientId, reportId }) {
  const out = { driveFile: null, artifactId: null, errors: [] };

  await Promise.all([
    folderId && drive.uploadFile({
      buffer: document.buffer, filename: document.filename, mimeType: PDF_MIME, folderId,
      overwrite: false, // a same-named file can only be another release's
    }).then((r) => { out.driveFile = r; }, (err) => { out.errors.push(`Drive upload failed: ${err.message}`); }),

    ARTIFACTS_ENABLED && uploadArtifactVerified({ clientId, reportId, document })
      .then((id) => { out.artifactId = id; }, (err) => { out.errors.push(`Plextrac artifact upload failed: ${err.message}`); }),
  ]);

  // The outcome is logged by the caller (pipeline/release-exports), in the release's trail.
  return out;
}

module.exports = {
  isEnabled,
  activeDocuments,
  loadReportData,
  loadFullFindings,
  startClientDocuments,
  generateClientDocuments,
  summariseWarnings,
  publishClientDocument,
};
