// Fetches a ClickUp task and decides whether we should act on it.
//
// Shared by the webhook (routes/clickup-webhook.js) and the manual task-admin
// endpoints (routes/task-admin.js) so a replay is filtered exactly like the live
// event it stands in for: same subtask rule, same monitored-space classification.
//
// Returns { task, pipeline, reason }:
//   • pipeline 'pentest' | 'vmaas' — act on it
//   • pipeline null                — ignore it; `reason` says why (and is logged
//                                    here, so webhook callers can just bail out)
//   • task null                    — the task couldn't be fetched at all

const { getTask } = require('../lib/clickup-api');
const { classifyTask } = require('../config/monitored-spaces');
const log = require('../lib/logger');

async function loadMonitoredTask(taskId) {
  let task;
  try {
    task = await getTask(taskId);
  } catch (err) {
    log.error('Failed to fetch ClickUp task details', { reason: err.message, task_id: taskId });
    return { task: null, pipeline: null, reason: `could not fetch the task from ClickUp — ${err.message}` };
  }

  // Subtasks are not delivery tasks in either space — no report, no auth form.
  if (task.parent) {
    log.info('Task ignored — subtask skipped', { task: task.name, parent: task.parent });
    return { task, pipeline: null, reason: 'subtask' };
  }

  const { pipeline, reason } = classifyTask(task);
  if (!pipeline) {
    log.info(`Task ignored — ${reason}`, {
      task: task.name, space: task.space?.name, space_id: task.space?.id,
      folder: task.folder?.name || null, list: task.list?.name || null,
    });
    return { task, pipeline: null, reason };
  }

  return { task, pipeline, reason: null };
}

module.exports = { loadMonitoredTask };
