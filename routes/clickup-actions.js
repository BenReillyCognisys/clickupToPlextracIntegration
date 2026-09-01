/**
 * SFE-portal → break.services action endpoints.
 *
 * Server-to-server POST routes the portal calls as an engagement moves through
 * intake. They all authenticate with the shared BREAK_SERVICES_API_KEY (usually
 * the same value as AVAILABILITY_API_KEY) via the X-API-Key header:
 *
 *   POST /clickup/merged-auth-form   — comment a merged auth-form link onto every
 *                                      related ClickUp task (idempotent, see below).
 *   POST /clickup/finalised-auth-form — download the signed auth form from Google
 *                                      Drive, store it on each related task's
 *                                      "Authorisation Forms" File custom field,
 *                                      prepend its link to the task description, and
 *                                      advance the task to the pre-reqs status.
 *   POST /clickup/extra-urls         — comment + alert SLACK_AUTH_FORM_CHANNEL for a
 *                                      Free Black Box form that scoped more than one URL.
 *   POST /clickup/schedule-task      — write resolved start/due dates onto an
 *                                      existing ClickUp task, assign the consultant,
 *                                      and record the client's report deadline. The
 *                                      dates and the deadline are independently
 *                                      optional (no slot before the deadline means
 *                                      the deadline arrives on its own). A repeat
 *                                      Free Black Box submission does not move an
 *                                      existing booking.
 *   POST /clickup/test-files-uploaded — a client uploaded their test files to the
 *                                      portal: tick the task's completion box.
 *                                      Called on every upload, so re-ticking is a
 *                                      no-op.
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
  updateTaskStatus,
  uploadCustomFieldAttachment,
  setTaskCustomField,
  getTask,
  getTaskDescription,
  updateTaskDescription,
  setChecklistItemResolved,
} = require('../lib/clickup-api');
const { downloadDriveFile, fileIdFromUrl } = require('../lib/google-drive');
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

// Resolves a custom field on a task by name (case-insensitive, trimmed), optionally
// requiring a ClickUp field type — two fields on the same list can share a name when
// their types differ, and the test-files link (short_text) and completion box
// (checkbox) are exactly that case. A field appears on every task in its list even
// when unset, so finding nothing means it isn't configured for that list at all.
function findCustomField(task, name, type = null) {
  const target = name.trim().toLowerCase();
  return (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target && (!type || f.type === type),
  ) || null;
}

// As above, but just the id — what the callers that only write a value need.
function findCustomFieldId(task, name) {
  const field = findCustomField(task, name);
  return field ? field.id : null;
}

// Label prefixing the auth-form line at the top of the task description. Doubles as the
// idempotency marker: if the description already carries this label we don't prepend
// again, so a repeat finalised-auth-form call never stacks duplicate links.
const AUTH_FORM_DESC_LABEL = '📄 **Authorisation form:**';

// Prepends the auth-form link to the top of the task's description without disturbing
// the existing text. Idempotent (skips when the label is already present). Returns
// 'updated' when it wrote the link, 'skipped' when it was already there.
async function prependAuthFormLink(taskId, url) {
  const existing = await getTaskDescription(taskId);
  if (existing.includes(AUTH_FORM_DESC_LABEL)) return 'skipped';
  const header = `${AUTH_FORM_DESC_LABEL} ${url}`;
  const next = existing.trim() ? `${header}\n\n${existing}` : header;
  await updateTaskDescription(taskId, next);
  return 'updated';
}

// A Free Black Box lets the client (re)submit their auth form; identify it from the
// test type so a repeat submission can be treated as a no-op for scheduling.
function isFreeBlackBox(testType) {
  return /free\s*black\s*box/i.test(String(testType || ''));
}

// ─── Pre-reqs status advance ──────────────────────────────────────────────────
// Once the signed auth form is attached to a task, the paperwork is done and the
// only thing outstanding is the client's pre-reqs — so the task advances to this
// status. Must match a status defined in the pentest space exactly; list them with
// `node scripts/list-statuses.js`.
const PRE_REQS_STATUS = process.env.CLICKUP_STATUS_PRE_REQS || 'Waiting for Pre-reqs';

// Only tasks currently sitting in one of these statuses are advanced. The finalised
// form can arrive late, or be re-sent for a client whose other tasks are already
// under way, and moving a task in QA (or Completed) back to pre-reqs would be worse
// than leaving it alone. Compared case-insensitively against ClickUp's status name.
const PRE_REQS_FROM_STATUSES = (process.env.CLICKUP_PRE_REQS_FROM_STATUSES || 'to do,open,scheduled')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Advances a task to PRE_REQS_STATUS if its current status allows it. Takes the
 * already-fetched task so this costs no extra read. Returns what happened:
 *   'set'          — status written
 *   'already_set'  — task was already in the pre-reqs status
 *   'skipped'      — current status isn't one we advance from (logged with the status)
 *   'failed'       — ClickUp rejected the write (logged; never thrown)
 */
