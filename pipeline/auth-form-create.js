// Phase 4 of the create pipeline: ask the secure portal (SFE) to generate the
// client authorisation form for a ClickUp delivery task, then store the returned
// form link in the task's "authformlink" custom field so the PM/client can find it.
//
// The portal is idempotent on clickupTaskId (a taskCreated event and a later
// rename both drive the create pipeline), so this can run more than once for the
// same task and just gets the same form back; re-setting the custom field to the
// same value is harmless.
//
// Auth forms are generated for every testing type. When a client has several
// ClickUp tasks the SFE merges their individual forms into one link separately
// (via POST /clickup/merged-auth-form); this step only produces the per-task form.
//
// Best-effort throughout: any failure is logged and swallowed so a portal hiccup
// never blocks report creation. Returns { formUrl, created } on success, or null.

const { createAuthForm } = require('../lib/secure-portal-api');
const { setTaskCustomField } = require('../lib/clickup-api');
const log = require('../lib/logger');

const clickupTaskUrl = (taskId) => `https://app.clickup.com/t/${taskId}`;

// Name of the ClickUp custom field the auth-form link is written to. Override with
// CLICKUP_AUTH_FORM_FIELD_NAME if the field is named differently.
const AUTH_FORM_FIELD_NAME = process.env.CLICKUP_AUTH_FORM_FIELD_NAME || 'authformlink';

// Resolves a custom field id from the task's custom_fields by name (case-insensitive,
// trimmed). The field appears on every task in its list even when unset, so this is
// available at create time. Returns null if the field isn't on the task.
function findCustomFieldId(task, name) {
  const target = name.trim().toLowerCase();
  const field = (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target
  );
  return field ? field.id : null;
}

// Writes the form URL into the task's authformlink custom field. Best-effort — a
// missing field or API failure is logged, never thrown.
async function setAuthFormLink(task, formUrl) {
  const fieldId = findCustomFieldId(task, AUTH_FORM_FIELD_NAME);
  if (!fieldId) {
    log.warn('Auth form — custom field not found on task; cannot store link', {
      field: AUTH_FORM_FIELD_NAME, task_id: task.id,
    });
    return;
  }
  try {
    await setTaskCustomField(task.id, fieldId, formUrl);
    log.info('Auth form — link written to custom field', {
      field: AUTH_FORM_FIELD_NAME, task_id: task.id,
    });
  } catch (err) {
    log.error('Auth form — failed to set custom field with link', {
      reason: err.message, task_id: task.id, field: AUTH_FORM_FIELD_NAME,
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

  await setAuthFormLink(task, result.formUrl);

  return { formUrl: result.formUrl, created };
}

module.exports = { createAuthFormForTask };
