/**
 * SFE-portal → break.services callbacks for DeliveryFlow engagements.
 *
 * The DeliveryFlow counterparts of the five /clickup/* actions in
 * routes/clickup-actions.js. Same paths under /api/deliveryflow, same request bodies,
 * same key (BREAK_SERVICES_API_KEY in X-API-Key) — so for a form it created with
 * `source: "deliveryflow"` the portal only swaps the path prefix. Where the ClickUp
 * versions write to a task, these forward a typed event to DeliveryFlow
 * (lib/deliveryflow-api.js) and keep a mirror on the engagement record
 * (lib/deliveryflow-store.js):
 *
 *   POST /api/deliveryflow/schedule-task       → schedule_set
 *        The client booked dates and/or gave a report deadline. A Free Black Box is
 *        collapsed onto one day and a repeat submission never moves its booking,
 *        as for ClickUp. A report still named for the month it was created in (no
 *        start date at creation) is renamed from the booked start date — what the
 *        ClickUp start-date watcher does — and its Plextrac dates are filled in.
 *   POST /api/deliveryflow/test-files-uploaded → test_files_uploaded
 *        Called on every upload.
 *   POST /api/deliveryflow/finalised-auth-form → auth_form_finalised
 *        The signed form's canonical Google Drive link, for each engagement it covers.
 *   POST /api/deliveryflow/merged-auth-form    → merged_auth_form
 *        The merged form link, for each engagement it covers.
 *   POST /api/deliveryflow/extra-urls          → extra_urls
 *        A Free Black Box form scoped more than one URL. The Slack alert goes out
 *        regardless, as for ClickUp.
 *
 * Engagement ids: `engagementId` / `engagementIds`, or the portal's existing
 * `clickupTaskId` / `clickupTaskIds` fields (the auth-form endpoint sends the
 * engagement id in clickupTaskId, so a portal that stores only that field works
 * unchanged). An id break.services didn't set up is refused (404 / per-id failure):
 * it is either a ClickUp task sent to the wrong prefix or a typo.
 *
 * The portal doesn't have to pick the path itself: routes/clickup-actions.js looks
 * each id up and hands DeliveryFlow engagements to the handlers exported here, so the
 * portal's existing /clickup/* calls work for both — including one signed form that
 * covers a ClickUp task and a DeliveryFlow engagement together.
 *
 * DeliveryFlow is the system of record, so forwarding is the part that has to land:
 * when it fails the call answers 502 and the portal should retry. Every event is
 * safe to resend.
 */

const express = require('express');
const crypto = require('crypto');
const deliveryflow = require('../lib/deliveryflow-api');
const store = require('../lib/deliveryflow-store');
const api = require('../lib/plextrac-api');
const { buildReportName, epochToISO } = require('../pipeline/plextrac-report');
const { fileIdFromUrl, driveFileUrl } = require('../lib/google-drive');
const { postMessage } = require('../lib/slack');
const { withTaskLock } = require('../lib/task-lock');
const { FREE_TYPE } = require('../config/free-markers');
const log = require('../lib/logger');

const router = express.Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────
// The portal's key, as on /clickup/*. Applied per route: /api/deliveryflow/auth-form
// shares this prefix and takes DeliveryFlow's key instead.

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requirePortalKey(req, res, next) {
  const expected = process.env.BREAK_SERVICES_API_KEY;
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}

// Forwarding is the job of every endpoint but extra-urls (which still alerts Slack),
// so without a DeliveryFlow URL there is nothing useful to do. Checked inside each
// handler rather than as middleware, so /clickup/* can delegate to the handlers.
function forwardingReady(res, name) {
  if (deliveryflow.isConfigured()) return true;
  log.error(`DeliveryFlow ${name} — DELIVERYFLOW_EVENTS_URL is not set`);
  res.status(503).json({ ok: false, error: 'DeliveryFlow forwarding is not configured' });
  return false;
}

const NOT_CONFIGURED = 'DeliveryFlow forwarding is not configured';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Same id rule as the auth-form endpoint that minted these ids.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IDS = 50;
const MAX_URLS = 50;

// Free Black Box extra-URL alerts go to the same channel as ClickUp's (hardcoded there).
const EXTRA_URLS_CHANNEL = 'C0AA3SNQUKE';

const FREE_BLACK_BOX_RE = /free\s*black\s*box/i;

class BadRequest extends Error {}

