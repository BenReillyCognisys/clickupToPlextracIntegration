/**
 * SFE-portal → break.services action endpoints.
 *
 * Three server-to-server POST routes the portal calls as auth forms move through
 * intake. All three authenticate with the shared BREAK_SERVICES_API_KEY (usually
 * the same value as AVAILABILITY_API_KEY) via the X-API-Key header:
 *
 *   POST /clickup/merged-auth-form   — comment a merged auth-form link onto every
 *                                      related ClickUp task (idempotent, see below).
 *   POST /clickup/finalised-auth-form — prepend the signed auth form's Google Drive
 *                                      link to each related task's description.
 *   POST /clickup/extra-urls         — comment + alert SLACK_AUTH_FORM_CHANNEL for a
 *                                      Free Black Box form that scoped more than one URL.
 *   POST /clickup/schedule-task      — write resolved start/due dates onto an
 *                                      existing ClickUp task.
 *
 * Idempotent-comment strategy (endpoint 1): the portal re-sends the same merged
 * form every time a new task for that client arrives, so this endpoint is called
 * repeatedly for the same set of tasks. To avoid stacking a fresh comment on each
 * call, every comment is prefixed with a stable marker `[merged-auth-form:<token>]`
 * keyed on the merged form's token. Before commenting on a task we list its
 * comments and look for that marker: found → PUT (update the existing comment),
 * not found → POST (create it). One merged form therefore yields at most one
 * comment per task, refreshed in place as the test-type/day set grows.
 */

const express = require('express');
const crypto = require('crypto');
const {
  listTaskComments,
  createTaskComment,
  updateComment,
  updateTaskSchedule,
  getTaskDescription,
  updateTaskDescription,
} = require('../lib/clickup-api');
const { prependFinalisedAuthForm } = require('../lib/auth-form-description');
const { cache, getMembersMap, findUserInMap } = require('../lib/availability-cache');
const { postMessage } = require('../lib/slack');
const log = require('../lib/logger');

const router = express.Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Constant-time key comparison — lengths first (timingSafeEqual throws on a length
// mismatch), then the bytes, so the check never short-circuits on the first
// differing character. Mirrors the timing-safe checks elsewhere in this service.
function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireBreakServicesKey(req, res, next) {
  const expected = process.env.BREAK_SERVICES_API_KEY;
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}

router.use(requireBreakServicesKey);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clickupTaskUrl = (taskId) => `https://app.clickup.com/t/${taskId}`;

// ─── POST /clickup/merged-auth-form ───────────────────────────────────────────
// Comments the merged auth-form link onto every related ClickUp task, idempotently
// (see the marker strategy in the file header).
router.post('/merged-auth-form', async (req, res) => {
  const {
    clientName,
    mergedFormUrl,
    mergedFormToken,
    clickupTaskIds,
    testTypes,
    dayCount,
  } = req.body || {};

  if (!clientName || !mergedFormUrl || !Array.isArray(clickupTaskIds) || clickupTaskIds.length === 0) {
    return res.status(400).json({
      error: 'clientName, mergedFormUrl, and a non-empty clickupTaskIds array are required',
    });
  }

  // The token anchors idempotency; fall back to the URL if the portal omits it so
  // repeat calls still collapse onto one comment per task.
  const marker = `[merged-auth-form:${mergedFormToken || mergedFormUrl}]`;
  const typesText = Array.isArray(testTypes) && testTypes.length ? testTypes.join(', ') : 'test';
  const daysText = dayCount != null ? `, ~${dayCount} days` : '';
  const commentText = `${marker} Merged authorisation form for ${clientName} (${typesText}${daysText}): ${mergedFormUrl}`;

  const results = [];
  for (const taskId of clickupTaskIds) {
    try {
      const comments = await listTaskComments(taskId);
      const existing = comments.find((c) => (c.comment_text || '').includes(marker));
      if (existing) {
        await updateComment(existing.id, commentText);
        results.push({ taskId, action: 'updated', commentId: existing.id });
      } else {
        const commentId = await createTaskComment(taskId, commentText);
        results.push({ taskId, action: 'created', commentId });
      }
    } catch (err) {
      log.error('Merged auth-form comment failed', { taskId, reason: err.message });
      results.push({ taskId, action: 'failed', error: err.message });
    }
  }

  const allFailed = results.every((r) => r.action === 'failed');
  res.status(allFailed ? 502 : 200).json({ ok: !allFailed, results });
});

// ─── POST /clickup/finalised-auth-form ────────────────────────────────────────
// The SFE has finalised the client's authorisation form and uploaded it to Google
// Drive. Prepend a link to that Drive file at the top of each related ClickUp task's
// description (keeping the original text below), so the consultant has the signed
// form to hand. Accepts a single clickupTaskId or a clickupTaskIds array (a merged
// form covers several tasks). Idempotent: a re-send replaces the block in place.
router.post('/finalised-auth-form', async (req, res) => {
  const { clientName, driveUrl, clickupTaskIds, clickupTaskId } = req.body || {};

  const taskIds = Array.isArray(clickupTaskIds) && clickupTaskIds.length
    ? clickupTaskIds
    : (clickupTaskId ? [clickupTaskId] : []);

  if (!driveUrl || taskIds.length === 0) {
    return res.status(400).json({
      error: 'driveUrl and at least one of clickupTaskId / clickupTaskIds are required',
    });
  }

  const results = [];
  for (const taskId of taskIds) {
    try {
      const existing = await getTaskDescription(taskId);
      const updated = prependFinalisedAuthForm(existing, driveUrl, clientName);
      await updateTaskDescription(taskId, updated);
      results.push({ taskId, action: 'updated' });
    } catch (err) {
      log.error('Finalised auth-form description update failed', { taskId, reason: err.message });
      results.push({ taskId, action: 'failed', error: err.message });
    }
  }

  const allFailed = results.every((r) => r.action === 'failed');
  res.status(allFailed ? 502 : 200).json({ ok: !allFailed, results });
});

// ─── POST /clickup/extra-urls ─────────────────────────────────────────────────
// A Free Black Box form scoped more than one URL: comment on the task (if any) and
// always alert Slack. The two actions are independent — one failing never aborts
// the other.
router.post('/extra-urls', async (req, res) => {
  const {
    clientName,
    formToken,
    formUrl,
    clickupTaskId,
    urls,
    urlCount,
  } = req.body || {};

  if (!clientName || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'clientName and a non-empty urls array are required' });
  }

  const count = urlCount != null ? urlCount : urls.length;
  const urlsText = urls.join(', ');
  const authFormText = formUrl ? ` Auth form: ${formUrl}` : '';
  const summary = `⚠️ Free Black Box for ${clientName} submitted ${count} URLs ` +
    `(additional hosts may incur extra cost): ${urlsText}.${authFormText}`;

  // 1) ClickUp comment — only when the form came from a ClickUp task. Not required
  //    to be idempotent (each submission is a distinct event).
  let clickup = 'skipped';
  if (clickupTaskId) {
    try {
      await createTaskComment(clickupTaskId, summary);
      clickup = 'commented';
    } catch (err) {
      log.error('Extra-URLs ClickUp comment failed', {
        clickupTaskId, formToken: formToken || null, reason: err.message,
      });
      clickup = 'failed';
    }
  }

  // 2) Slack alert — always. Link the ClickUp task too when we have one.
  let slack = 'failed';
  try {
    // Free Black Box extra-URL alerts always go to this channel (hardcoded).
    const channel = 'C0B9D6487HR';
    const taskLink = clickupTaskId ? ` ClickUp task: ${clickupTaskUrl(clickupTaskId)}` : '';
    await postMessage(channel, `${summary}${taskLink}`);
    slack = 'sent';
  } catch (err) {
    log.error('Extra-URLs Slack alert failed', {
      clientName, formToken: formToken || null, reason: err.message,
    });
    slack = 'failed';
  }

  // "skipped" is not itself a failure, but if there was no comment to make AND
  // Slack failed there is no successful action to report → 502.
  const anySuccess = clickup === 'commented' || slack === 'sent';
  res.status(anySuccess ? 200 : 502).json({ ok: anySuccess, clickup, slack });
});

