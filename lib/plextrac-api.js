const axios = require('axios');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

// ── Auth state ────────────────────────────────────────────────────────────────
let _token = null;
let _tenantId = null;
let _tokenExpiry = 0;

// Full re-authentication using service account credentials (no MFA on service accounts)
async function authenticate() {
  const { PLEXTRAC_USERNAME, PLEXTRAC_PASSWORD } = process.env;
  if (!PLEXTRAC_USERNAME || !PLEXTRAC_PASSWORD) {
    throw new Error('PLEXTRAC_USERNAME and PLEXTRAC_PASSWORD must be set in .env');
  }
  const { data } = await axios.post(
    `${BASE}/api/v1/authenticate`,
    { username: PLEXTRAC_USERNAME, password: PLEXTRAC_PASSWORD },
    { headers: { 'Content-Type': 'application/json' } }
  );
  _token = data.token;
  _tenantId = data.tenant_id;
  _tokenExpiry = Date.now() + 13 * 60 * 1000; // refresh at 13 min, well before the 15 min expiry
}

// Token refresh — extends the session without needing credentials again.
// Plextrac's refresh endpoint is PUT /api/v1/authenticate; falls back to
// full re-auth if the path ever changes or is unavailable.
async function refreshToken() {
  try {
    const { data } = await axios.put(
      `${BASE}/api/v1/authenticate`,
      {},
      { headers: { Authorization: _token, 'Content-Type': 'application/json' } }
    );
    _token = data.token;
    _tenantId = data.tenant_id ?? _tenantId;
    _tokenExpiry = Date.now() + 13 * 60 * 1000;
  } catch {
    // Refresh failed (e.g. token already expired) — fall through to full re-auth
    await authenticate();
  }
}

async function ensureToken() {
  if (!_token) {
    await authenticate();
  } else if (Date.now() >= _tokenExpiry) {
    await refreshToken();
  }
}

async function headers() {
  await ensureToken();
  return { Authorization: _token, 'Content-Type': 'application/json' };
}

async function tenantId() {
  await ensureToken();
  return _tenantId;
}

// ── HTTP wrapper with one-shot 401 recovery ───────────────────────────────────
async function call(method, path, body) {
  const h = await headers();
  try {
    const { data } = await axios({ method, url: `${BASE}${path}`, headers: h, data: body });
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      // Force full re-auth and retry once
      _tokenExpiry = 0;
      _token = null;
      const h2 = await headers();
      const { data } = await axios({ method, url: `${BASE}${path}`, headers: h2, data: body });
      return data;
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Plextrac API ${method.toUpperCase()} ${path} failed: ${detail}`);
  }
}

// ── Clients ───────────────────────────────────────────────────────────────────
async function listClients() {
  return call('get', '/api/v1/client/list');
}

async function createClient(name) {
  return call('post', '/api/v1/client/create', { name });
}

async function getClient(clientId) {
  return call('get', `/api/v1/client/${clientId}`);
}

// ── Reports ───────────────────────────────────────────────────────────────────
async function getReport(clientId, reportId) {
  return call('get', `/api/v1/client/${clientId}/report/${reportId}`);
}

async function listClientReports(clientId) {
  return call('get', `/api/v1/client/${clientId}/reports`);
}

async function createReport(clientId, payload) {
  return call('post', `/api/v1/client/${clientId}/report/create`, payload);
}

async function updateReport(clientId, reportId, payload) {
  return call('put', `/api/v1/client/${clientId}/report/${reportId}`, payload);
}

// ── Findings (Plextrac "flaws") ───────────────────────────────────────────────
// NOTE: Plextrac's v1 findings endpoints use the "flaw" nomenclature. The exact
// response shape varies by instance/version — run scripts/inspect-findings.js
// against the live instance to confirm before relying on field names.
async function listReportFindings(clientId, reportId) {
  return call('get', `/api/v1/client/${clientId}/report/${reportId}/flaws`);
}

async function getFinding(clientId, reportId, findingId) {
  return call('get', `/api/v1/client/${clientId}/report/${reportId}/flaw/${findingId}`);
}

async function updateFinding(clientId, reportId, findingId, payload) {
  return call('put', `/api/v1/client/${clientId}/report/${reportId}/flaw/${findingId}`, payload);
}

// ── Templates & Layouts ───────────────────────────────────────────────────────
async function listReportTemplates() {
  const tid = await tenantId();
  return call('get', `/api/v1/tenant/${tid}/report-templates`);
}

async function listFieldTemplates() {
  return call('get', '/api/v1/field-templates');
}

module.exports = {
  listClients,
  createClient,
  getClient,
  getReport,
  listClientReports,
  createReport,
  updateReport,
  listReportFindings,
  getFinding,
  updateFinding,
  listReportTemplates,
  listFieldTemplates,
  // Escape hatch for endpoints not yet wrapped (e.g. the change-tracking toggle,
  // once confirmed against the live instance). Same auth + 401-retry handling.
  raw: call,
};
