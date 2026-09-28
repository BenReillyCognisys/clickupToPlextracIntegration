// Request log for /api/deliveryflow/*.
//
// Every call — from DeliveryFlow or from the portal — gets:
//   • a "received" line when it arrives and a result line when it's answered, in the
//     console / PM2 log and LOG_FILE (lib/logger.js), including the calls that are
//     turned away before any handler runs (a wrong key, a bad body, the rate limit);
//   • a row in the deliveryflow_request_log collection (kept LOG_RETENTION_DAYS),
//     readable through GET /api/deliveryflow/requests, so "did DeliveryFlow's click
//     reach us, and what happened?" can be answered without shell access;
//   • for a failed POST /auth-form — a person pressed "Generate Auth Form" — a Slack
//     notice saying why.
//
// Keys are never logged. For a request whose key matched nothing, only its length is
// recorded, which is enough to tell a wrong key from one with stray characters.

const crypto = require('crypto');
const { getDb } = require('./mongodb');
const { deliveryFlowKey } = require('./deliveryflow-api');
const log = require('./logger');

const RETENTION_DAYS = Number(process.env.DELIVERYFLOW_LOG_RETENTION_DAYS) || 90;
const MAX_LIST = 200;

let indexed = false;
async function col() {
  const db = await getDb();
  const c = db.collection('deliveryflow_request_log');
  if (!indexed) {
    await c.createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400, background: true });
    await c.createIndex({ engagement_id: 1, at: -1 }, { background: true });
    indexed = true;
  }
  return c;
}

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Who the X-API-Key says the caller is: 'deliveryflow', 'portal', 'none' or
// 'unknown_key' (with its length, for comparing against the expected key's).
function identifyCaller(req) {
  const key = req.headers['x-api-key'];
  if (!key) return { caller: 'none' };
  if (deliveryFlowKey() && timingSafeMatch(key, deliveryFlowKey())) return { caller: 'deliveryflow' };
  if (process.env.BREAK_SERVICES_API_KEY && timingSafeMatch(key, process.env.BREAK_SERVICES_API_KEY)) return { caller: 'portal' };
  return { caller: 'unknown_key', keyLength: String(key).length };
}

// The engagement(s) a request is about, from whichever field it used.
function engagementOf(body) {
  const one = body.engagementId ?? body.clickupTaskId ?? null;
  const many = body.engagementIds ?? body.clickupTaskIds;
  if (one != null) return String(one).slice(0, 64);
  if (Array.isArray(many) && many.length) return many.map((id) => String(id).slice(0, 64)).join(',').slice(0, 300);
  return null;
}

// The useful parts of a reply, without echoing everything back into the log.
function outcomeOf(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  if (payload.error) out.error = String(payload.error).slice(0, 300);
  if (payload.detail) out.detail = String(payload.detail).slice(0, 300);
  if (payload.field) out.field = payload.field;
  if (payload.stage) out.stage = payload.stage;
  if (payload.formUrl) out.form_url = payload.formUrl;
  if (payload.created != null) out.form_created = payload.created;
  if (payload.formRescope) out.form_rescope = payload.formRescope;
  if (payload.plextrac?.status) out.plextrac = payload.plextrac.status;
  if (payload.plextrac?.reportId != null) out.report_id = payload.plextrac.reportId;
  if (typeof payload.deliveryflow === 'string') out.deliveryflow = payload.deliveryflow;
  if (Array.isArray(payload.results)) {
    out.results = payload.results.map((r) => `${r.taskId ?? r.engagementId}:${r.action}`).join(', ').slice(0, 300);
  }
  return out;
}

async function record(entry) {
  try {
    const c = await col();
    await c.insertOne(entry);
  } catch (err) {
    // Logging must never fail a request; the console line above still has it all.
    console.error(`[deliveryflow-log] could not store the request: ${err.message}`);
  }
}

/**
 * Express middleware for the /api/deliveryflow mount. Mount it before the rate
 * limiter and the routers so every request is seen, including refused ones.
 */
function logDeliveryFlowRequests(req, res, next) {
  const started = Date.now();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const path = req.originalUrl.split('?')[0];
  const { caller, keyLength } = identifyCaller(req);
  const request = {
    engagement_id: engagementOf(body),
    deal_id: body.dealId != null ? String(body.dealId).slice(0, 64) : null,
    client_name: typeof body.clientName === 'string' ? body.clientName.slice(0, 200) : null,
    test_type: typeof body.testType === 'string' ? body.testType.slice(0, 100) : null,
  };

  log.info('DeliveryFlow request received', {
    method: req.method, path, caller, ...(keyLength ? { key_length: keyLength } : {}),
    engagementId: request.engagement_id, client: request.client_name, testType: request.test_type,
  });

  // Keep what the handler answered, to log why a call failed.
  let payload;
  const json = res.json.bind(res);
  res.json = (data) => { payload = data; return json(data); };

  res.on('finish', () => {
    const status = res.statusCode;
    const ms = Date.now() - started;
    const outcome = outcomeOf(payload);
    const fields = {
      method: req.method, path, status, ms, caller,
      ...(keyLength ? { key_length: keyLength } : {}),
      engagementId: request.engagement_id, ...outcome,
    };
    if (status >= 500) log.error('DeliveryFlow request failed', fields);
    else if (status >= 400) log.warn('DeliveryFlow request refused', fields);
    else log.info('DeliveryFlow request done', fields);

    record({
      at: new Date(started), method: req.method, path, status, ms, ok: status < 400,
      caller, key_length: keyLength ?? null, ip: req.ip || null, ...request, ...outcome,
    });

    if (path.endsWith('/auth-form') && req.method === 'POST' && status >= 400) {
      const who = request.client_name ? `${request.client_name}${request.test_type ? ` ${request.test_type}` : ''}` : 'an engagement';
      const why = status === 401
        ? `the X-API-Key was ${caller === 'none' ? 'missing' : `not recognised (${keyLength} characters)`}`
        : [outcome.error, outcome.detail, outcome.stage && `stage: ${outcome.stage}`].filter(Boolean).join(' — ') || 'no reason given';
      log.notify(`DeliveryFlow "Generate Auth Form" failed for ${who} (engagement ${request.engagement_id || 'not given'}): HTTP ${status}, ${why}.`);
    }
  });

  next();
}

/**
 * GET /api/deliveryflow/requests — the stored request log, newest first.
 *   ?engagementId=…   only that engagement's requests
 *   ?failed=1         only refused / failed requests
 *   ?path=auth-form   only requests to paths containing this
 *   ?limit=50         at most this many (max 200)
 */
async function listRequests(req, res) {
  const filter = {};
  if (req.query.engagementId) filter.engagement_id = { $regex: `(^|,)${String(req.query.engagementId).replace(/[^A-Za-z0-9_-]/g, '')}(,|$)` };
  if (req.query.failed === '1' || req.query.failed === 'true') filter.ok = false;
  if (req.query.path) filter.path = { $regex: String(req.query.path).replace(/[^A-Za-z0-9/_-]/g, '') };
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LIST);
  try {
    const c = await col();
    const rows = await c.find(filter, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
    res.json({ ok: true, count: rows.length, requests: rows });
  } catch (err) {
    log.error('DeliveryFlow request log — could not read', { reason: err.message });
    res.status(500).json({ ok: false, error: 'could not read the request log' });
  }
}

module.exports = { logDeliveryFlowRequests, listRequests, identifyCaller, outcomeOf };
