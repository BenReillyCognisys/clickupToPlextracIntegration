const api = require('../lib/plextrac-api');
const log = require('../lib/logger');

const REPORT_TEMPLATE_NAME = process.env.PLEXTRAC_REPORT_TEMPLATE || 'Cognisys Web Application Black Box';
const FINDINGS_LAYOUT_NAME = process.env.PLEXTRAC_FINDINGS_LAYOUT || 'Pentest Cognisys';
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
    t => (t.name || t.title || '').toLowerCase() === name.toLowerCase()
  );
  if (!match) throw new Error(`Report template not found: "${name}"`);
  return match.id || match.template_id;
}

async function resolveLayoutId(name) {
  const layouts = await api.listFieldTemplates();
  const match = (layouts || []).find(
    l => (l.name || l.title || '').toLowerCase() === name.toLowerCase()
  );
  if (!match) throw new Error(`Findings layout not found: "${name}"`);
  return match.id || match.field_template_id;
}

/**
 * Maps ClickUp assignee emails to Plextrac user emails.
 * Logs a WARN for each assignee that has no Plextrac match; never throws.
 */
async function resolveOperators(assignees) {
  if (!assignees?.length) return [];

  const users = await api.listUsers();
  const knownEmails = new Set((users || []).map(u => (u.email || '').toLowerCase()));

  const resolved = [];
  for (const a of assignees) {
    const email = (a.email || '').toLowerCase();
    if (knownEmails.has(email)) {
      resolved.push(a.email);
    } else {
      log.warn('ClickUp assignee has no matching Plextrac user — omitting from operators', {
        assignee_email: a.email || a.username,
      });
    }
  }
  return resolved;
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
    return;
  }

  // Resolve names → IDs; fail loudly if template or layout can't be found
  let templateId, layoutId;
  try {
    templateId = await resolveTemplateId(REPORT_TEMPLATE_NAME);
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
  log.info('Plextrac Report created', {
    report: name,
    report_id: result.report_id,
    client_id: clientId,
  });
}

module.exports = { createReport };
