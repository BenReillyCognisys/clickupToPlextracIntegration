// Phase 4 of the create pipeline: ask the secure portal (SFE) to generate the
// client authorisation form for a ClickUp delivery task, then comment the returned
// form link back onto the task so the PM/client can find it.
//
// The portal is idempotent on clickupTaskId (a taskCreated event and a later
// rename both drive the create pipeline), so this can run more than once for the
// same task and just gets the same form back. The comment is likewise made
// idempotent with a stable [auth-form:<token>] marker — one comment per form,
// refreshed in place — mirroring the marker strategy in routes/clickup-actions.js.
//
// Auth forms are generated for every testing type. When a client has several
// ClickUp tasks the SFE merges their individual forms into one link separately
// (via POST /clickup/merged-auth-form); this step only produces the per-task form.
//
// Best-effort throughout: any failure is logged and swallowed so a portal hiccup
// never blocks report creation. Returns { formUrl, created } on success, or null.

const { createAuthForm } = require('../lib/secure-portal-api');
const { listTaskComments, createTaskComment, updateComment } = require('../lib/clickup-api');
const log = require('../lib/logger');

const clickupTaskUrl = (taskId) => `https://app.clickup.com/t/${taskId}`;

// Comments the auth-form link onto the task idempotently: a stable marker keyed on
// the form token means a repeat run updates the existing comment instead of stacking
// a new one. Best-effort — a comment failure never fails the step.
async function commentAuthForm(taskId, clientName, testType, formUrl, formToken) {
  const marker = `[auth-form:${formToken || formUrl}]`;
  const commentText = `${marker} Authorisation form for ${clientName} (${testType}): ${formUrl}`;
  try {
    const comments = await listTaskComments(taskId);
    const existing = comments.find((c) => (c.comment_text || '').includes(marker));
    if (existing) {
      await updateComment(existing.id, commentText);
    } else {
      await createTaskComment(taskId, commentText);
    }
  } catch (err) {
    log.error('Auth form — failed to comment link onto ClickUp task', {
      reason: err.message, task_id: taskId,
    });
  }
}

async function createAuthFormForTask(task, { clientName, testType, clientId, reportId }) {
  if (!process.env.SECURE_PORTAL_URL) {
    log.warn('SECURE_PORTAL_URL not set — skipping auth-form generation', { task: task.name });
    return null;
  }

  let result;
  try {
    result = await createAuthForm({
      clientName,
      testType,
      clickupTaskId: task.id,
      clickupTaskUrl: clickupTaskUrl(task.id),
      plextracClientId: clientId ?? null,
      plextracReportId: reportId ?? null,
      startDate: task.start_date ? Number(task.start_date) : null,
      endDate: task.due_date ? Number(task.due_date) : null,
    });
  } catch (err) {
    log.error('Auth form — portal generation failed', {
      reason: err.message, task: task.name, task_id: task.id,
    });
    return null;
  }

  if (!result?.ok || !result.formUrl) {
    log.error('Auth form — portal returned no form URL', {
      task: task.name, task_id: task.id,
      response: JSON.stringify(result ?? null).slice(0, 200),
    });
    return null;
  }

  const created = result.created !== false;
  log.info('Auth form generated', {
    task: task.name, task_id: task.id, form_url: result.formUrl, created,
  });

  await commentAuthForm(task.id, clientName, testType, result.formUrl, result.formToken);

  return { formUrl: result.formUrl, created };
}

module.exports = { createAuthFormForTask };
