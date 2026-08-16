// Keeps a client's authorisation form in step with a ClickUp task rename.
//
// The form the SFE generates is scoped to the task's testing type: a "Black Box"
// task produces a form carrying the black-box element (its scope wording, the URL
// questions, the sign-off clauses for that test). Rename the task to "External"
// and that element is now wrong — the form still asks for a web app URL and still
// authorises a black-box test. The client name is on the form too, so a client
// rename has to be reflected as well.
//
// This module tells the portal what changed so it can re-scope the form in place:
// drop the element for the OLD testing type, add the one for the NEW type, and
// re-render under the current client name. Sending the previous values (rather
// than just the new ones) is deliberate — the portal can then remove exactly the
// element it added for this task without having to guess, which matters when a
// client's merged form carries several tasks' elements side by side.
//
// The form link may change as a result (the portal can mint a fresh token when the
// scope changes), so a new URL is written back to the task's authformlink field.
//
// Best-effort throughout, like every other rename sync: failures are logged, and
// the cases a human has to resolve (an already-signed form) are posted to Slack.
// Nothing here ever throws — a portal hiccup must not wedge the rename webhook.

const { updateAuthForm } = require('../lib/secure-portal-api');
const { createAuthFormForTask, setAuthFormLink } = require('./auth-form-create');
const log = require('../lib/logger');

const clickupTaskUrl = (taskId) => `https://app.clickup.com/t/${taskId}`;

const normalise = (s) => String(s || '').trim().toLowerCase();

// What actually changed between the old and new task names. Used to skip the portal
// call entirely when the rename touched neither field the form depends on (e.g. only
// punctuation or a suffix outside "Client | Type" moved).
function diffAuthFormFields({ oldClientName, oldTestType, clientName, testType }) {
  const clientChanged = normalise(oldClientName) !== normalise(clientName);
  const typeChanged = normalise(oldTestType) !== normalise(testType);
  return { clientChanged, typeChanged, changed: clientChanged || typeChanged };
}

// Human-readable summary of the change, for logs and Slack.
function describeChange({ oldClientName, oldTestType, clientName, testType }, diff) {
  const parts = [];
  if (diff.typeChanged) parts.push(`testing type "${oldTestType}" → "${testType}"`);
  if (diff.clientChanged) parts.push(`client "${oldClientName}" → "${clientName}"`);
  return parts.join(' and ');
}

/**
 * Re-scopes the auth form for a renamed task. Returns { formUrl, updated } when the
 * portal changed something, or null when nothing was needed / the sync failed.
 *
 * `oldClientName` / `oldTestType` come from the mapping's stored task name — i.e.
 * what the form was generated against — so they must be read before the mapping is
 * updated with the new name.
 */
async function syncAuthFormForRename(task, {
  oldClientName, oldTestType, clientName, testType, clientId, reportId,
}) {
  const diff = diffAuthFormFields({ oldClientName, oldTestType, clientName, testType });
  if (!diff.changed) return null; // form still reflects the task

  if (!process.env.SECURE_PORTAL_URL) {
    log.warn('Auth form rename — SECURE_PORTAL_URL not set; skipping form re-scope', {
      task: task.name, task_id: task.id,
    });
    return null;
  }

  const change = describeChange({ oldClientName, oldTestType, clientName, testType }, diff);

  let result;
  try {
    result = await updateAuthForm({
      clientName,
      testType,
      previousClientName: oldClientName ?? null,
      previousTestType: oldTestType ?? null,
      clickupTaskId: task.id,
      clickupTaskUrl: clickupTaskUrl(task.id),
      plextracClientId: clientId ?? null,
      plextracReportId: reportId ?? null,
      startDate: task.start_date ? Number(task.start_date) : null,
      endDate: task.due_date ? Number(task.due_date) : null,
    });
  } catch (err) {
    // 404 — the portal has no form for this task (it was created before auth-form
    // generation existed, or the original create call failed). Create one now, at the
    // new scope, rather than leaving the task without a form.
    if (err.status === 404) {
      log.info('Auth form rename — no existing form for the task; creating one at the new scope', {
        task: task.name, task_id: task.id, change,
      });
      const created = await createAuthFormForTask(task, { clientName, testType, clientId, reportId });
      return created ? { formUrl: created.formUrl, updated: true } : null;
    }

    // 409 — the portal is refusing to re-scope (a signed form, typically). Not an
    // error on our side; a human has to reissue it.
    if (err.status === 409) {
      log.warn('Auth form rename — portal refused to re-scope the form', {
        task: task.name, task_id: task.id, change, reason: err.message,
      });
      log.notify(
        `"${task.name}" was renamed (${change}) but its authorisation form could not be re-scoped ` +
        `automatically — it looks like it has already been signed. Please reissue it manually: ` +
        `${clickupTaskUrl(task.id)}`
      );
      return null;
    }

    log.error('Auth form rename — portal update failed', {
      reason: err.message, task: task.name, task_id: task.id, change,
    });
    return null;
  }

  if (!result?.ok) {
    log.error('Auth form rename — portal reported failure', {
      task: task.name, task_id: task.id, change,
      response: JSON.stringify(result ?? null).slice(0, 200),
    });
    return null;
  }

  // The portal accepted the call but chose not to change the form (already signed,
  // client opted out, …). It tells us why so the notice is actionable.
  if (result.updated === false) {
    log.warn('Auth form rename — portal left the form unchanged', {
      task: task.name, task_id: task.id, change, reason: result.reason || 'no reason given',
    });
    log.notify(
      `"${task.name}" was renamed (${change}) but its authorisation form was left unchanged ` +
      `(${result.reason || 'no reason given'}) — please check whether it needs reissuing.`
    );
    return null;
  }

  // A re-scope can mint a new token/URL; keep the task's link field pointing at the
  // live form. Best-effort — setAuthFormLink logs its own failures.
  if (result.formUrl) {
    await setAuthFormLink(task, result.formUrl);
  }

  log.info('Auth form rename — form re-scoped', {
    task: task.name, task_id: task.id, change, form_url: result.formUrl || null,
  });
  const formLink = result.formUrl ? ` <${result.formUrl}|Updated form>.` : '';
  log.notify(`Authorisation form re-scoped for "${task.name}" — ${change}.${formLink}`);

  return { formUrl: result.formUrl || null, updated: true };
}

module.exports = { syncAuthFormForRename, diffAuthFormFields };
