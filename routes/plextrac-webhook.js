const crypto = require('crypto');
const { findByCuid } = require('../lib/task-store');
const { updateTaskStatus } = require('../lib/clickup-api');
const { getReport } = require('../lib/plextrac-api');
const log = require('../lib/logger');

// Plextrac signature: HMAC-SHA256(secret, rawBody), header: X-Authorization-HMAC-256
function verifySignature(secret, rawBody, header) {
  const computed    = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const headerBuf   = Buffer.from(header || '');
  const computedBuf = Buffer.from(computed);
  return headerBuf.length === computedBuf.length && crypto.timingSafeEqual(headerBuf, computedBuf);
}

// Plextrac status → ClickUp status (only statuses we act on)
const STATUS_MAP = {
  'Ready For Review': process.env.CLICKUP_STATUS_QA      || 'QA / Reviewing',
  'Published':        process.env.CLICKUP_STATUS_COMPLETE || 'Completed',
};

async function handler(req, res) {
  const secret = process.env.PLEXTRAC_WEBHOOK_SECRET;
  if (!secret) {
    log.error('PLEXTRAC_WEBHOOK_SECRET is not set — rejecting request', {});
    return res.status(500).end();
  }
  const sig = req.headers['x-authorization-hmac-256'];
  if (!sig || !verifySignature(secret, req.body.toString(), sig)) {
    log.warn('Plextrac webhook rejected — invalid signature', {});
    return res.status(401).end();
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

  // Look up the ClickUp task mapping using the report's CUID
  const mapping = await findByCuid(targetCuid).catch(err => {
    log.error('MongoDB CUID lookup failed', { reason: err.message, cuid: targetCuid });
    return null;
  });

  if (!mapping) {
    log.warn('Plextrac webhook — no mapping found for report CUID', { cuid: targetCuid });
    return;
  }

  // Fetch the report from Plextrac to get the current status — the webhook
  // payload only contains the list of configured trigger statuses, not the
  // status the report just changed to.
  let report;
  try {
    report = await getReport(mapping.plextrac_client_id, mapping.plextrac_report_id);
  } catch (err) {
    log.error('Failed to fetch Plextrac report', {
      reason: err.message,
      client_id: mapping.plextrac_client_id,
      report_id: mapping.plextrac_report_id,
    });
    return;
  }

  const reportStatus = report?.status;
  if (!reportStatus) {
    log.warn('Plextrac report response missing status field', {
      cuid: targetCuid,
      report_id: mapping.plextrac_report_id,
    });
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

  try {
    await updateTaskStatus(mapping.clickup_task_id, clickupStatus);
    log.info('ClickUp task status updated from Plextrac', {
      plextrac_status: reportStatus,
      clickup_status:  clickupStatus,
      report_id:       mapping.plextrac_report_id,
      clickup_task_id: mapping.clickup_task_id,
      task:            mapping.task_name,
    });
  } catch (err) {
    log.error('Failed to update ClickUp task status', {
      reason:          err.message,
      clickup_task_id: mapping.clickup_task_id,
      report_id:       mapping.plextrac_report_id,
    });
  }
}

module.exports = handler;
