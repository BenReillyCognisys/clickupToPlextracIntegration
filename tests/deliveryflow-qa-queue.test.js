// DeliveryFlow's PT QA queue (routes/deliveryflow-qa-queue.js, lib/qa-queue-store.js):
// listing reports in first- and second-round QA, claiming one for its round, a claim
// clearing when the report moves on, releasing, and the Slack notes.

const assert  = require('assert');
const http    = require('http');
const express = require('express');

process.env.DELIVERYFLOW_API_KEY = 'df-key-123';

// ── A small in-memory stand-in for the qa_queue collection ────────────────────
const docs = [];
const get = (doc, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
function matches(doc, filter) {
  return Object.entries(filter).every(([path, want]) => {
    const have = get(doc, path);
    if (want && typeof want === 'object' && !(want instanceof Date) && '$ne' in want) return have !== want.$ne;
    if (want === null) return have == null;
    return have === want;
  });
}
function apply(doc, update, inserting) {
  Object.assign(doc, update.$set || {});
  if (inserting) Object.assign(doc, update.$setOnInsert || {});
}
const fakeCollection = {
  createIndex: async () => {},
  updateOne: async (filter, update, opts = {}) => {
    const doc = docs.find((d) => matches(d, filter));
    if (doc) { apply(doc, update, false); return { matchedCount: 1 }; }
    if (!opts.upsert) return { matchedCount: 0 };
    const fresh = { report_id: filter.report_id };
    apply(fresh, update, true);
    docs.push(fresh);
    return { matchedCount: 0, upsertedCount: 1 };
  },
  findOneAndUpdate: async (filter, update) => {
    const doc = docs.find((d) => matches(d, filter));
    if (!doc) return null;
    apply(doc, update, false);
    return { ...doc };
  },
  findOne: async (filter) => {
    const doc = docs.find((d) => matches(d, filter));
    return doc ? { ...doc } : null;
  },
  find: () => {
    const cursor = { sort: () => cursor, toArray: async () => docs.map((d) => ({ ...d })) };
    return cursor;
  },
  deleteOne: async (filter) => {
    const i = docs.findIndex((d) => matches(d, filter));
    if (i >= 0) docs.splice(i, 1);
  },
};
require('../lib/mongodb').getDb = async () => ({ collection: () => fakeCollection });

const log = require('../lib/logger');
for (const level of ['info', 'warn', 'error']) log[level] = () => {};

const replies = [];
require('../lib/slack').postReply = async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); };
require('../lib/plextrac-users').cuidMap = async () => new Map([['cuid-author', { name: 'Ada Author' }]]);
require('../lib/deliveryflow-store').findEngagementsByReportIds = async () => new Map([['101', 'eng-1']]);
// A ClickUp-era report (303): task due Friday 9 Oct 2026 → report due 3 business days later, Wednesday 14th.
let clickupCalls = 0;
require('../lib/task-store').findByCuid = async (cuid) => (cuid === 'c-303' ? { clickup_task_id: 'task-303' } : null);
require('../lib/clickup-api').getTask = async () => { clickupCalls++; return { due_date: String(Date.UTC(2026, 9, 9, 12)) }; };
// Plextrac clients, for entries queued without a client name.
const clientLookups = [];
require('../lib/plextrac-api').getClient = async (id) => {
  clientLookups.push(id);
  if (Number(id) === 55) return { name: 'Echo Industries' };
  throw new Error('Plextrac 404');
};

const qaQueue = require('../lib/qa-queue-store');
const router = require('../routes/deliveryflow-qa-queue');
const { renderQueue } = require('../routes/slack-command');

