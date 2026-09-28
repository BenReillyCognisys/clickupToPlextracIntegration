/**
 * DeliveryFlow → break.services endpoints.
 *
 *   POST /api/deliveryflow/auth-form — set up a DeliveryFlow engagement: find or
 *                                      create the Plextrac client, create the
 *                                      Plextrac report, and create (or return) the
 *                                      client authorisation form.
 *
 * This is the DeliveryFlow counterpart of the ClickUp taskCreated pipeline
 * (pipeline/index.js) and runs the same phases in the same order, with the same
 * Plextrac helpers:
 *
 *   1. blacklist check          (config/blacklist.js)      → 422, nothing created
 *   2. find/create the client   (pipeline/plextrac-client) → 502 on failure
 *   3. create the report        (pipeline/plextrac-report) → 502 on failure
 *   4. generate the auth form   (portal, lib/secure-portal-api)
 *   5. Slack notice for a newly created report
 *
 * Where ClickUp needed parsing, DeliveryFlow sends structured fields: the client,
 * testing type and scope come in the body rather than out of a task name, and the
 * report operators are `consultantEmails` rather than ClickUp assignees. VMaaS
 * engagements skip phases 2–3 exactly as the ClickUp VMaaS pipeline does — there
 * is no Plextrac report behind them.
 *
 * Idempotent per engagement: the Plextrac link is stored as soon as the report
 * exists (lib/deliveryflow-store.js), so a repeat call — or a retry after a portal
 * failure — reuses that report instead of creating another, and the portal returns
 * the same form. An engagement stays on the deal it was first created under; a call
 * naming a different deal is refused with a 409 before anything is touched.
 *
 * DeliveryFlow authenticates with a shared secret in the X-API-Key header:
 * DELIVERYFLOW_API_KEY when it is set, otherwise AVAILABILITY_API_KEY (the key the
 * scheduling and /tasks/* endpoints use). Setting DELIVERYFLOW_API_KEY later gives
 * DeliveryFlow a key of its own without a code change. Server-to-server, so no CORS.
 *
 * The portal keys forms on `clickupTaskId`, so the engagement id is sent in that
 * field (and again as `engagementId`, with `dealId` and `source: 'deliveryflow'`,
 * for when the portal grows native fields).
 */

const express = require('express');
const crypto = require('crypto');
const { deliveryFlowKey } = require('../lib/deliveryflow-api');
const { createAuthForm } = require('../lib/secure-portal-api');
const { findOrCreateClient } = require('../pipeline/plextrac-client');
const { createPlextracReport, buildReportName } = require('../pipeline/plextrac-report');
const store = require('../lib/deliveryflow-store');
const { withTaskLock } = require('../lib/task-lock');
const TESTING_TYPES = require('../config/testing-types');
const BLACKLIST = require('../config/blacklist');
const { FREE_TYPE } = require('../config/free-markers');
const { VMAAS_TEST_TYPE } = require('../pipeline/vmaas');
const log = require('../lib/logger');

const router = express.Router();

const reportUrl = (clientId, reportId) =>
  `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}/client/${clientId}/report/${reportId}`;

// ─── Auth ─────────────────────────────────────────────────────────────────────

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireDeliveryFlowKey(req, res, next) {
  const expected = deliveryFlowKey();
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}


// ─── Validation ───────────────────────────────────────────────────────────────

// Every testing type the portal has a form element for: the canonical pentest
// types, the free half-day Black Box, and VMaaS.
const ALLOWED_TEST_TYPES = [...TESTING_TYPES.map((t) => t.type), FREE_TYPE, VMAAS_TEST_TYPE];

// Ids are opaque to us but end up in a Mongo key and the portal's form key, so keep
// them to URL-safe characters (covers UUIDs and numeric CRM ids).
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CLIENT_NAME = 200;
// Same ceiling the task-name parser puts on a scope qualifier: past this it's prose,
// and the Plextrac report name becomes unreadable.
const MAX_SCOPE = 60;
const MAX_CONSULTANTS = 20;

class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function requiredId(body, field) {
  const raw = body[field] == null ? '' : String(body[field]).trim();
  if (!raw) throw new ValidationError(field, `${field} is required`);
  if (!ID_RE.test(raw)) {
    throw new ValidationError(field, `${field} must be 1-64 characters of letters, digits, "-" or "_"`);
  }
  return raw;
}

function optionalText(body, field, max) {
  const raw = body[field];
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new ValidationError(field, `${field} must be a string`);
  const text = raw.trim();
  if (text.length > max) throw new ValidationError(field, `${field} must be at most ${max} characters`);
  return text || null;
}

