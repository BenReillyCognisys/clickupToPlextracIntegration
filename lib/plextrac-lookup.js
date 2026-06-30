// Resolves Plextrac client/report NAMES to their numeric IDs.
//
// Needed for the QA webhook's backwards-compatibility path: reports created
// before the ClickUp integration have no CUID→{clientId,reportId} mapping in
// MongoDB, and Plextrac's webhook can only send NAMES (%CLIENT_NAME% /
// %REPORT_NAME%) — the %CLIENT_ID% / %REPORT_ID% variables are not substituted.
// So we look the numeric IDs back up through the API.

const api = require('./plextrac-api');
const log = require('./logger');

// Plextrac list rows come back as { id, data: [numericId, name, ...] }.
function rowId(row)   { return Array.isArray(row.data) ? row.data[0] : (row.client_id ?? row.id); }
function rowName(row) { return String(Array.isArray(row.data) ? (row.data[1] ?? '') : (row.name ?? '')); }

// Normalise a name for comparison. Beyond a plain trim+lowercase we fold every
// kind of unicode whitespace — non-breaking space (U+00A0), the U+2000–U+200A
// range, zero-width space (U+200B), narrow nbsp (U+202F), ideographic space
// (U+3000) and BOM (U+FEFF) — to a regular space, then collapse runs of
// whitespace. The webhook-substituted %REPORT_NAME% and the API-returned name
// routinely drift by an nbsp or a doubled space around the " | " separators,
// which a bare trim would miss.
function normalise(s) {
  return String(s)
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const eq = (a, b) => normalise(a) === normalise(b);

// Returns the numeric IDs of EVERY client whose name matches (case/space
// insensitive). Plextrac tenants frequently accumulate duplicate client
// records with the same display name; the report we want may live under any of
// them, so callers must try them all rather than just the first.
async function findClientIdsByName(clientName) {
  const clients = await api.listClients();
  return (clients || []).filter(c => eq(rowName(c), clientName)).map(rowId);
}

// Back-compat: first matching client id, or null.
async function findClientIdByName(clientName) {
  const ids = await findClientIdsByName(clientName);
  return ids.length ? ids[0] : null;
}

async function findReportIdByName(clientId, reportName) {
  const reports = await api.listClientReports(clientId);
  const match = (reports || []).find(r => eq(rowName(r), reportName));
  return match ? rowId(match) : null;
}

// Returns { clientId, reportId } or null if either name can't be resolved.
// Tries every client that matches the name (handles duplicate client records)
// and logs precisely which stage failed so a "could not resolve" warning is
// actionable.
async function resolveClientAndReport({ clientName, reportName }) {
  const clientIds = await findClientIdsByName(clientName);
  if (!clientIds.length) {
    log.warn('Plextrac lookup — no client matched name', { client: clientName });
    return null;
  }

  for (const clientId of clientIds) {
    const reportId = await findReportIdByName(clientId, reportName);
    if (reportId) return { clientId, reportId };
  }

  log.warn('Plextrac lookup — client(s) matched but report name not found under any', {
    client: clientName,
    report: reportName,
    candidate_client_ids: clientIds,
  });
  return null;
}

module.exports = {
  resolveClientAndReport,
  findClientIdByName,
  findClientIdsByName,
  findReportIdByName,
};
