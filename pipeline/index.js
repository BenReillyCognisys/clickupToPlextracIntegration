const { parseTaskName } = require('./parse-task');
const { findOrCreateClient } = require('./plextrac-client');
const { createReport } = require('./plextrac-report');
const { createAuthFormForTask } = require('./auth-form-create');
const store = require('../lib/task-store');
const log = require('../lib/logger');
const BLACKLIST = require('../config/blacklist');
const { isPlaceholderTaskName } = require('../config/placeholder-task-names');

function findBlacklistedWord(text) {
  const lower = text.toLowerCase();
  return BLACKLIST.find(word => lower.includes(word.toLowerCase())) || null;
}

const reportUrl = (clientId, reportId) =>
  `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}/client/${clientId}/report/${reportId}`;

/**
 * Creates the Plextrac client, report and authorisation form for a ClickUp task.
 *
 * Driven by the taskCreated webhook, by the first meaningful rename of a template
 * placeholder (pipeline/task-rename.js), and by a manual replay
 * (pipeline/task-admin.js). Options:
 *   force — skip the "this task already has a report" check. Only for a manual
 *           replay repairing a half-finished run (e.g. the report was created but
 *           the auth form failed); createReport's name-based duplicate check is
 *           what then stops a second report being made.
 *
 * Returns { status, ... } describing what happened. Webhook callers ignore it;
 * the replay endpoint reports it back to the operator. Statuses:
 *   placeholder_name · already_mapped · unknown_testing_type · blacklisted
 *   client_failed · report_failed · report_exists · created
 */
async function runPipeline(task, { force = false } = {}) {
  // ── Phase 0: Skip template placeholders ──────────────────────────────────
  // The ClickUp project template creates each task as a placeholder ("Test Task")
  // which ClickBot then renames to the real "Client | Testing Type". Creating
  // anything now would post a spurious Slack notice for a name that's about to
  // change, so wait for the rename (handled by pipeline/task-rename.js) instead.
  if (isPlaceholderTaskName(task.name)) {
    log.info('Task still has its template placeholder name — waiting for rename before creating a report', {
      task: task.name,
      task_id: task.id,
    });
    return { status: 'placeholder_name', detail: `"${task.name}" is a template placeholder name` };
  }

  // ── Phase 0.5: Skip if a report already exists for this task ──────────────
  // taskCreated and a rename can both reach here for the same task; the webhook
  // serialises them so this check sees the mapping the first run saved and the
  // second run bails out — no duplicate report, no duplicate Slack notice.
  const existingMapping = await store.findByTaskId(task.id).catch((err) => {
    log.error('Idempotency check failed — proceeding with create pipeline', {
      reason: err.message, task_id: task.id,
    });
    return null;
  });
  if (existingMapping && !force) {
    log.info('Task already has a Plextrac report — skipping create pipeline', {
      task: task.name, task_id: task.id, report_id: existingMapping.plextrac_report_id,
    });
    return {
      status: 'already_mapped',
      detail: 'the task is already mapped to a Plextrac report',
      client_id: existingMapping.plextrac_client_id,
      report_id: existingMapping.plextrac_report_id,
      report_url: reportUrl(existingMapping.plextrac_client_id, existingMapping.plextrac_report_id),
    };
  }
  if (existingMapping && force) {
    log.warn('Task already has a Plextrac report — re-running the create pipeline anyway (forced)', {
      task: task.name, task_id: task.id, report_id: existingMapping.plextrac_report_id,
    });
  }

  // ── Phase 1: Parse task name ─────────────────────────────────────────────
  const { client_name, testing_type, warning } = parseTaskName(task.name);

  // The name didn't follow "Client | Testing Type" and had to be interpreted (e.g.
  // the testing type was entered first). We proceed with the recovered client, but
  // flag it so someone can fix the task name.
  if (warning) {
    log.warn('Task name interpreted', { task: task.name, client: client_name, type: testing_type, warning });
    log.notify(`${warning} Task: "${task.name}"`);
  }

  log.info('ClickUp Task received', {
    task: task.name,
    client: client_name,
    type: testing_type,
    start: task.start_date || null,
    end: task.due_date || null,
    status: task.status?.status || null,
  });

  const parsed = { client_name, testing_type, ...(warning ? { warning } : {}) };

  if (testing_type === 'Unknown') {
    log.warn('Testing type could not be determined — pipeline aborted', { task: task.name });
    log.notify(`Could not determine testing type from task name — no report created. Task: "${task.name}"`);
    return { status: 'unknown_testing_type', detail: 'the testing type could not be determined from the task name', ...parsed };
  }

  // ── Blacklist check ───────────────────────────────────────────────────────
  const hit = findBlacklistedWord(task.name);
  if (hit) {
    log.warn('Blacklisted word detected — pipeline aborted', { word: hit, task: task.name });
    log.notify(`Blacklisted word detected - ${hit} - ${client_name} ${testing_type}`);
    return { status: 'blacklisted', detail: `the task name contains the blacklisted word "${hit}"`, ...parsed };
  }

  // ── Phase 2: Find or create Plextrac client ───────────────────────────────
  let clientId, clientCreated;
  try {
    ({ clientId, clientCreated } = await findOrCreateClient(client_name));
  } catch (err) {
    log.error('Phase 2 failed | client find/create', {
      reason: err.message,
      client: client_name,
    });
    // Unrecoverable — cannot create a report without a client
    return { status: 'client_failed', detail: `Plextrac client find/create failed — ${err.message}`, ...parsed };
  }

  // ── Phase 3: Create Plextrac report ──────────────────────────────────────
  let reportName;
  try {
    reportName = await createReport(clientId, task, testing_type);
  } catch (err) {
    log.error('Phase 3 failed | report create', {
      reason: err.message,
      client_id: clientId,
      task: task.name,
    });
    return {
      status: 'report_failed',
      detail: `Plextrac report create failed — ${err.message}`,
      client_id: clientId, client_created: clientCreated, ...parsed,
    };
  }

  // ── Phase 4: Generate the client authorisation form (SFE portal) ─────────
  // For every testing type: ask the portal to create-or-return the individual auth
  // form for this task and comment its link back onto the task. Best-effort — the
  // portal is idempotent on the task id and any failure is logged without aborting
  // (the report already exists). The SFE merges a client's multiple forms itself.
  const authForm = await createAuthFormForTask(task, {
    clientName: client_name,
    testType: testing_type,
    clientId,
    reportId: reportName?.reportId ?? null,
  });

  const { name, reportId, existed } = reportName;
  const url = reportUrl(clientId, reportId);

  // Only announce a report we actually created. `existed` means createReport found
  // one already under this name — nothing new to shout about (it's the normal
  // outcome of a forced replay, and of two tasks sharing a client/type/month).
  if (!existed) {
    const suffix = clientCreated ? 'Client was created.' : 'Client already exists.';
    const authLine = authForm ? ` Auth form: <${authForm.formUrl}|link>.` : '';
    log.notify(`Report has been created for ${client_name} - <${url}|${name}>. ${suffix}${authLine}`);
  }

  return {
    status: existed ? 'report_exists' : 'created',
    detail: existed
      ? 'a Plextrac report with this name already existed under the client'
      : 'the Plextrac report was created',
    client_id: clientId,
    client_created: Boolean(clientCreated),
    report_id: reportId,
    report_name: name,
    report_url: url,
    auth_form_url: authForm?.formUrl ?? null,
    ...parsed,
  };
}

module.exports = { runPipeline };
