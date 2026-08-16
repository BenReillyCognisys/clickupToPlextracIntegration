// Covers the auth-form re-scope that runs when a ClickUp task is renamed
// (pipeline/auth-form-rename.js): what counts as a change worth telling the portal
// about, the payload the portal receives, and each of the outcomes it can return.
//
// A tiny express app stands in for the SFE portal so the real axios client is
// exercised end to end; ClickUp writes are stubbed on the module exports.

const assert  = require('assert');
const express = require('express');

process.env.BREAK_SERVICES_API_KEY = 'test-key';

// Stub the ClickUp write BEFORE the module under test pulls it in via
// pipeline/auth-form-create (which destructures it on import).
const clickupApi = require('../lib/clickup-api');
const fieldWrites = []; // recorded setTaskCustomField calls
clickupApi.setTaskCustomField = async (taskId, fieldId, value) => {
  fieldWrites.push({ taskId, fieldId, value });
};

const { syncAuthFormForRename, diffAuthFormFields } = require('../pipeline/auth-form-rename');

// ── Stub portal ───────────────────────────────────────────────────────────────
// Records every request and replies with whatever the current test has queued.
const received = [];      // { path, body }
let updateResponse = { status: 200, body: { ok: true, updated: true, formUrl: 'https://portal/f/new' } };

const app = express();
app.use(express.json());
app.post('/api/clickup/auth-form/update', (req, res) => {
  received.push({ path: '/api/clickup/auth-form/update', body: req.body });
  res.status(updateResponse.status).json(updateResponse.body);
});
app.post('/api/clickup/auth-form', (req, res) => {
  received.push({ path: '/api/clickup/auth-form', body: req.body });
  res.status(200).json({ ok: true, created: true, formUrl: 'https://portal/f/created' });
});

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

// A renamed task carrying the authformlink custom field, so a new form URL has
// somewhere to be written back to.
const AUTH_FIELD = { id: 'cf-authformlink', name: 'authformlink', type: 'url' };
const task = {
  id: 'T1',
  name: 'Acme Corp | External',
  start_date: '1755216000000',
  due_date: '1755302400000',
  custom_fields: [AUTH_FIELD],
};

// Black Box → External, the rename this feature exists for.
const BLACK_TO_EXTERNAL = {
  oldClientName: 'Acme Corp',
  oldTestType: 'Black Box',
  clientName: 'Acme Corp',
  testType: 'External',
  clientId: 42,
  reportId: 99,
};

(async () => {
  // ── diffAuthFormFields ──────────────────────────────────────────────────────
  console.log('\ndiffAuthFormFields:');

  await test('a testing-type change is a change', () => {
    const d = diffAuthFormFields(BLACK_TO_EXTERNAL);
    assert.deepStrictEqual(d, { clientChanged: false, typeChanged: true, changed: true });
  });

  await test('a client-name change is a change', () => {
    const d = diffAuthFormFields({
      oldClientName: 'Acme Corp', oldTestType: 'External',
      clientName: 'Acme Group', testType: 'External',
    });
    assert.deepStrictEqual(d, { clientChanged: true, typeChanged: false, changed: true });
  });

  await test('case and whitespace differences are not changes', () => {
    const d = diffAuthFormFields({
      oldClientName: ' acme corp ', oldTestType: 'black box',
      clientName: 'Acme Corp', testType: 'Black Box',
    });
    assert.strictEqual(d.changed, false);
  });

  // ── syncAuthFormForRename ───────────────────────────────────────────────────
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  process.env.SECURE_PORTAL_URL = `http://127.0.0.1:${server.address().port}`;

  console.log('\nsyncAuthFormForRename:');

  await test('sends the old and new testing type so the portal can swap the element', async () => {
    received.length = 0;
    fieldWrites.length = 0;
    const result = await syncAuthFormForRename(task, BLACK_TO_EXTERNAL);

    assert.strictEqual(received.length, 1, 'expected exactly one portal call');
    assert.strictEqual(received[0].path, '/api/clickup/auth-form/update');
    const body = received[0].body;
    assert.strictEqual(body.previousTestType, 'Black Box');
    assert.strictEqual(body.testType, 'External');
    assert.strictEqual(body.previousClientName, 'Acme Corp');
    assert.strictEqual(body.clientName, 'Acme Corp');
    assert.strictEqual(body.clickupTaskId, 'T1');
    assert.strictEqual(body.plextracReportId, 99);
    assert.strictEqual(body.startDate, 1755216000000);
    assert.deepStrictEqual(result, { formUrl: 'https://portal/f/new', updated: true });
  });

  await test('writes the refreshed form link back to the authformlink field', () => {
    assert.strictEqual(fieldWrites.length, 1);
    assert.deepStrictEqual(fieldWrites[0], {
      taskId: 'T1', fieldId: 'cf-authformlink', value: 'https://portal/f/new',
    });
  });

  await test('does not call the portal when neither client nor type changed', async () => {
    received.length = 0;
    const result = await syncAuthFormForRename(task, {
      ...BLACK_TO_EXTERNAL, oldTestType: 'External',
    });
    assert.strictEqual(result, null);
    assert.strictEqual(received.length, 0);
  });

  await test('creates a form when the portal has none for the task (404)', async () => {
    received.length = 0;
    updateResponse = { status: 404, body: { ok: false, error: 'no form for task' } };
    const result = await syncAuthFormForRename(task, BLACK_TO_EXTERNAL);

    assert.deepStrictEqual(received.map((r) => r.path), [
      '/api/clickup/auth-form/update',
      '/api/clickup/auth-form',
    ]);
    assert.strictEqual(received[1].body.testType, 'External', 'new form must use the NEW type');
    assert.deepStrictEqual(result, { formUrl: 'https://portal/f/created', updated: true });
  });

  await test('leaves a signed form alone when the portal refuses (409)', async () => {
    received.length = 0;
    updateResponse = { status: 409, body: { ok: false, error: 'form already signed' } };
    const result = await syncAuthFormForRename(task, BLACK_TO_EXTERNAL);
    assert.strictEqual(result, null);
    assert.deepStrictEqual(received.map((r) => r.path), ['/api/clickup/auth-form/update']);
  });

  await test('reports nothing done when the portal answers updated:false', async () => {
    updateResponse = { status: 200, body: { ok: true, updated: false, reason: 'already signed' } };
    const result = await syncAuthFormForRename(task, BLACK_TO_EXTERNAL);
    assert.strictEqual(result, null);
  });

  await test('swallows a portal error rather than throwing at the webhook', async () => {
    updateResponse = { status: 500, body: { ok: false, error: 'boom' } };
    const result = await syncAuthFormForRename(task, BLACK_TO_EXTERNAL);
    assert.strictEqual(result, null);
  });

  await test('skips the whole step when SECURE_PORTAL_URL is unset', async () => {
    const url = process.env.SECURE_PORTAL_URL;
    delete process.env.SECURE_PORTAL_URL;
    received.length = 0;
    const result = await syncAuthFormForRename(task, BLACK_TO_EXTERNAL);
    process.env.SECURE_PORTAL_URL = url;
    assert.strictEqual(result, null);
    assert.strictEqual(received.length, 0);
  });

  server.close();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