// ─── POST /clickup/schedule-task ──────────────────────────────────────────────
// Writes resolved start/due dates onto an existing ClickUp task. Optionally sets
// the assignee from `consultant`; assignee resolution failure is non-fatal.
router.post('/schedule-task', async (req, res) => {
  const {
    clickupTaskId,
    startDate,
    endDate,
    consultant,
    testType,
    days,
  } = req.body || {};

  if (!clickupTaskId || !startDate || !endDate) {
    return res.status(400).json({ error: 'clickupTaskId, startDate, and endDate are required' });
  }

  // yyyy-mm-dd → unix ms at UTC midnight (all-day dates).
  const startDateMs = Date.parse(`${startDate}T00:00:00Z`);
  const dueDateMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startDateMs) || !Number.isFinite(dueDateMs)) {
    return res.status(400).json({ error: 'startDate and endDate must be yyyy-mm-dd dates' });
  }

  // Optional assignee resolution — best effort, never blocks the date write.
  let assigneeId = null;
  if (consultant) {
    try {
      const membersMap = cache.availability?.membersMap || (await getMembersMap());
      assigneeId = findUserInMap(consultant, membersMap);
      if (assigneeId == null) {
        log.warn('Schedule-task could not resolve consultant to a ClickUp user', {
          clickupTaskId, consultant,
        });
      }
    } catch (err) {
      log.warn('Schedule-task consultant resolution failed', {
        clickupTaskId, consultant, reason: err.message,
      });
      assigneeId = null;
    }
  }

  try {
    await updateTaskSchedule(clickupTaskId, { startDateMs, dueDateMs, assigneeId });
    log.info('Schedule-task updated ClickUp task dates', {
      clickupTaskId, startDate, endDate, testType: testType || null, days: days ?? null,
      assigneeId: assigneeId ?? null,
    });
    res.status(200).json({ ok: true, taskId: clickupTaskId, start_date: startDateMs, due_date: dueDateMs });
  } catch (err) {
    log.error('Schedule-task update failed', { clickupTaskId, reason: err.message });
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
