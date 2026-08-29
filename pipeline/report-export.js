// Released-report export: when a Plextrac report is published, render it to PDF and
// file that PDF in Google Drive, then link it in the release announcement's thread.
//
// Runs from pipeline/qa-released.js (which the Plextrac webhook calls on the released
// status), so releasing a report is the only trigger — there is no separate schedule.
//
// Best-effort by design: every failure is logged, reported in the Slack thread, and
// swallowed. A report is released whether or not we managed to file a copy, and the
// PDF can always be re-exported by flipping the status again.
//
// Configuration (see .env.example → "Released-report export"):
//   GOOGLE_DRIVE_REPORTS_FOLDER_ID            destination folder — REQUIRED, else skipped
//   GOOGLE_DRIVE_REPORTS_SUBFOLDER_BY_CLIENT  file under <folder>/<client>/ (default on)
//   PLEXTRAC_EXPORT_FORMAT                    export format (default pdf)
//   PLEXTRAC_EXPORT_PATH                      export endpoint override (lib/plextrac-api)
// Drive auth reuses the existing service-account key (GOOGLE_SERVICE_ACCOUNT_KEY) and
// optional impersonation (GOOGLE_DRIVE_SUBJECT).

const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const slack = require('../lib/slack');
const log = require('../lib/logger');

// Destination folder in Drive. Unset, the export is skipped entirely (with a warning)
// rather than guessing where a client report should be filed.
const REPORTS_FOLDER_ID = process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID || null;

// File each report under a per-client subfolder of that folder, created on first use.
// Set to "false" to put every PDF straight in the one folder.
const SUBFOLDER_BY_CLIENT = process.env.GOOGLE_DRIVE_REPORTS_SUBFOLDER_BY_CLIENT !== 'false';

const EXPORT_FORMAT = (process.env.PLEXTRAC_EXPORT_FORMAT || 'pdf').trim().toLowerCase();

const MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Characters Drive/Windows/macOS all cope badly with in a filename, plus control
// characters. Collapses whitespace and caps the length so a long report title can't
// produce an unusable name.
function safeFilename(name, fallback = 'report') {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  return (cleaned || fallback).slice(0, 120).trim();
}

// "<client> - <report>.<ext>", falling back to the report id when a name is missing.
// Deterministic: re-releasing the same report produces the same name, so the Drive
// copy is replaced in place instead of duplicated.
function reportFilename({ clientName, reportName, reportId, format = EXPORT_FORMAT }) {
  const client = safeFilename(clientName, 'Unknown client');
  const report = safeFilename(reportName, `Report ${reportId}`);
  return `${client} - ${report}.${format}`;
}

// A PDF always starts "%PDF-". Plextrac can answer a 200 with a JSON job/error body,
// which would otherwise be filed in Drive as a "PDF" nobody can open.
function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > 4
    && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Exports a released report and files it in Drive.
 *
 * @param {object} args
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @param {string} args.clientName   canonical client name (used for the filename/subfolder)
 * @param {string} args.reportName
 * @param {string} [args.channel]    Slack channel of the release announcement
 * @param {string} [args.threadTs]   its thread anchor — the Drive link is replied there
 * @returns {Promise<object|null>} the upload result, or null when skipped/failed
 */
async function exportReleasedReport({ clientId, reportId, clientName, reportName, channel, threadTs }) {
  if (!REPORTS_FOLDER_ID) {
    log.warn('Released-report export skipped — GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set', {
      report_id: reportId,
    });
    return null;
  }

  const filename = reportFilename({ clientName, reportName, reportId });

  try {
    const { buffer, contentType } = await api.exportReport(clientId, reportId, EXPORT_FORMAT);

    if (EXPORT_FORMAT === 'pdf' && !looksLikePdf(buffer)) {
      // Almost always a JSON job/error body returned with a 200 — surface what came
      // back so the endpoint can be corrected via PLEXTRAC_EXPORT_PATH.
      const excerpt = buffer.subarray(0, 300).toString('utf8').replace(/\s+/g, ' ').trim();
      throw new Error(
        `Plextrac export did not return a PDF (content-type "${contentType}"): ${excerpt} `
        + '— confirm the endpoint with scripts/inspect-export.js and set PLEXTRAC_EXPORT_PATH',
      );
    }

    const result = await drive.uploadFile({
      buffer,
      filename,
      mimeType: MIME_TYPES[EXPORT_FORMAT] || 'application/octet-stream',
      folderId: REPORTS_FOLDER_ID,
      subfolder: SUBFOLDER_BY_CLIENT ? safeFilename(clientName, 'Unknown client') : undefined,
    });

    log.info('Released report exported to Drive', {
      report_id: reportId,
      file: result.name,
      file_id: result.fileId,
      replaced: result.replaced,
      bytes: buffer.length,
    });

    await postToThread(channel, threadTs, buildExportMessage(result));
    return result;
  } catch (err) {
    log.error('Failed to export released report to Drive', {
      reason: err.message, report_id: reportId, client_id: clientId, file: filename,
    });
    await postToThread(
      channel, threadTs,
      `:warning: Could not file the ${EXPORT_FORMAT.toUpperCase()} for this report in Drive — `
      + `it needs saving manually. Reason: ${err.message}`,
    );
    return null;
  }
}

// The Slack line announcing the filed copy. Pure, so it can be unit-tested.
function buildExportMessage({ name, url, replaced }) {
  const verb = replaced ? 'updated in' : 'saved to';
  return `:page_facing_up: Report ${verb} Drive: <${url}|${name}>`;
}

// Replies in the announcement's thread, or posts standalone if the announcement
// didn't make it. Never throws — the export itself is the point, not the notice.
async function postToThread(channel, threadTs, text) {
  if (!channel) return;
  try {
    if (threadTs) await slack.postReply(channel, threadTs, text);
    else await slack.postMessage(channel, text);
  } catch (err) {
    log.error('Failed to post report-export notice to Slack', { reason: err.message });
  }
}

module.exports = {
  exportReleasedReport,
  reportFilename,
  safeFilename,
  looksLikePdf,
  buildExportMessage,
};
