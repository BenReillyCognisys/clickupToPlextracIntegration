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
 * DeliveryFlow calls again whenever the engagement changes, and a repeat call
 * carries what the ClickUp rename sync (pipeline/task-rename.js) does for a renamed
 * task:
 *   • client name changed — the Plextrac client is renamed when that is safe (same
 *     rules as ClickUp: only when this is its sole report and the name is free);
 *   • testing type or scope changed — the report is renamed;
 *   • a first start date for a report created without one — the report is renamed
 *     for that month and its dates filled in;
 *   • client name or testing type changed — the portal re-scopes the form. A signed
 *     form is never rewritten; that is posted to Slack for someone to reissue.
 * New dates and consultants are kept on the record, which is what the availability
 * cache reads when AVAILABILITY_SOURCE=deliveryflow.
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
const { createAuthForm, updateAuthForm, createTestFilesLink } = require('../lib/secure-portal-api');
const { findOrCreateClient } = require('../pipeline/plextrac-client');
const { createPlextracReport, buildReportName, epochToISO } = require('../pipeline/plextrac-report');
const { syncClientName } = require('../pipeline/task-rename');
const plextracApi = require('../lib/plextrac-api');
const store = require('../lib/deliveryflow-store');
const { withTaskLock } = require('../lib/task-lock');
const TESTING_TYPES = require('../config/testing-types');
const PORTAL_TEST_TYPES = require('../config/portal-test-types');
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

// DeliveryFlow sends the portal's own testing types (config/portal-test-types.js):
// passed to the portal exactly, with plextracType naming the report and choosing its
// template. The break.services names that ClickUp tasks resolve to (the canonical
// pentest types, the free half-day Black Box, VMaaS) are still accepted for callers
// built against them; those reach the portal through its fuzzy matcher, as ClickUp's
// do.
const PORTAL_TYPES = PORTAL_TEST_TYPES.map((t) => ({
  testType: t.name,
  plextracType: t.plextracType || t.name,
  skipPlextrac: Boolean(t.skipPlextrac),
}));
const LEGACY_TYPES = [...TESTING_TYPES.map((t) => t.type), FREE_TYPE, VMAAS_TEST_TYPE]
  .filter((name) => !PORTAL_TYPES.some((p) => p.testType === name))
  .map((name) => ({ testType: name, plextracType: name, skipPlextrac: name === VMAAS_TEST_TYPE }));
const KNOWN_TYPES = [...PORTAL_TYPES, ...LEGACY_TYPES];

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

// The engagement's price in pounds, as DeliveryFlow holds it: a number, or a numeric
// string (commas and a leading £ are tolerated). null when not sent.
const MAX_COST = 10_000_000;
function optionalCost(body, field) {
  const raw = body[field];
  if (raw == null || raw === '') return null;
  const cleaned = typeof raw === 'string' ? raw.trim().replace(/^£/, '').replace(/,/g, '') : raw;
  const n = typeof cleaned === 'number' ? cleaned : (/^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : NaN);
  if (!Number.isFinite(n) || n < 0 || n > MAX_COST) {
    throw new ValidationError(field, `${field} must be a number of pounds, 0 or more`);
  }
  return n;
}

// ── Free or paid Black Box ─────────────────────────────────────────────────────
// The two tiers are different auth-form elements (a free half-day on one URL, or a
// paid test sized by the client's scope) and are booked and reported differently,
// so picking the wrong one is costly. The engagement's price settles it: £0 is the
// Free Black Box, anything more is the Paid Black Box Pentest. Any Black Box name
// DeliveryFlow sends — either tier, or plain "Black Box" — is resolved this way when
// engagementCost is present; without it the name sent is used as it is.
const FREE_BLACK_BOX = 'Free Black Box Web App';
const PAID_BLACK_BOX = 'Paid Black Box Pentest';
const BLACK_BOX_NAMES = new Set([FREE_BLACK_BOX, PAID_BLACK_BOX, 'Black Box', FREE_TYPE].map((n) => n.toLowerCase()));

