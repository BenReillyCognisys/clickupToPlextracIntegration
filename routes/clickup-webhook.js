const crypto = require('crypto');
const { runPipeline } = require('../pipeline');
const { handleTaskRename } = require('../pipeline/task-rename');
const { crossOffReport } = require('../pipeline/reports-due');
const { runVmaasPipeline, handleVmaasRename, handleVmaasStatusChange } = require('../pipeline/vmaas');
const { loadMonitoredTask } = require('../pipeline/load-task');
const { withTaskLock } = require('../lib/task-lock');
const log = require('../lib/logger');

// Signing secrets to accept a payload under. ClickUp issues one secret per webhook
// and a webhook can only be scoped to a single space, so the Penetration Test and
// SecOps webhooks — both delivering to this endpoint — sign with different secrets.
function webhookSecrets() {
  return [
    process.env.CLICKUP_WEBHOOK_SECRET,
    process.env.CLICKUP_WEBHOOK_SECRET_SECOPS,
  ].filter(Boolean);
}

// True when the signature matches the HMAC under any registered secret. Every
// candidate is compared with timingSafeEqual on equal-length buffers.
function signatureMatches(rawBody, signature) {
  const sigBuf = Buffer.from(signature || '');
  return webhookSecrets().some((secret) => {
    const cmpBuf = Buffer.from(
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    );
    return sigBuf.length === cmpBuf.length && crypto.timingSafeEqual(sigBuf, cmpBuf);
  });
}

// Pulls the new status name out of a taskStatusUpdated payload's history_items
// (ClickUp records the change as { field: 'status', after: { status } }). Returns
// null when there's no status change item.
function newStatusFromPayload(payload) {
  const item = (payload.history_items || []).find((h) => h.field === 'status');
  return item?.after?.status ?? null;
}

// The name change in a taskUpdated payload, as { before, after }, or null when the
// event was some other field edit (a taskUpdated fires for many of those; we only
// act on renames). `before` is what the VMaaS pipeline tells the portal the form
// was generated against — the pentest path reads its own stored mapping instead.
function nameChangeFromPayload(payload) {
  const item = (payload.history_items || []).find((h) => h.field === 'name');
  if (!item) return null;
  return { before: item.before ?? null, after: item.after ?? null };
}

async function handler(req, res) {
  if (!webhookSecrets().length) {
    console.error('[ClickUp] No webhook signing secret is set (CLICKUP_WEBHOOK_SECRET / CLICKUP_WEBHOOK_SECRET_SECOPS)');
    return res.status(500).end();
  }

  // req.body is a raw Buffer — required for correct HMAC computation
  if (!signatureMatches(req.body, req.headers['x-signature'])) {
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

  if (payload.event === 'taskStatusUpdated') {
    const status = newStatusFromPayload(payload);

    // A pentest report reaching a done status crosses it off the weekly reports-due
    // message. Tried straight from the payload (no task fetch needed — crossOffReport
    // only acts when the id is already on the posted message, i.e. a pentest task);
    // a hit therefore also tells us the task's space without asking ClickUp.
    let crossedOff = false;
    try {
      ({ updated: crossedOff } = await crossOffReport(payload.task_id, status));
      if (crossedOff) {
        log.info('Report crossed off reports-due message', { task_id: payload.task_id, status });
      }
    } catch (err) {
      log.error('Failed to cross off report on status change', {
        reason: err.message, task_id: payload.task_id, status,
      });
    }
    if (crossedOff) return;

    // Otherwise fetch the task to see whose status changed. VMaaS has no
    // reports-due equivalent yet, so its handler only records the change.
    const { task: statusTask, pipeline: statusPipeline } = await loadMonitoredTask(payload.task_id);
    if (statusPipeline === 'vmaas') {
      await handleVmaasStatusChange(statusTask, status);
    }
    return;
  }

  // A rename (taskUpdated with a name change) is handled per space:
  //   • Penetration Test — syncs the new name into Plextrac: for a project whose
  //     report doesn't exist yet (the task was still the template "Test Task"
  //     placeholder at taskCreated time) it creates the report now; for an existing
  //     project it renames/moves the report to match.
  //   • VMaaS — the task name IS the client name, so the portal re-renders the
  //     client's auth form under it (or generates it, after a placeholder rename).
  // Other field edits on a taskUpdated are ignored here.
  // taskCreated and a near-simultaneous rename both drive the create pipeline; run
  // concurrently they'd create duplicate reports/forms. Serialise all processing for
  // a given task id so the second event runs only after the first has finished (and
  // its idempotency check can see what the first one created).
  if (payload.event === 'taskUpdated') {
    const nameChange = nameChangeFromPayload(payload);
    if (!nameChange) return;
    await withTaskLock(payload.task_id, async () => {
      const { task, pipeline } = await loadMonitoredTask(payload.task_id);
      if (!pipeline) return;
      log.info('ClickUp task renamed', {
        task: task.name, task_id: task.id, previous_name: nameChange.before || null, pipeline,
      });
      if (pipeline === 'vmaas') {
        await handleVmaasRename(task, nameChange.before);
      } else {
        await handleTaskRename(task);
      }
    });
    return;
  }

  if (payload.event !== 'taskCreated') return;

  await withTaskLock(payload.task_id, async () => {
    const { task, pipeline } = await loadMonitoredTask(payload.task_id);
    if (!pipeline) return;
    log.info('ClickUp task received', { task: task.name, task_id: task.id, pipeline });
    if (pipeline === 'vmaas') {
      await runVmaasPipeline(task);
    } else {
      await runPipeline(task);
    }
  });
}

module.exports = handler;
