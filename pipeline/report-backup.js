// Backs one Plextrac report up into a Drive folder: everything needed to restore it
// and read it without Plextrac. Shared by the client merge (pipeline/client-merge.js)
// and the weekly backup of the whole tenant (pipeline/plextrac-backup.js).
//
//   <folder>/
//     <Report>.ptrac                                   restorable copy (Import Report)
//     Full-Pentest-Report-Tech-Details <timestamp>.pdf  the three client documents,
//     Executive Summary Report <timestamp>.pdf          from our own templates
//     Letter of Attestation <timestamp>.pdf             (config/client-documents.js)
//     Artifacts/<file>                                  the report's Artifacts tab
//
// Every file is checked against the MD5 Drive reports for what it stored. The three
// parts are attempted independently, so one failing still leaves the others filed;
// `ok` is true only when every part of the report was filed.
//
// Only reads from Plextrac.

const crypto = require('crypto');
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const clientDocuments = require('./client-documents');
const DOCUMENTS = require('../config/client-documents');
const { safeFilename } = require('./report-export');

const PDF_MIME = 'application/pdf';
const PTRAC_MIME = 'application/octet-stream';
const JSON_MIME = 'application/json';

const md5 = (buffer) => crypto.createHash('md5').update(buffer).digest('hex');

// Uploads one file and proves Drive holds exactly these bytes.
async function uploadVerified({ buffer, filename, mimeType, folderId, overwrite = false }) {
  const local = md5(buffer);
  const up = await drive.uploadFile({ buffer, filename, mimeType, folderId, overwrite });
  if (!up.md5Checksum || up.md5Checksum !== local) {
    throw new Error(`Drive copy of "${filename}" does not match (MD5 ${up.md5Checksum || 'missing'} vs ${local})`);
  }
  return { name: up.name, file_id: up.fileId, url: up.url, md5: local, size: buffer.length };
}

const folderUnder = (parentId, name) => drive.resolveFolder({ folderId: parentId, subfolder: name });

const clientFolderName = (client) => `${safeFilename(client.name, 'Client')} (${client.id})`;
const reportFolderName = (report) => `${safeFilename(report.name, 'Report')} (${report.id})`;

/**
 * What a .ptrac says about its report, for change tracking: the details worth naming
 * in a change log, and a hash of the content (minus the export's own timestamp), so an
 * edit anywhere — a narrative, a screenshot, an asset — shows as a change.
 */
function describePtrac(ptrac) {
  const info = ptrac.report_info || {};
  const { GeneratedOn, GeneratedBy, ...summary } = ptrac.summary || {};
  const { source_tenant, baseURL, ...reportInfo } = info;
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    reportInfo, flaws: ptrac.flaws_array, summary, evidence: ptrac.evidence, procedures: ptrac.procedures,
  })).digest('hex');
  return {
    cuid: info.cuid ?? null,
    name: info.name ?? null,
    status: info.status ?? null,
    hash,
    findings: (ptrac.flaws_array || []).map((f) => ({
      id: f.flaw_id ?? f.id ?? null,
      title: f.title ?? null,
      severity: f.severity ?? null,
      status: f.status ?? null,
      last_update: f.last_update ?? null,
    })),
    media: Object.keys(summary.ReportMedia || {}).length,
  };
}

/**
 * Backs a report up into a new subfolder of `parentFolderId`.
 *
 * @param {object} args
 * @param {number} args.clientId
 * @param {{id: number, name: string}} args.report
 * @param {string} args.parentFolderId  the client's folder
 * @param {Date}   args.exportedAt      names the PDFs
 * @returns {Promise<{ok, folder_id, folder_url, files, warnings, errors, error, bytes,
 *   report: object|null, artifacts: number}>}  never rejects
 */
async function backupReport({ clientId, report, parentFolderId, exportedAt }) {
  const out = { ok: false, folder_id: null, folder_url: null, files: [], warnings: [], errors: [], error: null, bytes: 0, report: null, artifacts: 0 };
  const file = (entry) => { out.files.push(entry); out.bytes += entry.size; };
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      out.errors.push(`${what}: ${err.message}`);
    }
  };

  await attempt('folder', async () => {
    out.folder_id = await folderUnder(parentFolderId, reportFolderName(report));
    out.folder_url = drive.driveFolderUrl(out.folder_id);
  });
  if (!out.folder_id) {
    out.error = out.errors.join('; ');
    return out;
  }
  const folderId = out.folder_id;

  // 1. The .ptrac — the restorable copy.
  await attempt('.ptrac', async () => {
    const { buffer, ptrac } = await api.exportReportPtrac(clientId, report.id);
    out.report = describePtrac(ptrac);
    file({ kind: 'ptrac', ...await uploadVerified({
      buffer, filename: `${safeFilename(report.name, 'Report')}.ptrac`, mimeType: PTRAC_MIME, folderId,
    }) });
  });

  // 2. The three client documents. Each one is its own success or failure.
  await attempt('documents', async () => {
    const documents = await clientDocuments.generateClientDocuments({
      clientId, reportId: report.id, exportedAt, respectSwitches: false,
    });
    for (const doc of DOCUMENTS) {
      const made = documents.find((d) => d.doc.key === doc.key);
      if (!made) { out.errors.push(`${doc.name}: not generated (template missing?)`); continue; }
      if (!made.ok) { out.errors.push(`${doc.name}: ${made.error}`); continue; }
      out.warnings.push(...(made.notices || []).map((n) => `${doc.name}: ${n}`));
      await attempt(doc.name, async () => {
        file({ kind: 'document', document: doc.key, ...await uploadVerified({
          buffer: made.buffer, filename: made.filename, mimeType: PDF_MIME, folderId,
        }) });
      });
    }
  });

  // 3. The Artifacts tab — not in the .ptrac, so copied file by file.
  await attempt('artifacts', async () => {
    const artifacts = await api.listReportArtifacts(clientId, report.id);
    out.artifacts = artifacts.length;
    if (!artifacts.length) return;
    const artifactsFolder = await folderUnder(folderId, 'Artifacts');
    for (const a of artifacts) {
      await attempt(`artifact "${a.filename}"`, async () => {
        const { buffer } = await api.downloadArtifact(a.id);
        if (a.size != null && Number(a.size) !== buffer.length) {
          throw new Error(`downloaded ${buffer.length} bytes, Plextrac lists ${a.size}`);
        }
        const contentType = a.content_type || 'application/octet-stream';
        file({
          kind: 'artifact', artifact_id: a.id, filename: a.filename, content_type: contentType, description: a.description ?? null,
          ...await uploadVerified({ buffer, filename: safeFilename(a.filename, 'artifact'), mimeType: contentType, folderId: artifactsFolder }),
        });
      });
    }
  });

  out.ok = out.errors.length === 0;
  out.error = out.errors.length ? out.errors.join('; ') : null;
  return out;
}

// The client record (and its report list) as client.json in the client's folder.
// `overwrite` replaces an existing client.json (a resumed weekly run) instead of adding
// a second one.
async function backupClientRecord({ record, reports, folderId, at, overwrite = false }) {
  const buffer = Buffer.from(JSON.stringify({
    client: record,
    reports: reports.map(({ id, name, status }) => ({ report_id: id, name, status })),
    backed_up_at: at,
  }, null, 2));
  return uploadVerified({ buffer, filename: 'client.json', mimeType: JSON_MIME, folderId, overwrite });
}

module.exports = {
  backupReport,
  backupClientRecord,
  uploadVerified,
  folderUnder,
  clientFolderName,
  reportFolderName,
  describePtrac,
  md5,
  JSON_MIME,
};
