// Where a released report's documents are filed in Google Drive, and what they are
// called: the <NNN. Month YYYY>/<Client>/ folder, the "<name> <timestamp>.pdf"
// filenames and the per-folder timestamp claim that keeps two releases' files apart.
// pipeline/release-exports.js resolves the folder once per release and hands it to
// every upload; the documents themselves are made by pipeline/client-documents.
//
// Also the Slack notice helper the release uses for anything that needs a human.
// Success is silent in Slack — only the log records it — so the release thread
// carries nothing but the announcement and any problem.
//
// Configuration (see .env.example → "Released-report export"):
//   GOOGLE_DRIVE_REPORTS_FOLDER_ID      destination folder — REQUIRED, else nothing is
//                                       filed in Drive (Plextrac still gets the documents)
//   GOOGLE_DRIVE_REPORTS_MONTH_FOLDERS  file under <folder>/<NNN. Month YYYY>/ (default on)
//   GOOGLE_DRIVE_REPORTS_TZ             timezone for the month and filename timestamp (Europe/London)
//   GOOGLE_DRIVE_REPORTS_EPOCH_MONTH    month numbered 001 (YYYY-MM, default 2026-07)
//
// Drive auth reuses the existing service-account key (GOOGLE_SERVICE_ACCOUNT_KEY) and
// optional impersonation (GOOGLE_DRIVE_SUBJECT).

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

// Timestamps claimed per Drive folder: "<folderId>|<timestamp>".
//
// The filename carries the time to the second, and a client's folder holds every
// report for that client. Two of the client's reports released in the same second
// would otherwise get IDENTICAL filenames in the same folder — and then no one could
// tell which "Full-Pentest-Report-Tech-Details 2026-09-26 14-30-05.pdf" belongs to
// which report, or which executive summary goes with which full report.
//
// Held for two hours: longer than any release takes, and long enough to cover the
// clocks going back an hour in October, when the same wall-clock second happens twice.
const claimedStamps = new Set();
const CLAIM_MS = 2 * 60 * 60 * 1000;

/**
 * Claims a filename timestamp in `folderId` for one release and returns it as a Date:
 * `date` itself, or the next second no other release has claimed in that folder.
 * Every document of the release is named with the returned time, so the set stays
 * together and never shares a name with another release's set.
 *
 * Synchronous check-and-claim, so concurrent releases can't claim the same second
 * (in-process, like the other locks — the service runs as one process).
 */
function claimFileTime(folderId, date = new Date(), tz = REPORTS_TZ) {
  let t = date.getTime();
  while (claimedStamps.has(`${folderId}|${exportTimestamp(new Date(t), tz)}`)) t += 1000;
  const key = `${folderId}|${exportTimestamp(new Date(t), tz)}`;
  claimedStamps.add(key);
  setTimeout(() => claimedStamps.delete(key), CLAIM_MS).unref();
  return new Date(t);
}

// A PDF always starts "%PDF-". Checked before anything is filed, so an error page or
// a half-written file is never uploaded as a "PDF" nobody can open.
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

// The release folder as a readable path under the reports folder, for the logs:
// "003. September 2026/Acme Corp".
function releaseFolderPath({ clientName, exportedAt }) {
  const { sequencedSubfolder: month, subfolder } = releaseFolderSpec({ clientName, exportedAt });
  return [month && `${String(month.sequence).padStart(3, '0')}. ${month.label}`, subfolder].filter(Boolean).join('/');
}

// "245 KB" / "1.2 MB", for the logs.
function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Resolves — creating as needed — the Drive folder this release's documents belong in,
 * and returns its id. Resolved ONCE per release by pipeline/release-exports.js and
 * handed to every upload, so a release's documents cannot end up in different
 * folders. Throws on any Drive failure.
 */
async function resolveReleaseFolder({ clientName, exportedAt }) {
  if (!REPORTS_FOLDER_ID) throw new Error('GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set');
  return drive.resolveFolder(releaseFolderSpec({ clientName, exportedAt }));
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
  resolveReleaseFolder,
  releaseFolderSpec,
  releaseFolderPath,
  formatSize,
  claimFileTime,
  isConfigured,
  postToThread,
  monthLabel,
  monthFolder,
  documentFilename,
  exportTimestamp,
  clientFolderName,
  safeFilename,
  looksLikePdf,
};
