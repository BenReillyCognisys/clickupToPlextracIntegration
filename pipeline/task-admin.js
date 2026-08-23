// Manual repair operations for the ClickUp → Plextrac automations.
//
// The webhook is the normal driver, but events do get missed (ClickUp didn't fire,
// the service was down, Mongo was unreachable mid-run) and they do land on the
// wrong task (a duplicate was created and the automations latched onto the first
// one). Two operations cover both, exposed over HTTP by routes/task-admin.js:
//
//   replayTask(taskId)              — process a task as if its taskCreated webhook
//                                     had just arrived: Plextrac client, report and
//                                     authorisation form. Idempotent by default.
//   remapTask(fromTaskId, toTaskId) — move an existing report's automations onto a
//                                     different ClickUp task, so every later
//                                     automation (status sync, QA, reports-due,
//                                     renames) follows the new task instead.
//
// Both take the same per-task lock the webhook uses, so a manual call can never run
// alongside a live event for the same task and produce a duplicate.
//
// Every operation returns { ok, status, detail, ... }. `status` is a stable machine
// token, `detail` a sentence for a human — the route maps status → HTTP code.

const { parseTaskName } = require('./parse-task');
const { runPipeline } = require('./index');
const { runVmaasPipeline } = require('./vmaas');
const { loadMonitoredTask } = require('./load-task');
const { syncClientName, syncReportName } = require('./task-rename');
const { createAuthFormForTask } = require('./auth-form-create');
const api = require('../lib/plextrac-api');
const store = require('../lib/task-store');
const { withTaskLock } = require('../lib/task-lock');
const log = require('../lib/logger');

const PLEXTRAC_BASE = () => `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
const reportUrl = (clientId, reportId) => `${PLEXTRAC_BASE()}/client/${clientId}/report/${reportId}`;
const clickupTaskUrl = (taskId) => `https://app.clickup.com/t/${taskId}`;

// Compact task descriptor echoed back so the caller can confirm it acted on the
// task it meant to (the ids alone are easy to mix up).
const taskSummary = (task) => ({
  id: task.id,
  name: task.name,
  url: clickupTaskUrl(task.id),
  space: task.space?.name ?? null,
  list: task.list?.name ?? null,
  status: task.status?.status ?? null,
  start_date: task.start_date ?? null,
  due_date: task.due_date ?? null,
});

// The mapping as the caller cares about it: which Plextrac report a ClickUp task
// drives, and how to open it.
const mappingSummary = (mapping) => mapping && ({
  clickup_task_id: mapping.clickup_task_id,
  plextrac_client_id: mapping.plextrac_client_id,
  plextrac_report_id: mapping.plextrac_report_id,
  plextrac_report_cuid: mapping.plextrac_report_cuid ?? null,
  report_url: reportUrl(mapping.plextrac_client_id, mapping.plextrac_report_id),
  task_name: mapping.task_name ?? null,
  testing_type: mapping.testing_type ?? null,
  remapped_from: mapping.remapped_from ?? null,
  remapped_at: mapping.remapped_at ?? null,
});

// Locks a pair of task ids in a stable order, so two remaps naming the same two
// tasks in opposite directions can't deadlock waiting on each other.
function withTaskPairLock(idA, idB, fn) {
  const [first, second] = [String(idA), String(idB)].sort();
  return withTaskLock(first, () => withTaskLock(second, fn));
}

// ── Inspect ───────────────────────────────────────────────────────────────────

/**
 * What the automations currently think about a task: whether we'd act on it, and
 * which Plextrac report (if any) it drives. Read-only — meant to be called before
 * a replay or remap to confirm the ids.
 */
async function inspectTask(taskId) {
  const { task, pipeline, reason } = await loadMonitoredTask(taskId);
  if (!task) return { ok: false, status: 'not_found', detail: reason };

  const mapping = await store.findByTaskId(taskId).catch((err) => {
    log.error('Task inspect — mapping lookup failed', { reason: err.message, task_id: taskId });
    return null;
  });

  return {
    ok: true,
    status: 'ok',
    detail: pipeline
      ? `the task is handled by the ${pipeline} pipeline`
      : `the task is not processed — ${reason}`,
    pipeline,
    monitored: Boolean(pipeline),
    task: taskSummary(task),
    parsed: pipeline === 'vmaas' ? null : parseTaskName(task.name),
    mapping: mappingSummary(mapping) ?? null,
  };
}

// ── Replay ────────────────────────────────────────────────────────────────────

