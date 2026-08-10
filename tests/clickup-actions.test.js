const assert  = require('assert');
const http    = require('http');
const express = require('express');

// The router's auth middleware reads this at request time.
process.env.BREAK_SERVICES_API_KEY = 'test-key';
process.env.SLACK_AUTH_FORM_CHANNEL = 'C0AUTH';

// ── Stub the outbound helpers BEFORE the router is required ────────────────────
// routes/clickup-actions destructures these on import, so the fakes must be in
// place first. We mutate the module exports objects the router will destructure.
const clickupApi = require('../lib/clickup-api');
const slack      = require('../lib/slack');
const availability = require('../lib/availability-cache');

// In-memory comment store keyed by task id; a task id of 'FAIL' throws.
const comments = {};   // taskId -> [{ id, comment_text }]
let nextCommentId = 1;
const scheduled = [];  // recorded updateTaskSchedule calls
const slackPosts = []; // recorded postMessage calls

clickupApi.listTaskComments = async (taskId) => {
  if (taskId === 'FAIL') throw new Error('boom (list)');
  return comments[taskId] || [];
};
clickupApi.createTaskComment = async (taskId, text) => {
  if (taskId === 'FAIL') throw new Error('boom (create)');
  const id = `c${nextCommentId++}`;
  (comments[taskId] ||= []).push({ id, comment_text: text });
  return id;
};
clickupApi.updateComment = async (commentId, text) => {
  for (const list of Object.values(comments)) {
    const c = list.find((x) => x.id === commentId);
    if (c) { c.comment_text = text; return; }
  }
  throw new Error(`comment ${commentId} not found`);
};
clickupApi.updateTaskSchedule = async (taskId, opts) => {
  if (taskId === 'FAIL') throw new Error('boom (schedule)');
  scheduled.push({ taskId, ...opts });
};
let slackShouldFail = false; // toggled by the "Slack fails" test (channel is hardcoded)
slack.postMessage = async (channel, text) => {
  if (channel === 'C0FAIL' || slackShouldFail) throw new Error('boom (slack)');
  slackPosts.push({ channel, text });
  return '123.456';
};
// Consultant resolution: a tiny fake members map + the real findUserInMap.
availability.cache.availability = { membersMap: { 99: { id: 99, name: 'Jane Smith', email: 'jane@example.com' } } };

const router = require('../routes/clickup-actions');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

