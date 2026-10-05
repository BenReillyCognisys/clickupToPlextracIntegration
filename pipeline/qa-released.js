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

// Who is @-mentioned on a release announcement: the publishers
// (config/report-status-permissions.js) other than the one who released it — Ben
// releases, Alice is tagged, and the other way round (lib/slack-people.js). The old
// fixed list and SLACK_RELEASED_QA_MENTIONS are no longer used.
const people = require('../lib/slack-people');

// Escapes the three characters special in Slack mrkdwn link text.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds the release announcement, matching the other QA announcements (client and
// report hyperlinked), bookended with a :white_check_mark::
//   :white_check_mark: Client: <client> - <report> released <@u1> <@u2>…. Release QA done by <name> :white_check_mark:
function buildReleaseMessage({ clientName, clientUrl, reportName, reportUrl, releaseQaName, mentions = [] }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  const pings = (mentions || []).map(id => `<@${id}>`).join(' ');
  const mentionPart = pings ? ` ${pings}` : '';
  return `:white_check_mark: Client: ${client} - ${report} released${mentionPart}. Release QA done by ${slackEscape(releaseQaName)} :white_check_mark:`;
}

// The actor who released the report (the user who moved it into the released status),
// as { name, email } via the cuid→user map. The name degrades to a cuid-based fallback
// and the email to null if they can't be resolved.
async function resolveReleaser(actorCuid) {
  if (!actorCuid) return { name: 'an unknown user', email: null };
  try {
    const user = (await users.cuidMap()).get(actorCuid);
    return { name: users.displayName(user, actorCuid), email: user?.email || null };
  } catch (err) {
    log.warn('Could not resolve release actor for release message', {
      reason: err.message, actor_cuid: actorCuid,
    });
    return { name: users.displayName(null, actorCuid), email: null };
  }
}

async function resolveReleaseQaName(actorCuid) {
  return (await resolveReleaser(actorCuid)).name;
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
  const releaser = await resolveReleaser(actorCuid);
  const releaseQaName = releaser.name;
  // Unknown releaser: every publisher is tagged.
  const [resolvedClientName, mentions] = await Promise.all([
    resolveClientName(clientId, clientName),
    people.publisherMentions({ except: releaser.email }),
  ]);
  const text = buildReleaseMessage({ clientName: resolvedClientName, clientUrl, reportName, reportUrl, releaseQaName, mentions });
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
