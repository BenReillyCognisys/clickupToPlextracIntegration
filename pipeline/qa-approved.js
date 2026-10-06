// Approved announcement: posted to the ready-for-release channel when a Plextrac report
// reaches Approved — the third round of QA is done and the report is waiting to be
// published. @-mentions the people who can publish it and credits whoever approved it.
//
// Only an approver can get a report here: pipeline/status-guard.js puts back anyone
// else's change before this runs (config/report-status-permissions.js).
//
// Like the release announcement, it also runs the empty-custom-field check in its
// thread. Nothing is exported until the report is Published (pipeline/qa-released.js).
//
// The message is remembered per report (lib/approved-message-store.js) so that, on
// release, it is edited into the release line rather than a second message posted.

const slack = require('../lib/slack');
const approvedMessages = require('../lib/approved-message-store');
const people = require('../lib/slack-people');
const { postEmptyFieldsNotice } = require('./qa-review/empty-fields');
const { resolveReleaseQaName, resolveClientName } = require('./qa-released');
const { READY_FOR_RELEASE_CHANNEL } = require('./status-guard');
const log = require('../lib/logger');

function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Slack ids to @-mention: SLACK_APPROVED_MENTIONS (comma/space-separated ids), else
// every publisher, found in Slack by email (lib/slack-people.js). Someone Slack can't
// find is left out rather than failing the post.
async function approvedMentions() {
  const configured = (process.env.SLACK_APPROVED_MENTIONS || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return configured.length ? configured : people.publisherMentions();
}

//   :large_green_circle: Client: <client> - <report> approved — ready for release <@a> <@b>. Approved by <name> :large_green_circle:
function buildApprovedMessage({ clientName, clientUrl, reportName, reportUrl, approverName, mentions = [] }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  const pings = mentions.map((id) => `<@${id}>`).join(' ');
  return `:large_green_circle: Client: ${client} - ${report} approved — ready for release${pings ? ` ${pings}` : ''}. `
    + `Approved by ${slackEscape(approverName)} :large_green_circle:`;
}

// Best-effort — any failure is logged and swallowed so it never disrupts the webhook.
async function postApprovedAnnouncement({ clientId, clientName, clientUrl, reportName, reportUrl, actorCuid, reportId, report }) {
  const channel = READY_FOR_RELEASE_CHANNEL();
  const [approverName, resolvedClientName, mentions] = await Promise.all([
    resolveReleaseQaName(actorCuid),
    resolveClientName(clientId, clientName),
    approvedMentions(),
  ]);
  const text = buildApprovedMessage({ clientName: resolvedClientName, clientUrl, reportName, reportUrl, approverName, mentions });
  let threadTs = null;
  try {
    threadTs = await slack.postMessage(channel, text);
    log.info('Approved announcement posted', { report_id: reportId, approved_by: approverName });
  } catch (err) {
    log.error('Failed to post Approved announcement to Slack', { reason: err.message, report_id: reportId });
  }
  if (threadTs) {
    try {
      await approvedMessages.set({ reportId, channel, ts: threadTs, approverName });
    } catch (err) {
      log.warn('Could not record the Approved announcement — the release will post a new message instead of editing it', {
        reason: err.message, report_id: reportId,
      });
    }
  }
  await postEmptyFieldsNotice({ report, channel, threadTs, actorCuid, reportId, round: 'approved' });
}

module.exports = { postApprovedAnnouncement, buildApprovedMessage };
