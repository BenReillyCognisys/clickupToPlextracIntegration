const assert = require('assert');
const http = require('http');
const express = require('express');

// Read by the router's auth middleware and by the pipeline at request time.
process.env.AVAILABILITY_API_KEY = 'test-key';
process.env.CLICKUP_SPACE_ID = 'pentest-space';
process.env.CLICKUP_SECOPS_SPACE_ID = 'secops-space';
process.env.CLICKUP_VMAAS_FOLDER_ID = 'vmaas-folder';
process.env.SECURE_PORTAL_URL = 'https://portal.test';
process.env.BREAK_SERVICES_API_KEY = 'portal-key';
process.env.PLEXTRAC_INSTANCE = 'test.plextrac.com';

// ── Stub the outbound helpers BEFORE the router is required ───────────────────
// pipeline/auth-form-create and pipeline/index destructure these on import, so the
// fakes must be in place first. Everything else reaches them through the module
// object (api.x / store.x) and picks the fakes up at call time either way.
const clickupApi = require('../lib/clickup-api');
const plextracApi = require('../lib/plextrac-api');
const portal = require('../lib/secure-portal-api');
const store = require('../lib/task-store');
const log = require('../lib/logger');

// ── ClickUp ───────────────────────────────────────────────────────────────────
let tasks = {}; // taskId -> task object; a missing id 404s like ClickUp does
const fieldWrites = []; // recorded setTaskCustomField calls

clickupApi.getTask = async (taskId) => {
  const task = tasks[taskId];
  if (!task) throw new Error(`ClickUp 404 GET /task/${taskId}: not found`);
  return task;
};
clickupApi.setTaskCustomField = async (taskId, fieldId, value) => {
  fieldWrites.push({ taskId, fieldId, value });
};

// ── Plextrac ──────────────────────────────────────────────────────────────────
let clients = []; // [{ client_id, name }]
let reports = {}; // clientId -> [{ id, name, cuid }]
let nextReportId = 900;
const clientRenames = []; // recorded updateClient calls
const reportUpdates = []; // recorded updateReport calls

plextracApi.listClients = async () => clients.map(c => ({ id: `client_${c.client_id}`, data: [c.client_id, c.name, null] }));
plextracApi.createClient = async (name) => {
  const client_id = 1000 + clients.length;
  clients.push({ client_id, name });
  return { client_id };
};
plextracApi.updateClient = async (clientId, payload) => {
  clientRenames.push({ clientId, ...payload });
  const c = clients.find(x => String(x.client_id) === String(clientId));
  if (c && payload.name) c.name = payload.name;
};
plextracApi.listClientReports = async (clientId) =>
  (reports[String(clientId)] || []).map(r => ({ id: r.id, data: [r.id, r.name] }));
plextracApi.getReport = async (clientId, reportId) =>
  (reports[String(clientId)] || []).find(r => String(r.id) === String(reportId)) || null;
plextracApi.createReport = async (clientId, payload) => {
  const id = nextReportId++;
  (reports[String(clientId)] ||= []).push({ id, name: payload.name, cuid: `cuid-${id}` });
  return { report_id: id };
};
plextracApi.updateReport = async (clientId, reportId, payload) => {
  reportUpdates.push({ clientId, reportId, ...payload });
  const r = (reports[String(clientId)] || []).find(x => String(x.id) === String(reportId));
  if (r && payload.name) r.name = payload.name;
};
// Every template the type→template map can resolve to, so a remap onto a different
// testing type resolves its template rather than failing on a missing one.
plextracApi.listReportTemplates = async () => [
  ...new Set([
    ...require('../config/template-map').map(e => e.template),
    'Cognisys Web Application Black Box',
  ]),
].map(name => ({ id: name, data: { doc_id: name, template_name: name } }));
plextracApi.listFieldTemplates = async () => [{ id: 'lay', data: { doc_id: 'lay', name: 'Pentest Cognisys' } }];

// ── Secure portal ─────────────────────────────────────────────────────────────
let forms = {}; // clickupTaskId -> { formUrl, clientName, testType }
const portalCalls = [];

portal.createAuthForm = async (payload) => {
  portalCalls.push({ op: 'create', ...payload });
  const existing = forms[payload.clickupTaskId];
  if (existing) return { ok: true, formUrl: existing.formUrl, created: false };
  const formUrl = `https://portal.test/f/${payload.clickupTaskId}`;
  forms[payload.clickupTaskId] = { formUrl, clientName: payload.clientName, testType: payload.testType };
  return { ok: true, formUrl, created: true };
};
portal.updateAuthForm = async (payload) => {
  portalCalls.push({ op: 'update', ...payload });
  const existing = forms[payload.clickupTaskId];
  if (!existing) throw Object.assign(new Error('no form'), { status: 404 });
  Object.assign(existing, { clientName: payload.clientName, testType: payload.testType });
  return { ok: true, formUrl: existing.formUrl, updated: true };
};

