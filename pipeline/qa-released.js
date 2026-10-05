// Report-released announcement: posted when a Plextrac report reaches the released
// status (default "Published"). Reaching it means the report has cleared release QA and
// gone out, so we ping the release reviewers and credit whoever released it (the actor
// who made this status change).
//
// Like the second-round announcement (pipeline/qa-second-round), this does NO AI review
// and never touches the Plextrac report — it is a single Slack notification, plus the
// deterministic empty-custom-field check and the PDF export in its thread.
// `buildReleaseMessage` is a pure function so it can be unit-tested without Slack or the
// Plextrac API.
//
// Releasing is also what triggers the report being exported to PDF and filed in Google
// Drive and on its Plextrac Artifacts tab, along with the client documents
// (pipeline/release-exports.js) — a released report is the version worth keeping.

const slack = require('../lib/slack');
const users = require('../lib/plextrac-users');
const api = require('../lib/plextrac-api');
const fields = require('./qa-review/report-fields');
const { postEmptyFieldsNotice } = require('./qa-review/empty-fields');
const { runReleaseExports } = require('./release-exports');
const log = require('../lib/logger');

// The ready-for-release channel, shared with the Approved announcement
// (pipeline/qa-approved.js) and the status guard's notices (pipeline/status-guard.js).
// SLACK_READY_FOR_RELEASE_CHANNEL; the old SLACK_RELEASED_QA_CHANNEL is no longer read.
const { READY_FOR_RELEASE_CHANNEL } = require('./status-guard');

const RELEASED_QA_CHANNEL = READY_FOR_RELEASE_CHANNEL();

// Slack user ids @-mentioned on a release announcement. Override with
// SLACK_RELEASED_QA_MENTIONS (comma/space-separated ids); falls back to the built-in list.
const DEFAULT_RELEASED_MENTIONS = ['U09CF6MLUF3', 'U06NJCD93RT', 'U06V88B1MEK'];
const CONFIGURED_MENTIONS = (process.env.SLACK_RELEASED_QA_MENTIONS || '')
  .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
const RELEASED_MENTIONS = CONFIGURED_MENTIONS.length ? CONFIGURED_MENTIONS : DEFAULT_RELEASED_MENTIONS;

// Escapes the three characters special in Slack mrkdwn link text.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds the release announcement, matching the other QA announcements (client and
// report hyperlinked), bookended with a :white_check_mark::
//   :white_check_mark: Client: <client> - <report> released <@u1> <@u2>…. Release QA done by <name> :white_check_mark:
function buildReleaseMessage({ clientName, clientUrl, reportName, reportUrl, releaseQaName, mentions = RELEASED_MENTIONS }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  const pings = (mentions || []).map(id => `<@${id}>`).join(' ');
  const mentionPart = pings ? ` ${pings}` : '';
  return `:white_check_mark: Client: ${client} - ${report} released${mentionPart}. Release QA done by ${slackEscape(releaseQaName)} :white_check_mark:`;
}

// Resolves the actor who released the report (the user who moved it into the released
// status) to a display name via the cuid→user map, degrading to a cuid-based fallback if
// resolution fails.
async function resolveReleaseQaName(actorCuid) {
  if (!actorCuid) return 'an unknown user';
  try {
    const map = await users.cuidMap();
    return users.displayName(map.get(actorCuid), actorCuid);
  } catch (err) {
    log.warn('Could not resolve release actor for release message', {
      reason: err.message, actor_cuid: actorCuid,
    });
    return users.displayName(null, actorCuid);
  }
}

// Resolves the canonical client name from the Plextrac client record, degrading to the
// mapping-derived fallback if the fetch fails. The webhook mapping's client_name can be
// missing (e.g. pre-integration reports), so — like the first-round pipeline — we fetch
// the real name rather than trust the fallback alone (which rendered "Client: undefined").
async function resolveClientName(clientId, fallback) {
  if (!clientId) return fallback;
  try {
    const clientRecord = await api.getClient(clientId);
    return fields.clientNameFromRecord(clientRecord, fallback);
  } catch (err) {
    log.warn('Could not fetch client record for release message — using fallback name', {
      reason: err.message, client_id: clientId,
    });
    return fallback;
  }
}

// Posts the release announcement to the release channel. Best-effort — any failure is
// logged and swallowed so it never disrupts the rest of the webhook.
async function postReleaseAnnouncement({ clientId, clientName, clientUrl, reportName, reportUrl, actorCuid, reportId, report }) {
  const releaseQaName = await resolveReleaseQaName(actorCuid);
  const resolvedClientName = await resolveClientName(clientId, clientName);
  const text = buildReleaseMessage({ clientName: resolvedClientName, clientUrl, reportName, reportUrl, releaseQaName });
  let threadTs = null;
  try {
    threadTs = await slack.postMessage(RELEASED_QA_CHANNEL, text);
    log.info('Release announcement posted', { report_id: reportId, release_qa: releaseQaName });
  } catch (err) {
    log.error('Failed to post release announcement to Slack', { reason: err.message, report_id: reportId });
  }

  // Same empty-custom-field check the earlier rounds run, reported in this
  // announcement's thread and @-ing whoever released the report. The release wording
  // is deliberately louder: this one went out with the holes still in it.
  // Best-effort and self-logging — it never throws.
  await postEmptyFieldsNotice({
    report, channel: RELEASED_QA_CHANNEL, threadTs, actorCuid, reportId, round: 'released',
  });

  // File the release: the full report PDF in Google Drive, plus the client documents
  // (executive summary, letter of attestation) in the same Drive folder and on the
  // report's Plextrac Artifacts tab. Problems are replied in this announcement's
  // thread. Best-effort and self-logging — it never throws.
  await runReleaseExports({
    clientId,
    reportId,
    clientName: resolvedClientName,
    reportName,
    channel: RELEASED_QA_CHANNEL,
    threadTs,
  });
}

module.exports = { postReleaseAnnouncement, buildReleaseMessage, resolveReleaseQaName, resolveClientName };
