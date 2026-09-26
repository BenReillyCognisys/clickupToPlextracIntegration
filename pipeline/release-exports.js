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
//   * Its filename timestamp is claimed within the client folder, so two of a client's
//     reports released in the same second get distinct names, and uploads never
//     overwrite a same-named file.
//   * The Drive folder is resolved ONCE, before anything is uploaded, and that one id
//     is handed to every upload. No step looks the folder up for itself.
//   * Runs for the same report are serialised (per-report lock): a webhook delivered
//     twice, or a quick re-release, waits for the first run to finish rather than
//     interleaving with it. Different reports still run side by side.
//   * Folder creation itself is serialised per parent folder (lib/google-drive), so
//     two releases for one client can't create two client folders.
//
// Speed: the full-report export (Plextrac renders the PDF) and the client documents
// (rendered here) are independent, so they run in parallel.
//
// Best-effort, like the export before it: failures are logged and reported in the
// release announcement's Slack thread, and never thrown — the release has happened
// whatever we manage to file. Success is silent in Slack.
//
// Console (PM2) trail — every line starts "Release export" and carries report_id, so
// one release can be followed even when several run at once:
//   Release export STARTED                        client, report, ids, Plextrac link
//   Release export: Drive folder ready            "003. September 2026/Acme Corp"
//   Release export: exporting full report from Plextrac
//   Release export: full report exported from Plextrac    size, time taken
//   Release export: full report uploaded to Drive          file, folder, Drive link
//   Release export: <document> rendered                    size
//   Release export: <document> uploaded to Drive           file, folder, Drive link
//   Release export: <document> uploaded to Plextrac        client, report, Plextrac link
//   Release export FINISHED                       time taken, files filed, problems
// Failures are ERROR lines in the same format ("... FAILED"), and a run with problems
// finishes with a WARN "FINISHED WITH PROBLEMS" line.

const reportExport = require('./report-export');
const clientDocuments = require('./client-documents');
const { withTaskLock } = require('../lib/task-lock');
const log = require('../lib/logger');

const PLEXTRAC_BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
const plextracReportUrl = (clientId, reportId) => `${PLEXTRAC_BASE}/client/${clientId}/report/${reportId}`;

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
    const startedAt = new Date();
    const problems = [];
    const filed = { drive: 0, plextrac: 0 };
    // Which Plextrac report this is, on the lines that name where things went.
    const project = {
      client: clientName, report: reportName, client_id: clientId, report_id: reportId,
      plextrac: plextracReportUrl(clientId, reportId),
    };

    log.info('Release export STARTED', project);

    try {
      // 1. Where this release's files go — resolved once, used by every upload below.
      let folderId = null;
      if (reportExport.isConfigured()) {
        try {
          folderId = await reportExport.resolveReleaseFolder({ clientName, exportedAt: startedAt });
          log.info('Release export: Drive folder ready', {
            report_id: reportId, folder: reportExport.releaseFolderPath({ clientName, exportedAt: startedAt }), folder_id: folderId,
          });
        } catch (err) {
          log.error('Release export: Drive folder FAILED — nothing will be filed in Drive', { report_id: reportId, reason: err.message });
          problems.push(`Could not create the Drive folder, so nothing was filed in Drive: ${err.message}`);
        }
      } else {
        log.warn('Release export: Drive filing skipped — GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set', { report_id: reportId });
      }

      // The release's details, frozen. exportedAt is the time every file is named
      // with — claimed in the folder, so another of this client's reports released in
      // the same second can't produce the same filenames (report-export.claimFileTime).
      const job = Object.freeze({
        clientId, reportId, clientName, reportName,
        exportedAt: folderId ? reportExport.claimFileTime(folderId, startedAt) : startedAt,
      });

      // 2. The full report and the client documents, side by side. The full report
      //    posts its own failure notice and logs its own steps.
      const [fullReport, documents] = await Promise.all([
        folderId && reportExport.exportReleasedReport({ ...job, channel, threadTs, folderId }),
        clientDocuments.generateClientDocuments(job).catch((err) => {
          log.error('Release export: client documents FAILED', { report_id: reportId, reason: err.message });
          problems.push(`Client documents could not be generated: ${err.message}`);
          return [];
        }),
      ]);
      if (fullReport) filed.drive++;

      // 3. File each document that was made, into the SAME folder as the full report.
      const folder = reportExport.releaseFolderPath({ clientName, exportedAt: startedAt });
      await Promise.all(documents.map(async (document) => {
        const name = document.doc.name;
        if (!document.ok) {
          log.error(`Release export: ${name} FAILED`, { report_id: reportId, reason: document.error });
          problems.push(`${name}: ${document.error}`);
          return;
        }
        log.info(`Release export: ${name} rendered`, { report_id: reportId, size: reportExport.formatSize(document.buffer.length) });

        const published = await clientDocuments.publishClientDocument({
          document, folderId, clientId: job.clientId, reportId: job.reportId,
        });
        if (published.driveFile) {
          filed.drive++;
          log.info(`Release export: ${name} uploaded to Drive`, {
            report_id: reportId, file: published.driveFile.name, folder, drive: published.driveFile.url,
          });
        }
        if (published.artifactId) {
          filed.plextrac++;
          log.info(`Release export: ${name} uploaded to Plextrac`, {
            ...project, file: document.filename, artifact_id: published.artifactId,
          });
        }
        for (const e of published.errors) {
          log.error(`Release export: ${name} upload FAILED`, { report_id: reportId, reason: e });
          problems.push(`${name}: ${e}`);
        }
      }));
    } catch (err) {
      // Anything unexpected — still reported, never thrown into the webhook.
      log.error('Release export: FAILED unexpectedly', { report_id: reportId, reason: err.message });
      problems.push(`Release exports failed: ${err.message}`);
    }

    const summary = {
      report_id: reportId, client: clientName, report: reportName,
      took: `${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`,
      drive_files: filed.drive, plextrac_artifacts: filed.plextrac,
    };
    if (problems.length) {
      log.warn('Release export FINISHED WITH PROBLEMS', { ...summary, problems: problems.length });
    } else {
      log.info('Release export FINISHED', summary);
    }

    if (problems.length) {
      await reportExport.postToThread(channel, threadTs,
        ':warning: Some release documents need doing by hand:\n'
        + problems.map((p) => `• ${p}`).join('\n'));
    }
  });
}

module.exports = { runReleaseExports };