// yyyy-mm-dd → unix ms at UTC midnight (all-day), the shape the portal and the
// Plextrac report helpers take.
function optionalDate(body, field) {
  const raw = body[field];
  if (raw == null || raw === '') return null;
  const ms = YMD_RE.test(String(raw)) ? Date.parse(`${raw}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) throw new ValidationError(field, `${field} must be a yyyy-mm-dd date`);
  return ms;
}

function optionalUrl(body, field) {
  const raw = body[field];
  if (raw == null || raw === '') return null;
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ValidationError(field, `${field} must be a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError(field, `${field} must be an http(s) URL`);
  }
  return url.toString();
}

// The consultants delivering the engagement — they become the Plextrac report's
// operators, as a ClickUp task's assignees do. Plextrac validates the addresses
// itself; this only rejects values that aren't email-shaped at all.
function optionalEmails(body, field) {
  const raw = body[field];
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(field, `${field} must be an array of email addresses`);
  if (raw.length > MAX_CONSULTANTS) {
    throw new ValidationError(field, `${field} may list at most ${MAX_CONSULTANTS} addresses`);
  }
  const emails = raw.map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''));
  const bad = raw.find((e, i) => !EMAIL_RE.test(emails[i]));
  if (bad !== undefined) throw new ValidationError(field, `${field} contains an invalid email address: ${JSON.stringify(bad)}`);
  return [...new Set(emails)];
}

function parseAuthFormRequest(body) {
  const engagementId = requiredId(body, 'engagementId');
  const dealId = requiredId(body, 'dealId');

  const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
  if (!clientName) throw new ValidationError('clientName', 'clientName is required');
  if (clientName.length > MAX_CLIENT_NAME) {
    throw new ValidationError('clientName', `clientName must be at most ${MAX_CLIENT_NAME} characters`);
  }

  const wanted = typeof body.testType === 'string' ? body.testType.trim().toLowerCase() : '';
  if (!wanted) throw new ValidationError('testType', 'testType is required');
  const testType = ALLOWED_TEST_TYPES.find((t) => t.toLowerCase() === wanted);
  if (!testType) {
    throw new ValidationError(
      'testType',
      `testType "${body.testType}" is not recognised. Allowed: ${ALLOWED_TEST_TYPES.join(', ')}`,
    );
  }

  const startDate = optionalDate(body, 'startDate');
  const endDate = optionalDate(body, 'endDate');
  if (startDate != null && endDate != null && endDate < startDate) {
    throw new ValidationError('endDate', 'endDate must not be before startDate');
  }

  return {
    engagementId,
    dealId,
    clientName,
    testType,
    scope: optionalText(body, 'scope', MAX_SCOPE),
    consultantEmails: optionalEmails(body, 'consultantEmails'),
    engagementUrl: optionalUrl(body, 'engagementUrl'),
    startDate,
    endDate,
  };
}

// Same blacklist the ClickUp pipeline applies to task names (leave, retests, …),
// checked across the text DeliveryFlow sends in place of a task name.
function findBlacklistedWord(...texts) {
  const lower = texts.filter(Boolean).join(' ').toLowerCase();
  return BLACKLIST.find((word) => lower.includes(word.toLowerCase())) || null;
}

// ─── POST /api/deliveryflow/auth-form ─────────────────────────────────────────

// Auth is per route rather than router-wide: the portal's callbacks share this
// prefix (routes/deliveryflow-portal.js) and authenticate with the portal's key.
router.post('/auth-form', requireDeliveryFlowKey, async (req, res) => {
  let input;
  try {
    input = parseAuthFormRequest(req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message, field: err.field });
    }
    log.error('DeliveryFlow auth-form — request parsing failed', { reason: err.message });
    return res.status(500).json({ ok: false, error: 'unexpected error' });
  }

  if (!process.env.SECURE_PORTAL_URL) {
    log.error('DeliveryFlow auth-form — SECURE_PORTAL_URL is not set', { engagementId: input.engagementId });
    return res.status(503).json({ ok: false, error: 'auth-form generation is not configured' });
  }

  // Serialise per engagement so a double-submit can't race the deal check, the
  // report creation or the store.
  try {
    const { status, body } = await withTaskLock(`deliveryflow:${input.engagementId}`, () => setUpEngagement(input));
    res.status(status).json(body);
  } catch (err) {
    log.error('DeliveryFlow auth-form — unexpected failure', { engagementId: input.engagementId, reason: err.message });
    res.status(500).json({ ok: false, error: 'unexpected error' });
  }
});

