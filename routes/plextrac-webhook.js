const crypto = require('crypto');
const { findByCuid } = require('../lib/task-store');
const { updateTaskStatus } = require('../lib/clickup-api');
const { getReport } = require('../lib/plextrac-api');
const lookup = require('../lib/plextrac-lookup');
const { runQaReview } = require('../pipeline/qa-review');
const { crossOffReport } = require('../pipeline/reports-due');
const qaQueue = require('../lib/qa-queue-store');
const log = require('../lib/logger');

// Pre-integration reports carry their client/report names in the webhook `text`
// field as "<client name>||<report name>" (see the no-mapping branch below).
// Returns { clientName, reportName } or null when the text isn't in that form.
function parsePreIntegrationText(text) {
  if (typeof text !== 'string') return null;
  const idx = text.indexOf('||');
  if (idx === -1) return null;
  const clientName = text.slice(0, idx).trim();
  const reportName = text.slice(idx + 2).trim();
  if (!clientName || !reportName) return null;
  return { clientName, reportName };
}

// Status that triggers the automated AI QA review (defaults to the QA status).
const QA_TRIGGER_STATUS = process.env.PLEXTRAC_QA_STATUS || 'Ready For Review';

// QA-queue statuses (drive the /reportqueue Slack commands). A report enters the
// queue at first-round QA, moves to the second-round list when it reaches the
// second-round status, and drops off entirely once released (Published).
const QA_FIRST_STATUS  = process.env.PLEXTRAC_QA_FIRST_STATUS  || QA_TRIGGER_STATUS;
const QA_SECOND_STATUS = process.env.PLEXTRAC_QA_SECOND_STATUS || 'In Review';
const QA_RELEASED_STATUS = process.env.PLEXTRAC_RELEASED_STATUS || 'Published';

// Base Plextrac instance URL for building report links shown in the queue.
const PLEXTRAC_BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

// Maintains the QA queue from a report's current status: add/move it for the two QA
// rounds, remove it on release, and ignore every other status. Best-effort — any
// failure is logged and swallowed so it never disrupts the rest of the webhook.
async function updateQaQueue(reportStatus, { reportId, cuid, clientId, clientName, reportName }) {
  const reportUrl = `${PLEXTRAC_BASE}/client/${clientId}/report/${reportId}`;
  const base = { reportId, cuid, clientId, clientName, reportName, reportUrl };
  try {
    if (reportStatus === QA_FIRST_STATUS) {
      await qaQueue.upsert({ ...base, stage: 'first' });
    } else if (reportStatus === QA_SECOND_STATUS) {
      await qaQueue.upsert({ ...base, stage: 'second' });
    } else if (reportStatus === QA_RELEASED_STATUS) {
      await qaQueue.remove(reportId);
    }
  } catch (err) {
    log.error('Failed to update QA queue', { reason: err.message, report_id: reportId, status: reportStatus });
  }
}

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

  const { event, targetCuid, targetType, text } = payload;

  if (event !== 'ReportStatusChanged' || targetType !== 'report' || typeof targetCuid !== 'string' || !targetCuid) {
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
    // Backwards compatibility for reports created before the ClickUp integration:
    // they have no CUID mapping. Plextrac's webhook can't send numeric IDs (only
    // the %CLIENT_NAME% / %REPORT_NAME% template variables resolve), so the
    // webhook `text` field is configured as "<client name>||<report name>" and we
    // resolve the numeric client/report IDs back through the Plextrac API.
    const parsed = parsePreIntegrationText(text);
    if (!parsed) {
      log.warn('Plextrac webhook — no mapping and payload text not in "<client>||<report>" form', {
        cuid: targetCuid, payload: JSON.stringify(payload),
      });
      return;
    }

    const ids = await lookup.resolveClientAndReport(parsed).catch(err => {
      log.error('Failed to resolve client/report IDs for unmapped report', {
        reason: err.message, cuid: targetCuid,
      });
      return null;
    });
    if (!ids) {
      log.warn('Plextrac webhook — could not resolve client/report from payload names', {
        cuid: targetCuid, client: parsed.clientName, report: parsed.reportName,
      });
      return;
    }

    mapped = false;
    mapping = {
      plextrac_client_id: ids.clientId,
      plextrac_report_id: ids.reportId,
      task_name:          parsed.reportName,
      client_name:        parsed.clientName,
    };
    log.info('Plextrac webhook — no mapping found; resolved IDs from payload names (pre-integration report)', {
      cuid: targetCuid, client_id: ids.clientId, report_id: ids.reportId,
    });
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

  // Keep the QA queue (the /reportqueue Slack commands) in step with the report's
  // status. Runs for mapped and pre-integration reports alike, before the mapped-only
  // ClickUp sync below, so both show up in the queue.
  await updateQaQueue(reportStatus, {
    reportId:   mapping.plextrac_report_id,
    cuid:       targetCuid,
    clientId:   mapping.plextrac_client_id,
    clientName: mapping.client_name,
    reportName: report?.name || mapping.task_name,
  });

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

  // Cross the report off the weekly reports-due message once it's Completed. Runs
  // even if the status sync above failed (the report is done regardless), and
  // self-filters via isDoneStatus, so non-done statuses (e.g. QA / Reviewing) no-op.
  try {
    const { updated } = await crossOffReport(mapping.clickup_task_id, clickupStatus);
    if (updated) {
      log.info('Report crossed off reports-due message from Plextrac', {
        clickup_task_id: mapping.clickup_task_id, clickup_status: clickupStatus,
      });
    }
  } catch (err) {
    log.error('Failed to cross off report from Plextrac status change', {
      reason: err.message, clickup_task_id: mapping.clickup_task_id,
    });
  }
}

module.exports = handler;