function resolveBlackBoxTier(known, engagementCost) {
  if (!BLACK_BOX_NAMES.has(known.testType.toLowerCase())) return { known, blackBox: null };
  if (engagementCost == null) return { known, blackBox: { tier: null, decidedBy: 'testType', requestedTestType: known.testType } };
  const tier = engagementCost > 0 ? 'paid' : 'free';
  const name = tier === 'paid' ? PAID_BLACK_BOX : FREE_BLACK_BOX;
  return {
    known: PORTAL_TYPES.find((t) => t.testType === name),
    blackBox: { tier, decidedBy: 'engagementCost', requestedTestType: known.testType },
  };
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
  const requested = KNOWN_TYPES.find((t) => t.testType.toLowerCase() === wanted);
  if (!requested) {
    throw new ValidationError(
      'testType',
      `testType "${body.testType}" is not recognised. Use one of the portal's testing types: ${PORTAL_TYPES.map((t) => t.testType).join(', ')}`,
    );
  }
  const engagementCost = optionalCost(body, 'engagementCost');
  const { known, blackBox } = resolveBlackBoxTier(requested, engagementCost);
  // testType: what the portal gets and the record keeps. plextracType: the report's
  // name and template. skipPlextrac: no report at all (VMaaS, Signature Only).
  const { testType, plextracType, skipPlextrac } = known;

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
    plextracType,
    skipPlextrac,
    engagementCost,
    blackBox,
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

// ─── Changes to an engagement already set up ──────────────────────────────────

// Case- and whitespace-insensitive, as the ClickUp rename sync and the portal compare.
const sameText = (a, b) => {
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
};

// What DeliveryFlow changed since the last call: [{ field, from, to }]. Empty for an
// engagement being set up for the first time.
function describeChanges(existing, input) {
  if (!existing?.client_name) return [];
  const changes = [];
  if (!sameText(existing.client_name, input.clientName)) {
    changes.push({ field: 'clientName', from: existing.client_name, to: input.clientName });
  }
  if (existing.test_type !== input.testType) {
    changes.push({ field: 'testType', from: existing.test_type, to: input.testType });
  }
  if (!sameText(existing.scope, input.scope)) {
    changes.push({ field: 'scope', from: existing.scope ?? null, to: input.scope });
  }
  return changes;
}

const describe = (changes) => changes.map((c) => `${c.field} "${c.from ?? ''}" → "${c.to ?? ''}"`).join(', ');

/**
 * Brings a linked Plextrac report (and its client) in line with the engagement.
 * Best-effort, like the ClickUp rename sync: failures are logged and, where someone
 * has to act, posted to Slack — never failed back to DeliveryFlow, whose change has
 * already happened. Returns { clientRenamed, reportRenamed, reportName, startDatePending }.
 */
async function syncLinkedReport(existing, input, changes) {
  const clientId = existing.plextrac_client_id;
  const reportId = existing.plextrac_report_id;
  const label = `${input.clientName} (DeliveryFlow engagement ${input.engagementId})`;
  const changed = (field) => changes.some((c) => c.field === field);
  const out = {
    clientRenamed: false,
    reportRenamed: false,
    reportName: existing.report_name ?? null,
    startDatePending: Boolean(existing.start_date_pending),
  };

  if (changed('clientName')) {
    out.clientRenamed = await syncClientName(
      { plextrac_client_id: clientId }, input.clientName, label,
      { oldClientName: existing.client_name, source: 'DeliveryFlow' },
    );
  }

  // Re-typed to something with no report (VMaaS, Signature Only): this report may
  // already hold work, so it is left for a person to decide about.
  if (input.skipPlextrac) {
    if (changed('testType')) {
      log.notify(`${label} changed from ${existing.test_type} to ${input.testType}, which has no Plextrac report — its report <${reportUrl(clientId, reportId)}|${out.reportName}> was left in place; please remove it if it isn't needed.`);
    }
    return out;
  }

  const datesArrived = Boolean(existing.start_date_pending) && input.startDate != null;
  if (!changed('testType') && !changed('scope') && !datesArrived) return out;

  const startMs = input.startDate ?? existing.start_date ?? null;
  const name = buildReportName(input.plextracType, startMs, input.scope);
  try {
    const report = await plextracApi.getReport(clientId, reportId);
    const current = report?.name ?? null;
    const payload = {};
    if (current == null || current.toLowerCase() !== name.toLowerCase()) payload.name = name;
    if (datesArrived) {
      payload.start_date = epochToISO(input.startDate);
      payload.end_date = epochToISO(input.endDate ?? existing.end_date);
    }
    if (Object.keys(payload).length) await plextracApi.updateReport(clientId, reportId, payload);

    out.reportName = name;
    if (datesArrived) out.startDatePending = false;
    if (payload.name) {
      out.reportRenamed = true;
      log.info('DeliveryFlow auth-form — Plextrac report renamed', {
        engagementId: input.engagementId, report_id: reportId, old_name: current, new_name: name,
      });
      log.notify(`DeliveryFlow change synced for ${label} — report renamed from "${current}" to <${reportUrl(clientId, reportId)}|${name}>.`);
    }
  } catch (err) {
    log.error('DeliveryFlow auth-form — could not update the Plextrac report', {
      engagementId: input.engagementId, client_id: clientId, report_id: reportId, reason: err.message,
    });
    return out;
  }

  try {
    await store.updateEngagement(input.engagementId, {
      report_name: out.reportName, start_date_pending: out.startDatePending, plextrac_type: input.plextracType,
    });
  } catch (err) {
    log.error('DeliveryFlow auth-form — could not record the report update', { engagementId: input.engagementId, reason: err.message });
  }
  return out;
}

/**
 * Asks the portal to re-scope an existing form for a new client name or testing
 * type — what pipeline/auth-form-rename.js does for a renamed ClickUp task. Returns:
 *   { kind: 'rescoped', result } — the form now matches
 *   { kind: 'missing' }          — the portal has no open form; create one instead
 *   { kind: 'refused', … }       — signed, or the portal can't apply it (Slack told)
 *   { kind: 'failed', status, error, code? }
 */
async function rescopeAuthForm(input, plextrac, previous) {
  const { engagementId } = input;
  const label = `${input.clientName} (DeliveryFlow engagement ${engagementId})`;
  const change = [
    previous.testType !== input.testType ? `testing type "${previous.testType}" → "${input.testType}"` : null,
    !sameText(previous.clientName, input.clientName) ? `client "${previous.clientName}" → "${input.clientName}"` : null,
  ].filter(Boolean).join(' and ');

  let result;
  try {
    result = await updateAuthForm({
      clientName: input.clientName,
      testType: input.testType,
      previousClientName: previous.clientName ?? null,
      previousTestType: previous.testType ?? null,
      clickupTaskId: engagementId,
      clickupTaskUrl: input.engagementUrl,
      plextracClientId: plextrac.clientId ?? null,
      plextracReportId: plextrac.reportId ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      source: 'deliveryflow',
      engagementId,
      engagementUrl: input.engagementUrl,
      dealId: input.dealId,
    });
  } catch (err) {
    if (err.status === 404) {
      log.info('DeliveryFlow auth-form — no open form to re-scope; creating one', { engagementId, change });
      return { kind: 'missing' };
    }
    if (err.status === 409) {
      log.warn('DeliveryFlow auth-form — form already signed; not re-scoped', { engagementId, change });
      log.notify(`${label} changed (${change}) but its authorisation form has already been signed, so it was not changed. Please issue a new form for the new scope.`);
      return { kind: 'refused', reason: 'form_signed' };
    }
    if (err.status === 400) {
      return { kind: 'failed', status: 422, code: 'test_type_not_on_auth_form', error: err.message };
    }
    log.error('DeliveryFlow auth-form — portal re-scope failed', { engagementId, change, reason: err.message });
    return { kind: 'failed', status: 502, error: `auth-form re-scope failed: ${err.message}` };
  }

  if (!result?.ok) {
    log.error('DeliveryFlow auth-form — portal re-scope reported failure', {
      engagementId, response: JSON.stringify(result ?? null).slice(0, 200),
    });
    return { kind: 'failed', status: 502, error: 'auth-form re-scope failed' };
  }
  if (result.updated === false) {
    const reason = result.reason || 'no reason given';
    log.warn('DeliveryFlow auth-form — portal left the form unchanged', { engagementId, change, reason });
    log.notify(`${label} changed (${change}) but its authorisation form was left unchanged (${reason}) — please check whether it needs reissuing.`);
    return { kind: 'refused', reason, formUrl: result.formUrl, formToken: result.formToken };
  }

  if (!result.unchanged) {
    const link = result.formUrl ? ` <${result.formUrl}|Updated form>.` : '';
    log.notify(`Authorisation form re-scoped for ${label} — ${change}.${link}`);
  }
  return { kind: 'rescoped', result };
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

// ─── POST /api/deliveryflow/auth-form/update ──────────────────────────────────
// DeliveryFlow's test selector moved an engagement to a different testing type. The
// DeliveryFlow counterpart of a renamed ClickUp task (pipeline/task-rename.js): the
// portal re-scopes the form (the old type's element out, the new one in), the
// Plextrac report is renamed for the new type — or created, if the old type had
// none — and a signed form is never rewritten (Slack is asked to reissue it).
//
//   { engagementId, testType, previousTestType?, engagementCost?, clientName?, dealId? }
//
// Only the engagement and the new type are needed; everything else defaults to what
// break.services recorded when the engagement was set up. previousTestType is what
// DeliveryFlow had selected before. What is actually on the form, as recorded here,
// wins over it when the two disagree; it matters for a form a PM linked by hand,
// whose type break.services never saw. The engagement must already have been set up
// (POST /auth-form) or linked in the portal; otherwise 404 — call /auth-form.

const toYmd = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString().slice(0, 10));

router.post('/auth-form/update', requireDeliveryFlowKey, async (req, res) => {
  const body = req.body || {};
  let engagementId;
  try {
    engagementId = requiredId(body, 'engagementId');
    if (typeof body.testType !== 'string' || !body.testType.trim()) {
      throw new ValidationError('testType', 'testType is required');
    }
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message, field: err.field });
  }

  if (!process.env.SECURE_PORTAL_URL) {
    log.error('DeliveryFlow auth-form update — SECURE_PORTAL_URL is not set', { engagementId });
    return res.status(503).json({ ok: false, error: 'auth-form generation is not configured' });
  }

  try {
    const { status, body: out } = await withTaskLock(`deliveryflow:${engagementId}`, async () => {
      let existing;
      try {
        existing = await store.findByEngagementId(engagementId);
      } catch (err) {
        log.error('DeliveryFlow auth-form update — could not read the engagement record', { engagementId, reason: err.message });
        return { status: 500, body: { ok: false, error: 'could not read the engagement record; safe to retry' } };
      }
      if (!existing) {
        return {
          status: 404,
          body: { ok: false, error: 'unknown_engagement', engagementId, detail: 'No auth form has been generated for this engagement yet — call /api/deliveryflow/auth-form.' },
        };
      }

      // The engagement as recorded, with the new type (and anything else sent) on top.
      let input;
      try {
        input = parseAuthFormRequest({
          engagementId,
          dealId: body.dealId ?? existing.deal_id,
          clientName: body.clientName ?? existing.client_name ?? existing.form_client_name,
          testType: body.testType,
          engagementCost: body.engagementCost ?? existing.engagement_cost,
          scope: existing.scope ?? null,
          startDate: toYmd(existing.start_date),
          endDate: toYmd(existing.end_date),
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          return { status: 400, body: { ok: false, error: err.message, field: err.field } };
        }
        throw err;
      }

      // The type the form was generated for: our record, else what DeliveryFlow says.
      const hinted = typeof body.previousTestType === 'string'
        ? KNOWN_TYPES.find((t) => t.testType.toLowerCase() === body.previousTestType.trim().toLowerCase())?.testType
          ?? body.previousTestType.trim()
        : null;
      const onRecord = existing.form_test_type ?? existing.test_type ?? null;
      if (hinted && onRecord && hinted !== onRecord) {
        log.warn('DeliveryFlow auth-form update — previousTestType differs from the recorded form; using the record', {
          engagementId, sent: hinted, recorded: onRecord,
        });
      }
      const previousTestType = onRecord ?? hinted;

      log.info('DeliveryFlow auth-form update — testing type change', {
        engagementId, from: previousTestType, to: input.testType,
      });
      const result = await setUpEngagement(input, { previousTestType, rescopeLinkedForm: true });
      if (result.body?.ok) {
        result.body = {
          ...result.body,
          previousTestType,
          changed: previousTestType !== input.testType,
          formRescope: result.body.formRescope ?? 'not_needed',
        };
      }
      return result;
    });
    res.status(status).json(out);
  } catch (err) {
    log.error('DeliveryFlow auth-form update — unexpected failure', { engagementId, reason: err.message });
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
  const { engagementId, dealId, clientName, testType, plextracType } = input;

  if (input.skipPlextrac) {
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
  const name = buildReportName(plextracType, input.startDate, input.scope);
  if (startDatePending) {
    log.warn('DeliveryFlow engagement has no startDate — using current month/year for report name', {
      engagementId, report: name,
    });
  }

  let report;
  try {
    report = await createPlextracReport(clientId, {
      name,
      testingType: plextracType,
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
      engagementId, dealId, clientName, testType, plextracType,
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

// `opts` is passed through to requestAuthForm (see there); /auth-form sends none.
async function setUpEngagement(input, opts = {}) {
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

  // The price contradicted the Black Box tier DeliveryFlow picked: the price wins,
  // but someone should check the engagement in DeliveryFlow is set up right.
  const bb = input.blackBox;
  if (bb?.decidedBy === 'engagementCost'
    && [FREE_BLACK_BOX, PAID_BLACK_BOX].includes(bb.requestedTestType)
    && bb.requestedTestType !== testType) {
    log.warn('DeliveryFlow auth-form — Black Box tier set from engagementCost, not the type sent', {
      engagementId, requested: bb.requestedTestType, used: testType, engagement_cost: input.engagementCost,
    });
    log.notify(`DeliveryFlow sent "${bb.requestedTestType}" for ${clientName} (engagement ${engagementId}) but the engagement cost is £${input.engagementCost}, so it was set up as "${testType}". Please check the engagement in DeliveryFlow.`);
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

  // A repeat call for an engagement DeliveryFlow has since changed.
  const changes = describeChanges(existing, input);
  if (plextrac.status === 'already_linked' && (changes.length || existing.start_date_pending)) {
    const synced = await syncLinkedReport(existing, input, changes);
    Object.assign(plextrac, synced);
  }
  if (changes.length) {
    log.info('DeliveryFlow auth-form — engagement changed', { engagementId, changes: describe(changes) });
  }

  // ── Phase 4: authorisation form ───────────────────────────────────────────
  const authForm = await requestAuthForm(input, plextrac, existing, opts);

  // ── Phase 5: announce a report we actually created ────────────────────────
  // Same notice as the ClickUp pipeline, sent whether or not the form came back —
  // the report exists either way.
  if (plextrac.status === 'created') {
    const suffix = plextrac.clientCreated ? 'Client was created.' : 'Client already exists.';
    const authLine = authForm.ok ? ` Auth form: <${authForm.formUrl}|link>.` : '';
    log.notify(`Report has been created for ${clientName} - <${plextrac.reportUrl}|${plextrac.reportName}>. ${suffix}${authLine} (DeliveryFlow)`);
  }

  if (!authForm.ok) {
    return {
      status: authForm.status,
      body: { ok: false, error: authForm.code || authForm.error, detail: authForm.code ? authForm.error : undefined, stage: authForm.stage, plextrac },
    };
  }

  log.info('DeliveryFlow engagement set up', {
    engagementId, dealId, client: clientName, testType,
    ...(input.engagementCost != null ? { engagement_cost: input.engagementCost } : {}),
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
      // Only on a repeat call that changed something: what changed, and whether the
      // form now reflects it ('rescoped' | 'recreated' | 'refused' | 'not_needed').
      // The testing type actually used — for a Black Box, the tier engagementCost
      // decided, which may differ from the one sent.
      testType,
      ...(input.blackBox ? { blackBox: input.blackBox } : {}),
      ...(changes.length ? { changes } : {}),
      ...(changes.length || authForm.rescope !== 'not_needed' ? { formRescope: authForm.rescope } : {}),
      plextrac,
    },
  };
}

// Asks the portal for the form — re-scoping the existing one when the client name or
// testing type changed — and records it. Returns { ok: true, ...form, rescope } or
// { ok: false, status, error, stage, code? }. Retrying after a failure is safe: the
// report is already linked, and the portal hands back the same form for the same
// engagement.
//
// opts (from POST /auth-form/update — DeliveryFlow changed the testing type):
//   previousTestType  — the type DeliveryFlow says the engagement had. Used when our
//                       record doesn't know what's on the form (a form a PM linked).
//   rescopeLinkedForm — re-scope a PM-linked form too, rather than leave it as it is.
async function requestAuthForm(input, plextrac, existing, opts = {}) {
  const { engagementId, dealId } = input;

  // What the current form was generated for (see lib/deliveryflow-store.js).
  const previous = {
    clientName: existing?.form_client_name ?? existing?.client_name,
    testType: existing?.form_test_type ?? opts.previousTestType ?? existing?.test_type,
  };
  const needsRescope = Boolean(existing?.form_url)
    && (!sameText(previous.clientName, input.clientName) || previous.testType !== input.testType);

  let result = null;
  let rescope = 'not_needed';
  let formFor = { formClientName: input.clientName, formTestType: input.testType };

  // A PM linked this engagement to a form in the portal (see /link-auth-form). That
  // form is the engagement's: reuse it rather than generate another — and only
  // re-scope it when DeliveryFlow explicitly changed the testing type.
  if (existing?.form_source === 'portal' && existing.form_url && !(opts.rescopeLinkedForm && needsRescope)) {
    result = { ok: true, created: false, formUrl: existing.form_url, formToken: existing.form_token };
    formFor = { formClientName: existing.form_client_name ?? input.clientName, formTestType: existing.form_test_type ?? null };
  } else if (needsRescope) {
    const r = await rescopeAuthForm(input, plextrac, previous);
    if (r.kind === 'failed') return { ok: false, status: r.status, error: r.error, code: r.code, stage: 'auth_form' };
    if (r.kind === 'rescoped') {
      result = { ...r.result, created: false };
      rescope = 'rescoped';
    } else if (r.kind === 'refused') {
      // The live form still carries the old scope; keep recording it as such.
      result = { ok: true, created: false, formUrl: r.formUrl || existing.form_url, formToken: r.formToken ?? existing.form_token };
      rescope = 'refused';
      formFor = { formClientName: previous.clientName, formTestType: previous.testType };
    } else {
      rescope = 'recreated'; // the portal had no open form: create one below
    }
  }

  if (!result) {
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
      // 400: the portal can't place this testing type on a form. Retrying won't
      // change that, so it isn't reported as a temporary failure.
      if (err.status === 400) {
        log.error('DeliveryFlow auth-form — portal does not recognise the testing type', { engagementId, testType: input.testType, reason: err.message });
        return { ok: false, status: 422, code: 'test_type_not_on_auth_form', error: err.message, stage: 'auth_form' };
      }
      log.error('DeliveryFlow auth-form — portal generation failed', { engagementId, dealId, reason: err.message });
      return { ok: false, status: 502, error: `auth-form generation failed: ${err.message}`, stage: 'auth_form' };
    }

    if (!result?.ok || !result.formUrl) {
      log.error('DeliveryFlow auth-form — portal returned no form URL', {
        engagementId, dealId, response: JSON.stringify(result ?? null).slice(0, 200),
      });
      return { ok: false, status: 502, error: 'auth-form generation returned no form URL', stage: 'auth_form' };
    }
  }

  // The intake call normally returns the test-files link too; when it didn't (and none
  // is on record), ask for it on its own, as the ClickUp flow does. Best-effort: the
  // next call tries again.
  let testFilesUrl = result.testFilesUrl ?? existing?.test_files_url ?? null;
  let testFilesToken = result.testFilesToken ?? existing?.test_files_token ?? null;
  if (!testFilesUrl) {
    try {
      const files = await createTestFilesLink({
        clientName: input.clientName,
        clickupTaskId: engagementId,
        clickupTaskUrl: input.engagementUrl,
        plextracClientId: plextrac.clientId ?? null,
      });
      if (files?.ok && files.testFilesUrl) {
        testFilesUrl = files.testFilesUrl;
        testFilesToken = files.testFilesToken ?? null;
      }
    } catch (err) {
      log.warn('DeliveryFlow auth-form — no test-files link this time', { engagementId, reason: err.message });
    }
  }

  try {
    await store.saveAuthForm({
      ...input,
      ...formFor,
      formUrl: result.formUrl,
      formToken: result.formToken,
      testFilesUrl,
      testFilesToken,
    });
  } catch (err) {
    log.error('DeliveryFlow auth-form — could not record the auth form', { engagementId, dealId, reason: err.message });
    return { ok: false, status: 500, error: 'could not record the auth form; safe to retry', stage: 'store' };
  }

  return {
    ok: true,
    created: result.created !== false,
    rescope,
    formUrl: result.formUrl,
    formToken: result.formToken ?? null,
    testFilesUrl,
    testFilesToken,
  };
}

module.exports = router;