/**
 * Phases 2–3: the engagement's Plextrac client and report. Returns
 * { ok: true, plextrac } or { ok: false, status, body }. `plextrac.status`:
 *   skipped        — VMaaS; no report behind it
 *   already_linked — an earlier call created the report; reused
 *   created        — client found/created and a new report created
 *   report_exists  — a report with this name was already under the client (made by
 *                    hand, or by another engagement); reported but NOT linked, as
 *                    the ClickUp pipeline does
 */
async function ensurePlextracReport(input, existing) {
  const { engagementId, dealId, clientName, testType } = input;

  if (testType === VMAAS_TEST_TYPE) {
    return { ok: true, plextrac: { status: 'skipped', clientId: null, reportId: null } };
  }

  if (existing?.plextrac_report_id != null) {
    return {
      ok: true,
      plextrac: {
        status: 'already_linked',
        clientId: existing.plextrac_client_id,
        clientCreated: false,
        reportId: existing.plextrac_report_id,
        reportName: existing.report_name ?? null,
        reportUrl: reportUrl(existing.plextrac_client_id, existing.plextrac_report_id),
        startDatePending: Boolean(existing.start_date_pending),
      },
    };
  }

  let clientId, clientCreated;
  try {
    ({ clientId, clientCreated } = await findOrCreateClient(clientName));
  } catch (err) {
    log.error('DeliveryFlow auth-form — Plextrac client find/create failed', { engagementId, client: clientName, reason: err.message });
    return { ok: false, status: 502, body: { ok: false, error: `Plextrac client find/create failed: ${err.message}`, stage: 'plextrac_client' } };
  }

  // No start date: the name falls back to the current month, exactly as a ClickUp
  // task without one does, and the record is flagged so it can be renamed later.
  const startDatePending = input.startDate == null;
  const name = buildReportName(testType, input.startDate, input.scope);
  if (startDatePending) {
    log.warn('DeliveryFlow engagement has no startDate — using current month/year for report name', {
      engagementId, report: name,
    });
  }

  let report;
  try {
    report = await createPlextracReport(clientId, {
      name,
      testingType: testType,
      operatorEmails: input.consultantEmails,
      startDateMs: input.startDate,
      endDateMs: input.endDate,
    });
  } catch (err) {
    log.error('DeliveryFlow auth-form — Plextrac report create failed', { engagementId, client_id: clientId, reason: err.message });
    return {
      ok: false, status: 502,
      body: { ok: false, error: `Plextrac report create failed: ${err.message}`, stage: 'plextrac_report', plextrac: { clientId, clientCreated } },
    };
  }

  const plextrac = {
    status: report.existed ? 'report_exists' : 'created',
    clientId,
    clientCreated: Boolean(clientCreated),
    reportId: report.reportId,
    reportName: report.name,
    reportUrl: reportUrl(clientId, report.reportId),
    startDatePending,
  };
  if (report.existed) return { ok: true, plextrac };

  try {
    await store.saveReport({
      engagementId, dealId, clientName, testType,
      scope: input.scope,
      plextracClientId: clientId,
      plextracReportId: report.reportId,
      plextracReportCuid: report.reportCuid,
      reportName: report.name,
      startDatePending,
    });
  } catch (err) {
    // The report exists but isn't linked. A retry would find it by name and report
    // report_exists rather than create a duplicate — say so, with the ids, so it can
    // be linked by hand.
    log.error('DeliveryFlow auth-form — could not record the Plextrac report', {
      engagementId, report_id: report.reportId, reason: err.message,
    });
    return {
      ok: false, status: 500,
      body: { ok: false, error: 'the Plextrac report was created but could not be recorded against the engagement', stage: 'store', plextrac },
    };
  }

  return { ok: true, plextrac };
}