async function advanceToPreReqs(task) {
  const current = task?.status?.status || '';
  const currentLower = current.trim().toLowerCase();

  if (currentLower === PRE_REQS_STATUS.trim().toLowerCase()) return 'already_set';

  if (!PRE_REQS_FROM_STATUSES.includes(currentLower)) {
    log.info('Finalised auth-form — pre-reqs status skipped, task has moved on', {
      taskId: task.id, current_status: current || null, status_type: task?.status?.type || null,
    });
    return 'skipped';
  }

  try {
    await updateTaskStatus(task.id, PRE_REQS_STATUS);
    log.info('Finalised auth-form — task advanced to the pre-reqs status', {
      taskId: task.id, from: current, to: PRE_REQS_STATUS,
    });
    return 'set';
  } catch (err) {
    log.error('Finalised auth-form — could not set the pre-reqs status', {
      taskId: task.id, status: PRE_REQS_STATUS, reason: err.message,
    });
    return 'failed';
  }
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
// File custom field, and prepend the form link to the top of the task description
// (without disturbing existing text), so the consultant has the signed form to hand.
// Accepts a single clickupTaskId or a clickupTaskIds array (a merged form covers
// several tasks). The file is fetched once and uploaded to each task's field.
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

  // Reject anything that isn't a genuine Drive share link up front (a bad link is a
  // client error, not an upstream failure). downloadDriveFile re-validates.
  if (!fileIdFromUrl(driveUrl)) {
    return res.status(400).json({ error: 'driveUrl is not a valid Google Drive file link' });
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

      // Also surface the form link at the top of the description. Uses the canonical
      // link rebuilt from the file id, never the caller's raw string, so nothing can be
      // smuggled into the description's markdown. Best-effort: the file is already on
      // the field, so a description hiccup must not fail the task.
      let description = 'skipped';
      try {
        description = await prependAuthFormLink(taskId, file.canonicalUrl);
      } catch (err) {
        log.error('Finalised auth-form description update failed', { taskId, reason: err.message });
        description = 'failed';
      }

      // The signed form is now on the task, so the paperwork is complete — advance it
      // to the pre-reqs status. Best-effort and guarded on the current status, for the
      // same reason as the description: the file is already attached, so nothing here
      // may fail the task or the whole request.
      const status = await advanceToPreReqs(task);

      results.push({ taskId, action: 'attached', description, status });
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

// ─── Report deadline ──────────────────────────────────────────────────────────
// Some jobs let the client pick the date they need the report by, and the portal sends
// that date on every schedule-task call. It is not a booking: availability may find no
// slot before it, in which case the deadline arrives on its own with no dates attached.
// Either way it is the date the client committed to, so it is always recorded.

// Date-type ClickUp custom field the deadline is written to. It is the only place the
// deadline is recorded — the deadline is never commented onto the task.
const REPORT_DEADLINE_FIELD_NAME = process.env.CLICKUP_REPORT_DUE_FIELD_NAME || 'Report Due';

/**
 * Records the client's report deadline on the task's REPORT_DEADLINE_FIELD_NAME date
 * custom field and returns { field } describing what happened. Never throws — the date
 * write must not fail because the deadline couldn't be recorded, and vice versa.
 *
 * `task` is the already-fetched task (null when the read failed, in which case we can't
 * see the field, so there is nowhere to put the deadline).
 *
 *   field: 'set' | 'absent' | 'failed'
 */
async function recordReportDeadline(taskId, { deadlineMs, reportDeadline, task }) {
  const dateField = task ? findCustomField(task, REPORT_DEADLINE_FIELD_NAME) : null;
  if (!dateField || dateField.type !== 'date') return { field: 'absent' };

  try {
    await setTaskCustomField(taskId, dateField.id, deadlineMs);
    return { field: 'set' };
  } catch (err) {
    log.error('Schedule-task could not write the report deadline custom field', {
      taskId, fieldId: dateField.id, reportDeadline, reason: err.message,
    });
    return { field: 'failed' };
  }
}

// True once the deadline has actually landed on the task.
function deadlineRecorded(deadline) {
  return !!deadline && deadline.field === 'set';
}

// ─── POST /clickup/schedule-task ──────────────────────────────────────────────
// Writes resolved start/due dates onto an existing ClickUp task and records the client's
// report deadline. The two are independent: when availability finds no slot before the
// deadline the portal still calls this with `startDate`/`endDate` null, so the date the
// client picked reaches the task even though there is nothing to book. At least one of
// (both dates) / reportDeadline must be present. Optionally sets the assignee from
// `consultant`; assignee resolution failure is non-fatal.
router.post('/schedule-task', async (req, res) => {
  const {
    clickupTaskId,
    startDate,
    endDate,
    consultant,
    testType,
    days,
    reportDeadline,
    note,
  } = req.body || {};

  const hasDates = startDate != null && endDate != null;
  if (!clickupTaskId || (!hasDates && !reportDeadline)) {
    return res.status(400).json({
      error: 'clickupTaskId, plus either both startDate and endDate or reportDeadline, are required',
    });
  }

  // yyyy-mm-dd → unix ms at UTC midnight (all-day dates).
  let startDateMs = null;
  let dueDateMs = null;
  if (hasDates) {
    startDateMs = Date.parse(`${startDate}T00:00:00Z`);
    dueDateMs = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isFinite(startDateMs) || !Number.isFinite(dueDateMs)) {
      return res.status(400).json({ error: 'startDate and endDate must be yyyy-mm-dd dates' });
    }
  }

  let deadlineMs = null;
  if (reportDeadline != null) {
    deadlineMs = Date.parse(`${reportDeadline}T00:00:00Z`);
    if (!Number.isFinite(deadlineMs)) {
      return res.status(400).json({ error: 'reportDeadline must be a yyyy-mm-dd date' });
    }
  }

  // A Free Black Box is a half-day (0.5) engagement, so it must sit on ONE day in
  // ClickUp — same start and due date. Callers commonly send the following day as
  // the end date, which reads as a 2-day booking on the board and in availability,
  // so collapse the due date onto the start date rather than trusting it.
  if (hasDates && isFreeBlackBox(testType) && dueDateMs !== startDateMs) {
    log.info('Schedule-task collapsed a Free Black Box to a single day', {
      clickupTaskId, startDate, requested_end_date: endDate,
    });
    dueDateMs = startDateMs;
  }

  // One read serves both the deadline's custom-field lookup and the Free Black Box
  // repeat-submission guard below. A read failure is non-fatal to either: the deadline
  // write is skipped (logged, and reported as `field: 'absent'`), and scheduling treats
  // it as a first submission rather than blocking a booking on a transient hiccup.
  let task = null;
  if (deadlineMs != null || isFreeBlackBox(testType)) {
    try {
      task = await getTask(clickupTaskId);
    } catch (err) {
      log.warn('Schedule-task could not read the task', { clickupTaskId, reason: err.message });
    }
  }

  // Record the deadline before anything below can return early: it must land on every
  // call, including the repeat Free Black Box submission that writes no dates at all.
  let deadline = null;
  if (deadlineMs != null) {
    deadline = await recordReportDeadline(clickupTaskId, { deadlineMs, reportDeadline, task });
    // The client's free-text scheduling note is no longer put on the task, so the log
    // is the only record of it — keep it here, capped so a runaway paste can't flood.
    log.info('Schedule-task recorded the client report deadline', {
      clickupTaskId, reportDeadline, field: deadline.field,
      note: String(note ?? '').trim().slice(0, 500) || null,
    });
  }

  // Free Black Box forms can be submitted more than once: the first submission fixes
  // the schedule and later ones must not move it. If this is a Free Black Box task
  // that already has a start date, skip the date update (no dates, no assignee) — the
  // deadline above is still refreshed, since the client may have changed it.
  if (isFreeBlackBox(testType) && task && task.start_date) {
    log.info('Schedule-task skipped — Free Black Box already scheduled (repeat submission)', {
      clickupTaskId, testType,
    });
    return res.status(200).json({
      ok: true,
      taskId: clickupTaskId,
      skipped: true,
      start_date: Number(task.start_date),
      due_date: task.due_date != null ? Number(task.due_date) : null,
      deadline,
    });
  }

  // No slot was free before the client's deadline, so there is nothing to book: the
  // deadline is the entire payload. No assignee either — there is no booking to put
  // anyone on. If the deadline never reached the field then the call achieved nothing,
  // so say so rather than reporting success the portal would audit as sent.
  if (!hasDates) {
    if (!deadlineRecorded(deadline)) {
      return res.status(502).json({
        ok: false,
        taskId: clickupTaskId,
        deadline,
        error: 'could not record the report deadline on the task',
      });
    }
    return res.status(200).json({
      ok: true, taskId: clickupTaskId, start_date: null, due_date: null, deadline,
    });
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
      clickupTaskId, startDate,
      endDate: new Date(dueDateMs).toISOString().slice(0, 10),
      testType: testType || null, days: days ?? null,
      assigneeId: assigneeId ?? null,
      reportDeadline: reportDeadline || null,
    });

    res.status(200).json({
      ok: true, taskId: clickupTaskId, start_date: startDateMs, due_date: dueDateMs, deadline,
    });
  } catch (err) {
    log.error('Schedule-task update failed', { clickupTaskId, reason: err.message });
    res.status(502).json({ ok: false, error: err.message, deadline });
  }
});

