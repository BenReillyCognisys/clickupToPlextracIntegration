// Client for the secure portal (SFE) intake API.
//
// break.services parses a ClickUp delivery task (name → client + testing type)
// and asks the portal to generate the client's authorisation form for that task.
// This is the reverse direction of routes/clickup-actions.js (where the portal
// calls into break.services): here we are the caller, authenticating with the
// shared BREAK_SERVICES_API_KEY via the X-API-Key header.

const axios = require('axios');

// Ceiling for outbound portal calls so a hung request can't wedge a handler.
const PORTAL_TIMEOUT_MS = Number(process.env.SECURE_PORTAL_TIMEOUT_MS) || 15000;

// Portal base URL without a trailing slash. Throws when unset so the caller can
// decide to skip the step rather than build a broken URL.
function portalBase() {
  const base = process.env.SECURE_PORTAL_URL;
  if (!base) throw new Error('SECURE_PORTAL_URL is not set');
  return base.replace(/\/+$/, '');
}

// Turns an axios error into a compact, loggable message (status + trimmed body)
// without ever including the X-API-Key header.
function portalError(err, method, path) {
  const status = err.response?.status || 'ERR';
  const body = typeof err.response?.data === 'string'
    ? err.response.data
    : JSON.stringify(err.response?.data ?? err.message);
  return new Error(`Secure portal ${status} ${method} ${path}: ${String(body).slice(0, 400)}`);
}

/**
 * POST /api/clickup/auth-form — create-or-return the individual authorisation form
 * for a ClickUp delivery task. The portal is idempotent on clickupTaskId, so this
 * can be called more than once for the same task and returns the same form.
 * Returns the parsed body: { ok, formUrl, formToken, created }.
 */
async function createAuthForm(payload) {
  const key = process.env.BREAK_SERVICES_API_KEY;
  if (!key) throw new Error('BREAK_SERVICES_API_KEY is not set');
  const path = '/api/clickup/auth-form';
  try {
    const { data } = await axios.post(`${portalBase()}${path}`, payload, {
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      timeout: PORTAL_TIMEOUT_MS,
    });
    return data;
  } catch (err) {
    throw portalError(err, 'POST', path);
  }
}

module.exports = { createAuthForm };
