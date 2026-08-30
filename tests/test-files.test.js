// Covers the break.services → portal half of the test-files feature: getting the
// client's per-task upload link and writing it into the task's `testfilesstorage`
// custom field (pipeline/auth-form-create.js).
//
// The other half — the portal calling us back once a client has uploaded, and the
// completion box being ticked — lives in tests/clickup-actions.test.js.
//
// A tiny express app stands in for the SFE portal so the real axios client is
// exercised end to end; ClickUp writes are stubbed on the module exports.

const assert  = require('assert');
const express = require('express');

process.env.BREAK_SERVICES_API_KEY = 'test-key';

// Stub the ClickUp write BEFORE the module under test destructures it on import.
const clickupApi = require('../lib/clickup-api');
const fieldWrites = []; // recorded setTaskCustomField calls
let fieldWriteShouldFail = false;
clickupApi.setTaskCustomField = async (taskId, fieldId, value) => {
  if (fieldWriteShouldFail) throw new Error('boom (custom field)');
  fieldWrites.push({ taskId, fieldId, value });
};

const {
  createAuthFormForTask, ensureTestFilesLinkForTask,
} = require('../pipeline/auth-form-create');

// ── Stub portal ───────────────────────────────────────────────────────────────
const received = [];  // { path, body }
// What /api/clickup/auth-form replies with; tests swap in the no-files-link variant.
let authFormResponse = {
  ok: true, created: true,
  formUrl: 'https://portal/f/tok', formToken: 'tok',
  testFilesUrl: 'https://portal/test-files/tf-tok', testFilesToken: 'tf-tok',
};
let testFilesResponse = {
  status: 200,
  body: { ok: true, created: false, testFilesUrl: 'https://portal/test-files/tf-tok', testFilesToken: 'tf-tok' },
};

const app = express();
app.use(express.json());
app.post('/api/clickup/auth-form', (req, res) => {
  received.push({ path: '/api/clickup/auth-form', body: req.body });
  res.status(200).json(authFormResponse);
});
app.post('/api/clickup/test-files', (req, res) => {
  received.push({ path: '/api/clickup/test-files', body: req.body });
  res.status(testFilesResponse.status).json(testFilesResponse.body);
});

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

// The two similarly named fields as they actually exist in the workspace: the link is
// short_text, the completion box is a checkbox under a different name.
const LINK_FIELD = { id: 'cf-testfilesstorage', name: 'testfilesstorage', type: 'short_text' };
const DONE_FIELD = { id: 'cf-testfilesstored', name: 'testfilesstored', type: 'checkbox' };
const AUTH_FIELD = { id: 'cf-authformlink', name: 'authformlink', type: 'short_text' };

const makeTask = (custom_fields) => ({
  id: 'T1',
  name: 'Acme Corp | External',
  start_date: '1755216000000',
  due_date: '1755302400000',
  custom_fields,
});