// ── Mongo-backed mapping store ────────────────────────────────────────────────
let mappings = []; // the task_mappings collection

store.saveMapping = async (m) => {
  const existing = mappings.find(x => String(x.plextrac_report_id) === String(m.plextracReportId));
  const doc = {
    clickup_task_id: String(m.clickupTaskId),
    plextrac_client_id: m.plextracClientId,
    plextrac_report_id: m.plextracReportId,
    plextrac_report_cuid: m.plextracReportCuid ?? null,
    task_name: m.taskName,
    testing_type: m.testingType,
    start_date_pending: Boolean(m.startDatePending),
  };
  if (existing) Object.assign(existing, doc);
  else mappings.push(doc);
};
store.findByTaskId = async (taskId) =>
  mappings.find(m => String(m.clickup_task_id) === String(taskId)) || null;
store.findByReportId = async (reportId) =>
  mappings.find(m => String(m.plextrac_report_id) === String(reportId)) || null;
store.updateMappingDetails = async (reportId, { clientId, taskName, testingType, startDatePending } = {}) => {
  const m = mappings.find(x => String(x.plextrac_report_id) === String(reportId));
  if (!m) return;
  if (clientId != null) m.plextrac_client_id = clientId;
  if (taskName != null) m.task_name = taskName;
  if (testingType != null) m.testing_type = testingType;
  if (startDatePending != null) m.start_date_pending = Boolean(startDatePending);
};
store.remapClickupTask = async (reportId, newTaskId, { previousTaskId } = {}) => {
  const m = mappings.find(x => String(x.plextrac_report_id) === String(reportId));
  if (!m) return false;
  m.clickup_task_id = String(newTaskId);
  m.remapped_from = previousTaskId == null ? null : String(previousTaskId);
  m.remapped_at = new Date();
  return true;
};

// ── Logger ────────────────────────────────────────────────────────────────────
// Slack notices are asserted; the console lines are silenced so the test output is
// the test output.
const notices = [];
log.notify = (message) => { notices.push(message); };
log.info = () => {};
log.warn = () => {};
log.error = () => {};

// Router last, so every stub above is in place when its imports resolve.
const app = express();
app.use(express.json());
app.use('/tasks', require('../routes/task-admin'));
const server = http.createServer(app);

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const queue = [];

function test(description, fn) {
  if (only && !description.includes(only)) return;
  queue.push({ description, fn });
}

async function runQueue() {
  for (const { description, fn } of queue) {
    reset();
    try {
      await fn();
      console.log(`  ✓  ${description}`);
      passed++;
    } catch (err) {
      console.error(`  ✗  ${description}`);
      console.error(`       ${err.message}`);
      failed++;
    }
  }
}

const PENTEST_TASK = (over = {}) => ({
  id: 'task1',
  name: 'Acme Corp | Black Box',
  space: { id: 'pentest-space', name: 'Penetration Test' },
  list: { id: 'l1', name: 'Acme Corp' },
  status: { status: 'open' },
  start_date: String(Date.UTC(2026, 7, 15)),
  due_date: String(Date.UTC(2026, 7, 22)),
  assignees: [{ email: 'tester@cognisys.group' }],
  custom_fields: [{ id: 'cf-authform', name: 'authformlink' }],
  ...over,
});

