const axios = require('axios');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

// ── Auth state ────────────────────────────────────────────────────────────────
let _token = null;
let _tenantId = null;
let _tenantCuid = null;
let _tokenExpiry = 0;

// The auth response's numeric `tenant_id` is 0 on this instance; the tenant's real
// identifier (a cuid, which the v2 endpoints route on) lives only inside the JWT.
// Decodes the JWT payload from the `cookie` field and pulls out `tenantCuid`.
// Best-effort — returns null if the token can't be decoded (callers fall back to
// the numeric id).
function tenantCuidFromCookie(cookie) {
  try {
    const part = String(cookie || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part, 'base64').toString('utf8');
    return JSON.parse(json).tenantCuid || null;
  } catch {
    return null;
  }
}

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
  _tenantCuid = tenantCuidFromCookie(data.cookie) ?? _tenantCuid;
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
    _tenantCuid = tenantCuidFromCookie(data.cookie) ?? _tenantCuid;
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

async function tenantCuid() {
  await ensureToken();
  return _tenantCuid;
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

// ── Users ─────────────────────────────────────────────────────────────────────
// Enumerates every user in the tenant. Used to cross-reference a webhook's
// `actorCuid` (the user who triggered the event) back to a real name/email —
// Plextrac's user lookup is by numeric id, not cuid, so the only way to map a
// cuid is to list all users and match on their `cuid` field (per Plextrac support).
//
// Enumerates tenant users via the v1 `user/list` endpoint, which routes on the
// numeric tenant id (0 on this instance). Each row is the list shape
// `{ id, doc_id, data: { cuid, email, name:{first,last}, user_id, ... } }` — the
// user, including the `cuid` we match webhook actors on, is nested under `data`.
//
// The v2 `/api/v2/tenants/{tenantCuid}/users` endpoint exists too but returned 403
// "Unauthorized!" for the service account even after the v1 "View Users" permission
// was granted, so v1 is the default. Override with PLEXTRAC_USERS_PATH (the literal
// `{tenantId}` / `{tenantCuid}` tokens are substituted) — confirm any change with
// `node scripts/inspect-users.js`.
//
// NOTE: requires the service account to hold the "View Users" permission. A
// restricted role gets 403 "Unauthorized!" here even though the same token can read
// clients/reports — grant that permission in Plextrac RBAC if so.
async function listTenantUsers() {
  const [tid, tcuid] = [await tenantId(), await tenantCuid()];
  const path = (process.env.PLEXTRAC_USERS_PATH || '/api/v1/tenant/{tenantId}/user/list')
    .replace('{tenantCuid}', tcuid ?? '')
    .replace('{tenantId}', tid);
  return call('get', path);
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
  listTenantUsers,
  tenantId,
  tenantCuid,
  listReportTemplates,
  listFieldTemplates,
  // Escape hatch for endpoints not yet wrapped (e.g. the change-tracking toggle,
  // once confirmed against the live instance). Same auth + 401-retry handling.
  raw: call,
};
