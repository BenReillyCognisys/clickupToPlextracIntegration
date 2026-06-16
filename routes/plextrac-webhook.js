const crypto = require('crypto');
const { findByReportId } = require('../lib/task-store');
const { updateTaskStatus } = require('../lib/clickup-api');
const { getReportByCuid } = require('../lib/plextrac-api');
const log = require('../lib/logger');

// Plextrac signature: SHA256(secret + rawBody), header: X-Authorization-HMAC-256
function verifySignature(secret, rawBody, header) {
  const computed = crypto.createHash('sha256').update(secret + rawBody).digest('hex');
  return header === computed;
}

// Plextrac status → ClickUp status (only statuses we act on)
const STATUS_MAP = {
  'Ready For Review': process.env.CLICKUP_STATUS_QA      || 'QA / Reviewing',
  'Published':        process.env.CLICKUP_STATUS_COMPLETE || 'Completed',
};

async function handler(req, res) {
  const secret = process.env.PLEXTRAC_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-authorization-hmac-256'];
    if (!sig || !verifySignature(secret, req.body.toString(), sig)) {
      log.warn('Plextrac webhook rejected — invalid signature', {});
      return res.status(401).end();
    }
  }

  // Acknowledge immediately so Plextrac doesn't retry
  res.status(200).end();

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    log.warn('Plextrac webhook — failed to parse JSON body', {});
    return;
  }

  const { event, targetCuid, targetType } = payload;

  if (event !== 'ReportStatusChanged' || targetType !== 'report' || !targetCuid) {
    return;
  }

  // The webhook payload's `statuses` field is the list of all configured trigger
  // statuses — not the status the report just changed to. We must call the API
  // to discover the current status.
  let report;
  try {
    report = await getReportByCuid(targetCuid);
  } catch (err) {
    log.error('Failed to fetch Plextrac report by CUID', {
      reason: err.message,
      cuid: targetCuid,
    });
    return;
  }

  // v2 API may nest data differently — try the most likely field paths
  const reportStatus = report?.status ?? report?.data?.status;
  const reportId     = report?.report_id ?? report?.id ?? report?.data?.report_id ?? report?.data?.id;

  if (!reportStatus) {
    log.warn('Plextrac report response missing status', { cuid: targetCuid, response: JSON.stringify(report) });
    return;
  }

  const clickupStatus = STATUS_MAP[reportStatus];
  if (!clickupStatus) {
    // Status we don't act on (Draft, In Review, Approved, etc.)
    log.info('Plextrac report status change — no ClickUp action required', {
      cuid: targetCuid,
      status: reportStatus,
    });
    return;
  }

  if (!reportId) {
    log.warn('Plextrac report response missing numeric ID', { cuid: targetCuid, response: JSON.stringify(report) });
    return;
  }

  const mapping = await findByReportId(reportId).catch(err => {
    log.error('MongoDB lookup failed', { reason: err.message, report_id: reportId });
    return null;
  });

  if (!mapping) {
    log.warn('Plextrac webhook — no ClickUp task mapping found for report', {
      cuid: targetCuid,
      report_id: reportId,
      status: reportStatus,
    });
    return;
  }

  try {
    await updateTaskStatus(mapping.clickup_task_id, clickupStatus);
    log.info('ClickUp task status updated from Plextrac', {
      plextrac_status: reportStatus,
      clickup_status: clickupStatus,
      report_id: reportId,
      clickup_task_id: mapping.clickup_task_id,
      task: mapping.task_name,
    });
  } catch (err) {
    log.error('Failed to update ClickUp task status', {
      reason: err.message,
      clickup_task_id: mapping.clickup_task_id,
      report_id: reportId,
    });
  }
}

module.exports = handler;