function reset() {
  tasks = {};
  clients = [];
  reports = {};
  mappings = [];
  forms = {};
  nextReportId = 900;
  fieldWrites.length = 0;
  clientRenames.length = 0;
  reportUpdates.length = 0;
  portalCalls.length = 0;
  notices.length = 0;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers: {
        'X-API-Key': 'test-key',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const replay = (body) => request('POST', '/tasks/replay', body);
const remap = (body) => request('POST', '/tasks/remap', body);

// ── Auth ──────────────────────────────────────────────────────────────────────
console.log('\nAuth:');

test('a missing API key is rejected', async () => {
  const res = await new Promise((resolve) => {
    const payload = JSON.stringify({ taskId: 'task1' });
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/tasks/replay',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode })); });
    req.write(payload);
    req.end();
  });
  assert.strictEqual(res.status, 401);
});

// ── Replay: input validation ──────────────────────────────────────────────────
console.log('\nReplay — validation:');

test('a missing taskId is a 400', async () => {
  const res = await replay({});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'invalid_request');
});

test('a malformed taskId is a 400 and never reaches ClickUp', async () => {
  const res = await replay({ taskId: '../../etc/passwd' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.detail, /not a valid ClickUp task id/);
});

test('an unknown task is a 404', async () => {
  const res = await replay({ taskId: 'nope' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.status, 'not_found');
});

test('a task outside the monitored spaces is refused', async () => {
  tasks.task1 = PENTEST_TASK({ space: { id: 'other-space', name: 'Sales' } });
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.status, 'not_monitored');
});

test('a subtask is refused', async () => {
  tasks.task1 = PENTEST_TASK({ parent: 'parent1' });
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.body.status, 'not_monitored');
  assert.match(res.body.detail, /subtask/);
});

// ── Replay: the missed-event case ─────────────────────────────────────────────
console.log('\nReplay — a missed taskCreated:');

test('creates the client, the report and the auth form', async () => {
  tasks.task1 = PENTEST_TASK();
  const res = await replay({ taskId: 'task1' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'created');
  assert.strictEqual(res.body.client_name, 'Acme Corp');
  assert.strictEqual(res.body.testing_type, 'Black Box');
  assert.strictEqual(res.body.report_name, 'Black Box | August 2026');
  assert.ok(res.body.report_url.includes('/report/'), res.body.report_url);
  assert.strictEqual(res.body.auth_form_url, 'https://portal.test/f/task1');

  // …and the mapping every later automation depends on now exists.
  const mapping = await store.findByTaskId('task1');
  assert.strictEqual(String(mapping.plextrac_report_id), String(res.body.report_id));
  assert.strictEqual(mapping.plextrac_report_cuid, `cuid-${res.body.report_id}`);
  // The link is written back to the task's authformlink field.
  assert.deepStrictEqual(fieldWrites, [{ taskId: 'task1', fieldId: 'cf-authform', value: 'https://portal.test/f/task1' }]);
});

test('is idempotent — a second replay reports the existing mapping and creates nothing', async () => {
  tasks.task1 = PENTEST_TASK();
  const first = await replay({ taskId: 'task1' });
  const second = await replay({ taskId: 'task1' });

  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.status, 'already_mapped');
  assert.strictEqual(String(second.body.report_id), String(first.body.report_id));
  assert.strictEqual(reports['1000'].length, 1, 'a second report was created');
  assert.strictEqual(mappings.length, 1);
});

test('a placeholder-named task is left for the rename', async () => {
  tasks.task1 = PENTEST_TASK({ name: 'Test Task' });
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.status, 'placeholder_name');
  assert.strictEqual(mappings.length, 0);
});

test('an unclassifiable name is refused without touching Plextrac', async () => {
  tasks.task1 = PENTEST_TASK({ name: 'Acme Corp Bespoke Work' });
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.status, 'unknown_testing_type');
  assert.strictEqual(clients.length, 0);
});

test('a mis-ordered name is replayed with the recovered client and flagged', async () => {
  tasks.task1 = PENTEST_TASK({ name: 'Black Box Pen Test - Brask - Black Box Web Application Penetration Testing' });
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.body.status, 'created');
  assert.strictEqual(res.body.client_name, 'Brask');
  assert.match(res.body.warning, /out of order/);
});

// ── Replay: force ─────────────────────────────────────────────────────────────
console.log('\nReplay — force (repairing a half-finished run):');

test('force re-runs an already-mapped task and repairs the missing auth form', async () => {
  tasks.task1 = PENTEST_TASK();
  await replay({ taskId: 'task1' });
  // Model a run whose auth form never landed.
  forms = {};
  fieldWrites.length = 0;

  const res = await replay({ taskId: 'task1', force: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'report_exists', JSON.stringify(res.body));
  assert.strictEqual(res.body.auth_form_url, 'https://portal.test/f/task1');
  assert.strictEqual(reports['1000'].length, 1, 'force created a duplicate report');
  assert.strictEqual(fieldWrites.length, 1);
});

test('force does not announce a report it did not create', async () => {
  tasks.task1 = PENTEST_TASK();
  await replay({ taskId: 'task1' });
  notices.length = 0;
  await replay({ taskId: 'task1', force: true });
  assert.deepStrictEqual(notices.filter(n => n.includes('has been created')), []);
});

// ── Replay: adopting an orphaned report ───────────────────────────────────────
console.log('\nReplay — adopting a report whose mapping was lost:');

// A run that created the report but never stored the mapping (Mongo down at the
// time): the report is invisible to every later automation until it's adopted.
function orphanedReport() {
  tasks.task1 = PENTEST_TASK();
  clients = [{ client_id: 1000, name: 'Acme Corp' }];
  reports['1000'] = [{ id: 555, name: 'Black Box | August 2026', cuid: 'cuid-555' }];
}

test('reports the orphan rather than silently adopting it', async () => {
  orphanedReport();
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.status, 'report_exists_unmapped');
  assert.match(res.body.next_step, /adopt/);
  assert.strictEqual(mappings.length, 0);
});

