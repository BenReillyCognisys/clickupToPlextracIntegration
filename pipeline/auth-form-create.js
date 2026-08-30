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
// The same intake call also returns the client's test-files upload link, which is
// written to the task's "testfilesstorage" field. That link is where the client sends
// us the files the engagement needs; when they do, the portal calls back to
// POST /clickup/test-files-uploaded and the task's completion box gets ticked.
//
// Best-effort throughout: any failure is logged and swallowed so a portal hiccup
// never blocks report creation. Returns { formUrl, created, testFilesUrl } or null.

const { createAuthForm, createTestFilesLink } = require('../lib/secure-portal-api');
const { setTaskCustomField } = require('../lib/clickup-api');
const log = require('../lib/logger');

const clickupTaskUrl = (taskId) => `https://app.clickup.com/t/${taskId}`;

// Name of the ClickUp custom field the auth-form link is written to. Override with
// CLICKUP_AUTH_FORM_FIELD_NAME if the field is named differently.
const AUTH_FORM_FIELD_NAME = process.env.CLICKUP_AUTH_FORM_FIELD_NAME || 'authformlink';

// Name of the ClickUp custom field the client's test-files upload link is written to.
// This is the TEXT field holding the link — distinct from the completion box the
// portal ticks when a client uploads (that one is "testfilesstored", resolved by name
// and type in routes/clickup-actions.js). Override with
// CLICKUP_TEST_FILES_LINK_FIELD_NAME.
const TEST_FILES_FIELD_NAME = process.env.CLICKUP_TEST_FILES_LINK_FIELD_NAME || 'testfilesstorage';

// Field types a link can legitimately live in. The type check is what stops a URL
// being written into a same-named checkbox if the two are ever renamed to match.
const LINK_FIELD_TYPES = ['short_text', 'text', 'url'];

// Resolves a custom field id from the task's custom_fields by name (case-insensitive,
// trimmed), optionally restricted to a set of field types. The field appears on every
// task in its list even when unset, so this is available at create time. Returns null
// if the field isn't on the task.
function findCustomFieldId(task, name, types = null) {
  const target = name.trim().toLowerCase();
  const field = (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target
      && (!types || types.includes(f.type))
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

// Writes the portal's test-files upload link into the task's testfilesstorage field.
// Best-effort, exactly like setAuthFormLink: a missing field or API failure is logged,
// never thrown — the link lives in the portal either way, this only surfaces it.
async function setTestFilesLink(task, testFilesUrl) {
  const fieldId = findCustomFieldId(task, TEST_FILES_FIELD_NAME, LINK_FIELD_TYPES);
  if (!fieldId) {
    log.warn('Test files — custom field not found on task; cannot store link', {
      field: TEST_FILES_FIELD_NAME, task_id: task.id,
    });
    return;
  }
  try {
    await setTaskCustomField(task.id, fieldId, testFilesUrl);
    log.info('Test files — upload link written to custom field', {
      field: TEST_FILES_FIELD_NAME, task_id: task.id,
    });
  } catch (err) {
    log.error('Test files — failed to set custom field with link', {
      reason: err.message, task_id: task.id, field: TEST_FILES_FIELD_NAME,
    });
  }
}

/**
 * Gives a task a test-files upload link when it needs one but never gets an auth form
 * (a remap onto a task whose testing type is still Unknown, say). Everything else
 * picks the link up from the auth-form intake call below, which returns both.
 *
 * The portal endpoint is idempotent per ClickUp task — one link for the life of the
 * task — so this is safe to call repeatedly. Best-effort: returns the link, or null
 * on any failure, and never throws.
 */
async function ensureTestFilesLinkForTask(task, { clientName }) {
  if (!process.env.SECURE_PORTAL_URL) {
    log.warn('SECURE_PORTAL_URL not set — skipping the test-files link', { task_id: task.id });
    return null;
  }

  let result;
  try {
    result = await createTestFilesLink({
      clientName,
      clickupTaskId: task.id,
      clickupTaskUrl: clickupTaskUrl(task.id),
    });
  } catch (err) {
    log.error('Test files — portal link generation failed', {
      reason: err.message, task_id: task.id,
    });
    return null;
  }

  if (!result?.ok || !result.testFilesUrl) {
    log.error('Test files — portal returned no upload link', {
      task_id: task.id, response: JSON.stringify(result ?? null).slice(0, 200),
    });
    return null;
  }

  await setTestFilesLink(task, result.testFilesUrl);
  return result.testFilesUrl;
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

  // The same intake call returns the task's test-files upload link, so one round trip
  // fills both fields. Absent testFiles* keys mean the portal couldn't mint a link
  // this time — leave the field alone and pick it up on the next sync rather than
  // treating it as a failure of the auth form we already have.
  if (result.testFilesUrl) {
    await setTestFilesLink(task, result.testFilesUrl);
  } else {
    log.info('Test files — portal returned no upload link with the auth form', {
      task: task.name, task_id: task.id,
    });
  }

  return { formUrl: result.formUrl, created, testFilesUrl: result.testFilesUrl || null };
}

module.exports = {
  createAuthFormForTask, setAuthFormLink, setTestFilesLink, ensureTestFilesLinkForTask,
};
