// Report-released announcement: posted when a Plextrac report reaches the released
// status (default "Published"). Reaching it means the report has cleared release QA and
// gone out, so we ping the release reviewers and credit whoever released it (the actor
// who made this status change).
//
// Like the second-round announcement (pipeline/qa-second-round), this does NO AI review
// and never touches the Plextrac report — it is a single Slack notification.
// `buildReleaseMessage` is a pure function so it can be unit-tested without Slack or the
// Plextrac API.

const slack = require('../lib/slack');
const users = require('../lib/plextrac-users');
const log = require('../lib/logger');

// Channel for the release announcement (shares #pt-second-round-qa by default; override).
const RELEASED_QA_CHANNEL = process.env.SLACK_RELEASED_QA_CHANNEL || 'C09GDNG20JFC';

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

// Posts the release announcement to the release channel. Best-effort — any failure is
// logged and swallowed so it never disrupts the rest of the webhook.
async function postReleaseAnnouncement({ clientName, clientUrl, reportName, reportUrl, actorCuid, reportId }) {
  const releaseQaName = await resolveReleaseQaName(actorCuid);
  const text = buildReleaseMessage({ clientName, clientUrl, reportName, reportUrl, releaseQaName });
  try {
    await slack.postMessage(RELEASED_QA_CHANNEL, text);
    log.info('Release announcement posted', { report_id: reportId, release_qa: releaseQaName });
  } catch (err) {
    log.error('Failed to post release announcement to Slack', { reason: err.message, report_id: reportId });
  }
}

module.exports = { postReleaseAnnouncement, buildReleaseMessage, resolveReleaseQaName };
