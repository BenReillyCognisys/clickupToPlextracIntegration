const crypto = require('crypto');
const { findByCuid } = require('../lib/task-store');
const { updateTaskStatus } = require('../lib/clickup-api');
const { getReport } = require('../lib/plextrac-api');
const { runQaReview } = require('../pipeline/qa-review');
const log = require('../lib/logger');

// Status that triggers the automated AI QA review (defaults to the QA status).
const QA_TRIGGER_STATUS = process.env.PLEXTRAC_QA_STATUS || 'Ready For Review';

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

  const { event, targetCuid, targetType, clientId, reportId, clientName, reportName } = payload;

  if (event !== 'ReportStatusChanged' || targetType !== 'report' || !targetCuid) {
    return;
  }

  // Look up the ClickUp task mapping using the report's CUID
  let mapping = await findByCuid(targetCuid).catch(err => {
    log.error('MongoDB CUID lookup failed', { reason: err.message, cuid: targetCuid });
    return null;
  });

  // Tracks whether this report has a ClickUp task mapping. Reports created before
  // the ClickUp integration existed have no mapping — we still run the QA review
  // for them (below), but skip the ClickUp status sync since there is no task.
  let mapped = true;

  if (!mapping) {
    // Backwards compatibility: fall back to the client/report identifiers that
    // Plextrac sends in the webhook payload so the QA review can still run for a
    // pre-integration report. Requires the numeric clientId + reportId fields.
    if (!clientId || !reportId) {
      log.warn('Plextrac webhook — no mapping found and payload missing client/report id', { cuid: targetCuid });
      return;
    }
    mapped = false;
    mapping = {
      plextrac_client_id: clientId,
      plextrac_report_id: reportId,
      task_name:          reportName,
      client_name:        clientName,
    };
    log.info('Plextrac webhook — no mapping found; running QA from payload IDs (pre-integration report)', {
      cuid: targetCuid, client_id: clientId, report_id: reportId,
    });
    // Notify the main Slack channel (same one used for "Report has been created").
    log.notify(`Client: ${clientName} - ${reportName}`);
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

  // When the report enters the QA status, kick off the automated AI QA review.
  // Fire-and-forget so the (fast) ClickUp status sync below isn't blocked by the
  // (slower, billable) review; runQaReview logs its own outcome and errors.
  if (reportStatus === QA_TRIGGER_STATUS) {
    runQaReview(mapping).catch(err => {
      log.error('QA review pipeline threw', {
        reason: err.message,
        cuid: targetCuid,
        report_id: mapping.plextrac_report_id,
      });
    });
  }

  // Pre-integration reports have no ClickUp task to update — the QA review above
  // is the only action we take for them.
  if (!mapped) {
    log.info('Plextrac report status change — no ClickUp mapping, skipping status sync', {
      cuid: targetCuid, status: reportStatus,
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
