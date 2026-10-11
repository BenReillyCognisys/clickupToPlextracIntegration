// When a queued report is due, for ordering DeliveryFlow's QA queue soonest-due first.
//
// A DeliveryFlow engagement's report: DeliveryFlow has the report due date itself and
// adds it. A report that came through ClickUp: the task's due date plus
// REPORTS_DUE_SLA_DAYS business days, the same deadline the weekly "reports due" post
// uses (pipeline/reports-due.js). It is looked up in the background and kept on the
// queue entry (due_date), so listing the queue never waits on ClickUp; it shows on the
// next refresh and is looked up again after RECHECK_MS in case the task moved. Reports
// from before the ClickUp integration have no due date.

const { findByCuid } = require('./task-store');
const { getTask } = require('./clickup-api');
const qaQueue = require('./qa-queue-store');
const { addBusinessDays, toTzDate } = require('../pipeline/reports-due');
const log = require('./logger');

const SLA_DAYS = Number(process.env.REPORTS_DUE_SLA_DAYS) || 3;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const inFlight = new Set();

// The ClickUp-era deadline as 'YYYY-MM-DD', or null when the task has no due date.
async function clickupDueDate(reportCuid) {
  const mapping = await findByCuid(reportCuid);
  if (!mapping?.clickup_task_id) return null;
  const task = await getTask(mapping.clickup_task_id);
  const due = task?.due_date != null ? Number(task.due_date) : null;
  if (!due) return null;
  return addBusinessDays(toTzDate(due), SLA_DAYS).toISOString().slice(0, 10);
}

const isStale = (e) => !e.due_checked_at || Date.now() - new Date(e.due_checked_at).getTime() > RECHECK_MS;

// Starts a lookup for each listed report that isn't a DeliveryFlow engagement's and
// hasn't been checked lately. Never awaited by the caller; each lookup logs its own
// failure and is retried after RECHECK_MS.
function refreshDueDates(entries, engagements) {
  for (const e of entries) {
    if (!e.report_cuid || engagements.has(String(e.report_id)) || !isStale(e) || inFlight.has(e.report_id)) continue;
    inFlight.add(e.report_id);
    clickupDueDate(e.report_cuid)
      .then((due) => qaQueue.setDueDate(e.report_id, due))
      .catch((err) => {
        log.warn('QA queue: could not look up the report due date', { reason: err.message, report_id: e.report_id });
        return qaQueue.setDueDate(e.report_id, e.due_date || null).catch(() => {});
      })
      .finally(() => inFlight.delete(e.report_id));
  }
}

module.exports = { refreshDueDates, clickupDueDate };
