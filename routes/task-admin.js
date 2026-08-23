/**
 * Manual repair endpoints for the ClickUp → Plextrac automations.
 *
 * All three authenticate with the X-API-Key header (AVAILABILITY_API_KEY), the same
 * key the /jobs/* triggers use, and are rate-limited by the caller in index.js.
 * Unlike /jobs/*, these answer synchronously with the outcome — the point of a
 * manual repair is knowing what it did.
 *
 *   GET  /tasks/:taskId   — read-only: which pipeline handles the task and which
 *                           Plextrac report (if any) it currently drives. Use it to
 *                           confirm the ids before either POST below.
 *
 *   POST /tasks/replay    — { taskId, force?, adopt? }
 *                           Process the task as if its taskCreated webhook had just
 *                           arrived: Plextrac client, report and authorisation form.
 *                           For an event that never arrived or failed part-way.
 *                             force — re-run even when the task is already mapped
 *                                     (repairs e.g. a missing auth form).
 *                             adopt — map the task to a same-named report that
 *                                     already exists in Plextrac.
 *
 *   POST /tasks/remap     — { fromTaskId, toTaskId }
 *                           Move an existing report's automations onto a different
 *                           ClickUp task, so every later automation follows the new
 *                           task. For duplicates, where the report was created
 *                           against the wrong one.
 *
 * Both POSTs run under the same per-task lock as the webhook, so a manual call can
 * never race a live event for the same task.
 */

const express = require('express');
const { requireApiKey } = require('../lib/availability-cache');
const { replayTask, remapTask, inspectTask } = require('../pipeline/task-admin');
const log = require('../lib/logger');

const router = express.Router();

router.use(requireApiKey);

// status → HTTP code. Anything not listed is a successful outcome (200) when
// result.ok, and a 422 when not — i.e. the request was well-formed but the task
// wasn't in a state we could act on.
const STATUS_CODES = {
  invalid_request: 400,
  not_found: 404,
  source_not_mapped: 404,
  not_monitored: 409,
  target_not_eligible: 409,
  target_already_mapped: 409,
  adopt_conflict: 409,
  remap_failed: 500,
};

function send(res, result) {
  res.status(STATUS_CODES[result.status] ?? (result.ok ? 200 : 422)).json(result);
}

// Wraps a handler so an unexpected throw (Mongo down, ClickUp 500) becomes a clean
// 500 with a loggable reason instead of an unhandled rejection.
const guard = (name, fn) => async (req, res) => {
  try {
    send(res, await fn(req));
  } catch (err) {
    log.error(`Task admin — ${name} failed`, { reason: err.message, body: JSON.stringify(req.body ?? {}).slice(0, 200) });
    res.status(500).json({ ok: false, status: 'error', detail: err.message });
  }
};

// A ClickUp task id as it appears in a task URL: alphanumeric, no separators.
// Rejecting anything else keeps a malformed id out of the ClickUp path and out of
// the Mongo query, and gives the caller a clearer error than a 404 from ClickUp.
const TASK_ID = /^[A-Za-z0-9]{1,32}$/;

function taskId(value, field) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) throw Object.assign(new Error(`${field} is required`), { field });
  if (!TASK_ID.test(raw)) throw Object.assign(new Error(`${field} is not a valid ClickUp task id`), { field });
  return raw;
}

// Turns the id validation above into a 400 rather than a 500.
const withValidatedIds = (fn) => async (req) => {
  try {
    return await fn(req);
  } catch (err) {
    if (err.field) return { ok: false, status: 'invalid_request', detail: err.message };
    throw err;
  }
};

router.get('/:taskId', guard('inspect', withValidatedIds(async (req) =>
  inspectTask(taskId(req.params.taskId, 'taskId'))
)));

router.post('/replay', guard('replay', withValidatedIds(async (req) => {
  const body = req.body ?? {};
  return replayTask(taskId(body.taskId, 'taskId'), {
    force: body.force === true,
    adopt: body.adopt === true,
  });
})));

router.post('/remap', guard('remap', withValidatedIds(async (req) => {
  const body = req.body ?? {};
  return remapTask(
    taskId(body.fromTaskId, 'fromTaskId'),
    taskId(body.toTaskId, 'toTaskId'),
  );
})));

module.exports = router;
