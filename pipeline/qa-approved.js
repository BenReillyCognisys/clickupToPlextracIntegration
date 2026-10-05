// Approved announcement: posted to the ready-for-release channel when a Plextrac report
// reaches Approved — the third round of QA is done and the report is waiting to be
// published. @-mentions the people who can publish it and credits whoever approved it.
//
// Only an approver can get a report here: pipeline/status-guard.js puts back anyone
// else's change before this runs (config/report-status-permissions.js).
//
// Like the release announcement, it also runs the empty-custom-field check in its
// thread. Nothing is exported until the report is Published (pipeline/qa-released.js).

const slack = require('../lib/slack');
const PERMS = require('../config/report-status-permissions');
const { postEmptyFieldsNotice } = require('./qa-review/empty-fields');
const { resolveReleaseQaName, resolveClientName } = require('./qa-released');
const { READY_FOR_RELEASE_CHANNEL } = require('./status-guard');
const log = require('../lib/logger');

function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Slack ids to @-mention: SLACK_APPROVED_MENTIONS (comma/space-separated ids), else the
// publishers looked up by email. Looked up once and kept; someone Slack can't find is
// left out rather than failing the post.
let publisherIds = null;
async function approvedMentions() {
  const configured = (process.env.SLACK_APPROVED_MENTIONS || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  if (!publisherIds) {
    const ids = await Promise.all(PERMS.PUBLISHERS.map((email) => slack.lookupUserIdByEmail(email).catch((err) => {
      log.warn('Could not find a publisher in Slack for the Approved mention', { email, reason: err.message });
      return null;
    })));
    const found = ids.filter(Boolean);
    if (found.length === PERMS.PUBLISHERS.length) publisherIds = found; // keep only a complete lookup
    return found;
  }
  return publisherIds;
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
  await postEmptyFieldsNotice({ report, channel, threadTs, actorCuid, reportId, round: 'approved' });
}

module.exports = { postApprovedAnnouncement, buildApprovedMessage };
