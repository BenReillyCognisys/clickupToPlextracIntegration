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
      val.forEach((section, i) => {
        if (typeof section === 'string') {
          segments.push({ path: `${field}[${i}]`, label: `${field}[${i}]`, text: section });
        } else if (section && typeof section === 'object') {
          for (const key of TEXT_KEYS) {
            if (typeof section[key] === 'string') {
              segments.push({
                path: `${field}[${i}].${key}`,
                label: section.title ? `${field}: ${section.title}` : `${field}[${i}].${key}`,
                text: section[key],
              });
              break;
            }
          }
        }
      });
    }
  }
  return segments;
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
};
