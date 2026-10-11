// Pentest QA feedback (pipeline/qa-feedback.js) and DeliveryFlow's PT Management API
// (routes/deliveryflow-pt-management.js).

const assert  = require('assert');
const http    = require('http');
const express = require('express');

process.env.DELIVERYFLOW_API_KEY = 'df-key-123';

const log = require('../lib/logger');
for (const level of ['info', 'warn', 'error']) log[level] = () => {};

// ── Stubs, before the modules under test are required ─────────────────────────
const USERS = new Map([
  ['cuid-author', { cuid: 'cuid-author', name: 'Ada Author', email: 'ada@cognisys.group' }],
  ['cuid-qa1', { cuid: 'cuid-qa1', name: 'Quinn First', email: 'quinn@cognisys.co.uk' }],
  ['cuid-qa2', { cuid: 'cuid-qa2', name: 'Soham Bakore', email: 'soham.bakore@cognisys.group' }],
  ['cuid-noemail', { cuid: 'cuid-noemail', name: 'No Mail', email: null }],
]);
const users = require('../lib/plextrac-users');
users.cuidMap = async () => USERS;
users.findByEmail = async (email) => [...USERS.values()].find((u) => u.email === email) || null;

const portal = require('../lib/secure-portal-api');
const created = [];
let portalCreated = true;
portal.createQaFeedback = async (payload) => {
  created.push(payload);
  return { ok: true, created: portalCreated, token: 't1', url: 'https://sfe/qa-feedback/t1' };
};
portal.qaFeedbackResults = async (range) => ({ ok: true, results: [{ id: 'f1', range, answers: [{ key: 'severity', score: 4 }] }] });
portal.pendingQaFeedback = async (email) => ({ ok: true, pending: [{ id: 'p1', reviewer: email, url: 'https://sfe/qa-feedback/p1' }] });

const people = require('../lib/slack-people');
people.slackIdForEmail = async (email) => (email.startsWith('quinn') || email.startsWith('soham') ? `U-${email.split('.')[0]}` : null);
const slack = require('../lib/slack');
const posts = [];
slack.postMessage = async (channel, text) => { posts.push({ channel, text }); return 'ts'; };

require('../lib/qa-submission-store').actorFor = async () => 'cuid-author';

const qaKpi = require('../lib/qa-kpi');
qaKpi.buildKpiEntries = async (window) => [{ cuid: 'cuid-qa2', name: 'Soham Bakore', count: 7, window: window.label }];
qaKpi.buildUserPeriods = async (cuid) => [{ label: 'Last 30 days', stats: { count: 3 }, late: { count: 1 }, cuid }];
qaKpi.buildUserLogs = async () => [{ reportId: 9, reportName: 'R9', countedAt: new Date('2026-10-01T10:00:00Z') }];

const { requestQaFeedback, completesRound } = require('../pipeline/qa-feedback');
const ptManagement = require('../routes/deliveryflow-pt-management');