const ARGS = { clientName: 'Acme Corp', testType: 'External', clientId: 42, reportId: 99 };
const linkWrites = () => fieldWrites.filter((w) => w.fieldId === LINK_FIELD.id);

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  process.env.SECURE_PORTAL_URL = `http://127.0.0.1:${server.address().port}`;

  // ── The intake call fills both fields ───────────────────────────────────────
  console.log('\ncreateAuthFormForTask — test-files link:');

  await test('writes the portal\'s upload link into the testfilesstorage field', async () => {
    fieldWrites.length = 0;
    const task = makeTask([AUTH_FIELD, LINK_FIELD, DONE_FIELD]);
    const result = await createAuthFormForTask(task, ARGS);
    assert.strictEqual(result.testFilesUrl, 'https://portal/test-files/tf-tok');
    assert.deepStrictEqual(linkWrites(), [
      { taskId: 'T1', fieldId: 'cf-testfilesstorage', value: 'https://portal/test-files/tf-tok' },
    ]);
  });

  await test('one intake call fills the auth-form field too — no second portal round trip', async () => {
    fieldWrites.length = 0;
    received.length = 0;
    const task = makeTask([AUTH_FIELD, LINK_FIELD, DONE_FIELD]);
    await createAuthFormForTask(task, ARGS);
    assert.deepStrictEqual(received.map((r) => r.path), ['/api/clickup/auth-form']);
    assert.deepStrictEqual(
      fieldWrites.map((w) => w.fieldId).sort(),
      ['cf-authformlink', 'cf-testfilesstorage'],
    );
  });

  await test('never writes the link into a same-named checkbox', async () => {
    fieldWrites.length = 0;
    // Both fields named "testfilesstorage" — only the type separates them.
    const task = makeTask([
      AUTH_FIELD,
      { id: 'cf-box', name: 'testfilesstorage', type: 'checkbox' },
      { id: 'cf-link', name: 'testfilesstorage', type: 'short_text' },
    ]);
    await createAuthFormForTask(task, ARGS);
    const written = fieldWrites.find((w) => w.value === 'https://portal/test-files/tf-tok');
    assert.strictEqual(written.fieldId, 'cf-link', 'the short_text field takes the link');
  });

  await test('leaves the field alone when the portal returns no link', async () => {
    fieldWrites.length = 0;
    authFormResponse = { ok: true, created: true, formUrl: 'https://portal/f/tok', formToken: 'tok' };
    const task = makeTask([AUTH_FIELD, LINK_FIELD, DONE_FIELD]);
    const result = await createAuthFormForTask(task, ARGS);
    assert.strictEqual(result.formUrl, 'https://portal/f/tok', 'the auth form is unaffected');
    assert.strictEqual(result.testFilesUrl, null);
    assert.strictEqual(linkWrites().length, 0, 'nothing is written, so the next sync can retry');
    authFormResponse = {
      ok: true, created: true,
      formUrl: 'https://portal/f/tok', formToken: 'tok',
      testFilesUrl: 'https://portal/test-files/tf-tok', testFilesToken: 'tf-tok',
    };
  });

  await test('a task without the field is logged, not thrown', async () => {
    fieldWrites.length = 0;
    const task = makeTask([AUTH_FIELD]);
    const result = await createAuthFormForTask(task, ARGS);
    assert.strictEqual(result.testFilesUrl, 'https://portal/test-files/tf-tok');
    assert.strictEqual(linkWrites().length, 0);
  });

  await test('a failed ClickUp write never breaks the auth form', async () => {
    fieldWriteShouldFail = true;
    const task = makeTask([AUTH_FIELD, LINK_FIELD, DONE_FIELD]);
    const result = await createAuthFormForTask(task, ARGS);
    fieldWriteShouldFail = false;
    assert.strictEqual(result.formUrl, 'https://portal/f/tok');
  });

  // ── The standalone call, for tasks that never get an auth form ──────────────
  console.log('\nensureTestFilesLinkForTask:');

  await test('asks the portal for a link and writes it to the field', async () => {
    fieldWrites.length = 0;
    received.length = 0;
    const task = makeTask([LINK_FIELD, DONE_FIELD]);
    const url = await ensureTestFilesLinkForTask(task, { clientName: 'Acme Corp' });
    assert.strictEqual(url, 'https://portal/test-files/tf-tok');
    assert.deepStrictEqual(received.map((r) => r.path), ['/api/clickup/test-files']);
    assert.deepStrictEqual(received[0].body, {
      clientName: 'Acme Corp',
      clickupTaskId: 'T1',
      clickupTaskUrl: 'https://app.clickup.com/t/T1',
    });
    assert.deepStrictEqual(linkWrites(), [
      { taskId: 'T1', fieldId: 'cf-testfilesstorage', value: 'https://portal/test-files/tf-tok' },
    ]);
  });

  await test('returns null and writes nothing when the portal fails', async () => {
    fieldWrites.length = 0;
    testFilesResponse = { status: 500, body: { ok: false, error: 'boom' } };
    const task = makeTask([LINK_FIELD, DONE_FIELD]);
    const url = await ensureTestFilesLinkForTask(task, { clientName: 'Acme Corp' });
    testFilesResponse = {
      status: 200,
      body: { ok: true, created: false, testFilesUrl: 'https://portal/test-files/tf-tok', testFilesToken: 'tf-tok' },
    };
    assert.strictEqual(url, null);
    assert.strictEqual(linkWrites().length, 0);
  });

  await test('returns null when the portal answers 200 with no link', async () => {
    fieldWrites.length = 0;
    testFilesResponse = { status: 200, body: { ok: true, created: false } };
    const task = makeTask([LINK_FIELD, DONE_FIELD]);
    const url = await ensureTestFilesLinkForTask(task, { clientName: 'Acme Corp' });
    testFilesResponse = {
      status: 200,
      body: { ok: true, created: false, testFilesUrl: 'https://portal/test-files/tf-tok', testFilesToken: 'tf-tok' },
    };
    assert.strictEqual(url, null);
    assert.strictEqual(linkWrites().length, 0);
  });

  await test('skips the whole step when SECURE_PORTAL_URL is unset', async () => {
    const url = process.env.SECURE_PORTAL_URL;
    delete process.env.SECURE_PORTAL_URL;
    received.length = 0;
    const result = await ensureTestFilesLinkForTask(makeTask([LINK_FIELD]), { clientName: 'Acme Corp' });
    process.env.SECURE_PORTAL_URL = url;
    assert.strictEqual(result, null);
    assert.strictEqual(received.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  if (failed > 0) process.exit(1);
})();
