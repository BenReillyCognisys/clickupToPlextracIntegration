// Released-report export: when a Plextrac report is published, render it to PDF and
// file that PDF in Google Drive.
//
// Runs from pipeline/qa-released.js (which the Plextrac webhook calls on the released
// status), so releasing a report is the only trigger — there is no separate schedule.
//
// Best-effort by design: every failure is logged, reported in the Slack thread, and
// swallowed. A report is released whether or not we managed to file a copy, and the
// PDF can always be re-exported by flipping the status again. A SUCCESSFUL export is
// silent in Slack — only the log records it — so the release thread carries nothing
// but the announcement and any problem that needs a human.
//
// Configuration (see .env.example → "Released-report export"):
//   GOOGLE_DRIVE_REPORTS_FOLDER_ID      destination folder — REQUIRED, else skipped
//   GOOGLE_DRIVE_REPORTS_MONTH_FOLDERS  file under <folder>/<NNN. Month YYYY>/ (default on)
//   GOOGLE_DRIVE_REPORTS_TZ             timezone for the month and filename timestamp (Europe/London)
//   GOOGLE_DRIVE_REPORTS_EPOCH_MONTH    month numbered 001 (YYYY-MM, default 2026-07)
//   PLEXTRAC_EXPORT_FORMAT              export format (default pdf)
//   PLEXTRAC_EXPORT_PATH                export endpoint override (lib/plextrac-api)
//
// Layout: <folder>/<NNN. Month YYYY>/<Client>/Plextrac Full Report <timestamp>.pdf
// Drive auth reuses the existing service-account key (GOOGLE_SERVICE_ACCOUNT_KEY) and
// optional impersonation (GOOGLE_DRIVE_SUBJECT).

const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const slack = require('../lib/slack');
const log = require('../lib/logger');

// Destination folder in Drive. Unset, the export is skipped entirely (with a warning)
// rather than guessing where a client report should be filed.
const REPORTS_FOLDER_ID = process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID || null;

// File each report under a month folder of that folder — "002. August 2026" — so Drive
// lists the months in order rather than alphabetically. Set to "false" to put every
// PDF straight in the one folder.
const MONTH_FOLDERS = process.env.GOOGLE_DRIVE_REPORTS_MONTH_FOLDERS !== 'false';

// The month that is numbered 001, as YYYY-MM. Every other month's number is counted
// forward from here — August 2026 is 002 because it is one month after July 2026, and
// December 2050 is 294 because it is 293 months after it.
//
// This is why the number is anchored to a fixed month rather than to a count of the
// folders in Drive: months can be deleted (an 18-month retention sweep, an archive
// tidy-up, the whole folder emptied) and every remaining and future folder keeps the
// number it always had. A count would slide backwards the moment anything was removed.
//
// Changing this after reports have been filed renumbers every FUTURE folder; existing
// ones are matched by month name, so they are left alone rather than duplicated.
const EPOCH_MONTH = process.env.GOOGLE_DRIVE_REPORTS_EPOCH_MONTH || '2026-07';

// Which month a given export time falls in is a wall-clock question: an export at
// 00:30 BST on the 1st belongs to the new month, not to the previous one UTC still
// says it is. Matches the timezone convention used by the rest of the schedulers.
const REPORTS_TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

const EXPORT_FORMAT = (process.env.PLEXTRAC_EXPORT_FORMAT || 'pdf').trim().toLowerCase();

const MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// The month a Drive folder is labelled with, e.g. "August 2026", read off `date` in
// REPORTS_TZ.
function monthLabel(date = new Date(), tz = REPORTS_TZ) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long', year: 'numeric' }).format(date);
}

// { year, month } for `date` as seen in `tz` (month 1-12). Intl is the timezone
// authority here rather than getMonth(), which would answer in the server's zone.
function yearMonthIn(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit' })
    .formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month') };
}

// EPOCH_MONTH parsed once. A malformed value would otherwise silently produce NaN
// folder numbers, so it falls back to the documented default and says so.
const EPOCH = (() => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(EPOCH_MONTH).trim());
  const month = match && Number(match[2]);
  if (!match || month < 1 || month > 12) {
    log.warn('GOOGLE_DRIVE_REPORTS_EPOCH_MONTH is not YYYY-MM — falling back to 2026-07', {
      value: EPOCH_MONTH,
    });
    return { year: 2026, month: 7 };
  }
  return { year: Number(match[1]), month };
})();

/**
 * The month folder for `date`: { label, sequence }, e.g. { label: 'August 2026',
 * sequence: 2 } → "002. August 2026".
 *
 * `sequence` counts months forward from EPOCH_MONTH, so it depends only on WHICH
 * month this is. Nothing about the state of Drive enters into it: deleting old
 * folders, or every folder, leaves the numbering of everything else untouched, and a
 * month refiled years later still gets the number it had originally.
 *
 * A date before EPOCH_MONTH counts backwards (0, -1, ...) rather than being clamped
 * onto 001 and colliding with the epoch's own folder — it means the epoch is set
 * later than the earliest report being filed, which the number makes obvious.
 */
