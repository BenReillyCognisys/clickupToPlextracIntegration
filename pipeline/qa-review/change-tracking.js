// Plextrac change-tracking toggle (best-effort).
//
// The user requirement is: "set Plextrac to track changes before doing anything,
// then turn tracking off once fully completed."
//
// ⚠️ Whether Plextrac exposes its change-tracking / review-mode feature over the
// API — and at what endpoint — could NOT be verified while building this. It may
// be a UI-only feature. So this module is deliberately:
//   1. A no-op by default (PLEXTRAC_CHANGE_TRACKING_ENABLED is unset/false).
//   2. Driven entirely by env config when enabled, so you can wire in the real
//      endpoint once confirmed WITHOUT code changes.
//
// The authoritative audit trail does NOT depend on this — every applied change
// is independently logged to the log file + Slack in pipeline/qa-review/index.js.
// That is the real guarantee; this is a convenience that mirrors the tracking
// state into Plextrac's own UI when the API supports it.
//
// To enable once you've confirmed the endpoint, set in .env, e.g.:
//   PLEXTRAC_CHANGE_TRACKING_ENABLED=true
//   PLEXTRAC_TRACKING_METHOD=put
//   PLEXTRAC_TRACKING_PATH=/api/v1/client/{clientId}/report/{reportId}/track
//   PLEXTRAC_TRACKING_ON_BODY={"enabled":true}
//   PLEXTRAC_TRACKING_OFF_BODY={"enabled":false}

const api = require('../../lib/plextrac-api');
const log = require('../../lib/logger');

const ENABLED = String(process.env.PLEXTRAC_CHANGE_TRACKING_ENABLED).toLowerCase() === 'true';

function buildPath(clientId, reportId) {
  const tmpl = process.env.PLEXTRAC_TRACKING_PATH || '';
  return tmpl
    .replace('{clientId}', String(clientId))
    .replace('{reportId}', String(reportId));
}

function parseBody(envVar) {
  const raw = process.env[envVar];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    log.warn('Change-tracking body env var is not valid JSON', { var: envVar });
    return {};
  }
}

async function toggle(clientId, reportId, on) {
  if (!ENABLED) {
    log.info('Plextrac change-tracking toggle skipped (disabled) — relying on internal audit log', {
      desired_state: on ? 'on' : 'off',
      report_id: reportId,
    });
    return false;
  }

  const method = (process.env.PLEXTRAC_TRACKING_METHOD || 'put').toLowerCase();
  const path = buildPath(clientId, reportId);
  if (!path) {
    log.warn('Change-tracking enabled but PLEXTRAC_TRACKING_PATH is not set — skipping', {});
    return false;
  }
  const body = parseBody(on ? 'PLEXTRAC_TRACKING_ON_BODY' : 'PLEXTRAC_TRACKING_OFF_BODY');

  try {
    await api.raw(method, path, body);
    log.info('Plextrac change-tracking toggled', { state: on ? 'on' : 'off', report_id: reportId });
    return true;
  } catch (err) {
    // Never abort the QA run because tracking failed — we still log every change.
    log.error('Plextrac change-tracking toggle failed (continuing with internal audit log)', {
      reason: err.message,
      state: on ? 'on' : 'off',
      report_id: reportId,
    });
    return false;
  }
}

const enable = (clientId, reportId) => toggle(clientId, reportId, true);
const disable = (clientId, reportId) => toggle(clientId, reportId, false);

module.exports = { enable, disable };