// The one engagement a call is about: engagementId, else the portal's clickupTaskId.
function singleId(body, { required = true } = {}) {
  const raw = body.engagementId ?? body.clickupTaskId;
  if (raw == null || String(raw).trim() === '') {
    if (!required) return null;
    throw new BadRequest('engagementId (or clickupTaskId) is required');
  }
  const id = String(raw).trim();
  if (!ID_RE.test(id)) throw new BadRequest('engagementId must be 1-64 characters of letters, digits, "-" or "_"');
  return id;
}

// The engagements a form covers: an array, or a single id, under either name.
function idList(body) {
  const list = body.engagementIds ?? body.clickupTaskIds;
  let ids;
  if (Array.isArray(list) && list.length) ids = list;
  else {
    const one = singleId(body, { required: false });
    ids = one ? [one] : [];
  }
  if (!ids.length) throw new BadRequest('at least one of engagementIds / engagementId (or clickupTaskIds / clickupTaskId) is required');
  if (ids.length > MAX_IDS) throw new BadRequest(`at most ${MAX_IDS} engagement ids per call`);
  const clean = ids.map((v) => String(v ?? '').trim());
  const bad = clean.find((id) => !ID_RE.test(id));
  if (bad !== undefined) throw new BadRequest(`invalid engagement id: ${JSON.stringify(bad)}`);
  return [...new Set(clean)];
}

// yyyy-mm-dd → unix ms at UTC midnight; null when absent.
function ymd(body, field) {
  const raw = body[field];
  if (raw == null || raw === '') return null;
  const ms = YMD_RE.test(String(raw)) ? Date.parse(`${raw}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) throw new BadRequest(`${field} must be a yyyy-mm-dd date`);
  return ms;
}

const toYmd = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

function httpUrl(value, field) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new BadRequest(`${field} must be a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequest(`${field} must be an http(s) URL`);
  return url.toString();
}

// Wraps a handler: a BadRequest becomes a 400, anything else a logged 500.
function handle(name, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      log.error(`DeliveryFlow ${name} — unexpected failure`, { reason: err.message });
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'unexpected error' });
    }
  };
}

// Loads the record for a single-engagement call. Returns the record, or sends the
// 404 / 500 and returns null.
async function loadEngagement(res, name, engagementId) {
  let record;
  try {
    record = await store.findByEngagementId(engagementId);
  } catch (err) {
    log.error(`DeliveryFlow ${name} — could not read the engagement record`, { engagementId, reason: err.message });
    res.status(500).json({ ok: false, error: 'could not read the engagement record; safe to retry' });
    return null;
  }
  if (!record) {
    log.warn(`DeliveryFlow ${name} — unknown engagement`, { engagementId });
    res.status(404).json({ ok: false, error: 'unknown_engagement', engagementId });
    return null;
  }
  return record;
}

// The mirror on our record is secondary to DeliveryFlow, which already has the
// event: a failed write is logged, never failed back to the portal.
async function mirror(name, engagementId, set) {
  try {
    await store.updateEngagement(engagementId, set);
  } catch (err) {
    log.error(`DeliveryFlow ${name} — could not update the engagement record`, { engagementId, reason: err.message });
  }
}

// Sends one event for each engagement a form covers, independently. Returns the
// per-engagement results; the caller answers 502 only when every one failed.
async function forwardToEach(name, ids, event, dataFor, mirrorFor) {
  const results = [];
  for (const engagementId of ids) {
    try {
      if (!deliveryflow.isConfigured()) throw new Error(NOT_CONFIGURED);
      const record = await store.findByEngagementId(engagementId);
      if (!record) throw new Error('unknown engagement');
      await deliveryflow.sendEvent(event, { engagementId, dealId: record.deal_id }, dataFor(record));
      await mirror(name, engagementId, mirrorFor(record));
      results.push({ engagementId, action: 'sent' });
    } catch (err) {
      log.error(`DeliveryFlow ${name} — could not forward to DeliveryFlow`, { engagementId, reason: err.message });
      results.push({ engagementId, action: 'failed', error: err.message });
    }
  }
  return results;
}

// ─── POST /api/deliveryflow/schedule-task ─────────────────────────────────────

/**
 * Renames a report created without a start date now that one is booked, and fills
 * in its Plextrac dates — the DeliveryFlow twin of the ClickUp start-date watcher
 * (pipeline/start-date-watch.js). Only reports still flagged start_date_pending are
 * touched, as there: a report created with dates keeps the name it was given.
 * Never throws. Returns:
 *   'no_report' | 'not_pending' | 'renamed' | 'dates_set' | 'failed'
 */