test('adopt maps the task to the existing report, cuid and all', async () => {
  orphanedReport();
  const res = await replay({ taskId: 'task1', adopt: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'adopted');

  const mapping = await store.findByTaskId('task1');
  assert.strictEqual(mapping.plextrac_report_id, 555);
  assert.strictEqual(mapping.plextrac_report_cuid, 'cuid-555');
  assert.strictEqual(mapping.testing_type, 'Black Box');
  assert.strictEqual(reports['1000'].length, 1, 'adopting created a second report');
});

test('adopt refuses to steal a report another task already owns', async () => {
  orphanedReport();
  mappings.push({
    clickup_task_id: 'other', plextrac_client_id: 1000, plextrac_report_id: 555,
    task_name: 'Acme Corp | Black Box', testing_type: 'Black Box',
  });
  const res = await replay({ taskId: 'task1', adopt: true });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.status, 'adopt_conflict');
  assert.strictEqual(res.body.mapping.clickup_task_id, 'other');
});

// ── Replay: VMaaS ─────────────────────────────────────────────────────────────
console.log('\nReplay — VMaaS tasks:');

test('a VMaaS task replays its auth form and no report', async () => {
  tasks.task1 = PENTEST_TASK({
    name: 'Acme Ltd',
    space: { id: 'secops-space', name: 'SecOps' },
    folder: { id: 'vmaas-folder', name: 'VMaaS' },
    list: { id: 'l1', name: 'Acme Ltd' },
  });
  const res = await replay({ taskId: 'task1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.pipeline, 'vmaas');
  assert.strictEqual(res.body.auth_form_url, 'https://portal.test/f/task1');
  assert.strictEqual(portalCalls[0].testType, 'VMaaS');
  assert.strictEqual(reports['1000'], undefined);
});

// ── Remap ─────────────────────────────────────────────────────────────────────
console.log('\nRemap — validation:');

test('remapping a task onto itself is a 400', async () => {
  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task1' });
  assert.strictEqual(res.status, 400);
});

test('a missing toTaskId is a 400', async () => {
  const res = await remap({ fromTaskId: 'task1' });
  assert.strictEqual(res.status, 400);
});

test('an unmapped source is a 404 pointing at replay', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2' });
  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.status, 'source_not_mapped');
  assert.match(res.body.next_step, /replay/);
});

test('a target that already drives its own report is a 409, and nothing moves', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2', name: 'Other Ltd | External' });
  await replay({ taskId: 'task1' });
  await replay({ taskId: 'task2' });

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.status, 'target_already_mapped');
  assert.strictEqual((await store.findByTaskId('task1')).clickup_task_id, 'task1');
});

test('a target outside the pentest space is refused', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2', space: { id: 'secops-space', name: 'SecOps' }, folder: { id: 'vmaas-folder', name: 'VMaaS' } });
  await replay({ taskId: 'task1' });
  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.status, 'target_not_eligible');
});

console.log('\nRemap — the duplicate-task case:');

test('moves the mapping to the duplicate and gives it its own auth form', async () => {
  tasks.task1 = PENTEST_TASK();
  // The duplicate: same name, so nothing in Plextrac needs renaming.
  tasks.task2 = PENTEST_TASK({ id: 'task2' });
  const created = await replay({ taskId: 'task1' });

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'remapped');
  assert.strictEqual(String(res.body.report_id), String(created.body.report_id));
  assert.strictEqual(res.body.report_name, 'Black Box | August 2026');

  // The report now follows task2, and task1 no longer resolves to anything.
  assert.strictEqual(await store.findByTaskId('task1'), null);
  const mapping = await store.findByTaskId('task2');
  assert.strictEqual(String(mapping.plextrac_report_id), String(created.body.report_id));
  assert.strictEqual(mapping.remapped_from, 'task1');

  // The duplicate gets its own form (the portal keys them on the task id), and the
  // link lands on the duplicate's field — the case a same-name rename would miss.
  assert.strictEqual(res.body.auth_form_url, 'https://portal.test/f/task2');
  assert.ok(fieldWrites.some(w => w.taskId === 'task2' && w.value === 'https://portal.test/f/task2'));
  assert.strictEqual(reports['1000'].length, 1, 'remap created a second report');
});