// Links a task to a Plextrac report that already exists — the repair for a run that
// created the report but never stored the mapping (Mongo unavailable at the time),
// which otherwise leaves the report invisible to every later automation. Refuses
// when another task already owns that report, since one report can only follow one
// task and adopting it would silently steal it.
async function adoptExistingReport(task, { clientId, reportId, reportName, testingType }) {
  const owner = await store.findByReportId(reportId);
  if (owner && String(owner.clickup_task_id) !== String(task.id)) {
    return {
      ok: false,
      status: 'adopt_conflict',
      detail: `Plextrac report ${reportId} is already mapped to ClickUp task ${owner.clickup_task_id}`
        + ' — remap it instead of adopting it',
      mapping: mappingSummary(owner),
    };
  }

  // The Plextrac webhook identifies reports by CUID, so the mapping needs it.
  let cuid = null;
  try {
    cuid = (await api.getReport(clientId, reportId))?.cuid ?? null;
  } catch (err) {
    log.warn('Task replay — could not read the report CUID while adopting', {
      reason: err.message, client_id: clientId, report_id: reportId,
    });
  }

  await store.saveMapping({
    clickupTaskId: task.id,
    plextracClientId: clientId,
    plextracReportId: reportId,
    plextracReportCuid: cuid,
    taskName: task.name,
    testingType,
    // The report name came from whatever start date existed when it was created; if
    // the task still has none, leave it on the start-date watcher's list.
    startDatePending: !task.start_date,
  });

  log.info('Task replay — adopted an existing Plextrac report', {
    task: task.name, task_id: task.id, report: reportName, report_id: reportId, client_id: clientId,
  });
  log.notify(
    `Existing Plextrac report <${reportUrl(clientId, reportId)}|${reportName}> is now mapped to `
    + `<${clickupTaskUrl(task.id)}|${task.name}> — status syncs and QA automations will follow it again.`
  );

  return { ok: true, status: 'adopted', detail: 'the existing Plextrac report is now mapped to this task', cuid };
}

/**
 * Runs the create pipeline for a task as though its taskCreated webhook had just
 * arrived. Safe to call repeatedly: an already-mapped task is reported and left
 * alone unless `force` is set.
 *
 * Options:
 *   force — re-run even when the task is already mapped. Repairs a half-finished
 *           run (report created, auth form failed). The report itself is protected
 *           by createReport's name-based duplicate check.
 *   adopt — when the report already exists in Plextrac but this task has no mapping,
 *           store the mapping instead of reporting the mismatch.
 */
async function replayTask(taskId, { force = false, adopt = false } = {}) {
  if (!taskId) return { ok: false, status: 'invalid_request', detail: 'taskId is required' };

  return withTaskLock(String(taskId), async () => {
    const { task, pipeline, reason } = await loadMonitoredTask(taskId);
    if (!task) return { ok: false, status: 'not_found', detail: reason };
    if (!pipeline) {
      return { ok: false, status: 'not_monitored', detail: `the task is not processed — ${reason}`, task: taskSummary(task) };
    }

    log.info('Manual replay requested', {
      task: task.name, task_id: task.id, pipeline, force, adopt,
    });

    // VMaaS tasks have no Plextrac report — the whole pipeline is the auth form,
    // and the portal is idempotent per task id, so a replay is always safe.
    if (pipeline === 'vmaas') {
      const authForm = await runVmaasPipeline(task);
      return {
        ok: true,
        status: authForm ? 'created' : 'skipped',
        detail: authForm
          ? `the VMaaS authorisation form ${authForm.created ? 'was created' : 'already existed'}`
          : 'no authorisation form was generated — see the logs for why',
        pipeline,
        task: taskSummary(task),
        auth_form_url: authForm?.formUrl ?? null,
      };
    }

    const result = await runPipeline(task, { force });

    // The report exists but this task isn't mapped to it — the one outcome a replay
    // can't resolve on its own, because adopting the report is a judgement call.
    if (result.status === 'report_exists') {
      const mapping = await store.findByTaskId(task.id).catch(() => null);
      if (!mapping) {
        if (!adopt) {
          return {
            ...result, // the pipeline's own status is superseded by the one below
            ok: false,
            status: 'report_exists_unmapped',
            detail: `a Plextrac report named "${result.report_name}" already exists under client `
              + `${result.client_id}, but this task is not mapped to it`,
            next_step: 'retry with {"adopt": true} to map this task to that report, '
              + 'or use /tasks/remap if another task should own it',
            pipeline,
            task: taskSummary(task),
          };
        }
        const adopted = await adoptExistingReport(task, {
          clientId: result.client_id,
          reportId: result.report_id,
          reportName: result.report_name,
          testingType: result.testing_type,
        });
        if (!adopted.ok) return { ...adopted, pipeline, task: taskSummary(task) };
        return {
          ...result, // 'report_exists' describes the report; 'adopted' describes the run
          ok: true,
          status: 'adopted',
          detail: adopted.detail,
          pipeline,
          task: taskSummary(task),
        };
      }
    }

    const ok = ['created', 'report_exists', 'already_mapped'].includes(result.status);
    return { ok, pipeline, task: taskSummary(task), ...result };
  });
}

