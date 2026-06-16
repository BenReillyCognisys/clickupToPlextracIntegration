const { parseTaskName } = require('./parse-task');
const { findOrCreateClient } = require('./plextrac-client');
const { createReport } = require('./plextrac-report');
const log = require('../lib/logger');

async function runPipeline(task) {
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
    log.warn('Testing type could not be determined from task name', { task: task.name });
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

  if (reportName) {
    const msg = clientCreated
      ? `Client and report has been created for ${client_name} - ${reportName}.`
      : `Report has been created for ${client_name} - ${reportName}.`;
    log.notify(msg);
  }
}

module.exports = { runPipeline };
