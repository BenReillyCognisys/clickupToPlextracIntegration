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

async function runPipeline(task) {
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
    return;
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
  if (existingMapping) {
    log.info('Task already has a Plextrac report — skipping create pipeline', {
      task: task.name, task_id: task.id, report_id: existingMapping.plextrac_report_id,
    });
    return;
  }

  // ── Phase 1: Parse task name ─────────────────────────────────────────────
  const { client_name, testing_type } = parseTaskName(task.name);

  log.info('ClickUp Task received', {
    task: task.name,
    client: client_name,
    type: testing_type,
    start: task.start_date || null,
    end: task.due_date || null,
    status: task.status?.status || null,
  });

  if (testing_type === 'Unknown') {
    log.warn('Testing type could not be determined — pipeline aborted', { task: task.name });
    log.notify(`Could not determine testing type from task name — no report created. Task: "${task.name}"`);
    return;
  }

  // ── Blacklist check ───────────────────────────────────────────────────────
  const hit = findBlacklistedWord(task.name);
  if (hit) {
    log.warn('Blacklisted word detected — pipeline aborted', { word: hit, task: task.name });
    log.notify(`Blacklisted word detected - ${hit} - ${client_name} ${testing_type}`);
    return;
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
    return; // Unrecoverable — cannot create a report without a client
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
    return;
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

  if (reportName) {
    const { name, reportId } = reportName;
    const base = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
    const url = `${base}/client/${clientId}/report/${reportId}`;
    const suffix = clientCreated ? 'Client was created.' : 'Client already exists.';
    const authLine = authForm ? ` Auth form: <${authForm.formUrl}|link>.` : '';
    log.notify(`Report has been created for ${client_name} - <${url}|${name}>. ${suffix}${authLine}`);
  }
}

module.exports = { runPipeline };
