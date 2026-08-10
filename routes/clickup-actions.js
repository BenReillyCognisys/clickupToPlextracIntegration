/**
 * SFE-portal → break.services action endpoints.
 *
 * Three server-to-server POST routes the portal calls as auth forms move through
 * intake. All three authenticate with the shared BREAK_SERVICES_API_KEY (usually
 * the same value as AVAILABILITY_API_KEY) via the X-API-Key header:
 *
 *   POST /clickup/merged-auth-form   — comment a merged auth-form link onto every
 *                                      related ClickUp task (idempotent, see below).
 *   POST /clickup/finalised-auth-form — download the signed auth form from Google
 *                                      Drive and store it on each related task's
 *                                      "Authorisation Forms" File custom field.
 *   POST /clickup/extra-urls         — comment + alert SLACK_AUTH_FORM_CHANNEL for a
 *                                      Free Black Box form that scoped more than one URL.
 *   POST /clickup/schedule-task      — write resolved start/due dates onto an
 *                                      existing ClickUp task. A repeat Free Black Box
 *                                      submission (task already scheduled) is a no-op.
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
  uploadCustomFieldAttachment,
  setTaskCustomField,
  getTask,
} = require('../lib/clickup-api');
const { downloadDriveFile } = require('../lib/google-drive');
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

// Name of the File-type ClickUp custom field the finalised auth form is stored in.
// Override with CLICKUP_AUTH_FORM_FILE_FIELD_NAME if it's named differently. (This is
// the file field, distinct from the auth-form *link* field CLICKUP_AUTH_FORM_FIELD_NAME.)
const AUTH_FORM_FILE_FIELD_NAME = process.env.CLICKUP_AUTH_FORM_FILE_FIELD_NAME || 'Authorisation Forms';

// Resolves a custom field id from a task's custom_fields by name (case-insensitive,
// trimmed). The field appears on every task in its list even when unset. Returns null
// when the field isn't on the task.
function findCustomFieldId(task, name) {
  const target = name.trim().toLowerCase();
  const field = (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target,
  );
  return field ? field.id : null;
}

// A Free Black Box lets the client (re)submit their auth form; identify it from the
// test type so a repeat submission can be treated as a no-op for scheduling.
function isFreeBlackBox(testType) {
  return /free\s*black\s*box/i.test(String(testType || ''));
}

// The name the finalised auth form is stored under in ClickUp. Prefer the original
// Drive filename; fall back to a client-labelled default when Drive gives us none.
function authFormFilename(driveName, clientName) {
  if (driveName) return driveName;
  return clientName ? `Authorisation Form - ${clientName}.pdf` : 'Authorisation Form.pdf';
}

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
// Drive. Download that file and store it on each related task's "Authorisation Forms"
// File custom field, so the consultant has the signed form to hand. Accepts a single
// clickupTaskId or a clickupTaskIds array (a merged form covers several tasks). The
// file is fetched once and uploaded to each task's field.
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

  // Fetch the finalised form from Drive once — every related task gets the same file.
  // A download failure is fatal here: there's nothing to attach.
  let file;
  try {
    file = await downloadDriveFile(driveUrl);
  } catch (err) {
    log.error('Finalised auth-form download failed', { driveUrl, reason: err.message });
    return res.status(502).json({ ok: false, error: `could not download auth form: ${err.message}` });
  }

  const filename = authFormFilename(file.filename, clientName);

  const workspaceId = process.env.CLICKUP_TEAM_ID;
  if (!workspaceId) {
    log.error('Finalised auth-form cannot upload — CLICKUP_TEAM_ID is not set');
    return res.status(500).json({ ok: false, error: 'CLICKUP_TEAM_ID is not set' });
  }

  // For each task: resolve the "Authorisation Forms" File custom field, upload the
  // file to that field (V3), then associate the resulting attachment with the task.
  // Uploading per task keeps each task's field pointing at its own attachment.
  const results = [];
  for (const taskId of taskIds) {
    try {
      const task = await getTask(taskId);
      const fieldId = findCustomFieldId(task, AUTH_FORM_FILE_FIELD_NAME);
      if (!fieldId) {
        throw new Error(`custom field "${AUTH_FORM_FILE_FIELD_NAME}" not found on task`);
      }
      const attachment = await uploadCustomFieldAttachment(workspaceId, fieldId, file.buffer, filename);
      await setTaskCustomField(taskId, fieldId, { add: [attachment.id], rem: [] });
      results.push({ taskId, action: 'attached' });
    } catch (err) {
      log.error('Finalised auth-form attachment failed', { taskId, reason: err.message });
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
    const channel = 'C0AA3SNQUKE';
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

  // Free Black Box forms can be submitted more than once: the first submission fixes
  // the schedule and later ones must not move it. If this is a Free Black Box task
  // that already has a start date, skip the whole update (no dates, no assignee). A
  // read failure is non-fatal — we fall through and treat it as a first submission
  // rather than block one on a transient hiccup.
  if (isFreeBlackBox(testType)) {
    let existing = null;
    try {
      existing = await getTask(clickupTaskId);
    } catch (err) {
      log.warn('Schedule-task could not read task to check for a repeat submission', {
        clickupTaskId, reason: err.message,
      });
    }
    if (existing && existing.start_date) {
      log.info('Schedule-task skipped — Free Black Box already scheduled (repeat submission)', {
        clickupTaskId, testType,
      });
      return res.status(200).json({
        ok: true,
        taskId: clickupTaskId,
        skipped: true,
        start_date: Number(existing.start_date),
        due_date: existing.due_date != null ? Number(existing.due_date) : null,
      });
    }
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
