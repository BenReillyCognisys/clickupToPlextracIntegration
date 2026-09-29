// Client-facing documents for a released report — the executive summary and the letter
// of attestation (config/client-documents.js).
//
// For each document:
//   1. Plextrac data   report, client and findings, fetched fresh for THIS release
//   2. Template        a reduced copy of that data (./data) → the document's Jinja2
//                      template, which fills itself from it → PDF (lib/pdf-renderer)
//   3. Publish         into the release's Drive folder and onto the report's Artifacts
//                      tab in Plextrac (publishClientDocument)
//
// Documents are independent: one failing (a template error) never stops the other.
// All documents of a release render in a single renderer run.
//
// Nothing here decides WHERE a document goes: the Drive folder is resolved once per
// release by pipeline/release-exports.js and passed in, and the Plextrac relations are
// built from the same clientId/reportId the data was fetched with.

const api = require('../../lib/plextrac-api');
const renderer = require('../../lib/pdf-renderer');
const drive = require('../../lib/google-drive');
const reportExport = require('../report-export');
const { documentFilename, looksLikePdf } = reportExport;
const data = require('./data');
const DOCUMENTS = require('../../config/client-documents');
const log = require('../../lib/logger');

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

/**
 * Builds every active document for one release.
 *
 * @param {object} args
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @param {Date}   args.exportedAt          the release's export time (issue date, filename)
 * @param {Array}  [args.documents]         defaults to config/client-documents.js
 * @param {'pdf'|'html'} [args.output='pdf']
 * @param {boolean} [args.respectSwitches=true]  false = make switched-off documents too (previews)
 * @returns {Promise<Array<{doc, ok: boolean, buffer?: Buffer, filename?: string,
 *   warnings?: string[], error?: string}>>} one entry per active document, in config
 *   order. Rejects only if the Plextrac data can't be loaded. With every document
 *   switched off, returns [] without contacting Plextrac.
 */
async function generateClientDocuments({
  clientId, reportId, exportedAt, documents, output = 'pdf', respectSwitches = true,
}) {
  const docs = activeDocuments(documents, { reportId, respectSwitches });
  if (!docs.length) return [];

  const context = data.templateContext({ ...(await loadReportData({ clientId, reportId })), exportedAt });

  let rendered;
  try {
    rendered = await renderer.renderTemplates(docs.map((doc) => ({
      id: doc.key, template: doc.template, context, output,
    })));
  } catch (err) {
    rendered = new Map(docs.map((doc) => [doc.key, { ok: false, error: err.message }]));
  }

  return docs.map((doc) => {
    const r = rendered.get(doc.key) || { ok: false, error: 'renderer returned no result' };
    if (r.ok && output === 'pdf' && !looksLikePdf(r.buffer)) {
      r.ok = false;
      r.error = 'renderer output is not a PDF';
    }
    if (r.warnings?.length) {
      log.warn('Client document rendered with warnings', { document: doc.key, warnings: r.warnings });
    }
    return r.ok
      ? {
        doc, ok: true, buffer: r.buffer, warnings: r.warnings,
        filename: documentFilename(doc.name, { date: exportedAt, tz: TZ, format: output }),
      }
      : { doc, ok: false, error: `Rendering failed: ${r.error}` };
  });
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

    ARTIFACTS_ENABLED && reportExport.uploadArtifactVerified({
      clientId, reportId, buffer: document.buffer, filename: document.filename, contentType: PDF_MIME,
      description: `${document.doc.name} - generated automatically on release`,
    })
      .then((id) => { out.artifactId = id; }, (err) => { out.errors.push(`Plextrac artifact upload failed: ${err.message}`); }),
  ]);

  // The outcome is logged by the caller (pipeline/release-exports), in the release's trail.
  return out;
}

module.exports = {
  isEnabled,
  activeDocuments,
  loadReportData,
  generateClientDocuments,
  publishClientDocument,
};