async function setUpEngagement(input) {
  const { engagementId, dealId, clientName, testType } = input;

  // ── Deal check ────────────────────────────────────────────────────────────
  let existing;
  try {
    existing = await store.findByEngagementId(engagementId);
  } catch (err) {
    log.error('DeliveryFlow auth-form — could not read the engagement record', { engagementId, reason: err.message });
    return { status: 500, body: { ok: false, error: 'could not read the engagement record; safe to retry' } };
  }

  if (existing && existing.deal_id && existing.deal_id !== dealId) {
    log.warn('DeliveryFlow auth-form — engagement already belongs to a different deal', {
      engagementId, dealId, existingDealId: existing.deal_id,
    });
    return {
      status: 409,
      body: { ok: false, error: 'deal_id_conflict', engagementId, dealId, existingDealId: existing.deal_id },
    };
  }

  // ── Phase 1: blacklist ────────────────────────────────────────────────────
  const hit = findBlacklistedWord(clientName, input.scope);
  if (hit) {
    log.warn('DeliveryFlow auth-form — blacklisted word, nothing created', { engagementId, word: hit, client: clientName });
    log.notify(`Blacklisted word detected - ${hit} - ${clientName} ${testType} (DeliveryFlow engagement ${engagementId})`);
    return { status: 422, body: { ok: false, error: 'blacklisted', word: hit } };
  }

  // ── Phases 2–3: Plextrac client + report ──────────────────────────────────
  const plextracResult = await ensurePlextracReport(input, existing);
  if (!plextracResult.ok) return { status: plextracResult.status, body: plextracResult.body };
  const { plextrac } = plextracResult;

  // ── Phase 4: authorisation form ───────────────────────────────────────────
  const authForm = await requestAuthForm(input, plextrac);

  // ── Phase 5: announce a report we actually created ────────────────────────
  // Same notice as the ClickUp pipeline, sent whether or not the form came back —
  // the report exists either way.
  if (plextrac.status === 'created') {
    const suffix = plextrac.clientCreated ? 'Client was created.' : 'Client already exists.';
    const authLine = authForm.ok ? ` Auth form: <${authForm.formUrl}|link>.` : '';
    log.notify(`Report has been created for ${clientName} - <${plextrac.reportUrl}|${plextrac.reportName}>. ${suffix}${authLine} (DeliveryFlow)`);
  }

  if (!authForm.ok) {
    return { status: authForm.status, body: { ok: false, error: authForm.error, stage: authForm.stage, plextrac } };
  }

  log.info('DeliveryFlow engagement set up', {
    engagementId, dealId, client: clientName, testType,
    plextrac: plextrac.status, report_id: plextrac.reportId, form_url: authForm.formUrl, form_created: authForm.created,
  });

  return {
    status: authForm.created || plextrac.status === 'created' ? 201 : 200,
    body: {
      ok: true,
      created: authForm.created,
      engagementId,
      dealId,
      formUrl: authForm.formUrl,
      formToken: authForm.formToken,
      testFilesUrl: authForm.testFilesUrl,
      testFilesToken: authForm.testFilesToken,
      plextrac,
    },
  };
}

// Asks the portal for the form and records it. Returns { ok: true, ...form } or
// { ok: false, status, error, stage }. Retrying after a failure is safe: the report
// is already linked, and the portal hands back the same form for the same engagement.
async function requestAuthForm(input, plextrac) {
  const { engagementId, dealId } = input;

  let result;
  try {
    result = await createAuthForm({
      clientName: input.clientName,
      testType: input.testType,
      // The portal keys forms on clickupTaskId; the engagement id stands in for it.
      clickupTaskId: engagementId,
      clickupTaskUrl: input.engagementUrl,
      plextracClientId: plextrac.clientId ?? null,
      plextracReportId: plextrac.reportId ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      source: 'deliveryflow',
      engagementId,
      engagementUrl: input.engagementUrl,
      dealId,
    });
  } catch (err) {
    log.error('DeliveryFlow auth-form — portal generation failed', { engagementId, dealId, reason: err.message });
    return { ok: false, status: 502, error: `auth-form generation failed: ${err.message}`, stage: 'auth_form' };
  }

  if (!result?.ok || !result.formUrl) {
    log.error('DeliveryFlow auth-form — portal returned no form URL', {
      engagementId, dealId, response: JSON.stringify(result ?? null).slice(0, 200),
    });
    return { ok: false, status: 502, error: 'auth-form generation returned no form URL', stage: 'auth_form' };
  }

  try {
    await store.saveAuthForm({
      ...input,
      formUrl: result.formUrl,
      formToken: result.formToken,
      testFilesUrl: result.testFilesUrl,
      testFilesToken: result.testFilesToken,
    });
  } catch (err) {
    log.error('DeliveryFlow auth-form — could not record the auth form', { engagementId, dealId, reason: err.message });
    return { ok: false, status: 500, error: 'could not record the auth form; safe to retry', stage: 'store' };
  }

  return {
    ok: true,
    created: result.created !== false,
    formUrl: result.formUrl,
    formToken: result.formToken ?? null,
    testFilesUrl: result.testFilesUrl ?? null,
    testFilesToken: result.testFilesToken ?? null,
  };
}

module.exports = router;
