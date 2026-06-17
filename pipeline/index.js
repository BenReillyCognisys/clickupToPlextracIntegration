const { parseTaskName } = require('./parse-task');
const { findOrCreateClient } = require('./plextrac-client');
const { createReport } = require('./plextrac-report');
const log = require('../lib/logger');
const BLACKLIST = require('../config/blacklist');

function findBlacklistedWord(text) {
  const lower = text.toLowerCase();
  return BLACKLIST.find(word => lower.includes(word.toLowerCase())) || null;
}

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

  if (reportName) {
    const { name, reportId } = reportName;
    const base = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
    const url = `${base}/client/${clientId}/report/${reportId}`;
    const suffix = clientCreated ? 'Client was created.' : 'Client already exists.';
    log.notify(`Report has been created for ${client_name} - <${url}|${name}>. ${suffix}`);
  }
}

module.exports = { runPipeline };
