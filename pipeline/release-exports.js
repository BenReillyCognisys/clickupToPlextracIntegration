// Everything filed when a report is released, in one place:
//
//   Drive: <reports folder>/<NNN. Month YYYY>/<Client>/
//            Plextrac Full Report <timestamp>.pdf     (pipeline/report-export.js)
//            Executive Summary Report <timestamp>.pdf (pipeline/client-documents)
//            Letter of Attestation <timestamp>.pdf    (pipeline/client-documents)
//   Plextrac: the two client documents on the report's Artifacts tab
//
// Guarantees against filing into the wrong place:
//   * The release's details (client, report, export time) are captured once, frozen,
//     and passed to every step. Nothing is read from shared state mid-flight.
//   * The Drive folder is resolved ONCE, before anything is uploaded, and that one id
//     is handed to every upload. No step looks the folder up for itself.
//   * Runs for the same report are serialised (per-report lock): a webhook delivered
//     twice, or a quick re-release, waits for the first run to finish rather than
//     interleaving with it. Different reports still run side by side.
//   * Folder creation itself is serialised per parent folder (lib/google-drive), so
//     two releases for one client can't create two client folders.
//
// Speed: the full-report export (Plextrac renders the PDF) and the client documents
// (Claude, then the renderer) are independent, so they run in parallel.
//
// Best-effort, like the export before it: failures are logged and reported in the
// release announcement's Slack thread, and never thrown — the release has happened
// whatever we manage to file. Success is silent in Slack.

const reportExport = require('./report-export');
const clientDocuments = require('./client-documents');
const { withTaskLock } = require('../lib/task-lock');
const log = require('../lib/logger');

/**
 * @param {object} args
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @param {string} args.clientName   canonical client name (client folder, prompts)
 * @param {string} args.reportName
 * @param {string} [args.channel]    release announcement channel — problems go there
 * @param {string} [args.threadTs]   its thread anchor
 */
async function runReleaseExports({ clientId, reportId, clientName, reportName, channel, threadTs }) {
  return withTaskLock(`release-exports:${reportId}`, async () => {
    const job = Object.freeze({ clientId, reportId, clientName, reportName, exportedAt: new Date() });
    const problems = [];

    try {
      // 1. Where this release's files go — resolved once, used by every upload below.
      let folderId = null;
      if (reportExport.isConfigured()) {
        try {
          folderId = await reportExport.resolveReleaseFolder(job);
        } catch (err) {
          log.error('Could not resolve the release folder in Drive', { reason: err.message, report_id: reportId });
          problems.push(`Could not create the Drive folder, so nothing was filed in Drive: ${err.message}`);
        }
      } else {
        log.warn('Drive filing skipped — GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set', { report_id: reportId });
      }

      if (!clientDocuments.isEnabled()) {
        log.warn('Client documents skipped — EXEC_SUMMARY_EDIT_API_KEY is not set', { report_id: reportId });
      }

      // 2. The full report and the client documents, side by side. The full report
      //    posts its own failure notice.
      const [, documents] = await Promise.all([
        folderId && reportExport.exportReleasedReport({ ...job, channel, threadTs, folderId }),
        clientDocuments.isEnabled()
          ? clientDocuments.generateClientDocuments(job).catch((err) => {
            log.error('Client documents could not be generated', { reason: err.message, report_id: reportId });
            problems.push(`Client documents could not be generated: ${err.message}`);
            return [];
          })
          : [],
      ]);

      // 3. File each document that was made, into the SAME folder as the full report.
      await Promise.all(documents.map(async (document) => {
        if (!document.ok) {
          log.error('Client document failed', { document: document.doc.key, reason: document.error, report_id: reportId });
          problems.push(`${document.doc.name}: ${document.error}`);
          return;
        }
        const published = await clientDocuments.publishClientDocument({
          document, folderId, clientId: job.clientId, reportId: job.reportId,
        });
        for (const e of published.errors) problems.push(`${document.doc.name}: ${e}`);
      }));
    } catch (err) {
      // Anything unexpected — still reported, never thrown into the webhook.
      log.error('Release exports failed', { reason: err.message, report_id: reportId });
      problems.push(`Release exports failed: ${err.message}`);
    }

    if (problems.length) {
      await reportExport.postToThread(channel, threadTs,
        ':warning: Some release documents need doing by hand:\n'
        + problems.map((p) => `• ${p}`).join('\n'));
    }
  });
}

module.exports = { runReleaseExports };
