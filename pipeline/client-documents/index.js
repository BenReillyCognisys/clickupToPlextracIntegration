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
const { documentFilename, looksLikePdf } = require('../report-export');
const data = require('./data');
const DOCUMENTS = require('../../config/client-documents');
const log = require('../../lib/logger');

// Set to "false" to file the documents in Drive only.
const ARTIFACTS_ENABLED = process.env.CLIENT_DOCS_PLEXTRAC_ARTIFACTS !== 'false';

const PDF_MIME = 'application/pdf';
const TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

// The documents whose template is present. An entry can sit in the config before its
// template is written; it is skipped, with a warning, until the file appears.
function activeDocuments(documents = DOCUMENTS) {
  return documents.filter((doc) => {
    if (renderer.templateExists(doc.template)) return true;
    log.warn('Client document skipped — template not found', {
      document: doc.key, template: `jinja2-export-templates/${doc.template}`,
    });
    return false;
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
 * @returns {Promise<Array<{doc, ok: boolean, buffer?: Buffer, filename?: string,
 *   warnings?: string[], error?: string}>>} one entry per active document, in config
 *   order. Rejects only if the Plextrac data can't be loaded.
 */
async function generateClientDocuments({ clientId, reportId, exportedAt, documents, output = 'pdf' }) {
  const docs = activeDocuments(documents);
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
  activeDocuments,
  loadReportData,
  generateClientDocuments,
  publishClientDocument,
};