async function resolvePendingReport(record, startMs, endMs) {
  if (record.plextrac_report_id == null) return 'no_report';
  if (!record.start_date_pending) return 'not_pending';

  const clientId = record.plextrac_client_id;
  const reportId = record.plextrac_report_id;
  try {
    const report = await api.getReport(clientId, reportId);
    const currentName = report?.name ?? null;
    const resolvedName = buildReportName(record.test_type, startMs, record.scope);
    const nameChanged = currentName == null || currentName.toLowerCase() !== resolvedName.toLowerCase();

    const payload = { start_date: epochToISO(startMs), end_date: epochToISO(endMs) };
    if (nameChanged) payload.name = resolvedName;
    await api.updateReport(clientId, reportId, payload);

    await mirror('schedule-task', record.engagement_id, { start_date_pending: false, report_name: resolvedName });

    if (nameChanged) {
      log.info('DeliveryFlow schedule-task — start date booked, report renamed', {
        engagementId: record.engagement_id, report_id: reportId, old_name: currentName, new_name: resolvedName,
      });
      log.notify(`Start date set for ${record.client_name} (DeliveryFlow engagement ${record.engagement_id}) — report renamed from "${currentName}" to "${resolvedName}".`);
      return 'renamed';
    }
    return 'dates_set';
  } catch (err) {
    // The booking already reached DeliveryFlow; the flag stays set so the next
    // schedule-task call for this engagement tries again.
    log.error('DeliveryFlow schedule-task — could not update the Plextrac report', {
      engagementId: record.engagement_id, client_id: clientId, report_id: reportId, reason: err.message,
    });
    return 'failed';
  }
}

const scheduleTask = handle('schedule-task', async (req, res) => {
  if (!forwardingReady(res, 'schedule-task')) return;
  const body = req.body || {};
  const engagementId = singleId(body);

  const startMs = ymd(body, 'startDate');
  let endMs = ymd(body, 'endDate');
  const deadlineMs = ymd(body, 'reportDeadline');
  const hasDates = startMs != null && endMs != null;
  if (!hasDates && deadlineMs == null) {
    throw new BadRequest('either both startDate and endDate, or reportDeadline, are required');
  }
  if (hasDates && endMs < startMs) throw new BadRequest('endDate must not be before startDate');

  const consultant = typeof body.consultant === 'string' && body.consultant.trim() ? body.consultant.trim().slice(0, 200) : null;
  const note = String(body.note ?? '').trim().slice(0, 2000) || null;

  // Serialised with the auth-form endpoint's lock key, so a booking can't interleave
  // with the engagement being set up or with a second booking.
  const { status, payload } = await withTaskLock(`deliveryflow:${engagementId}`, async () => {
    const record = await loadEngagement(res, 'schedule-task', engagementId);
    if (!record) return { status: null };

    const freeBlackBox = record.test_type === FREE_TYPE || FREE_BLACK_BOX_RE.test(String(body.testType || ''));

    // A Free Black Box is a half-day: one day, whatever end date was sent.
    if (hasDates && freeBlackBox && endMs !== startMs) {
      log.info('DeliveryFlow schedule-task collapsed a Free Black Box to a single day', {
        engagementId, startDate: body.startDate, requested_end_date: body.endDate,
      });
      endMs = startMs;
    }

    // Its form can be submitted again, but the first booking stands; a new deadline
    // is still passed on.
    const repeatFreeBooking = hasDates && freeBlackBox && record.start_date != null;
    if (repeatFreeBooking) {
      log.info('DeliveryFlow schedule-task — Free Black Box already booked, dates left alone', { engagementId });
      if (deadlineMs == null) {
        return {
          status: 200,
          payload: {
            ok: true, engagementId, skipped: true,
            startDate: toYmd(record.start_date), endDate: toYmd(record.end_date), deliveryflow: 'not_sent',
          },
        };
      }
    }
    const booking = hasDates && !repeatFreeBooking;

    const data = {
      startDate: booking ? toYmd(startMs) : null,
      endDate: booking ? toYmd(endMs) : null,
      consultant: booking ? consultant : null,
      reportDeadline: toYmd(deadlineMs),
      days: booking && body.days != null && Number.isFinite(Number(body.days)) ? Number(body.days) : null,
      testType: typeof body.testType === 'string' ? body.testType.slice(0, 100) : null,
      clientNote: note,
    };

    try {
      await deliveryflow.sendEvent('schedule_set', { engagementId, dealId: record.deal_id }, data);
    } catch (err) {
      log.error('DeliveryFlow schedule-task — could not forward to DeliveryFlow', { engagementId, reason: err.message });
      return { status: 502, payload: { ok: false, engagementId, error: err.message, stage: 'deliveryflow' } };
    }

    await mirror('schedule-task', engagementId, {
      // Read back by the availability cache, so the consultant shows as busy.
      ...(booking ? { start_date: startMs, end_date: endMs, consultant, days: data.days } : {}),
      ...(deadlineMs != null ? { report_deadline: deadlineMs } : {}),
    });

    const plextrac = booking ? await resolvePendingReport(record, startMs, endMs) : 'not_booked';

    log.info('DeliveryFlow schedule-task forwarded', {
      engagementId, startDate: data.startDate, endDate: data.endDate, consultant: data.consultant,
      reportDeadline: data.reportDeadline, plextrac, note,
    });

    return {
      status: 200,
      payload: {
        ok: true, engagementId,
        ...(repeatFreeBooking ? { skipped: true } : {}),
        startDate: booking ? data.startDate : toYmd(record.start_date),
        endDate: booking ? data.endDate : toYmd(record.end_date),
        reportDeadline: data.reportDeadline,
        deliveryflow: 'sent',
        plextrac,
      },
    };
  });

  if (status != null) res.status(status).json(payload);
});

