// Resolves Plextrac client/report NAMES to their numeric IDs.
//
// Needed for the QA webhook's backwards-compatibility path: reports created
// before the ClickUp integration have no CUID→{clientId,reportId} mapping in
// MongoDB, and Plextrac's webhook can only send NAMES (%CLIENT_NAME% /
// %REPORT_NAME%) — the %CLIENT_ID% / %REPORT_ID% variables are not substituted.
// So we look the numeric IDs back up through the API.

const api = require('./plextrac-api');

// Plextrac list rows come back as { id, data: [numericId, name, ...] }.
function rowId(row)   { return Array.isArray(row.data) ? row.data[0] : (row.client_id ?? row.id); }
function rowName(row) { return String(Array.isArray(row.data) ? (row.data[1] ?? '') : (row.name ?? '')); }

const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

async function findClientIdByName(clientName) {
  const clients = await api.listClients();
  const match = (clients || []).find(c => eq(rowName(c), clientName));
  return match ? rowId(match) : null;
}

async function findReportIdByName(clientId, reportName) {
  const reports = await api.listClientReports(clientId);
  const match = (reports || []).find(r => eq(rowName(r), reportName));
  return match ? rowId(match) : null;
}

// Returns { clientId, reportId } or null if either name can't be resolved.
async function resolveClientAndReport({ clientName, reportName }) {
  const clientId = await findClientIdByName(clientName);
  if (!clientId) return null;
  const reportId = await findReportIdByName(clientId, reportName);
  if (!reportId) return null;
  return { clientId, reportId };
}

module.exports = { resolveClientAndReport, findClientIdByName, findReportIdByName };
