// Client-facing documents for a released report — the executive summary and the letter
// of attestation (config/client-documents.js).
//
// For each document:
//   1. Plextrac data   report, client and findings, fetched fresh for THIS release
//   2. Claude          the document's prompt (prompts/), placeholders filled from (1)
//   3. Template        Claude's output (cleaned to basic HTML) + a reduced copy of the
//                      report → the document's Jinja2 template → PDF (lib/pdf-renderer)
//   4. Publish         into the release's Drive folder and onto the report's Artifacts
//                      tab in Plextrac (publishClientDocument)
//
// Documents are independent: one failing (Claude refusing, a template error) never
// stops the other. The Claude calls run in parallel, and all documents render in a
// single renderer run.
//
// Nothing here decides WHERE a document goes: the Drive folder is resolved once per
// release by pipeline/release-exports.js and passed in, and the Plextrac relations are
// built from the same clientId/reportId the data was fetched with.

const api = require('../../lib/plextrac-api');
const ai = require('../../lib/client-doc-ai');
const renderer = require('../../lib/pdf-renderer');
const drive = require('../../lib/google-drive');
const prompts = require('../../lib/prompt-template');
const { documentFilename, looksLikePdf } = require('../report-export');
const data = require('./data');
const DOCUMENTS = require('../../config/client-documents');
const log = require('../../lib/logger');

// Set to "false" to file the documents in Drive only.
const ARTIFACTS_ENABLED = process.env.CLIENT_DOCS_PLEXTRAC_ARTIFACTS !== 'false';

const PDF_MIME = 'application/pdf';
const TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

function isEnabled() {
  return ai.isConfigured();
}

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

// The document's prompt with its placeholders filled for this report.
function buildPrompt(doc, facts) {
  return prompts.fillPrompt(prompts.loadPrompt(doc.prompt), data.promptResolvers(facts));
}

/**
 * Claude's draft for one document, and the template context built around it.
 *
 * With useAi false (previews) Claude is not called: outputs are marked as not
 * generated and narratives keep their Plextrac text, so the template can be checked
 * for free.
 */
async function draftDocument(doc, facts, { useAi = true } = {}) {
  if (!useAi) {
    const values = Object.fromEntries(Object.keys(doc.outputs)
      .map((k) => [k, `<p>[${k} - not generated: preview run without Claude]</p>`]));
    return { doc, values, meta: null, context: data.templateContext({ ...facts, ai: values }) };
  }

  const prompt = buildPrompt(doc, facts);
  const result = await ai.generate({ prompt, outputs: doc.outputs });
  const values = Object.fromEntries(Object.entries(result.values).map(([k, v]) => [k, data.cleanHtml(v)]));

  log.info('Client document drafted by Claude', {
    document: doc.key, model: result.model,
    input_tokens: result.usage?.input_tokens, output_tokens: result.usage?.output_tokens,
  });

  return {
    doc,
    values,
    meta: { model: result.model, usage: result.usage },
    context: data.templateContext({ ...facts, ai: values, replaceNarratives: doc.replaceNarratives }),
  };
}

/**
 * Builds every active document for one release.
 *
 * @param {object} args
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @param {string} args.clientName
 * @param {Date}   args.exportedAt          the release's export time (cover date, filename)
 * @param {Array}  [args.documents]         defaults to config/client-documents.js
 * @param {boolean} [args.useAi=true]
 * @param {'pdf'|'html'} [args.output='pdf']
 * @returns {Promise<Array<{doc, ok: boolean, buffer?: Buffer, filename?: string,
 *   values?: object, warnings?: string[], error?: string}>>} one entry per active
 *   document, in config order. Rejects only if the Plextrac data can't be loaded.
 */
async function generateClientDocuments({
  clientId, reportId, clientName, exportedAt, documents, useAi = true, output = 'pdf',
}) {
  const docs = activeDocuments(documents);
  if (!docs.length) return [];

  const facts = { ...(await loadReportData({ clientId, reportId })), clientName, exportedAt };

  const drafts = await Promise.allSettled(docs.map((doc) => draftDocument(doc, facts, { useAi })));
  const results = new Map();
  const ready = [];
  drafts.forEach((d, i) => {
    if (d.status === 'fulfilled') ready.push(d.value);
    else results.set(docs[i].key, { doc: docs[i], ok: false, error: `Drafting failed: ${d.reason.message}` });
  });

  if (ready.length) {
    let rendered;
    try {
      rendered = await renderer.renderTemplates(ready.map((d) => ({
        id: d.doc.key, template: d.doc.template, context: d.context, output,
      })));
    } catch (err) {
      rendered = new Map(ready.map((d) => [d.doc.key, { ok: false, error: err.message }]));
    }

    for (const d of ready) {
      const r = rendered.get(d.doc.key) || { ok: false, error: 'renderer returned no result' };
      if (r.ok && output === 'pdf' && !looksLikePdf(r.buffer)) {
        r.ok = false;
        r.error = 'renderer output is not a PDF';
      }
      if (r.warnings?.length) {
        log.warn('Client document rendered with warnings', { document: d.doc.key, warnings: r.warnings });
      }
      results.set(d.doc.key, r.ok
        ? {
          doc: d.doc, ok: true, buffer: r.buffer, warnings: r.warnings, values: d.values, meta: d.meta,
          filename: documentFilename(d.doc.name, { date: exportedAt, tz: TZ, format: output }),
        }
        : { doc: d.doc, ok: false, error: `Rendering failed: ${r.error}` });
    }
  }

  return docs.map((doc) => results.get(doc.key));
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
    }).then((r) => { out.driveFile = r; }, (err) => { out.errors.push(`Drive upload failed: ${err.message}`); }),

    ARTIFACTS_ENABLED && uploadArtifactVerified({ clientId, reportId, document })
      .then((id) => { out.artifactId = id; }, (err) => { out.errors.push(`Plextrac artifact upload failed: ${err.message}`); }),
  ]);

  log.info('Client document published', {
    document: document.doc.key, file: document.filename, report_id: reportId,
    drive_file_id: out.driveFile?.fileId || null, drive_folder_id: out.driveFile?.folderId || null,
    artifact_id: out.artifactId, errors: out.errors.length,
  });
  return out;
}

module.exports = {
  isEnabled,
  activeDocuments,
  loadReportData,
  buildPrompt,
  draftDocument,
  generateClientDocuments,
  publishClientDocument,
};
