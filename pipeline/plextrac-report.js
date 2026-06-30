const api = require('../lib/plextrac-api');
const log = require('../lib/logger');
const TEMPLATE_MAP = require('../config/template-map');
const store = require('../lib/task-store');

const DEFAULT_TEMPLATE_NAME = process.env.PLEXTRAC_REPORT_TEMPLATE || 'Cognisys Web Application Black Box';
const FINDINGS_LAYOUT_NAME = process.env.PLEXTRAC_FINDINGS_LAYOUT || 'Pentest Cognisys';

function templateNameForType(testingType) {
  const lower = testingType.toLowerCase();
  const match = TEMPLATE_MAP.find(
    entry => entry.keywords.some(kw => lower.includes(kw.toLowerCase()))
  );
  if (match) return match.template;
  log.warn('No template mapping for testing type — using default', {
    type: testingType,
    fallback: DEFAULT_TEMPLATE_NAME,
  });
  return DEFAULT_TEMPLATE_NAME;
}
const REVIEWER_EMAILS = ['ben.reilly@cognisys.group', 'punit.sharma@cognisys.group'];

const MONTHS = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];

function epochToISO(epochMs) {
  if (!epochMs) return null;
  return new Date(Number(epochMs)).toISOString();
}

function buildReportName(testingType, startEpochMs) {
  // Month/year derived from the task start date; fallback to current date with a warning
  const d = startEpochMs ? new Date(Number(startEpochMs)) : new Date();
  return `${testingType} | ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// ── ID resolution helpers ─────────────────────────────────────────────────────

async function resolveTemplateId(name) {
  const templates = await api.listReportTemplates();
  const match = (templates || []).find(
    t => (t.data?.template_name || t.data?.name || t.name || '').toLowerCase() === name.toLowerCase()
  );
  if (!match) throw new Error(`Report template not found: "${name}"`);
  return match.data?.doc_id || match.id;
}

async function resolveLayoutId(name) {
  const layouts = await api.listFieldTemplates();
  const match = (layouts || []).find(
    l => (l.data?.name || l.data?.template_name || l.name || '').toLowerCase() === name.toLowerCase()
  );
  if (!match) throw new Error(`Findings layout not found: "${name}"`);
  return match.data?.doc_id || match.id;
}

// Extract assignee emails directly from the ClickUp task.
// Plextrac validates emails server-side on report creation; we skip the
// pre-validation user list call because the service account lacks that permission.
function resolveOperators(assignees) {
  return (assignees || [])
    .map(a => a.email)
    .filter(Boolean);
}

// ── Main export ───────────────────────────────────────────────────────────────

async function createReport(clientId, task, testingType) {
  if (!task.start_date) {
    log.warn('Task has no start_date — using current month/year for report name', {
      task: task.name,
    });
  }

  const name = buildReportName(testingType, task.start_date);

  // Idempotency: skip if a report with this exact name already exists under the client
  const existingReports = await api.listClientReports(clientId);
  const duplicate = (existingReports || []).find(r => {
    const rName = Array.isArray(r.data) ? r.data[1] : (r.name || '');
    return rName.toLowerCase() === name.toLowerCase();
  });
  if (duplicate) {
    const reportId = Array.isArray(duplicate.data) ? duplicate.data[0] : duplicate.id;
    log.warn('Plextrac Report already exists — skipping creation', {
      report: name,
      report_id: reportId,
      client_id: clientId,
    });
    return null;
  }

  // Resolve names → IDs; fail loudly if template or layout can't be found
  const templateName = templateNameForType(testingType);
  let templateId, layoutId;
  try {
    templateId = await resolveTemplateId(templateName);
  } catch (err) {
    throw new Error(`Template resolution failed | ${err.message}`);
  }
  try {
    layoutId = await resolveLayoutId(FINDINGS_LAYOUT_NAME);
  } catch (err) {
    throw new Error(`Layout resolution failed | ${err.message}`);
  }

  const operators = await resolveOperators(task.assignees);

  const year = task.start_date
    ? new Date(Number(task.start_date)).getFullYear()
    : new Date().getFullYear();

  const payload = {
    name,
    status: 'Draft',
    template: templateId,
    fields_template: layoutId,
    operators,
    reviewers: REVIEWER_EMAILS,
    start_date: epochToISO(task.start_date),
    end_date: epochToISO(task.due_date),
    tags: [String(year)],
  };

  const result = await api.createReport(clientId, payload);

  // Explicitly patch reviewers after creation — the create endpoint only reliably
  // sets a single reviewer, so a follow-up update ensures all are applied.
  await api.updateReport(clientId, result.report_id, { reviewers: REVIEWER_EMAILS });

  // Fetch the full report to get its CUID — the create endpoint only returns the
  // numeric report_id, but the Plextrac webhook uses CUIDs to identify reports.
  const fullReport = await api.getReport(clientId, result.report_id);
  const reportCuid = fullReport?.cuid || null;

  // Store the ClickUp task → Plextrac report mapping so the reverse webhook
  // (Plextrac → ClickUp) can look up which task to update later.
  //
  // When the task had no start_date, the report name above was built from a
  // fallback (current month/year). Flag it as start_date_pending and record the
  // testing type so the start-date watcher (pipeline/start-date-watch.js) can
  // rename the report once a start date is set in ClickUp.
  const startDatePending = !task.start_date;
  await store.saveMapping({
    clickupTaskId:      task.id,
    plextracClientId:   clientId,
    plextracReportId:   result.report_id,
    plextracReportCuid: reportCuid,
    taskName:           task.name,
    testingType,
    startDatePending,
  });
  if (startDatePending) {
    log.info('Report created without a start date — will watch ClickUp for one', {
      report: name,
      report_id: result.report_id,
      clickup_task_id: task.id,
    });
  }

  log.info('Plextrac Report created', {
    report: name,
    report_id: result.report_id,
    client_id: clientId,
  });

  return { name, reportId: result.report_id };
}

module.exports = { createReport, buildReportName, epochToISO };
