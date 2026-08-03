const crypto = require('crypto');
const { findByCuid } = require('../lib/task-store');
const { updateTaskStatus, getTask } = require('../lib/clickup-api');
const { getReport, listReportFindings } = require('../lib/plextrac-api');
const lookup = require('../lib/plextrac-lookup');
const { runQaReview } = require('../pipeline/qa-review');
const { postSecondRoundQa } = require('../pipeline/qa-second-round');
const { postReleaseAnnouncement } = require('../pipeline/qa-released');
const { crossOffReport } = require('../pipeline/reports-due');
const qaQueue = require('../lib/qa-queue-store');
const kpiStore = require('../lib/qa-kpi-store');
const submissionStore = require('../lib/qa-submission-store');
const { hoursLate, trackingStartMs } = require('../lib/report-lateness');
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

// Report statuses that do NOT earn a QA KPI credit (see /report-kpis). The initial
// "Ready For Review" is the author submitting their OWN report for QA — not a QA
// performed on someone else's work — so it never counts. Every other status change
// counts (deduped to one credit per consultant per report in lib/qa-kpi-store.js).
// Override/extend with PLEXTRAC_KPI_EXCLUDED_STATUSES (comma-separated status names).
const KPI_EXCLUDED_STATUSES = new Set(
  (process.env.PLEXTRAC_KPI_EXCLUDED_STATUSES || QA_FIRST_STATUS)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

function isKpiExcludedStatus(status) {
  return KPI_EXCLUDED_STATUSES.has(String(status || '').trim().toLowerCase());
}

// Number of findings in a report, or null if it can't be determined. Matches the
// shape handling the QA-review pipeline uses for the same endpoint (array or
// { data: [...] }). Best-effort — the count is context, never worth failing over.
async function countReportFindings(clientId, reportId) {
  try {
    const raw = await listReportFindings(clientId, reportId);
    const list = Array.isArray(raw) ? raw : (raw?.data || []);
    return list.length;
  } catch (err) {
    log.warn('Could not count report findings for QA KPI', {
      reason: err.message, client_id: clientId, report_id: reportId,
    });
    return null;
  }
}

// Credits the actor who moved a report into `reportStatus` with one QA (for the
// /report-kpis leaderboard) — unless the actor is unknown or the status is excluded
// (the initial "Ready For Review"). The store dedups to one credit per consultant
// per report, so repeatedly flipping a report's status never inflates the count. We
// also record the report's findings count (report size) so the leaderboard can tell
// apart consultants QA'ing large vs short reports; it's only fetched for a genuinely
// new credit (has() guard), so duplicate flips cost no extra Plextrac call.
// Best-effort: any failure is logged and swallowed so it never disrupts the webhook.
async function recordQaKpi(reportStatus, actorCuid, ctx) {
  if (typeof actorCuid !== 'string' || !actorCuid) return;
  if (isKpiExcludedStatus(reportStatus)) return;
  try {
    if (await kpiStore.has(ctx.reportId, actorCuid)) return; // already credited

    const findingsCount = await countReportFindings(ctx.clientId, ctx.reportId);
    const counted = await kpiStore.record({ ...ctx, actorCuid, status: reportStatus, findingsCount });
    if (counted) {
      log.info('QA KPI credit recorded', {
        actor_cuid: actorCuid, report_id: ctx.reportId, status: reportStatus, findings: findingsCount,
      });
    }
  } catch (err) {
    log.error('Failed to record QA KPI', {
      reason: err.message, report_id: ctx.reportId, actor_cuid: actorCuid, status: reportStatus,
    });
  }
}

// The status a report reaches when its author submits it for QA. Reaching it is the
// "report submitted" event whose lateness the /report-kpis @user view reports. Same
// as the initial "Ready For Review" by default; override with PLEXTRAC_SUBMIT_STATUS.
const SUBMIT_STATUS = (process.env.PLEXTRAC_SUBMIT_STATUS || QA_FIRST_STATUS).trim().toLowerCase();

function isSubmitStatus(status) {
  return String(status || '').trim().toLowerCase() === SUBMIT_STATUS;
}

// Records a report's first submission (author → "Ready For Review") with how late it
// was vs the ClickUp due date, for the /report-kpis @user lateness stats. Only runs
// for mapped reports (a ClickUp task is needed for the due date) and only once per
// report (submissionStore dedups), so the due date is fetched at most once. Lateness
// starts at 09:00 the next working day after the due date (report-lateness.js).
// Best-effort: any failure is logged and swallowed so it never disrupts the webhook.
async function recordSubmission(reportStatus, actorCuid, ctx) {
  if (!isSubmitStatus(reportStatus)) return;
  if (typeof actorCuid !== 'string' || !actorCuid) return;
  if (!ctx.clickupTaskId) return; // pre-integration report: no ClickUp due date to measure
  try {
    if (await submissionStore.has(ctx.reportId)) return; // already recorded the first submission

    const submittedAt = new Date();
    let dueDate = null, trackingStart = null, lateHours = null;
    try {
      const task = await getTask(ctx.clickupTaskId);
      const due = task?.due_date != null ? Number(task.due_date) : null;
      if (due) {
        dueDate = due;
        trackingStart = trackingStartMs(due);
        lateHours = hoursLate(due, submittedAt.getTime());
      }
    } catch (err) {
      log.warn('Could not fetch ClickUp due date for submission lateness (recording submission without it)', {
        reason: err.message, clickup_task_id: ctx.clickupTaskId, report_id: ctx.reportId,
      });
    }

    const counted = await submissionStore.record({
      reportId: ctx.reportId, actorCuid, clickupTaskId: ctx.clickupTaskId,
      dueDate, trackingStart, submittedAt, hoursLate: lateHours,
    });
    if (counted) {
      log.info('QA submission recorded', {
        actor_cuid: actorCuid, report_id: ctx.reportId, hours_late: lateHours,
      });
    }
  } catch (err) {
    log.error('Failed to record QA submission', {
      reason: err.message, report_id: ctx.reportId, actor_cuid: actorCuid,
    });
  }
}

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

  // `actorCuid` identifies the user who triggered the status change (per Plextrac
  // support). It is not on every legacy payload, so all downstream use is optional.
  const { event, targetCuid, targetType, text, actorCuid } = payload;

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

  // Credit the consultant who made this status change on the QA leaderboard
  // (/report-kpis). Runs for mapped and pre-integration reports alike.
  await recordQaKpi(reportStatus, actorCuid, {
    reportId:   mapping.plextrac_report_id,
    clientId:   mapping.plextrac_client_id,
    reportCuid: targetCuid,
    clientName: mapping.client_name,
    reportName: report?.name || mapping.task_name,
  });

  // Record report-submission lateness (author → "Ready For Review") for the
  // /report-kpis @user view. No-ops for non-submit statuses and pre-integration
  // reports (no ClickUp task).
  await recordSubmission(reportStatus, actorCuid, {
    reportId:      mapping.plextrac_report_id,
    clickupTaskId: mapping.clickup_task_id,
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

  // When the report reaches the second-round QA status, the first round is complete:
  // announce it to #pt-second-round-qa, pinging the second-round reviewers and crediting
  // whoever did the first QA (the actor who made this status change). Fire-and-forget so
  // the ClickUp sync below isn't blocked by the cuid→name resolution; it logs its own errors.
  if (reportStatus === QA_SECOND_STATUS) {
    postSecondRoundQa({
      clientName: mapping.client_name,
      clientUrl:  `${PLEXTRAC_BASE}/client/${mapping.plextrac_client_id}`,
      reportName: report?.name || mapping.task_name,
      reportUrl:  `${PLEXTRAC_BASE}/client/${mapping.plextrac_client_id}/report/${mapping.plextrac_report_id}`,
      actorCuid,
      reportId:   mapping.plextrac_report_id,
    }).catch(err => {
      log.error('Second-round QA announcement threw', {
        reason: err.message, cuid: targetCuid, report_id: mapping.plextrac_report_id,
      });
    });
  }

  // When the report reaches the released status, it has cleared release QA and gone out:
  // announce it, pinging the release reviewers and crediting whoever released it (the
  // actor who made this status change). Fire-and-forget so the ClickUp sync below isn't
  // blocked by the cuid→name resolution; it logs its own errors.
  if (reportStatus === QA_RELEASED_STATUS) {
    postReleaseAnnouncement({
      clientName: mapping.client_name,
      clientUrl:  `${PLEXTRAC_BASE}/client/${mapping.plextrac_client_id}`,
      reportName: report?.name || mapping.task_name,
      reportUrl:  `${PLEXTRAC_BASE}/client/${mapping.plextrac_client_id}/report/${mapping.plextrac_report_id}`,
      actorCuid,
      reportId:   mapping.plextrac_report_id,
    }).catch(err => {
      log.error('Release announcement threw', {
        reason: err.message, cuid: targetCuid, report_id: mapping.plextrac_report_id,
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
