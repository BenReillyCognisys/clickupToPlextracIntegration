// VMaaS pipeline (SecOps space → VMaaS folder).
//
// A VMaaS delivery task is named after the client and nothing else — there is no
// "Client | Testing Type" to parse, and no Plextrac report behind it. The whole
// job is the client authorisation form: when the task is created we ask the secure
// portal (SFE) to generate the client's form with the testing type "VMaaS", and
// the returned link is written back to the task's authformlink custom field by
// createAuthFormForTask (same as every pentest task).
//
// The portal is idempotent on clickupTaskId, so a taskCreated followed by a rename
// can both reach here without producing two forms.
//
// Best-effort throughout, like the pentest pipeline: createAuthFormForTask and
// syncAuthFormForRename log their own failures and never throw, so a portal hiccup
// can't wedge the webhook.

const { createAuthFormForTask } = require('./auth-form-create');
const { syncAuthFormForRename } = require('./auth-form-rename');
const { isPlaceholderTaskName } = require('../config/placeholder-task-names');
const log = require('../lib/logger');

// The testing type sent to the portal for every task in the VMaaS folder. The
// portal needs an element registered under this exact name for the form to carry
// the right scope wording.
const VMAAS_TEST_TYPE = 'VMaaS';

const normalise = (s) => String(s || '').trim().toLowerCase();
const clientNameFromTask = (task) => String(task?.name || '').trim();

/**
 * What a rename means for the auth form. Pure so it can be tested without the
 * portal:
 *   'create'  — the task was still the template placeholder when it was created,
 *               so no form exists yet; generate one at the real client name.
 *   'rescope' — the client name changed; the portal re-renders the form under it.
 *   'none'    — nothing the form depends on changed.
 */
function vmaasRenameAction(previousName, newName) {
  if (!clientNameFromTask({ name: newName })) return 'none';
  if (isPlaceholderTaskName(newName)) return 'none';
  if (!previousName || isPlaceholderTaskName(previousName)) return 'create';
  return normalise(previousName) === normalise(newName) ? 'none' : 'rescope';
}

// taskCreated: generate the client's VMaaS authorisation form.
async function runVmaasPipeline(task) {
  // The VMaaS project template creates its tasks under a placeholder name; acting
  // now would produce a form for "Test Task". Wait for the rename instead.
  if (isPlaceholderTaskName(task.name)) {
    log.info('VMaaS task still has its template placeholder name — waiting for rename', {
      task: task.name, task_id: task.id,
    });
    return null;
  }

  const clientName = clientNameFromTask(task);
  if (!clientName) {
    log.warn('VMaaS task has no name — cannot generate an auth form', { task_id: task.id });
    return null;
  }

  log.info('VMaaS task received', {
    task: task.name,
    client: clientName,
    list: task.list?.name || null,
    status: task.status?.status || null,
  });

  const authForm = await createAuthFormForTask(task, {
    clientName,
    testType: VMAAS_TEST_TYPE,
    clientId: null,
    reportId: null,
  });

  if (authForm) {
    const verb = authForm.created ? 'created' : 'already existed';
    log.notify(
      `VMaaS authorisation form ${verb} for ${clientName} — <${authForm.formUrl}|link>.`
    );
  }

  return authForm;
}

// taskUpdated with a name change: the client name is the whole task name, so a
// rename means the form has to be re-rendered under the new one (or created, when
// the task was still a placeholder at creation time).
async function handleVmaasRename(task, previousName) {
  const clientName = clientNameFromTask(task);
  const action = vmaasRenameAction(previousName, task.name);

  if (action === 'none') {
    log.info('VMaaS rename — nothing the auth form depends on changed', {
      task: task.name, task_id: task.id, previous_name: previousName || null,
    });
    return null;
  }

  if (action === 'create') {
    log.info('VMaaS task renamed from its placeholder — generating the auth form now', {
      task: task.name, task_id: task.id, previous_name: previousName || null,
    });
    return runVmaasPipeline(task);
  }

  // Only the client name can change here — the testing type is always VMaaS — so
  // the portal is told the old and new client name and leaves the scope alone. A
  // 404 (no form for this task yet) makes it create one; a signed form comes back
  // as a 409 and is posted to Slack for a human. Both handled by the sync itself.
  return syncAuthFormForRename(task, {
    oldClientName: previousName,
    oldTestType: VMAAS_TEST_TYPE,
    clientName,
    testType: VMAAS_TEST_TYPE,
    clientId: null,
    reportId: null,
  }).catch((err) => {
    log.error('VMaaS rename — auth-form sync threw unexpectedly', {
      reason: err.message, task: task.name, task_id: task.id,
    });
    return null;
  });
}

// taskStatusUpdated: the SecOps webhook subscribes to status changes, but no
// downstream action has been specified for VMaaS yet (the pentest equivalent
// crosses a report off the weekly reports-due message, which VMaaS has no
// counterpart for). Logged so the events are visible while that's decided —
// this is where that behaviour hangs when it is.
async function handleVmaasStatusChange(task, status) {
  log.info('VMaaS task status changed — no downstream action configured', {
    task: task.name, task_id: task.id, status: status || null,
  });
  return null;
}

module.exports = {
  runVmaasPipeline,
  handleVmaasRename,
  handleVmaasStatusChange,
  vmaasRenameAction,
  VMAAS_TEST_TYPE,
};
