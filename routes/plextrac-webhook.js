const crypto = require('crypto');
const { findByReportId } = require('../lib/task-store');
const { updateTaskStatus } = require('../lib/clickup-api');
const log = require('../lib/logger');

// Plextrac signature: SHA256(secret + rawBody), header: X-Authorization-HMAC-256
function verifySignature(secret, rawBody, header) {
  const computed = crypto.createHash('sha256').update(secret + rawBody).digest('hex');
  return header === computed;
}

// Plextrac status → ClickUp status
const STATUS_MAP = {
  'Ready For Review': process.env.CLICKUP_STATUS_QA       || 'QA / Reviewing',
  'Published':        process.env.CLICKUP_STATUS_COMPLETE  || 'Completed',
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

  // Acknowledge immediately
  res.status(200).end();

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    log.warn('Plextrac webhook — failed to parse JSON body', {});
    return;
  }

  // Log full payload so we can identify the exact field names Plextrac sends
  console.log('[Plextrac] Full webhook payload:', JSON.stringify(payload, null, 2));

  const { event, reportId, clientId } = payload;

  // Determine which ClickUp status to apply
  let clickupStatus;

  if (event === 'ReportPublished' || payload.status === 'Published') {
    clickupStatus = STATUS_MAP['Published'];
  } else if (payload.status === 'Ready For Review') {
    clickupStatus = STATUS_MAP['Ready For Review'];
  } else {
    // Event is not one we act on — ignore silently
    return;
  }

  if (!reportId) {
    log.warn('Plextrac webhook missing reportId — cannot look up ClickUp task', { event, payload: JSON.stringify(payload) });
    return;
  }

  const mapping = await findByReportId(reportId).catch(err => {
    log.error('MongoDB lookup failed', { reason: err.message, report_id: reportId });
    return null;
  });

  if (!mapping) {
    log.warn('Plextrac webhook — no ClickUp task mapping found for report', {
      report_id: reportId,
      client_id: clientId,
      event,
    });
    return;
  }

  try {
    await updateTaskStatus(mapping.clickup_task_id, clickupStatus);
    log.info('ClickUp task status updated', {
      event,
      report_id: reportId,
      clickup_task_id: mapping.clickup_task_id,
      task: mapping.task_name,
      status: clickupStatus,
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