function request(path, { key = 'df-key-123' } = {}) {
  const a = express();
  a.use('/api/deliveryflow/pt-management', ptManagement.management);
  a.use('/api/deliveryflow/qa-feedback', ptManagement.reviewer);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      http.get({ port: server.address().port, path, headers: key ? { 'X-API-Key': key } : {} }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

const REPORT = { reportId: 101, reportCuid: 'c-101', clientName: 'Acme', reportName: 'Acme Web', reportUrl: 'https://p/r/101', engagementId: 'eng-1' };

let passed = 0, failed = 0;
async function test(description, fn) {
  try { await fn(); console.log(`  ✓ ${description}`); passed++; }
  catch (err) { console.log(`  ✗ ${description}\n    ${err.stack}`); failed++; }
}
const reset = () => { created.length = 0; posts.length = 0; portalCreated = true; };

(async () => {
  console.log('\nQA feedback requests:');

  await test('only a report moving forward out of the round asks', () => {
    assert.strictEqual(completesRound('first', { stage: 'first' }), true);
    assert.strictEqual(completesRound('second', { stage: 'second' }), true);
    assert.strictEqual(completesRound('first', { stage: 'release' }), false, 'Approved → In Review is a step back');
    assert.strictEqual(completesRound('first', null), true, 'not in the queue: trust the status');
  });

  await test('first round done: the first QA gets a form for the author\'s report, by DM only', async () => {
    reset();
    const out = await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: 'cuid-qa1', prior: { stage: 'first', stage_actor_cuid: 'cuid-author' } });
    assert.deepStrictEqual(out, { url: 'https://sfe/qa-feedback/t1', created: true });
    assert.strictEqual(created.length, 1);
    const p = created[0];
    assert.strictEqual(p.round, 'first');
    assert.strictEqual(p.reportId, 101);
    assert.strictEqual(p.engagementId, 'eng-1');
    assert.deepStrictEqual(p.reviewer, { cuid: 'cuid-qa1', name: 'Quinn First', email: 'quinn@cognisys.co.uk' });
    assert.strictEqual(p.author.name, 'Ada Author');
    assert.strictEqual(p.firstReviewer, null);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].channel, 'U-quinn@cognisys', 'a DM to the reviewer, not a channel');
    assert.ok(posts[0].text.includes('<https://sfe/qa-feedback/t1|Pentest QA feedback>'), posts[0].text);
    assert.ok(posts[0].text.includes('first-round QA on *Acme - Acme Web*'), posts[0].text);
  });

  await test('second round done: the approver rates the report and the first QA', async () => {
    reset();
    await requestQaFeedback({ ...REPORT, round: 'second', actorCuid: 'cuid-qa2', prior: { stage: 'second', stage_actor_cuid: 'cuid-qa1' } });
    const p = created[0];
    assert.strictEqual(p.round, 'second');
    assert.strictEqual(p.reviewer.name, 'Soham Bakore');
    assert.strictEqual(p.firstReviewer.name, 'Quinn First');
    assert.strictEqual(p.author.name, 'Ada Author', 'author from the submission record');
    assert.ok(posts[0].text.includes('second-round QA'));
  });

  await test('a repeat webhook reuses the form and sends no second DM', async () => {
    reset();
    portalCreated = false;
    await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: 'cuid-qa1', prior: { stage: 'first' } });
    assert.strictEqual(created.length, 1);
    assert.strictEqual(posts.length, 0);
  });

  await test('no form when sent back, when the actor is unknown, or has no email', async () => {
    reset();
    assert.strictEqual(await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: 'cuid-qa1', prior: { stage: 'release' } }), null);
    assert.strictEqual(await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: null, prior: { stage: 'first' } }), null);
    assert.strictEqual(await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: 'cuid-noemail', prior: { stage: 'first' } }), null);
    assert.strictEqual(created.length, 0);
    assert.strictEqual(posts.length, 0);
  });

  await test('a reviewer Slack can\'t find still gets the form (shown in DeliveryFlow)', async () => {
    reset();
    USERS.set('cuid-ghost', { cuid: 'cuid-ghost', name: 'Ghost', email: 'ghost@cognisys.group' });
    const out = await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: 'cuid-ghost', prior: { stage: 'first' } });
    assert.strictEqual(out.created, true);
    assert.strictEqual(posts.length, 0);
  });

  await test('a portal failure is swallowed', async () => {
    reset();
    const original = portal.createQaFeedback;
    portal.createQaFeedback = async () => { throw new Error('portal down'); };
    assert.strictEqual(await requestQaFeedback({ ...REPORT, round: 'first', actorCuid: 'cuid-qa1', prior: { stage: 'first' } }), null);
    portal.createQaFeedback = original;
  });

  console.log('\nPT Management API:');

  await test('refuses a call without the DeliveryFlow key', async () => {
    assert.strictEqual((await request('/api/deliveryflow/pt-management/kpis', { key: null })).status, 401);
    assert.strictEqual((await request('/api/deliveryflow/qa-feedback/pending?email=a@b.c', { key: 'wrong' })).status, 401);
  });

  await test('the QA leaderboard for a window', async () => {
    const res = await request('/api/deliveryflow/pt-management/kpis?window=90d');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.window.label, 'last 90 days');
    assert.strictEqual(res.json.entries[0].count, 7);
    assert.strictEqual((await request('/api/deliveryflow/pt-management/kpis?window=nonsense')).status, 400);
  });

  await test('one consultant, found on either Cognisys domain', async () => {
    const res = await request('/api/deliveryflow/pt-management/consultant?email=quinn@cognisys.group');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.consultant.name, 'Quinn First');
    assert.strictEqual(res.json.periods[0].cuid, 'cuid-qa1');
    assert.strictEqual(res.json.logs[0].countedAt, '2026-10-01T10:00:00.000Z');
    const nobody = await request('/api/deliveryflow/pt-management/consultant?email=nobody@cognisys.group');
    assert.strictEqual(nobody.json.consultant, null);
  });

  await test('feedback results and a reviewer\'s pending forms come from the portal', async () => {
    const results = await request('/api/deliveryflow/pt-management/qa-feedback?since=2026-09-01');
    assert.strictEqual(results.status, 200);
    assert.strictEqual(results.json.results[0].answers[0].score, 4);
    assert.strictEqual(results.json.results[0].range.since, '2026-09-01T00:00:00.000Z');
    const pending = await request('/api/deliveryflow/qa-feedback/pending?email=quinn@cognisys.group');
    assert.strictEqual(pending.json.pending[0].reviewer, 'quinn@cognisys.group');
    assert.ok(!('answers' in pending.json.pending[0]));
    assert.strictEqual((await request('/api/deliveryflow/qa-feedback/pending')).status, 400);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