// ─── POST /api/deliveryflow/test-files-uploaded ───────────────────────────────

const testFilesUploaded = handle('test-files-uploaded', async (req, res) => {
  if (!forwardingReady(res, 'test-files-uploaded')) return;
  const body = req.body || {};
  const engagementId = singleId(body);

  const record = await loadEngagement(res, 'test-files-uploaded', engagementId);
  if (!record) return;

  const data = {
    fileCount: body.fileCount != null && Number.isFinite(Number(body.fileCount)) ? Number(body.fileCount) : null,
    archiveName: typeof body.archiveName === 'string' ? body.archiveName.slice(0, 300) : null,
    submittedAt: typeof body.submittedAt === 'string' ? body.submittedAt.slice(0, 40) : new Date().toISOString(),
  };

  try {
    await deliveryflow.sendEvent('test_files_uploaded', { engagementId, dealId: record.deal_id }, data);
  } catch (err) {
    log.error('DeliveryFlow test-files-uploaded — could not forward to DeliveryFlow', { engagementId, reason: err.message });
    return res.status(502).json({ ok: false, engagementId, error: err.message, stage: 'deliveryflow' });
  }

  await mirror('test-files-uploaded', engagementId, { test_files_last_uploaded_at: data.submittedAt });
  log.info('DeliveryFlow test-files upload forwarded', { engagementId, client: record.client_name, ...data });
  res.status(200).json({ ok: true, engagementId, deliveryflow: 'sent' });
});

// ─── POST /api/deliveryflow/finalised-auth-form ───────────────────────────────
// Unlike ClickUp, nothing is downloaded: DeliveryFlow gets the signed form's link,
// rebuilt from the Drive file id so no caller-supplied text is passed on.

// Per-engagement results for a signed form. Exported for /clickup/finalised-auth-form,
// which sends a form's DeliveryFlow engagements here and its ClickUp tasks to ClickUp.
async function forwardFinalisedForm(ids, driveUrl) {
  const fileId = fileIdFromUrl(driveUrl);
  if (!fileId) throw new BadRequest('driveUrl is not a valid Google Drive file link');
  const signedFormUrl = driveFileUrl(fileId);
  return forwardToEach(
    'finalised-auth-form', ids, 'auth_form_finalised',
    () => ({ signedFormUrl, driveFileId: fileId }),
    () => ({ signed_form_url: signedFormUrl }),
  );
}

const finalisedAuthForm = handle('finalised-auth-form', async (req, res) => {
  if (!forwardingReady(res, 'finalised-auth-form')) return;
  const body = req.body || {};
  const ids = idList(body);
  const results = await forwardFinalisedForm(ids, body.driveUrl);
  const allFailed = results.every((r) => r.action === 'failed');
  res.status(allFailed ? 502 : 200).json({ ok: !allFailed, results });
});

// ─── POST /api/deliveryflow/merged-auth-form ──────────────────────────────────

// Per-engagement results for a merged form; exported for /clickup/merged-auth-form.
async function forwardMergedForm(ids, body) {
  if (!body.mergedFormUrl) throw new BadRequest('mergedFormUrl is required');
  const mergedFormUrl = httpUrl(body.mergedFormUrl, 'mergedFormUrl');
  const mergedFormToken = body.mergedFormToken != null ? String(body.mergedFormToken).slice(0, 200) : null;
  const testTypes = Array.isArray(body.testTypes) ? body.testTypes.map((t) => String(t).slice(0, 100)).slice(0, 20) : [];
  const dayCount = body.dayCount != null && Number.isFinite(Number(body.dayCount)) ? Number(body.dayCount) : null;

  return forwardToEach(
    'merged-auth-form', ids, 'merged_auth_form',
    () => ({ mergedFormUrl, mergedFormToken, testTypes, dayCount, engagementIds: ids }),
    () => ({ merged_form_url: mergedFormUrl, merged_form_token: mergedFormToken }),
  );
}

