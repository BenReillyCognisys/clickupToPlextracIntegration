// Locating the editable narrative text inside a Plextrac report / finding.
//
// ⚠️ Plextrac's exact field shapes vary by instance and template. The helpers
// below are intentionally TOLERANT of the common shapes and return a normalised
// list of "segments" — { path, label, text } — that the pipeline edits and then
// writes back via setByPath(). Run scripts/inspect-report.js and
// scripts/inspect-findings.js against the live instance and adjust the candidate
// paths below if a field isn't being picked up (it will be logged as such).

// Read a value at a dot/bracket path like "exec_summary" or "exec_summary[0].text".
function getByPath(obj, path) {
  return path.split('.').reduce((acc, part) => {
    if (acc == null) return undefined;
    const m = part.match(/^(\w+)\[(\d+)\]$/);
    if (m) return acc[m[1]]?.[Number(m[2])];
    return acc[part];
  }, obj);
}

// Immutably set a value at a dot/bracket path, returning a modified clone.
function setByPath(obj, path, value) {
  const clone = JSON.parse(JSON.stringify(obj));
  const parts = path.split('.');
  let cursor = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].match(/^(\w+)\[(\d+)\]$/);
    cursor = m ? cursor[m[1]][Number(m[2])] : cursor[parts[i]];
  }
  const last = parts[parts.length - 1];
  const m = last.match(/^(\w+)\[(\d+)\]$/);
  if (m) cursor[m[1]][Number(m[2])] = value;
  else cursor[last] = value;
  return clone;
}

// Sub-properties that hold the actual text inside an exec-summary section object.
const TEXT_KEYS = ['text', 'value', 'custom_field', 'content', 'body'];

// Section names the AI QA review skips entirely (e.g. Methodology, Issue Matrix).
const EXCLUDED_SECTIONS = require('../../config/excluded-sections');

// True if a section's name matches one of the excluded names (case-insensitive,
// substring — so "Testing Methodology" matches "Methodology").
function isExcludedSection(name, excluded = EXCLUDED_SECTIONS) {
  if (!name) return false;
  const hay = String(name).toLowerCase();
  return excluded.some(n => n && hay.includes(String(n).toLowerCase()));
}

// Returns [{ path, label, text }] for every executive-summary text segment found.
function getExecutiveSummarySegments(report) {
  const segments = [];
  // Candidate top-level fields that hold the executive summary.
  const candidates = ['exec_summary', 'executive_summary', 'execSummary'];

  for (const field of candidates) {
    const val = report?.[field];
    if (val == null) continue;

    if (typeof val === 'string') {
      segments.push({ path: field, label: field, text: val });
    } else if (Array.isArray(val)) {
      val.forEach((section, i) => pushSection(segments, field, `${field}[${i}]`, section));
    } else if (val && typeof val === 'object' && Array.isArray(val.custom_fields)) {
      // Real Plextrac shape: exec_summary = { custom_fields: [{ label, text }, ...] }
      val.custom_fields.forEach((section, i) =>
        pushSection(segments, field, `${field}.custom_fields[${i}]`, section));
    }
  }
  return segments;
}

// Pushes a segment for a section object, picking the first text-bearing key.
function pushSection(segments, field, basePath, section) {
  if (typeof section === 'string') {
    segments.push({ path: basePath, label: basePath, text: section });
    return;
  }
  if (!section || typeof section !== 'object') return;
  const name = section.label || section.title;
  // Skip boilerplate/reference sections (Methodology, Issue Matrix, …) — they are
  // templated, not narrative, and must not be run through the AI.
  if (isExcludedSection(name)) return;
  for (const key of TEXT_KEYS) {
    if (typeof section[key] === 'string') {
      segments.push({
        path: `${basePath}.${key}`,
        label: name ? `${field}: ${name}` : `${basePath}.${key}`,
        text: section[key],
      });
      break;
    }
  }
}

// Returns [{ path, label, text }] for the editable narrative fields of a finding.
function getFindingSegments(finding) {
  // Plextrac findings nest most data under `.data` for array-shaped responses,
  // or expose fields at the top level for object-shaped ones. Handle both.
  const root = finding?.data && typeof finding.data === 'object' ? 'data.' : '';
  const fields = ['description', 'recommendations', 'recommendation', 'references', 'fields'];
  const segments = [];
  for (const f of fields) {
    const path = `${root}${f}`;
    const val = getByPath(finding, path);
    if (typeof val === 'string' && val.trim()) {
      segments.push({ path, label: f, text: val });
    }
  }
  return segments;
}

// Best-effort canonical client name from a Plextrac client object (tolerant of
// the array `data: [id, name, ...]` shape used elsewhere in this codebase).
function clientNameFromRecord(clientRecord, fallback) {
  if (!clientRecord) return fallback;
  if (typeof clientRecord.name === 'string' && clientRecord.name.trim()) return clientRecord.name;
  if (Array.isArray(clientRecord.data) && clientRecord.data[1]) return String(clientRecord.data[1]);
  if (clientRecord.data?.name) return String(clientRecord.data.name);
  return fallback;
}

module.exports = {
  getByPath,
  setByPath,
  getExecutiveSummarySegments,
  getFindingSegments,
  clientNameFromRecord,
  isExcludedSection,
};
