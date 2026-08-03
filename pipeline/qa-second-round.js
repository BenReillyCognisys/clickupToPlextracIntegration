// Second-round QA announcement: posted when a Plextrac report moves out of first-round
// QA into the second-round status (default "In Review"). Reaching that status means the
// first round of QA is complete, so we ping the second-round QA reviewers and credit
// whoever did the first round (the actor who made this status change).
//
// Unlike the first-round pipeline (pipeline/qa-review), this does NO AI review and never
// touches the Plextrac report — it is a single Slack notification. `buildSecondRoundMessage`
// is a pure function so it can be unit-tested without Slack or the Plextrac API.

const slack = require('../lib/slack');
const users = require('../lib/plextrac-users');
const api = require('../lib/plextrac-api');
const fields = require('./qa-review/report-fields');
const log = require('../lib/logger');

// #pt-second-round-qa channel id (override via env).
const SECOND_ROUND_QA_CHANNEL = process.env.SLACK_SECOND_ROUND_QA_CHANNEL || 'C09GDNG20JF';

// Slack user ids @-mentioned on a second-round announcement (the second-round QA
// reviewers). Override with SLACK_SECOND_ROUND_QA_MENTIONS (comma/space-separated ids);
// falls back to the built-in list when unset.
const DEFAULT_SECOND_ROUND_MENTIONS = ['U0811891NTU', 'U07R28NJ0KS', 'U07LSK8F8DN', 'U07PYU23RN3'];
const CONFIGURED_MENTIONS = (process.env.SLACK_SECOND_ROUND_QA_MENTIONS || '')
  .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
const SECOND_ROUND_MENTIONS = CONFIGURED_MENTIONS.length ? CONFIGURED_MENTIONS : DEFAULT_SECOND_ROUND_MENTIONS;

// Escapes the three characters special in Slack mrkdwn link text.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds the second-round QA announcement, matching the first-round style (client and
// report hyperlinked):
//   Client: <client> - <report> ready for second round of QA <@u1> <@u2>…. First QA done by <name>
function buildSecondRoundMessage({ clientName, clientUrl, reportName, reportUrl, firstQaName, mentions = SECOND_ROUND_MENTIONS }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  const pings = (mentions || []).map(id => `<@${id}>`).join(' ');
  const mentionPart = pings ? ` ${pings}` : '';
  return `Client: ${client} - ${report} ready for second round of QA${mentionPart}. First QA done by ${slackEscape(firstQaName)}`;
}

// Resolves the actor who completed the first round of QA (the user who moved the report
// into the second-round status) to a display name via the cuid→user map, degrading to a
// cuid-based fallback if resolution fails.
async function resolveFirstQaName(actorCuid) {
  if (!actorCuid) return 'an unknown user';
  try {
    const map = await users.cuidMap();
    return users.displayName(map.get(actorCuid), actorCuid);
  } catch (err) {
    log.warn('Could not resolve first-QA actor for second-round message', {
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
    log.warn('Could not fetch client record for second-round message — using fallback name', {
      reason: err.message, client_id: clientId,
    });
    return fallback;
  }
}

// Posts the second-round QA announcement to #pt-second-round-qa. Best-effort — any
// failure is logged and swallowed so it never disrupts the rest of the webhook.
async function postSecondRoundQa({ clientId, clientName, clientUrl, reportName, reportUrl, actorCuid, reportId }) {
  const firstQaName = await resolveFirstQaName(actorCuid);
  const resolvedClientName = await resolveClientName(clientId, clientName);
  const text = buildSecondRoundMessage({ clientName: resolvedClientName, clientUrl, reportName, reportUrl, firstQaName });
  try {
    await slack.postMessage(SECOND_ROUND_QA_CHANNEL, text);
    log.info('Second-round QA message posted', { report_id: reportId, first_qa: firstQaName });
  } catch (err) {
    log.error('Failed to post second-round QA message to Slack', { reason: err.message, report_id: reportId });
  }
}

module.exports = { postSecondRoundQa, buildSecondRoundMessage, resolveFirstQaName };