// ─── Test files uploaded ──────────────────────────────────────────────────────
// The portal hosts a per-task upload link clients use to send us the files an
// engagement needs (source archives, VPN packs, sample data). On every successful
// upload the portal calls the endpoint below and we tick the task's completion box.
//
// Two similarly named fields are in play and they are NOT the same thing:
//   testfilesstorage (short_text) — holds the upload LINK, written by the create
//                                   pipeline (pipeline/auth-form-create.js).
//   testfilesstored  (checkbox)   — the completion box ticked here.
// ClickUp won't take two fields with the same name on one list, so the box is the one
// that got renamed. Accepted names are a list, so the original "testfilesstorage"
// naming (and any future rename) still resolves without a code change.
const TEST_FILES_DONE_NAMES = (process.env.CLICKUP_TEST_FILES_DONE_FIELD_NAME || 'testfilesstored,testfilesstorage')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// A ClickUp checkbox custom field reads back as a boolean or as the string "true".
function isTicked(value) {
  return value === true || value === 'true';
}

// Finds the completion box as a Checkbox custom field, trying each accepted name in
// order. The type check matters: "testfilesstorage" is also the name of the short_text
// field holding the link, so a name-only match could tick the wrong field entirely.
function findTestFilesCheckbox(task) {
  for (const name of TEST_FILES_DONE_NAMES) {
    const field = findCustomField(task, name, 'checkbox');
    if (field) return field;
  }
  return null;
}

