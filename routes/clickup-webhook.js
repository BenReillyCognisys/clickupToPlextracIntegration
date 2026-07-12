const crypto = require('crypto');
const axios = require('axios');
const { runPipeline } = require('../pipeline');
const { crossOffReport } = require('../pipeline/reports-due');
const log = require('../lib/logger');

// Pulls the new status name out of a taskStatusUpdated payload's history_items
// (ClickUp records the change as { field: 'status', after: { status } }). Returns
// null when there's no status change item.
function newStatusFromPayload(payload) {
  const item = (payload.history_items || []).find((h) => h.field === 'status');
  return item?.after?.status ?? null;
}

async function fetchTaskDetails(taskId) {
  try {
    const { data } = await axios.get(`https://api.clickup.com/api/v2/task/${taskId}`, {
      headers: { Authorization: process.env.CLICKUP_API_TOKEN },
    });
    return data;
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error('CLICKUP_API_TOKEN is invalid or revoked — check your .env');
    }
    throw err;
  }
}

async function handler(req, res) {
  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[ClickUp] CLICKUP_WEBHOOK_SECRET is not set');
    return res.status(500).end();
  }

  // req.body is a raw Buffer — required for correct HMAC computation
  const signature = req.headers['x-signature'];
  const computed = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  const sigBuf = Buffer.from(signature || '');
  const cmpBuf = Buffer.from(computed);
  if (sigBuf.length !== cmpBuf.length || !crypto.timingSafeEqual(sigBuf, cmpBuf)) {
    console.warn('[ClickUp] Rejected webhook — invalid signature');
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).end();
  }

  // Acknowledge immediately so ClickUp doesn't retry
  res.status(200).end();

  // A report reaching a done status crosses it off the weekly reports-due message.
  // Handled straight from the payload (no task fetch needed — crossOffReport only
  // acts when the id is already on the posted message, i.e. in the monitored space).
  if (payload.event === 'taskStatusUpdated') {
    const status = newStatusFromPayload(payload);
    try {
      const { updated } = await crossOffReport(payload.task_id, status);
      if (updated) {
        log.info('Report crossed off reports-due message', { task_id: payload.task_id, status });
      }
    } catch (err) {
      log.error('Failed to cross off report on status change', {
        reason: err.message, task_id: payload.task_id, status,
      });
    }
    return;
  }

  if (payload.event !== 'taskCreated') return;

  let task;
  try {
    task = await fetchTaskDetails(payload.task_id);
  } catch (err) {
    log.error('Failed to fetch ClickUp task details', {
      reason: err.message,
      task_id: payload.task_id,
    });
    return;
  }

  const allowedSpaceId = process.env.CLICKUP_SPACE_ID;
  if (allowedSpaceId && String(task.space?.id) !== String(allowedSpaceId)) {
    log.info('Task ignored — outside monitored space', {
      task: task.name,
      space: task.space?.name,
      space_id: task.space?.id,
    });
    return;
  }

  if (task.parent) {
    log.info('Task ignored — subtask skipped', { task: task.name, parent: task.parent });
    return;
  }

  log.info('ClickUp task received', { task: task.name, task_id: task.id });

  await runPipeline(task);
}

module.exports = handler;
