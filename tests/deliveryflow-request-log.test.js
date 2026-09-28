// Every /api/deliveryflow/* request is logged — including the ones refused before a
// handler runs — stored for GET /api/deliveryflow/requests, and a failed
// "Generate Auth Form" is posted to Slack (lib/deliveryflow-request-log.js).

const assert  = require('assert');
const http    = require('http');
const express = require('express');

process.env.DELIVERYFLOW_API_KEY = 'df-key-123';
process.env.BREAK_SERVICES_API_KEY = 'portal-key';
process.env.AVAILABILITY_API_KEY = 'admin-key';

// ── Stubs, before the logger module is required ───────────────────────────────
const stored = [];
const fakeCollection = {
  createIndex: async () => {},
  insertOne: async (doc) => { stored.push(doc); },
  find: (filter) => {
    let rows = stored.slice().reverse();
    if (filter.ok === false) rows = rows.filter((r) => r.ok === false);
    if (filter.engagement_id) rows = rows.filter((r) => new RegExp(filter.engagement_id.$regex).test(r.engagement_id || ''));
    const cursor = { sort: () => cursor, limit: (n) => { rows = rows.slice(0, n); return cursor; }, toArray: async () => rows };
    return cursor;
  },
};
require('../lib/mongodb').getDb = async () => ({ collection: () => fakeCollection });

const log = require('../lib/logger');
const lines = [];
for (const level of ['info', 'warn', 'error']) log[level] = (message, data) => lines.push({ level, message, data });
const notices = [];
log.notify = (message) => notices.push(message);

const { logDeliveryFlowRequests, listRequests } = require('../lib/deliveryflow-request-log');
const { requireApiKey } = require('../lib/availability-cache');

// A stand-in for the real routers: the key check and a couple of outcomes.
function app() {
  const a = express();
  a.use(express.json());
  a.get('/api/deliveryflow/requests', requireApiKey, listRequests);
  a.use('/api/deliveryflow', logDeliveryFlowRequests);
  a.post('/api/deliveryflow/auth-form', (req, res) => {
    if (req.headers['x-api-key'] !== 'df-key-123') return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
    if (req.body.clientName === 'Broken Ltd') return res.status(502).json({ ok: false, error: 'auth-form generation failed: boom', stage: 'auth_form' });
    return res.status(201).json({
      ok: true, created: true, formUrl: `https://portal.test/f/${req.body.engagementId}`,
      plextrac: { status: 'created', reportId: 501 },
    });
  });
  return a;
}

function request(path, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app().listen(0, () => {
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request({
        port: server.address().port, path, method,
        headers: { 'Content-Type': 'application/json', ...headers },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          // The result line and stored row are written on 'finish'; give it a tick.
          const isJson = /json/.test(res.headers['content-type'] || '');
          setImmediate(() => { server.close(); resolve({ status: res.statusCode, json: isJson && buf ? JSON.parse(buf) : null }); });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

let passed = 0, failed = 0;
async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}\n       ${err.message}`);
    failed++;
  }
}

const reset = () => { lines.length = 0; notices.length = 0; };
const body = { engagementId: '348669400292', dealId: 'd-1', clientName: 'Acme Ltd', testType: 'Black Box' };

(async () => {
  console.log('DeliveryFlow request log:');

  await test('a wrong key is logged (with its length, never its value), stored, and posted to Slack', async () => {
    reset();
    const r = await request('/api/deliveryflow/auth-form', { headers: { 'X-API-Key': 'x'.repeat(16) }, body });
    assert.strictEqual(r.status, 401);

    const received = lines.find((l) => l.message === 'DeliveryFlow request received');
    assert.strictEqual(received.data.engagementId, '348669400292');
    assert.strictEqual(received.data.caller, 'unknown_key');

    const result = lines.find((l) => l.message === 'DeliveryFlow request refused');
    assert.strictEqual(result.level, 'warn');
    assert.strictEqual(result.data.status, 401);
    assert.strictEqual(result.data.key_length, 16);

    const row = stored[stored.length - 1];
    assert.strictEqual(row.ok, false);
    assert.strictEqual(row.client_name, 'Acme Ltd');
    assert.strictEqual(row.key_length, 16);

    assert.ok(notices[0].includes('Generate Auth Form" failed for Acme Ltd Black Box'));
    assert.ok(notices[0].includes('not recognised (16 characters)'));
    assert.ok(!JSON.stringify({ lines, stored, notices }).includes('x'.repeat(16)), 'the key itself is never logged');
  });

  await test('a missing key says so', async () => {
    reset();
    await request('/api/deliveryflow/auth-form', { body });
    assert.strictEqual(lines.find((l) => l.message === 'DeliveryFlow request refused').data.caller, 'none');
    assert.ok(notices[0].includes('X-API-Key was missing'));
  });

  await test('a success is logged with the form and report, and nothing goes to Slack', async () => {
    reset();
    const r = await request('/api/deliveryflow/auth-form', { headers: { 'X-API-Key': 'df-key-123' }, body });
    assert.strictEqual(r.status, 201);
    const done = lines.find((l) => l.message === 'DeliveryFlow request done');
    assert.strictEqual(done.data.caller, 'deliveryflow');
    assert.strictEqual(done.data.form_url, 'https://portal.test/f/348669400292');
    assert.strictEqual(done.data.plextrac, 'created');
    assert.strictEqual(done.data.report_id, 501);
    assert.strictEqual(stored[stored.length - 1].ok, true);
    assert.strictEqual(notices.length, 0);
  });

  await test('a handler failure is logged as an error with its stage and posted to Slack', async () => {
    reset();
    await request('/api/deliveryflow/auth-form', { headers: { 'X-API-Key': 'df-key-123' }, body: { ...body, clientName: 'Broken Ltd' } });
    const failedLine = lines.find((l) => l.message === 'DeliveryFlow request failed');
    assert.strictEqual(failedLine.level, 'error');
    assert.strictEqual(failedLine.data.stage, 'auth_form');
    assert.ok(notices[0].includes('auth-form generation failed: boom — stage: auth_form'));
  });

  await test('portal calls are identified; only /auth-form failures go to Slack', async () => {
    reset();
    const r = await request('/api/deliveryflow/schedule-task', { headers: { 'X-API-Key': 'portal-key' }, body: { clickupTaskId: 'eng-7' } });
    assert.strictEqual(r.status, 404); // no such route in this stand-in
    const refused = lines.find((l) => l.message === 'DeliveryFlow request refused');
    assert.strictEqual(refused.data.caller, 'portal');
    assert.strictEqual(refused.data.engagementId, 'eng-7');
    assert.strictEqual(notices.length, 0);
  });

  await test('GET /requests needs the admin key and lists newest first, filtered', async () => {
    reset();
    assert.strictEqual((await request('/api/deliveryflow/requests', { method: 'GET' })).status, 401);
    const all = await request('/api/deliveryflow/requests?engagementId=348669400292', { method: 'GET', headers: { 'X-API-Key': 'admin-key' } });
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.json.count, 4);
    assert.strictEqual(all.json.requests[0].client_name, 'Broken Ltd', 'newest first');
    const failedOnly = await request('/api/deliveryflow/requests?failed=1', { method: 'GET', headers: { 'X-API-Key': 'admin-key' } });
    assert.ok(failedOnly.json.requests.every((r) => r.ok === false));
    assert.strictEqual(lines.length, 0, 'reading the log does not add to it');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