// ── Remap ─────────────────────────────────────────────────────────────────────

// Brings Plextrac in line with the task that now owns the mapping. Mirrors what a
// rename does, but driven by the move rather than by a name-change event: the
// "previous" name is the task we moved away from, held in the pre-move mapping.
async function resyncPlextracForTask(mapping, task) {
  const { client_name, testing_type, warning } = parseTaskName(task.name);
  const clientId = mapping.plextrac_client_id;
  const reportId = mapping.plextrac_report_id;

  // Don't overwrite a live report name with a fallback we can't classify — same
  // guard the rename sync applies.
  if (testing_type === 'Unknown') {
    log.warn('Task remap — the new task name does not resolve to a testing type; leaving Plextrac names as they are', {
      task: task.name, task_id: task.id, report_id: reportId,
    });
    await store.updateMappingDetails(reportId, { taskName: task.name }).catch((err) => {
      log.error('Task remap — failed to persist the new task name', { reason: err.message, report_id: reportId });
    });
    return { client_name, testing_type, warning: warning ?? null, client_renamed: false, report_renamed: false };
  }

  const clientRenamed = await syncClientName(mapping, client_name, task.name);
  const reportRenamed = await syncReportName(clientId, reportId, testing_type, task.start_date, task.name);

  // A duplicate often has no dates set yet — that can be why it was duplicated. The
  // report name's month then comes from a fallback (today), exactly as it does for a
  // dateless task at create time, so re-arm the start-date watcher to correct the
  // name once ClickUp gets a real start date.
  const startDatePending = !task.start_date;
  await store.updateMappingDetails(reportId, {
    taskName: task.name, testingType: testing_type, startDatePending,
  }).catch((err) => {
    log.error('Task remap — failed to persist the new task details', { reason: err.message, report_id: reportId });
  });
  if (startDatePending) {
    log.info('Task remap — the target task has no start date; the report month will be corrected by the watcher', {
      task: task.name, task_id: task.id, report_id: reportId,
    });
  }

  return {
    client_name,
    testing_type,
    warning: warning ?? null,
    client_renamed: clientRenamed,
    report_renamed: reportRenamed,
    start_date_pending: startDatePending,
  };
}

/**
 * Moves the automations for a Plextrac report from one ClickUp task to another.
 *
 * Use it when the automations ran against the wrong task — typically a duplicate,
 * where the report was created for the first task and the work is being tracked on
 * the second. Afterwards every later automation (Plextrac → ClickUp status sync, QA
 * queue, reports-due, renames, the start-date watcher) follows `toTaskId`.
 *
 * Plextrac's client and report names are re-synced to the target task's name, and
 * the target task gets its own authorisation form. The source task is deliberately
 * left untouched: its auth form still exists in the portal (there is no API to
 * withdraw one) and its authformlink field still points at it, so the response and
 * the Slack notice both flag that as manual tidy-up.
 */