const mergedAuthForm = handle('merged-auth-form', async (req, res) => {
  if (!forwardingReady(res, 'merged-auth-form')) return;
  const body = req.body || {};
  if (!body.mergedFormUrl) throw new BadRequest('mergedFormUrl is required');
  const results = await forwardMergedForm(idList(body), body);
  const allFailed = results.every((r) => r.action === 'failed');
  res.status(allFailed ? 502 : 200).json({ ok: !allFailed, results });
});

// ─── POST /api/deliveryflow/extra-urls ────────────────────────────────────────
// Slack and DeliveryFlow are independent, as ClickUp's comment and Slack are: one
// failing never stops the other, and only both failing is a 502.

const extraUrls = handle('extra-urls', async (req, res) => {
  const body = req.body || {};
  const clientName = typeof body.clientName === 'string' ? body.clientName.trim().slice(0, 200) : '';
  if (!clientName || !Array.isArray(body.urls) || body.urls.length === 0) {
    throw new BadRequest('clientName and a non-empty urls array are required');
  }
  const urls = body.urls.slice(0, MAX_URLS).map((u) => String(u).slice(0, 500));
  const engagementId = singleId(body, { required: false });
  const count = body.urlCount != null && Number.isFinite(Number(body.urlCount)) ? Number(body.urlCount) : body.urls.length;
  const formUrl = body.formUrl ? httpUrl(body.formUrl, 'formUrl') : null;

  const summary = `⚠️ Free Black Box for ${clientName} submitted ${count} URLs ` +
    `(additional hosts may incur extra cost): ${urls.join(', ')}.${formUrl ? ` Auth form: ${formUrl}` : ''}`;

  let record = null;
  if (engagementId) {
    try {
      record = await store.findByEngagementId(engagementId);
    } catch (err) {
      log.error('DeliveryFlow extra-urls — could not read the engagement record', { engagementId, reason: err.message });
    }
  }

  // 1) DeliveryFlow — only for an engagement we know about.
  let deliveryflowResult = 'skipped';
  if (record && deliveryflow.isConfigured()) {
    try {
      await deliveryflow.sendEvent('extra_urls', { engagementId, dealId: record.deal_id }, { urls, urlCount: count, formUrl });
      deliveryflowResult = 'sent';
    } catch (err) {
      log.error('DeliveryFlow extra-urls — could not forward to DeliveryFlow', { engagementId, reason: err.message });
      deliveryflowResult = 'failed';
    }
  } else if (engagementId) {
    log.warn('DeliveryFlow extra-urls — not forwarded', {
      engagementId, reason: record ? 'DELIVERYFLOW_EVENTS_URL is not set' : 'unknown engagement',
    });
    deliveryflowResult = 'failed';
  }

  // 2) Slack — always, linking the engagement when DeliveryFlow gave us its URL.
  let slack;
  try {
    const link = record?.engagement_url ? ` DeliveryFlow engagement: ${record.engagement_url}` : '';
    await postMessage(EXTRA_URLS_CHANNEL, `${summary}${link}`);
    slack = 'sent';
  } catch (err) {
    log.error('DeliveryFlow extra-urls — Slack alert failed', { clientName, engagementId, reason: err.message });
    slack = 'failed';
  }

  const anySuccess = deliveryflowResult === 'sent' || slack === 'sent';
  res.status(anySuccess ? 200 : 502).json({ ok: anySuccess, deliveryflow: deliveryflowResult, slack });
});

router.post('/schedule-task', requirePortalKey, scheduleTask);
router.post('/test-files-uploaded', requirePortalKey, testFilesUploaded);
router.post('/finalised-auth-form', requirePortalKey, finalisedAuthForm);
router.post('/merged-auth-form', requirePortalKey, mergedAuthForm);
router.post('/extra-urls', requirePortalKey, extraUrls);

module.exports = router;
// For routes/clickup-actions.js, which has already checked the portal's key.
module.exports.handlers = { scheduleTask, testFilesUploaded, extraUrls };
module.exports.forwardFinalisedForm = forwardFinalisedForm;
module.exports.forwardMergedForm = forwardMergedForm;