function request(path, { method = 'GET', key = 'df-key-123', body } = {}) {
  const a = express();
  a.use(express.json());
  a.use('/api/deliveryflow/qa-queue', router);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request({
        port: server.address().port, path, method,
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const ALICE = { name: 'Alice Elvin', email: 'alice@cognisys.group' };
const BOB = { name: 'Bob Tester', email: 'bob@cognisys.group' };
// Second-round reviewers (config/qa-queue.js); Karan signs in with the .co.uk domain.
const KARAN = { name: 'Karan Luniyal', email: 'karan.luniyal@cognisys.co.uk' };
const SOHAM = { name: 'Soham Bakore', email: 'soham.bakore@cognisys.group' };
const claim = (who, stage = 'first', id = 101) =>
  request(`/api/deliveryflow/qa-queue/${id}/claim`, { method: 'POST', body: { stage, ...who } });
const release = (who, stage = 'first', extra = {}) =>
  request('/api/deliveryflow/qa-queue/101/release', { method: 'POST', body: { stage, ...who, ...extra } });
const report = (stage, actorCuid) => qaQueue.upsert({
  reportId: 101, cuid: 'c-101', clientId: 7, clientName: 'Acme', reportName: 'Acme Web App', reportUrl: 'https://p/r/101', stage, actorCuid,
});

let passed = 0, failed = 0;
async function test(description, fn) {
  try { await fn(); console.log(`  ✓ ${description}`); passed++; }
  catch (err) { console.log(`  ✗ ${description}\n    ${err.stack}`); failed++; }
}

(async () => {
  console.log('\nDeliveryFlow QA queue:');

  await test('refuses a call without the DeliveryFlow key', async () => {
    const res = await request('/api/deliveryflow/qa-queue', { key: null });
    assert.strictEqual(res.status, 401);
  });

  await test('lists first- and second-round reports with the project and who sent it', async () => {
    await report('first', 'cuid-author');
    await qaQueue.upsert({ reportId: 202, clientName: 'Beta', reportName: 'Beta Infra', stage: 'release' });
    const res = await request('/api/deliveryflow/qa-queue');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.entries.length, 1, 'release stage is left out');
    const e = res.json.entries[0];
    assert.strictEqual(e.reportId, 101);
    assert.strictEqual(e.stage, 'first');
    assert.strictEqual(e.engagementId, 'eng-1');
    assert.strictEqual(e.movedBy, 'Ada Author');
    assert.strictEqual(e.claimedBy, null);
  });

  await test('one person claims; the claim is noted in the round\'s Slack thread', async () => {
    await qaQueue.setThread({ reportId: 101, stage: 'first', channel: 'C-FIRST', ts: 'ts-1' });
    const res = await claim(ALICE);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.entry.claimedBy, ALICE);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].channel, 'C-FIRST');
    assert.strictEqual(replies[0].threadTs, 'ts-1');
    assert.ok(/Alice Elvin\* has claimed this report for first-round QA/.test(replies[0].text), replies[0].text);
  });

  await test('claiming again is harmless; anyone else is refused but still sees who has it', async () => {
    assert.strictEqual((await claim(ALICE)).status, 200);
    const res = await claim(BOB);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.reason, 'claimed');
    assert.strictEqual(res.json.entry.claimedBy.name, 'Alice Elvin');
    const list = await request('/api/deliveryflow/qa-queue');
    assert.strictEqual(list.json.entries[0].claimedBy.name, 'Alice Elvin');
    assert.strictEqual(replies.length, 1, 'no second note');
  });

  await test('/reportqueue shows who has claimed a report', async () => {
    const text = renderQueue(await qaQueue.list());
    assert.ok(/Acme Web App>.*— claimed by Alice Elvin/.test(text), text);
  });

  await test('the same round again (resubmitted) keeps the claim', async () => {
    await report('first', 'cuid-author');
    assert.strictEqual((await qaQueue.get(101)).claimed_by.name, 'Alice Elvin');
  });

  await test('moving to the second round clears the claim and the thread; a reviewer may claim', async () => {
    await report('second', 'cuid-alice');
    const doc = await qaQueue.get(101);
    assert.strictEqual(doc.stage, 'second');
    assert.strictEqual(doc.claimed_by, null);
    assert.strictEqual(doc.slack_ts, null);
    assert.strictEqual(doc.stage_actor_cuid, 'cuid-alice');
    const stale = await claim(KARAN, 'first');
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.reason, 'moved');
    const res = await claim(KARAN, 'second');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.entry.claimedBy.name, 'Karan Luniyal');
  });

  await test('second round can only be claimed by the second-round reviewers', async () => {
    await release(KARAN, 'second');
    const res = await claim(BOB, 'second');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.reason, 'not_reviewer');
    assert.strictEqual((await qaQueue.get(101)).claimed_by, null, 'nothing claimed');
    const list = await request('/api/deliveryflow/qa-queue?viewer=bob@cognisys.group');
    assert.deepStrictEqual(list.json.viewer, { canClaim: { first: true, second: false } });
    const reviewer = await request('/api/deliveryflow/qa-queue?viewer=punit.sharma@cognisys.co.uk');
    assert.deepStrictEqual(reviewer.json.viewer, { canClaim: { first: true, second: true } });
  });

  await test('only the claimer may release, unless DeliveryFlow sends override', async () => {
    assert.strictEqual((await claim(SOHAM, 'second')).status, 200);
    const theirs = await release(KARAN, 'second');
    assert.strictEqual(theirs.status, 403);
    assert.strictEqual(theirs.json.reason, 'not_yours');
    const forced = await release(ALICE, 'second', { override: true });
    assert.strictEqual(forced.status, 200);
    assert.strictEqual(forced.json.entry.claimedBy, null);
    assert.strictEqual((await claim(KARAN, 'second')).status, 200);
    const own = await release({ ...KARAN, email: 'karan.luniyal@cognisys.group' }, 'second');
    assert.strictEqual(own.status, 200, 'same mailbox on the other domain');
    assert.strictEqual(own.json.entry.claimedBy, null);
  });

  await test('a report that moves on unclaimed arrives unclaimed, with no Slack note', async () => {
    const notes = replies.length;
    await qaQueue.upsert({ reportId: 404, clientName: 'Gamma', reportName: 'Gamma API', stage: 'first', actorCuid: 'cuid-author' });
    await qaQueue.setThread({ reportId: 404, stage: 'first', channel: 'C-FIRST', ts: 'ts-404' });
    await qaQueue.upsert({ reportId: 404, clientName: 'Gamma', reportName: 'Gamma API', stage: 'second', actorCuid: 'cuid-alice' });
    const doc = await qaQueue.get(404);
    assert.strictEqual(doc.stage, 'second');
    assert.strictEqual(doc.claimed_by, null);
    assert.strictEqual(doc.slack_ts, null);
    assert.strictEqual(replies.length, notes);
    assert.strictEqual((await claim(SOHAM, 'second', 404)).status, 200);
  });

  await test('a ClickUp-era report gets its due date in the background, looked up once', async () => {
    await qaQueue.upsert({ reportId: 303, cuid: 'c-303', clientName: 'Delta', reportName: 'Delta Ext', stage: 'first' });
    const first = await request('/api/deliveryflow/qa-queue');
    assert.strictEqual(first.json.entries.find((e) => e.reportId === 303).dueDate, null, 'not waited for');
    await new Promise((r) => setTimeout(r, 20));
    const second = await request('/api/deliveryflow/qa-queue');
    assert.strictEqual(second.json.entries.find((e) => e.reportId === 303).dueDate, '2026-10-14');
    assert.strictEqual(second.json.entries.find((e) => e.reportId === 101).dueDate, null, 'DeliveryFlow reports are left to DeliveryFlow');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(clickupCalls, 1);
  });

  await test('an entry queued without a client name gets it from Plextrac, once', async () => {
    clientLookups.length = 0;
    // No client id recorded either: it is read from the report link.
    await qaQueue.upsert({ reportId: 505, reportName: 'Echo Web', reportUrl: 'https://p/client/55/report/505', stage: 'first' });
    await qaQueue.upsert({ reportId: 606, clientId: 66, reportName: 'Foxtrot API', stage: 'first' });
    const res = await request('/api/deliveryflow/qa-queue');
    const echo = res.json.entries.find((e) => e.reportId === 505);
    assert.strictEqual(echo.clientName, 'Echo Industries');
    assert.strictEqual(echo.clientId, 55);
    assert.strictEqual(res.json.entries.find((e) => e.reportId === 606).clientName, null, 'Plextrac failing leaves it unknown');
    assert.strictEqual((await qaQueue.get(505)).client_name, 'Echo Industries', 'saved on the entry');
    assert.deepStrictEqual(clientLookups.filter((id) => Number(id) === 55), [55]);
    // Saved: not looked up again; and a later status change without a name keeps it.
    await request('/api/deliveryflow/qa-queue');
    assert.strictEqual(clientLookups.filter((id) => Number(id) === 55).length, 1);
    await qaQueue.upsert({ reportId: 505, reportName: 'Echo Web', reportUrl: 'https://p/client/55/report/505', stage: 'second' });
    assert.strictEqual((await qaQueue.get(505)).client_name, 'Echo Industries');
  });

  await test('bad input and a report no longer queued', async () => {
    assert.strictEqual((await claim({ name: 'X', email: 'not-an-email' })).status, 400);
    assert.strictEqual((await claim(ALICE, 'release')).status, 400);
    assert.strictEqual((await claim(ALICE, 'first', 999)).status, 404);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