async function remapTask(fromTaskId, toTaskId) {
  if (!fromTaskId || !toTaskId) {
    return { ok: false, status: 'invalid_request', detail: 'fromTaskId and toTaskId are both required' };
  }
  if (String(fromTaskId) === String(toTaskId)) {
    return { ok: false, status: 'invalid_request', detail: 'fromTaskId and toTaskId are the same task' };
  }

  return withTaskPairLock(fromTaskId, toTaskId, async () => {
    const mapping = await store.findByTaskId(fromTaskId);
    if (!mapping) {
      return {
        ok: false,
        status: 'source_not_mapped',
        detail: `ClickUp task ${fromTaskId} is not mapped to a Plextrac report — there is nothing to move`,
        next_step: `if the report exists but was never mapped, replay ${fromTaskId} with {"adopt": true} first`,
      };
    }

    const { task: toTask, pipeline, reason } = await loadMonitoredTask(toTaskId);
    if (!toTask) return { ok: false, status: 'not_found', detail: reason };
    if (pipeline !== 'pentest') {
      return {
        ok: false,
        status: 'target_not_eligible',
        detail: `ClickUp task ${toTaskId} is not a Penetration Test task — ${reason || `it is handled by the ${pipeline} pipeline`}`,
        task: taskSummary(toTask),
      };
    }

    // One report can only follow one task. If the target already drives its own
    // report, moving this one onto it would leave two mappings on the same task id
    // and every lookup picking between them arbitrarily.
    const targetMapping = await store.findByTaskId(toTaskId);
    if (targetMapping) {
      return {
        ok: false,
        status: 'target_already_mapped',
        detail: `ClickUp task ${toTaskId} is already mapped to Plextrac report ${targetMapping.plextrac_report_id}`,
        next_step: 'decide which report should survive, then remap or delete the other one in Plextrac',
        task: taskSummary(toTask),
        source_mapping: mappingSummary(mapping),
        target_mapping: mappingSummary(targetMapping),
      };
    }

    const moved = await store.remapClickupTask(mapping.plextrac_report_id, toTask.id, { previousTaskId: fromTaskId });
    if (!moved) {
      return {
        ok: false,
        status: 'remap_failed',
        detail: `the mapping for Plextrac report ${mapping.plextrac_report_id} could not be updated`,
      };
    }

    log.info('Task remap — mapping moved to a new ClickUp task', {
      report_id: mapping.plextrac_report_id,
      client_id: mapping.plextrac_client_id,
      from_task_id: String(fromTaskId),
      to_task_id: toTask.id,
      from_task_name: mapping.task_name ?? null,
      to_task_name: toTask.name,
    });

    // Plextrac and the auth form now follow the target task's name. `mapping` is the
    // pre-move document, so it still carries the old name the syncs diff against.
    const resync = await resyncPlextracForTask(mapping, toTask);

    // The portal keys forms on the ClickUp task id, so the target task needs its own
    // (create-or-return: a second call for the same task is a no-op). Best-effort —
    // createAuthFormForTask logs its own failures and never throws.
    const authForm = resync.testing_type === 'Unknown' ? null : await createAuthFormForTask(toTask, {
      clientName: resync.client_name,
      testType: resync.testing_type,
      clientId: mapping.plextrac_client_id,
      reportId: mapping.plextrac_report_id,
    });

    let reportName = mapping.report_name ?? null;
    try {
      reportName = (await api.getReport(mapping.plextrac_client_id, mapping.plextrac_report_id))?.name ?? reportName;
    } catch (err) {
      log.warn('Task remap — could not read the report name for the summary', {
        reason: err.message, report_id: mapping.plextrac_report_id,
      });
    }

    const url = reportUrl(mapping.plextrac_client_id, mapping.plextrac_report_id);
    const authLine = authForm ? ` Auth form: <${authForm.formUrl}|link>.` : '';
    log.notify(
      `Automations remapped: Plextrac report <${url}|${reportName || mapping.plextrac_report_id}> now follows `
      + `<${clickupTaskUrl(toTask.id)}|${toTask.name}> instead of `
      + `<${clickupTaskUrl(fromTaskId)}|${mapping.task_name || fromTaskId}>.${authLine}`
      + ` The old task keeps its authorisation form — withdraw it in the portal if that task is a duplicate.`
    );

    return {
      ok: true,
      status: 'remapped',
      detail: `Plextrac report ${mapping.plextrac_report_id} now follows ClickUp task ${toTask.id}`,
      from: { id: String(fromTaskId), name: mapping.task_name ?? null, url: clickupTaskUrl(fromTaskId) },
      to: taskSummary(toTask),
      client_id: mapping.plextrac_client_id,
      report_id: mapping.plextrac_report_id,
      report_name: reportName,
      report_url: url,
      client_renamed: resync.client_renamed,
      report_renamed: resync.report_renamed,
      client_name: resync.client_name,
      testing_type: resync.testing_type,
      start_date_pending: resync.start_date_pending ?? false,
      ...(resync.warning ? { warning: resync.warning } : {}),
      auth_form_url: authForm?.formUrl ?? null,
      manual_followup: 'The source task still has its own authorisation form in the portal and its '
        + 'authformlink field still points at it — withdraw it manually if that task is a duplicate.',
    };
  });
}

module.exports = { replayTask, remapTask, inspectTask };
