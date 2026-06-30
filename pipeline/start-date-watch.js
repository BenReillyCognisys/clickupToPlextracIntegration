// Start-date watcher.
//
// Reports are created as soon as their ClickUp task appears, even when the task
// has no start date yet — in that case the report name falls back to the current
// month/year (see pipeline/plextrac-report.js). Those reports are flagged
// start_date_pending in the task-mappings store.
//
// This watcher periodically re-checks each pending task in ClickUp. Once a start
// date has been set, it rebuilds the report name from that date, renames the
// Plextrac report (and backfills its start/end dates), and clears the pending
// flag. It runs on an 8-hour cron and can be triggered early via
// POST /jobs/start-date-watch.

const store = require('../lib/task-store');
const { getTask } = require('../lib/clickup-api');
const api = require('../lib/plextrac-api');
const { buildReportName, epochToISO } = require('./plextrac-report');
const log = require('../lib/logger');

// Derives the testing type for the report name. Prefer the value stored at
// creation; fall back to the prefix of the existing report name ("Type | Month
// Year") for mappings written before testing_type was recorded.
function testingTypeFor(mapping, currentReportName) {
  if (mapping.testing_type) return mapping.testing_type;
  const name = currentReportName || mapping.report_name || mapping.task_name || '';
  const idx = name.indexOf('|');
  return idx === -1 ? name.trim() : name.slice(0, idx).trim();
}

// Processes a single pending mapping. Returns one of:
//   'renamed'  — a start date appeared and the report was renamed
//   'set'      — a start date appeared but the name was already correct
//   'pending'  — still no start date
//   'error'    — the task or report could not be processed (stays pending)
async function processPending(mapping) {
  const reportId = mapping.plextrac_report_id;
  const taskId   = mapping.clickup_task_id;

  let task;
  try {
    task = await getTask(taskId);
  } catch (err) {
    log.error('Start-date watch — failed to fetch ClickUp task', {
      reason: err.message, clickup_task_id: taskId, report_id: reportId,
    });
    return 'error';
  }

  if (!task.start_date) {
    log.info('Start-date watch — task still has no start date', {
      task: task.name, clickup_task_id: taskId, report_id: reportId,
    });
    return 'pending';
  }

  // Fetch the live report to compare names — the stored name may be stale, and we
  // want an accurate before/after for the log.
  let currentName = null;
  try {
    const report = await api.getReport(mapping.plextrac_client_id, reportId);
    currentName = report?.name ?? null;
  } catch (err) {
    log.error('Start-date watch — failed to fetch Plextrac report', {
      reason: err.message, client_id: mapping.plextrac_client_id, report_id: reportId,
    });
    return 'error';
  }

  const resolvedName = buildReportName(testingTypeFor(mapping, currentName), task.start_date);
  const nameChanged  = currentName == null || currentName.toLowerCase() !== resolvedName.toLowerCase();

  // Backfill the report's start/end dates from the task regardless — they were
  // null/derived when the report was first created without a start date.
  const payload = {
    start_date: epochToISO(task.start_date),
    end_date:   epochToISO(task.due_date),
  };
  if (nameChanged) payload.name = resolvedName;

  try {
    await api.updateReport(mapping.plextrac_client_id, reportId, payload);
  } catch (err) {
    log.error('Start-date watch — failed to update Plextrac report', {
      reason: err.message, client_id: mapping.plextrac_client_id, report_id: reportId,
    });
    return 'error';
  }

  await store.resolveStartDate(reportId, { reportName: resolvedName, startDate: task.start_date });

  if (nameChanged) {
    log.info('Start-date watch — start date set, report renamed', {
      task: task.name,
      report_id: reportId,
      old_name: currentName,
      new_name: resolvedName,
      start_date: epochToISO(task.start_date),
    });
    log.notify(`Start date set for "${task.name}" — report renamed from "${currentName}" to "${resolvedName}".`);
    return 'renamed';
  }

  log.info('Start-date watch — start date set, report name unchanged', {
    task: task.name, report_id: reportId, name: resolvedName,
  });
  return 'set';
}

// Re-checks every report still awaiting a ClickUp start date and renames any whose
// task now has one. Safe to run concurrently with the cron — each mapping is
// independent and resolveStartDate is idempotent.
async function runStartDateWatch() {
  console.log('[start-date-watch] Starting check for reports awaiting a start date…');

  let pending;
  try {
    pending = await store.findPendingStartDate();
  } catch (err) {
    log.error('Start-date watch — failed to load pending mappings', { reason: err.message });
    return { checked: 0, renamed: 0, set: 0, stillPending: 0, errors: 0 };
  }

  if (!pending.length) {
    console.log('[start-date-watch] No reports awaiting a start date. Done.');
    return { checked: 0, renamed: 0, set: 0, stillPending: 0, errors: 0 };
  }

  console.log(`[start-date-watch] ${pending.length} report(s) awaiting a start date — checking ClickUp…`);

  const tally = { checked: pending.length, renamed: 0, set: 0, stillPending: 0, errors: 0 };
  for (const mapping of pending) {
    const outcome = await processPending(mapping);
    if (outcome === 'renamed')      tally.renamed++;
    else if (outcome === 'set')     tally.set++;
    else if (outcome === 'pending') tally.stillPending++;
    else                            tally.errors++;
  }

  console.log(
    `[start-date-watch] Done. checked=${tally.checked} renamed=${tally.renamed} ` +
    `dates-set=${tally.set} still-pending=${tally.stillPending} errors=${tally.errors}`
  );
  return tally;
}

module.exports = { runStartDateWatch };