// The same box modelled the other way — as an item on one of the task's checklists.
// Returns { checklistId, item } (the update needs the checklist id, not the task id).
function findTestFilesChecklistItem(task) {
  for (const checklist of task.checklists || []) {
    for (const item of checklist.items || []) {
      if (TEST_FILES_DONE_NAMES.includes((item.name || '').trim().toLowerCase())) {
        return { checklistId: checklist.id, item };
      }
    }
  }
  return null;
}

// ─── POST /clickup/test-files-uploaded ────────────────────────────────────────
// A client has uploaded the files their engagement needs to the portal's per-task
// upload link. Tick the task's completion box — that is the whole job; the upload
// itself is recorded in the portal, not on the ClickUp task.
//
// Called on EVERY successful upload, not just the first: a client can come back with
// more files after the box is ticked. A re-tick is skipped and still answers 200, so
// repeat uploads leave no trace here at all.
//
// The upload's details (file count, archive name, timestamp) are logged rather than
// written to the task, so a client's submission history stays in one place.
router.post('/test-files-uploaded', async (req, res) => {
  const { clickupTaskId, clientName, fileCount, archiveName, submittedAt } = req.body || {};

  if (!clickupTaskId) {
    return res.status(400).json({ error: 'clickupTaskId is required' });
  }

  // The task read resolves the completion box (custom field or checklist item) and
  // tells us whether it's already ticked. Fatal — without it there's nothing to act on.
  let task;
  try {
    task = await getTask(clickupTaskId);
  } catch (err) {
    log.error('Test-files upload — could not read the ClickUp task', {
      clickupTaskId, reason: err.message,
    });
    return res.status(502).json({ ok: false, error: err.message });
  }

  // Checkbox custom field first, then a checklist item, then neither.
  let marked = false;
  let via = null;
  let ticked = 'none';
  try {
    const checkbox = findTestFilesCheckbox(task);
    if (checkbox) {
      via = 'custom_field';
      marked = true;
      if (isTicked(checkbox.value)) {
        ticked = 'already';
      } else {
        await setTaskCustomField(clickupTaskId, checkbox.id, true);
        ticked = 'set';
      }
    } else {
      const found = findTestFilesChecklistItem(task);
      if (found) {
        via = 'checklist_item';
        marked = true;
        if (found.item.resolved) {
          ticked = 'already';
        } else {
          await setChecklistItemResolved(found.checklistId, found.item.id, true);
          ticked = 'set';
        }
      }
    }
  } catch (err) {
    log.error('Test-files upload — could not tick the completion box', {
      clickupTaskId, via, reason: err.message,
    });
    return res.status(502).json({ ok: false, error: err.message });
  }

  // A missing box is not an upload failure: the files are already safely stored in the
  // portal, and a task with no box is a ClickUp configuration problem for a human — so
  // it is logged and reported, never thrown.
  if (!marked) {
    log.warn('Test-files upload — no completion box on the task', {
      clickupTaskId, client: clientName || null, looked_for: TEST_FILES_DONE_NAMES.join(', '),
    });
    return res.status(200).json({
      ok: true,
      marked: false,
      taskId: clickupTaskId,
      reason: 'no testfilesstorage field or checklist item',
    });
  }

  // The upload's own details live only here: nothing about them is written to the task.
  log.info('Test-files upload recorded on the ClickUp task', {
    clickupTaskId, client: clientName || null, file_count: fileCount ?? null,
    archive: archiveName || null, submitted_at: submittedAt || null, via, ticked,
  });

  return res.status(200).json({ ok: true, marked: true, taskId: clickupTaskId, via, ticked });
});

module.exports = router;