function monthFolder(date = new Date(), tz = REPORTS_TZ) {
  const { year, month } = yearMonthIn(date, tz);
  return {
    label: monthLabel(date, tz),
    sequence: (year - EPOCH.year) * 12 + (month - EPOCH.month) + 1,
  };
}

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

// The client folder the report is filed in, under the month folder.
function clientFolderName(clientName) {
  return safeFilename(clientName, 'Unknown client');
}

// "2026-09-26 14-30-05" — the export time as wall-clock time in `tz`. Hyphens rather
// than colons, which Windows/macOS reject in a filename once the PDF is downloaded.
function exportTimestamp(date = new Date(), tz = REPORTS_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const v = (type) => parts.find((part) => part.type === type)?.value;
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}-${v('minute')}-${v('second')}`;
}

// "<name> <timestamp>.<ext>". The client is carried by the folder, and the timestamp
// makes every export its own file: a re-release adds a new copy next to the old one
// rather than overwriting it. Every document filed for one release shares the one
// timestamp, so they read as a set.
function documentFilename(name, { date = new Date(), tz = REPORTS_TZ, format = 'pdf' } = {}) {
  return `${safeFilename(name, 'Document')} ${exportTimestamp(date, tz)}.${format}`;
}

// "Plextrac Full Report <timestamp>.<ext>".
function reportFilename({ date = new Date(), tz = REPORTS_TZ, format = EXPORT_FORMAT } = {}) {
  return documentFilename('Plextrac Full Report', { date, tz, format });
}

// A PDF always starts "%PDF-". Plextrac can answer a 200 with a JSON job/error body,
// which would otherwise be filed in Drive as a "PDF" nobody can open.
function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > 4
    && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

// True when there is somewhere in Drive to file released reports.
function isConfigured() {
  return Boolean(REPORTS_FOLDER_ID);
}

// The folder levels a release files into: <folder>/<NNN. Month YYYY>/<Client>/.
function releaseFolderSpec({ clientName, exportedAt }) {
  return {
    folderId: REPORTS_FOLDER_ID,
    sequencedSubfolder: MONTH_FOLDERS ? monthFolder(exportedAt) : undefined,
    subfolder: clientFolderName(clientName),
  };
}

/**
 * Resolves — creating as needed — the Drive folder this release's documents belong in,
 * and returns its id. Resolved ONCE per release by pipeline/release-exports.js and
 * handed to every upload, so the full report and the client documents cannot end up
 * in different folders. Throws on any Drive failure.
 */
async function resolveReleaseFolder({ clientName, exportedAt }) {
  if (!REPORTS_FOLDER_ID) throw new Error('GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set');
  return drive.resolveFolder(releaseFolderSpec({ clientName, exportedAt }));
}

/**
 * Exports a released report and files it in Drive.
 *
 * @param {object} args
 * @param {number|string} args.clientId
 * @param {number|string} args.reportId
 * @param {string} args.clientName   canonical client name (names the client folder)
 * @param {string} args.reportName   logged only — the filename is a timestamp
 * @param {string} [args.channel]    Slack channel of the release announcement
 * @param {string} [args.threadTs]   its thread anchor — failures are replied there
 * @param {Date}   [args.exportedAt] the release's export time (default now) — month
 *                                   folder and filename timestamp
 * @param {string} [args.folderId]   an already-resolved destination folder
 *                                   (resolveReleaseFolder). Without it the month and
 *                                   client folders are resolved here.
 * @returns {Promise<object|null>} the upload result, or null when skipped/failed
 */
async function exportReleasedReport({
  clientId, reportId, clientName, reportName, channel, threadTs, exportedAt = new Date(), folderId,
}) {
  if (!REPORTS_FOLDER_ID) {
    log.warn('Released-report export skipped — GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set', {
      report_id: reportId,
    });
    return null;
  }

  // "Based on export time" — one instant for both the month folder and the filename
  // timestamp, so a report released just after midnight on the 1st lands in the new
  // month and its name agrees.
  const filename = reportFilename({ date: exportedAt });

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

    const spec = releaseFolderSpec({ clientName, exportedAt });
    const month = spec.sequencedSubfolder;

    const result = await drive.uploadFile({
      buffer,
      filename,
      mimeType: MIME_TYPES[EXPORT_FORMAT] || 'application/octet-stream',
      ...(folderId ? { folderId } : spec),
    });

    log.info('Released report exported to Drive', {
      report_id: reportId,
      report_name: reportName,
      file: result.name,
      file_id: result.fileId,
      month: month ? `${String(month.sequence).padStart(3, '0')}. ${month.label}` : null,
      client_folder: clientFolderName(clientName),
      folder_id: result.folderId,
      replaced: result.replaced,
      bytes: buffer.length,
    });

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

// Replies in the announcement's thread, or posts standalone if the announcement
// didn't make it. Only failures come through here. Never throws — the export itself is
// the point, not the notice.
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
  resolveReleaseFolder,
  releaseFolderSpec,
  isConfigured,
  postToThread,
  monthLabel,
  monthFolder,
  reportFilename,
  documentFilename,
  exportTimestamp,
  clientFolderName,
  safeFilename,
  looksLikePdf,
};