test('renames the Plextrac report when the target task has a different testing type', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2', name: 'Acme Corp | External' });
  await replay({ taskId: 'task1' });

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.body.report_renamed, true);
  assert.strictEqual(res.body.report_name, 'External | August 2026');
  assert.strictEqual(res.body.testing_type, 'External');
  assert.strictEqual((await store.findByTaskId('task2')).testing_type, 'External');
});

test('renames the Plextrac client when the target task names a different one', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2', name: 'Brask Ltd | Black Box' });
  await replay({ taskId: 'task1' });

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.body.client_renamed, true);
  assert.strictEqual(res.body.client_name, 'Brask Ltd');
  assert.deepStrictEqual(clientRenames.map(r => r.name), ['Brask Ltd']);
});

test('leaves the report name alone when the target name cannot be classified', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2', name: 'Acme Corp Bespoke Work' });
  await replay({ taskId: 'task1' });
  reportUpdates.length = 0;

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.testing_type, 'Unknown');
  assert.strictEqual(res.body.report_name, 'Black Box | August 2026');
  assert.deepStrictEqual(reportUpdates.filter(u => u.name), []);
  // The stored testing type is preserved, so a later rename still diffs correctly.
  const mapping = await store.findByTaskId('task2');
  assert.strictEqual(mapping.testing_type, 'Black Box');
  assert.strictEqual(mapping.task_name, 'Acme Corp Bespoke Work');
});

test('announces the move and flags the source task\'s form for tidy-up', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2' });
  await replay({ taskId: 'task1' });
  notices.length = 0;

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  const notice = notices.find(n => n.includes('remapped'));
  assert.ok(notice, `no remap notice posted: ${JSON.stringify(notices)}`);
  assert.ok(notice.includes('task2'), notice);
  assert.match(notice, /withdraw it in the portal/);
  assert.match(res.body.manual_followup, /authformlink/);
});

test('re-arms the start-date watcher when the target task has no start date', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2', start_date: null, due_date: null });
  await replay({ taskId: 'task1' });

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.body.start_date_pending, true);
  // The watcher polls mapping.clickup_task_id, which is now the target task, so the
  // fallback month in the report name gets corrected once ClickUp has a start date.
  assert.strictEqual((await store.findByTaskId('task2')).start_date_pending, true);
});

test('leaves the start-date flag clear when the target task is dated', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2' });
  await replay({ taskId: 'task1' });

  const res = await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  assert.strictEqual(res.body.start_date_pending, false);
  assert.strictEqual((await store.findByTaskId('task2')).start_date_pending, false);
});

test('a remapped report can be remapped on again', async () => {
  tasks.task1 = PENTEST_TASK();
  tasks.task2 = PENTEST_TASK({ id: 'task2' });
  tasks.task3 = PENTEST_TASK({ id: 'task3' });
  await replay({ taskId: 'task1' });
  await remap({ fromTaskId: 'task1', toTaskId: 'task2' });
  const res = await remap({ fromTaskId: 'task2', toTaskId: 'task3' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await store.findByTaskId('task3')).remapped_from, 'task2');
});

// ── Inspect ───────────────────────────────────────────────────────────────────
console.log('\nInspect:');

test('reports the pipeline, the parsed name and the mapping', async () => {
  tasks.task1 = PENTEST_TASK();
  const created = await replay({ taskId: 'task1' });
  const res = await request('GET', '/tasks/task1');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.pipeline, 'pentest');
  assert.strictEqual(res.body.monitored, true);
  assert.strictEqual(res.body.parsed.client_name, 'Acme Corp');
  assert.strictEqual(String(res.body.mapping.plextrac_report_id), String(created.body.report_id));
  assert.ok(res.body.mapping.report_url.includes('test.plextrac.com'));
});

test('reports an unmapped task without a mapping', async () => {
  tasks.task1 = PENTEST_TASK();
  const res = await request('GET', '/tasks/task1');
  assert.strictEqual(res.body.mapping, null);
});

test('reports why an unmonitored task is ignored', async () => {
  tasks.task1 = PENTEST_TASK({ space: { id: 'other-space', name: 'Sales' } });
  const res = await request('GET', '/tasks/task1');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.monitored, false);
  assert.match(res.body.detail, /outside the monitored spaces/);
});

// ── Run ───────────────────────────────────────────────────────────────────────

server.listen(0, async () => {
  await runQueue();
  server.close();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