function request(path, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/clickup', router);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request({
        port, path, method,
        headers: { 'Content-Type': 'application/json', ...headers },
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

const KEY = { 'X-API-Key': 'test-key' };

(async () => {
  // ── merged-auth-form ────────────────────────────────────────────────────────
  console.log('POST /clickup/merged-auth-form:');

  await test('rejects a missing/wrong API key with 401', async () => {
    const r = await request('/clickup/merged-auth-form', { body: {} });
    assert.strictEqual(r.status, 401);
  });

  await test('rejects a missing clickupTaskIds array with 400', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY, body: { clientName: 'Acme', mergedFormUrl: 'https://f/1' },
    });
    assert.strictEqual(r.status, 400);
  });

  await test('creates one comment per task on first call', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: {
        clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1',
        clickupTaskIds: ['T1', 'T2'], testTypes: ['External', 'Wireless'], dayCount: 2.5,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['created', 'created']);
    assert.strictEqual(comments.T1.length, 1);
    assert.ok(comments.T1[0].comment_text.includes('[merged-auth-form:tok-1]'));
    assert.ok(comments.T1[0].comment_text.includes('https://f/1'));
  });

  await test('is idempotent — a repeat call updates the same comment, not stacks', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: {
        clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1',
        clickupTaskIds: ['T1', 'T2', 'T3'], testTypes: ['External', 'Wireless', 'Internal'], dayCount: 4,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['updated', 'updated', 'created']);
    assert.strictEqual(comments.T1.length, 1, 'T1 must still have exactly one comment');
    assert.ok(comments.T1[0].comment_text.includes('Internal'), 'comment text was refreshed');
  });

  await test('reports a per-task failure but still 200 when others succeed', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: { clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1', clickupTaskIds: ['T1', 'FAIL'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    const fail = r.json.results.find((x) => x.taskId === 'FAIL');
    assert.strictEqual(fail.action, 'failed');
    assert.ok(fail.error);
  });

  await test('returns 502 with ok:false when every task fails', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: { clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1', clickupTaskIds: ['FAIL'] },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
  });

  // ── extra-urls ────────────────────────────────────────────────────────────────
  console.log('\nPOST /clickup/extra-urls:');

  await test('rejects an empty urls array with 400', async () => {
    const r = await request('/clickup/extra-urls', { headers: KEY, body: { clientName: 'Acme', urls: [] } });
    assert.strictEqual(r.status, 400);
  });

  await test('comments on the task and posts to Slack', async () => {
    const before = slackPosts.length;
    const r = await request('/clickup/extra-urls', {
      headers: KEY,
      body: {
        clientName: 'Acme', formToken: 'f1', formUrl: 'https://f/x', clickupTaskId: 'U1',
        urls: ['https://a.acme.com', 'https://b.acme.com'], urlCount: 2,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ ok: r.json.ok, clickup: r.json.clickup, slack: r.json.slack }, { ok: true, clickup: 'commented', slack: 'sent' });
    assert.strictEqual(comments.U1.length, 1);
    assert.strictEqual(slackPosts.length, before + 1);
    assert.strictEqual(slackPosts.at(-1).channel, 'C0AA3SNQUKE', 'alert goes to the hardcoded channel');
    assert.ok(slackPosts.at(-1).text.includes('app.clickup.com/t/U1'), 'Slack text links the task');
  });

  await test('skips the comment when clickupTaskId is null but still alerts Slack', async () => {
    const r = await request('/clickup/extra-urls', {
      headers: KEY,
      body: { clientName: 'Acme', clickupTaskId: null, urls: ['https://a.acme.com', 'https://b.acme.com'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.clickup, 'skipped');
    assert.strictEqual(r.json.slack, 'sent');
  });

  await test('returns 502 when the only work (Slack) fails', async () => {
    slackShouldFail = true;
    const r = await request('/clickup/extra-urls', {
      headers: KEY, body: { clientName: 'Acme', clickupTaskId: null, urls: ['https://a', 'https://b'] },
    });
    assert.strictEqual(r.status, 502);
    assert.deepStrictEqual({ ok: r.json.ok, clickup: r.json.clickup, slack: r.json.slack }, { ok: false, clickup: 'skipped', slack: 'failed' });
    slackShouldFail = false;
  });

  // ── schedule-task ─────────────────────────────────────────────────────────────
  console.log('\nPOST /clickup/schedule-task:');

  await test('rejects a missing endDate with 400', async () => {
    const r = await request('/clickup/schedule-task', { headers: KEY, body: { clickupTaskId: 'S1', startDate: '2026-09-07' } });
    assert.strictEqual(r.status, 400);
  });

  await test('rejects a malformed date with 400', async () => {
    const r = await request('/clickup/schedule-task', {
      headers: KEY, body: { clickupTaskId: 'S1', startDate: 'not-a-date', endDate: '2026-09-08' },
    });
    assert.strictEqual(r.status, 400);
  });

  await test('writes UTC-midnight ms dates and resolves the consultant assignee', async () => {
    const before = scheduled.length;
    const r = await request('/clickup/schedule-task', {
      headers: KEY,
      body: { clickupTaskId: 'S1', startDate: '2026-09-07', endDate: '2026-09-08', consultant: 'Jane Smith', testType: 'Paid Black Box Pentest', days: 2 },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.start_date, Date.parse('2026-09-07T00:00:00Z'));
    assert.strictEqual(r.json.due_date, Date.parse('2026-09-08T00:00:00Z'));
    assert.strictEqual(scheduled.length, before + 1);
    assert.strictEqual(scheduled.at(-1).assigneeId, 99, 'Jane Smith resolves to user id 99');
  });

  await test('still sets dates when the consultant cannot be resolved (non-fatal)', async () => {
    const r = await request('/clickup/schedule-task', {
      headers: KEY, body: { clickupTaskId: 'S2', startDate: '2026-09-07', endDate: '2026-09-08', consultant: 'Nobody Here' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(scheduled.at(-1).assigneeId, null);
  });

  await test('returns 502 when the ClickUp update fails', async () => {
    const r = await request('/clickup/schedule-task', {
      headers: KEY, body: { clickupTaskId: 'FAIL', startDate: '2026-09-07', endDate: '2026-09-08' },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
