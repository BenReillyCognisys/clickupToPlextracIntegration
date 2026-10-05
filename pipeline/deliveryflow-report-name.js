// Report names for DeliveryFlow engagements that never collide with other work.
//
// A report is named "<Testing Type> | <Month Year>" (pipeline/plextrac-report.js), so
// two engagements of the same type for the same client in the same month — two API
// tests on one deal, two call-offs drawn from one bank of days — would get the same
// name. Plextrac then hands the second one the first one's report ("already exists")
// and it is never linked.
//
// DeliveryFlow knows the DealFlow line item each engagement was sold as, so when the
// plain name already belongs to another engagement (or a ClickUp task) the name is
// qualified with that line: its call-off or product name, else its line id —
//   "API Testing (Isentia - Application Penetration Testing) | October 2026".
// Engagements that don't clash keep the plain name. A report with the name that
// nothing has claimed is left alone, as before: it may be this engagement's own report
// from a run that failed before it was recorded.

const api = require('../lib/plextrac-api');
const dfStore = require('../lib/deliveryflow-store');
const taskStore = require('../lib/task-store');
const { buildReportName } = require('./plextrac-report');

// Same ceiling the auth-form endpoint puts on a scope.
const MAX_SCOPE = 60;

// A line label as a report-name qualifier: the characters the name format uses as
// delimiters ("|" between parts, brackets around the scope) are replaced, whitespace
// collapsed, and the result kept short enough to read.
function cleanLabel(raw) {
  const text = String(raw ?? '')
    .replace(/[|()[\]]/g, ' - ')
    .replace(/\s*-\s*(-\s*)+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-\s*|\s*-$/g, '')
    .trim();
  if (!text) return null;
  return text.length > MAX_SCOPE ? text.slice(0, MAX_SCOPE).trim() : text;
}

// The qualifiers to try, best first: the line's label, its id, then both.
function qualifiers({ lineLabel, lineId }) {
  const label = cleanLabel(lineLabel);
  const id = cleanLabel(lineId);
  return [...new Set([label, id, label && id ? cleanLabel(`${label} ${id}`) : null].filter(Boolean))];
}

const reportName = (r) => (Array.isArray(r?.data) ? r.data[1] : (r?.name || ''));
const reportId = (r) => (Array.isArray(r?.data) ? r.data[0] : r?.id);

/**
 * Who owns the report called `name` under the client, from an already-fetched list:
 *   null                                    — no report has that name
 *   { reportId, engagementId, clickupTaskId } — one does; both ids null when nothing
 *                                               has claimed it
 */
async function ownerOf(reports, name) {
  const hit = (reports || []).find((r) => reportName(r).toLowerCase() === name.toLowerCase());
  if (!hit) return null;
  const id = reportId(hit);
  const [engagement, mapping] = await Promise.all([
    dfStore.findByReportId(id).catch(() => null),
    taskStore.findByReportId(id).catch(() => null),
  ]);
  return {
    reportId: id,
    engagementId: engagement?.engagement_id ?? null,
    clickupTaskId: mapping?.clickup_task_id ?? null,
  };
}

// True when the name is free for this engagement: nobody has it, it is the
// engagement's own report, or nothing has claimed the report holding it.
function freeFor(owner, { engagementId, ownReportId }) {
  if (!owner) return true;
  if (ownReportId != null && String(owner.reportId) === String(ownReportId)) return true;
  if (owner.engagementId && owner.engagementId === engagementId) return true;
  return !owner.engagementId && !owner.clickupTaskId;
}

/**
 * The name to give an engagement's report, and the scope that produced it.
 *
 *   clientId, testingType, startMs — what the plain name is built from
 *   scope        — a scope already chosen (sent explicitly, or settled on an earlier
 *                  call); used as it is, never second-guessed
 *   engagementId — the engagement the report is for
 *   ownReportId  — its report, when renaming one that already exists
 *   lineLabel, lineId — the DealFlow line, for the qualifier
 *
 * Returns { name, scope, qualified }. `qualified` is true when a line qualifier was
 * added because the plain name was taken; the caller records `scope` so later renames
 * (a start date arriving, a type change) keep it. Never throws: when Plextrac can't be
 * read the plain name is returned and the existing duplicate handling applies.
 */
async function chooseReportName({ clientId, testingType, startMs, scope = null, engagementId, ownReportId = null, lineLabel = null, lineId = null }) {
  const plain = buildReportName(testingType, startMs, scope);
  if (scope) return { name: plain, scope, qualified: false };

  let reports;
  try {
    reports = await api.listClientReports(clientId);
  } catch {
    return { name: plain, scope: null, qualified: false };
  }

  const who = { engagementId, ownReportId };
  if (freeFor(await ownerOf(reports, plain), who)) return { name: plain, scope: null, qualified: false };

  for (const q of qualifiers({ lineLabel, lineId })) {
    const name = buildReportName(testingType, startMs, q);
    if (freeFor(await ownerOf(reports, name), who)) return { name, scope: q, qualified: true };
  }
  return { name: plain, scope: null, qualified: false };
}

module.exports = { chooseReportName, cleanLabel, qualifiers };
