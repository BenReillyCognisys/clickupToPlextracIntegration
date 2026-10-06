// Report-released announcement: made when a Plextrac report reaches the released
// status (default "Published"). Reaching it means the report has cleared release QA and
// gone out, so the report's "approved — ready for release" message is edited to credit
// whoever approved it and whoever released it (the actor who made this status change).
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

// The report's "approved — ready for release" message (pipeline/qa-approved.js), which
// the release edits rather than posting its own.
const approvedMessages = require('../lib/approved-message-store');

// Escapes the three characters special in Slack mrkdwn link text.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The tick either side of the release line, replacing the approved message's green
// circles, and the reaction added to the message on release. A name the workspace
// doesn't have (":white_tick:" isn't one) prints as plain text, so this is Slack's
// standard ✅.
const RELEASED_REACTION = 'white_check_mark';
const RELEASED_EMOJI = `:${RELEASED_REACTION}:`;

// Ticks the release message. Needs the bot's `reactions:write` scope; without it the
// release goes ahead and the log says what to add. Never throws.
async function addReleasedReaction(channel, ts, reportId) {
  try {
    await slack.addReaction(channel, ts, RELEASED_REACTION);
  } catch (err) {
    log.warn('Could not add the release tick reaction', {
      reason: err.message, report_id: reportId,
      ...(/missing_scope/.test(err.message) ? { fix: 'add the reactions:write scope to the Slack app and reinstall it' } : {}),
    });
  }
}

// Builds the release line, client and report hyperlinked as in the other QA announcements:
//   :white_check_mark: Client: <client> - <report> - Second QA by <approver> - Release by <releaser> :white_check_mark:
// It replaces the report's "approved — ready for release" message in place, so it
// pings no one. "Second QA by" is left out when the approver isn't known (a report
// approved before the approved message was recorded).
function buildReleaseMessage({ clientName, clientUrl, reportName, reportUrl, secondQaName, releaseQaName }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  const secondQa = secondQaName ? ` - Second QA by ${slackEscape(secondQaName)}` : '';
  return `${RELEASED_EMOJI} Client: ${client} - ${report}${secondQa} - Release by ${slackEscape(releaseQaName)} ${RELEASED_EMOJI}`;
}

// The report's approved message, or null if there isn't one on record (or the store
// can't be reached — the release then posts a new message rather than failing).
async function findApprovedMessage(reportId) {
  try {
    return await approvedMessages.get(reportId);
  } catch (err) {
    log.warn('Could not look up the Approved announcement — posting the release as a new message', {
      reason: err.message, report_id: reportId,
    });
    return null;
  }
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

// Announces the release by editing the report's "approved — ready for release" message
// into the release line; its thread then carries the release's notices and exports.
// With no approved message to edit (approved before they were recorded, or since
// deleted), the release line is posted as a new message instead. Best-effort — any
// failure is logged and swallowed so it never disrupts the rest of the webhook.
async function postReleaseAnnouncement({ clientId, clientName, clientUrl, reportName, reportUrl, actorCuid, reportId, report }) {
  const [releaser, resolvedClientName, approvedMessage] = await Promise.all([
    resolveReleaser(actorCuid),
    resolveClientName(clientId, clientName),
    findApprovedMessage(reportId),
  ]);
  const releaseQaName = releaser.name;
  const text = buildReleaseMessage({
    clientName: resolvedClientName, clientUrl, reportName, reportUrl,
    secondQaName: approvedMessage?.approverName, releaseQaName,
  });

  let channel = RELEASED_QA_CHANNEL;
  let threadTs = null;
  if (approvedMessage) {
    try {
      if (await slack.updateMessage(approvedMessage.channel, approvedMessage.ts, text)) {
        channel = approvedMessage.channel;
        threadTs = approvedMessage.ts;
        log.info('Release announcement: Approved message edited', { report_id: reportId, release_qa: releaseQaName });
      }
    } catch (err) {
      log.error('Failed to edit the Approved message — posting the release as a new message', {
        reason: err.message, report_id: reportId,
      });
    }
  }
  if (!threadTs) {
    try {
      threadTs = await slack.postMessage(channel, text);
      log.info('Release announcement posted', { report_id: reportId, release_qa: releaseQaName });
    } catch (err) {
      log.error('Failed to post release announcement to Slack', { reason: err.message, report_id: reportId });
    }
  }
  if (threadTs) await addReleasedReaction(channel, threadTs, reportId);

  // Same empty-custom-field check the earlier rounds run, reported in this
  // announcement's thread and @-ing whoever released the report. The release wording
  // is deliberately louder: this one went out with the holes still in it.
  // Best-effort and self-logging — it never throws.
  await postEmptyFieldsNotice({
    report, channel, threadTs, actorCuid, reportId, round: 'released',
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
    channel,
    threadTs,
  });
}

module.exports = { postReleaseAnnouncement, buildReleaseMessage, resolveReleaseQaName, resolveClientName };
