const assert  = require('assert');
const http    = require('http');
const express = require('express');

// The router's auth middleware and the portal check read these at request time.
process.env.DELIVERYFLOW_API_KEY = 'df-key';
process.env.AVAILABILITY_API_KEY = 'avail-key';
process.env.SECURE_PORTAL_URL = 'https://portal.test';

// ── Stub the portal and the store BEFORE the router is required ────────────────
// routes/deliveryflow destructures createAuthForm on import, so the fake must be in
// place first.
const portal = require('../lib/secure-portal-api');
const store  = require('../lib/deliveryflow-store');
const plextracClient = require('../pipeline/plextrac-client');
const plextracReport = require('../pipeline/plextrac-report');
const log    = require('../lib/logger');

// Plextrac: clients by lower-cased name, reports by client id → name. 'Plex Fail Ltd'
// fails the client lookup; reportMode 'throw' fails the report create.
const plextracClients = { 'existing corp': 7 };
const plextracReports = {}; // clientId -> { name -> reportId }
let nextClientId = 100, nextReportId = 500;
let reportMode = 'ok';
const reportCalls = [];
plextracClient.findOrCreateClient = async (name) => {
  if (name === 'Plex Fail Ltd') throw new Error('Plextrac 500 listClients');
  const key = name.toLowerCase();
  if (plextracClients[key]) return { clientId: plextracClients[key], clientCreated: false };
  plextracClients[key] = nextClientId++;
  return { clientId: plextracClients[key], clientCreated: true };
};
plextracReport.createPlextracReport = async (clientId, opts) => {
  reportCalls.push({ clientId, ...opts });
  if (reportMode === 'throw') throw new Error('Template resolution failed | Report template not found');
  const byName = (plextracReports[clientId] ||= {});
  if (byName[opts.name]) return { name: opts.name, reportId: byName[opts.name], reportCuid: null, existed: true };
  byName[opts.name] = nextReportId++;
  return { name: opts.name, reportId: byName[opts.name], reportCuid: `cuid-${byName[opts.name]}`, existed: false };
};

const notices = [];
log.notify = (message) => { notices.push(message); };

const portalError = (status, message) => Object.assign(new Error(message), { status });

const portalCalls = [];   // recorded createAuthForm payloads
const forms = {};         // clickupTaskId -> { formUrl, formToken } (portal-side idempotency)
// 'ok' | 'throw' | 'no-url' | 'no-files' (no link from either call) |
// 'intake-no-files' (only the standalone call mints one) | 'bad-type' (400)
let portalMode = 'ok';
portal.createAuthForm = async (payload) => {
  portalCalls.push(payload);
  if (portalMode === 'throw') throw new Error('Secure portal 500 POST /api/clickup/auth-form: boom');
  if (portalMode === 'bad-type') throw portalError(400, 'Secure portal 400 POST /api/clickup/auth-form: {"code":"unknown_test_type"}');
  if (portalMode === 'no-url') return { ok: true };
  const existed = Boolean(forms[payload.clickupTaskId]);
  forms[payload.clickupTaskId] ||= { formUrl: `https://portal.test/f/${payload.clickupTaskId}`, formToken: `tok-${payload.clickupTaskId}` };
  const noFiles = portalMode === 'no-files' || portalMode === 'intake-no-files';
  return {
    ok: true,
    created: !existed,
    ...forms[payload.clickupTaskId],
    ...(noFiles ? {} : { testFilesUrl: `https://portal.test/u/${payload.clickupTaskId}`, testFilesToken: 'ft-1' }),
  };
};
portal.createTestFilesLink = async (payload) => {
  if (portalMode === 'no-files') throw portalError(500, 'Secure portal 500 POST /api/clickup/test-files: boom');
  return { ok: true, created: true, testFilesUrl: `https://portal.test/u/${payload.clickupTaskId}`, testFilesToken: 'ft-2' };
};

// Re-scope: 'ok' | 'signed' (409) | 'missing' (404) | 'unchanged-false' (updated:false)
const updateCalls = [];
let updateMode = 'ok';
portal.updateAuthForm = async (payload) => {
  updateCalls.push(payload);
  if (updateMode === 'signed') throw portalError(409, 'Secure portal 409: form_signed');
  if (updateMode === 'missing') throw portalError(404, 'Secure portal 404: form_not_found');
  if (updateMode === 'unchanged-false') return { ok: true, updated: false, reason: 'another task holds the other Black Box tier', formUrl: `https://portal.test/f/${payload.clickupTaskId}` };
  return { ok: true, updated: true, formUrl: `https://portal.test/f/${payload.clickupTaskId}-v2`, formToken: `tok-${payload.clickupTaskId}-v2` };
};

// Plextrac report renames, and the ClickUp client-rename helper the route reuses.
const plextracApi = require('../lib/plextrac-api');
const reportNames = {};   // reportId -> current name (defaults to what createPlextracReport made)
const reportUpdates = [];
plextracApi.getReport = async (clientId, reportId) => ({ name: reportNames[reportId] });
// The report namer reads the client's reports to spot a clash.
plextracApi.listClientReports = async (clientId) =>
  Object.entries(plextracReports[clientId] || {}).map(([name, id]) => ({ id, name }));
// ClickUp mappings the namer checks a clashing report against: reportId -> task id.
const clickupMappings = {};
require('../lib/task-store').findByReportId = async (id) =>
  (clickupMappings[id] ? { clickup_task_id: clickupMappings[id] } : null);
plextracApi.updateReport = async (clientId, reportId, payload) => {
  reportUpdates.push({ reportId, payload });
  if (payload.name) reportNames[reportId] = payload.name;
};
const clientRenames = [];
require('../pipeline/task-rename').syncClientName = async (mapping, newName, label, opts) => {
  clientRenames.push({ clientId: mapping.plextrac_client_id, newName, ...opts });
  return true;
};

// Mirrors lib/deliveryflow-store.js: snake_case fields; dates, the engagement URL,
// consultants and the test-files link are only overwritten when a value is sent.
const records = {};       // engagement_id -> saved record
let storeMode = 'ok';     // 'ok' | 'read-fail' | 'write-fail' | 'report-write-fail'
store.findByEngagementId = async (id) => {
  if (storeMode === 'read-fail') throw new Error('mongo down');
  return records[id] || null;
};
store.saveReport = async (rec) => {
  if (storeMode === 'report-write-fail') throw new Error('mongo down');
  records[rec.engagementId] = {
    ...records[rec.engagementId], engagement_id: rec.engagementId, deal_id: rec.dealId,
    ...(rec.lineId ? { line_id: rec.lineId } : {}), ...(rec.lineLabel ? { line_label: rec.lineLabel } : {}),
    client_name: rec.clientName, test_type: rec.testType, scope: rec.scope ?? null,
    plextrac_type: rec.plextracType ?? rec.testType,
    plextrac_client_id: rec.plextracClientId, plextrac_report_id: rec.plextracReportId,
    plextrac_report_cuid: rec.plextracReportCuid, report_name: rec.reportName,
    start_date_pending: rec.startDatePending,
  };
  reportNames[rec.plextracReportId] = rec.reportName;
};
store.saveAuthForm = async (rec) => {
  if (storeMode === 'write-fail') throw new Error('mongo down');
  records[rec.engagementId] = {
    ...records[rec.engagementId],
    engagement_id: rec.engagementId, deal_id: rec.dealId,
    ...(rec.lineId ? { line_id: rec.lineId } : {}), ...(rec.lineLabel ? { line_label: rec.lineLabel } : {}),
    client_name: rec.clientName, test_type: rec.testType, scope: rec.scope ?? null,
    form_url: rec.formUrl, form_token: rec.formToken ?? null,
    form_client_name: rec.formClientName ?? rec.clientName, form_test_type: rec.formTestType ?? rec.testType,
    ...(rec.engagementUrl ? { engagement_url: rec.engagementUrl } : {}),
    ...(rec.replaceDates
      ? { start_date: rec.startDate ?? null, end_date: rec.endDate ?? null }
      : {
        ...(rec.startDate != null ? { start_date: rec.startDate } : {}),
        ...(rec.endDate != null ? { end_date: rec.endDate } : {}),
      }),
    ...(Array.isArray(rec.consultantEmails) ? { consultant_emails: rec.consultantEmails, consultant: null } : {}),
    ...(rec.engagementCost != null ? { engagement_cost: rec.engagementCost } : {}),
    ...(rec.testFilesUrl ? { test_files_url: rec.testFilesUrl, test_files_token: rec.testFilesToken ?? null } : {}),
  };
};
store.findByReportId = async (id) =>
  Object.values(records).find((r) => r.plextrac_report_id != null && String(r.plextrac_report_id) === String(id)) || null;
store.findByDealId = async (dealId) => Object.values(records).filter((r) => r.deal_id === String(dealId));
store.updateEngagement = async (id, set) => {
  if (!records[id]) return false;
  records[id] = { ...records[id], ...set };
  return true;
};

const router = require('../routes/deliveryflow');

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
    app.use('/api/deliveryflow', router);
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

const KEY = { 'X-API-Key': 'df-key' };
const PATH = '/api/deliveryflow/auth-form';
const valid = (over = {}) => ({
  engagementId: 'eng-1',
  dealId: '123456789',
  clientName: 'Acme Ltd',
  testType: 'Black Box',
  engagementUrl: 'https://deliveryflow.test/engagements/eng-1',
  startDate: '2026-10-05',
  endDate: '2026-10-07',
  ...over,
});

(async () => {
  console.log('POST /api/deliveryflow/auth-form:');

  await test('rejects a missing API key with 401', async () => {
    const r = await request(PATH, { body: valid() });
    assert.strictEqual(r.status, 401);
  });

  await test('rejects the portal\'s key (wrong secret) with 401', async () => {
    const r = await request(PATH, { headers: { 'X-API-Key': 'test-key' }, body: valid() });
    assert.strictEqual(r.status, 401);
  });

  await test('a set DELIVERYFLOW_API_KEY replaces AVAILABILITY_API_KEY', async () => {
    const r = await request(PATH, { headers: { 'X-API-Key': 'avail-key' }, body: valid() });
    assert.strictEqual(r.status, 401);
  });

  await test('with DELIVERYFLOW_API_KEY unset, AVAILABILITY_API_KEY is accepted', async () => {
    delete process.env.DELIVERYFLOW_API_KEY;
    try {
      // A bad body proves the request got past auth without creating anything.
      const ok = await request(PATH, { headers: { 'X-API-Key': 'avail-key' }, body: valid({ engagementId: undefined }) });
      assert.strictEqual(ok.status, 400);
      const old = await request(PATH, { headers: KEY, body: valid({ engagementId: undefined }) });
      assert.strictEqual(old.status, 401);
    } finally {
      process.env.DELIVERYFLOW_API_KEY = 'df-key';
    }
  });

  await test('401 when neither key is configured', async () => {
    delete process.env.DELIVERYFLOW_API_KEY;
    delete process.env.AVAILABILITY_API_KEY;
    try {
      const r = await request(PATH, { headers: { 'X-API-Key': 'avail-key' }, body: valid() });
      assert.strictEqual(r.status, 401);
    } finally {
      process.env.DELIVERYFLOW_API_KEY = 'df-key';
      process.env.AVAILABILITY_API_KEY = 'avail-key';
    }
  });

  for (const field of ['engagementId', 'dealId', 'clientName', 'testType']) {
    await test(`400 naming the field when ${field} is missing`, async () => {
      const r = await request(PATH, { headers: KEY, body: valid({ [field]: undefined }) });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.field, field);
    });
  }

  await test('400 on an unknown testType, listing the portal\'s types', async () => {
    const r = await request(PATH, { headers: KEY, body: valid({ testType: 'Underwater Basket Weaving' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'testType');
    assert.ok(r.json.error.includes('Paid Black Box Pentest'));
    assert.ok(r.json.error.includes('Code Review - White Box'));
    assert.ok(r.json.error.includes('VMaaS'));
  });

  await test('400 on a malformed date, and on endDate before startDate', async () => {
    let r = await request(PATH, { headers: KEY, body: valid({ startDate: '05/10/2026' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'startDate');
    r = await request(PATH, { headers: KEY, body: valid({ startDate: '2026-10-07', endDate: '2026-10-05' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'endDate');
  });

  await test('400 on an id with unsafe characters or a non-http engagementUrl', async () => {
    let r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng/1' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'engagementId');
    r = await request(PATH, { headers: KEY, body: valid({ engagementUrl: 'javascript:alert(1)' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'engagementUrl');
  });

  await test('creates client, report and form: 201, portal keyed on the engagement id, deal recorded', async () => {
    portalCalls.length = 0;
    reportCalls.length = 0;
    notices.length = 0;
    const r = await request(PATH, {
      headers: KEY,
      body: valid({ testType: 'black box', consultantEmails: ['Jane@Cognisys.group', 'jane@cognisys.group', 'raj@cognisys.group'] }),
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.created, true);
    assert.strictEqual(r.json.formUrl, 'https://portal.test/f/eng-1');
    assert.strictEqual(r.json.testFilesUrl, 'https://portal.test/u/eng-1');
    assert.strictEqual(r.json.dealId, '123456789');

    const sent = portalCalls[0];
    assert.strictEqual(sent.clickupTaskId, 'eng-1');
    assert.strictEqual(sent.engagementId, 'eng-1');
    assert.strictEqual(sent.dealId, '123456789');
    assert.strictEqual(sent.source, 'deliveryflow');
    assert.strictEqual(sent.testType, 'Black Box'); // normalised to the canonical casing
    assert.strictEqual(sent.clickupTaskUrl, 'https://deliveryflow.test/engagements/eng-1');
    assert.strictEqual(sent.startDate, Date.parse('2026-10-05T00:00:00Z'));
    assert.strictEqual(sent.endDate, Date.parse('2026-10-07T00:00:00Z'));

    assert.strictEqual(records['eng-1'].deal_id, '123456789');
    assert.strictEqual(records['eng-1'].form_url, 'https://portal.test/f/eng-1');

    // Plextrac: new client, report named like the ClickUp pipeline names it, and the
    // consultants (lower-cased, de-duplicated) as the report operators.
    const { plextrac } = r.json;
    assert.strictEqual(plextrac.status, 'created');
    assert.strictEqual(plextrac.clientCreated, true);
    assert.strictEqual(plextrac.reportName, 'Black Box | October 2026');
    assert.ok(plextrac.reportUrl.endsWith(`/client/${plextrac.clientId}/report/${plextrac.reportId}`));
    assert.strictEqual(plextrac.startDatePending, false);
    assert.deepStrictEqual(reportCalls[0].operatorEmails, ['jane@cognisys.group', 'raj@cognisys.group']);
    assert.strictEqual(reportCalls[0].startDateMs, Date.parse('2026-10-05T00:00:00Z'));
    assert.strictEqual(reportCalls[0].endDateMs, Date.parse('2026-10-07T00:00:00Z'));
    assert.strictEqual(sent.plextracClientId, plextrac.clientId);
    assert.strictEqual(sent.plextracReportId, plextrac.reportId);
    assert.strictEqual(records['eng-1'].plextrac_report_id, plextrac.reportId);
    assert.strictEqual(records['eng-1'].plextrac_report_cuid, `cuid-${plextrac.reportId}`);

    // The same Slack notice the ClickUp pipeline posts, with the form link.
    assert.strictEqual(notices.length, 1);
    assert.ok(notices[0].includes('Report has been created for Acme Ltd'));
    assert.ok(notices[0].includes('Client was created.'));
    assert.ok(notices[0].includes('https://portal.test/f/eng-1'));
  });

  await test('a numeric dealId is accepted and treated as a string', async () => {
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-num', dealId: 987654321 }) });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.dealId, '987654321');
  });

  await test('a repeat call reuses the linked report and returns the same form with 200', async () => {
    reportCalls.length = 0;
    notices.length = 0;
    const r = await request(PATH, { headers: KEY, body: valid() });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.created, false);
    assert.strictEqual(r.json.formUrl, 'https://portal.test/f/eng-1');
    assert.strictEqual(r.json.plextrac.status, 'already_linked');
    assert.strictEqual(r.json.plextrac.reportId, records['eng-1'].plextrac_report_id);
    assert.strictEqual(reportCalls.length, 0, 'no second report');
    assert.strictEqual(notices.length, 0, 'no second Slack notice');
  });

  await test('an existing Plextrac client is reused, and the scope goes into the report name', async () => {
    const r = await request(PATH, {
      headers: KEY,
      body: valid({ engagementId: 'eng-scope', clientName: 'Existing Corp', testType: 'Web App', scope: 'Money Guru' }),
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.plextrac.clientId, 7);
    assert.strictEqual(r.json.plextrac.clientCreated, false);
    assert.strictEqual(r.json.plextrac.reportName, 'Web App (Money Guru) | October 2026');
  });

  await test('a same-named report already in Plextrac is reported but not linked', async () => {
    notices.length = 0;
    // Same client, type, scope and month as eng-scope, so the report name collides.
    const r = await request(PATH, {
      headers: KEY,
      body: valid({ engagementId: 'eng-dup', clientName: 'Existing Corp', testType: 'Web App', scope: 'Money Guru' }),
    });
    assert.strictEqual(r.status, 201); // the form is still new
    assert.strictEqual(r.json.plextrac.status, 'report_exists');
    assert.strictEqual(r.json.plextrac.reportId, records['eng-scope'].plextrac_report_id);
    assert.strictEqual(records['eng-dup'].plextrac_report_id, undefined, 'must not adopt a report it did not create');
    assert.strictEqual(notices.length, 0, 'nothing new to announce');
  });

  await test('no startDate: report named for the current month and flagged pending', async () => {
    const r = await request(PATH, {
      headers: KEY,
      body: valid({ engagementId: 'eng-nodate', clientName: 'Gamma', startDate: null, endDate: null }),
    });
    assert.strictEqual(r.status, 201);
    const now = new Date();
    const month = now.toLocaleString('en-GB', { month: 'long' });
    assert.strictEqual(r.json.plextrac.reportName, `Black Box | ${month} ${now.getFullYear()}`);
    assert.strictEqual(r.json.plextrac.startDatePending, true);
    assert.strictEqual(records['eng-nodate'].start_date_pending, true);
  });

  await test('400 on consultantEmails that are not email addresses', async () => {
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-bad-mail', consultantEmails: ['jane'] }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'consultantEmails');
  });

  await test('422 on a blacklisted word, with nothing created and a Slack notice', async () => {
    portalCalls.length = 0;
    reportCalls.length = 0;
    notices.length = 0;
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-bl', clientName: 'Acme Retest' }) });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'blacklisted');
    assert.strictEqual(r.json.word, 'retest');
    assert.strictEqual(reportCalls.length, 0);
    assert.strictEqual(portalCalls.length, 0);
    assert.ok(notices[0].includes('Blacklisted word detected - retest'));
  });

  await test('502 at the client stage when Plextrac fails, before the portal is called', async () => {
    portalCalls.length = 0;
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-pcf', clientName: 'Plex Fail Ltd' }) });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.stage, 'plextrac_client');
    assert.strictEqual(portalCalls.length, 0);
  });

  await test('502 at the report stage when the report cannot be created', async () => {
    portalCalls.length = 0;
    reportMode = 'throw';
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-prf', clientName: 'Delta' }) });
    reportMode = 'ok';
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.stage, 'plextrac_report');
    assert.ok(r.json.error.includes('Template resolution failed'));
    assert.strictEqual(portalCalls.length, 0);
    assert.strictEqual(records['eng-prf'], undefined);
  });

  await test('500 naming the report when it was created but could not be recorded', async () => {
    storeMode = 'report-write-fail';
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-rwf', clientName: 'Epsilon' }) });
    storeMode = 'ok';
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.stage, 'store');
    assert.ok(r.json.plextrac.reportId);
  });

  await test('409 deal_id_conflict when the engagement is already on another deal', async () => {
    portalCalls.length = 0;
    const r = await request(PATH, { headers: KEY, body: valid({ dealId: 'other-deal' }) });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'deal_id_conflict');
    assert.strictEqual(r.json.existingDealId, '123456789');
    assert.strictEqual(portalCalls.length, 0, 'the portal must not be called');
    assert.strictEqual(records['eng-1'].deal_id, '123456789');
  });

  await test('VMaaS skips Plextrac entirely; optional fields may be omitted', async () => {
    portalCalls.length = 0;
    reportCalls.length = 0;
    const r = await request(PATH, {
      headers: KEY,
      body: { engagementId: 'eng-vm', dealId: 'd-2', clientName: 'Beta', testType: 'vmaas' },
    });
    assert.strictEqual(r.status, 201);
    const sent = portalCalls[0];
    assert.strictEqual(sent.testType, 'VMaaS');
    assert.strictEqual(sent.startDate, null);
    assert.strictEqual(sent.clickupTaskUrl, null);
    assert.strictEqual(sent.plextracClientId, null);
    assert.strictEqual(r.json.plextrac.status, 'skipped');
    assert.strictEqual(reportCalls.length, 0);
  });

  await test('the form still returns when the portal mints no test-files link', async () => {
    portalMode = 'no-files';
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-nf' }) });
    portalMode = 'ok';
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.testFilesUrl, null);
  });

  await test('502 when the portal fails; the report stays linked and a retry reuses it', async () => {
    portalMode = 'throw';
    notices.length = 0;
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-pf', clientName: 'Zeta' }) });
    portalMode = 'ok';
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.stage, 'auth_form');
    assert.strictEqual(r.json.plextrac.status, 'created');
    assert.strictEqual(records['eng-pf'].plextrac_report_id, r.json.plextrac.reportId);
    assert.strictEqual(records['eng-pf'].form_url, undefined);
    assert.strictEqual(notices.length, 1, 'the new report is still announced');
    assert.ok(!notices[0].includes('Auth form'));

    reportCalls.length = 0;
    const retry = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-pf', clientName: 'Zeta' }) });
    assert.strictEqual(retry.status, 201);
    assert.strictEqual(retry.json.plextrac.status, 'already_linked');
    assert.strictEqual(retry.json.plextrac.reportId, r.json.plextrac.reportId);
    assert.strictEqual(reportCalls.length, 0);
  });

  await test('502 when the portal answers without a form URL', async () => {
    portalMode = 'no-url';
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-nu' }) });
    portalMode = 'ok';
    assert.strictEqual(r.status, 502);
  });

  await test('500 (retryable) when the deal cannot be recorded', async () => {
    storeMode = 'write-fail';
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-wf' }) });
    storeMode = 'ok';
    assert.strictEqual(r.status, 500);
    assert.ok(r.json.error.includes('safe to retry'));
  });

  await test('500 without calling the portal when the record cannot be read', async () => {
    portalCalls.length = 0;
    storeMode = 'read-fail';
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-rf' }) });
    storeMode = 'ok';
    assert.strictEqual(r.status, 500);
    assert.strictEqual(portalCalls.length, 0);
  });

  await test('503 when the portal is not configured', async () => {
    const saved = process.env.SECURE_PORTAL_URL;
    delete process.env.SECURE_PORTAL_URL;
    const r = await request(PATH, { headers: KEY, body: valid({ engagementId: 'eng-np' }) });
    process.env.SECURE_PORTAL_URL = saved;
    assert.strictEqual(r.status, 503);
  });

  // ── Repeat calls: DeliveryFlow changed the engagement ─────────────────────
  console.log('\nRepeat calls for a changed engagement:');

  const reset = () => {
    notices.length = 0; reportUpdates.length = 0; updateCalls.length = 0;
    clientRenames.length = 0; portalCalls.length = 0; reportCalls.length = 0;
    updateMode = 'ok'; portalMode = 'ok';
  };
  const setUp = (over) => request(PATH, { headers: KEY, body: valid(over) });

  await test('a testing type change re-scopes the form and renames the report', async () => {
    reset();
    await setUp({ engagementId: 'eng-ch1', clientName: 'Change Co', testType: 'Black Box' });
    reset();
    const r = await setUp({ engagementId: 'eng-ch1', clientName: 'Change Co', testType: 'Grey Box' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.changes, [{ field: 'testType', from: 'Black Box', to: 'Grey Box' }]);
    assert.strictEqual(r.json.formRescope, 'rescoped');
    assert.strictEqual(r.json.formUrl, 'https://portal.test/f/eng-ch1-v2');

    // The portal is told what the form was for, so it can drop exactly that element.
    assert.strictEqual(updateCalls[0].previousTestType, 'Black Box');
    assert.strictEqual(updateCalls[0].testType, 'Grey Box');
    assert.strictEqual(portalCalls.length, 0, 'no second form created');

    assert.strictEqual(r.json.plextrac.reportRenamed, true);
    assert.strictEqual(r.json.plextrac.reportName, 'Grey Box | October 2026');
    assert.strictEqual(reportCalls.length, 0, 'no second report');
    assert.strictEqual(records['eng-ch1'].form_test_type, 'Grey Box');
    assert.strictEqual(records['eng-ch1'].report_name, 'Grey Box | October 2026');
    assert.ok(notices.some((n) => n.includes('re-scoped')));
    assert.ok(notices.some((n) => n.includes('report renamed')));
  });

  await test('a client name change renames the Plextrac client (via the ClickUp rules) and re-scopes', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-ch1', clientName: 'Change Company Ltd', testType: 'Grey Box' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(clientRenames[0].newName, 'Change Company Ltd');
    assert.strictEqual(clientRenames[0].oldClientName, 'Change Co');
    assert.strictEqual(clientRenames[0].source, 'DeliveryFlow');
    assert.strictEqual(updateCalls[0].previousClientName, 'Change Co');
    assert.strictEqual(r.json.plextrac.reportRenamed, false, 'type and scope unchanged');
  });

  await test('a scope change renames the report but leaves the form alone', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-ch1', clientName: 'Change Company Ltd', testType: 'Grey Box', scope: 'Portal' });
    assert.strictEqual(r.json.plextrac.reportName, 'Grey Box (Portal) | October 2026');
    assert.strictEqual(r.json.formRescope, 'not_needed');
    assert.strictEqual(updateCalls.length, 0);
  });

  await test('the same call again changes nothing', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-ch1', clientName: 'Change Company Ltd', testType: 'Grey Box', scope: 'Portal' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changes, undefined);
    assert.strictEqual(updateCalls.length + reportUpdates.length + clientRenames.length + notices.length, 0);
  });

  await test('a signed form is never rewritten: Slack is told and the old scope is kept on record', async () => {
    reset();
    await setUp({ engagementId: 'eng-signed', clientName: 'Signed Ltd', testType: 'External' });
    reset();
    updateMode = 'signed';
    const r = await setUp({ engagementId: 'eng-signed', clientName: 'Signed Ltd', testType: 'Internal' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.formRescope, 'refused');
    assert.strictEqual(r.json.formUrl, 'https://portal.test/f/eng-signed');
    assert.ok(notices.some((n) => n.includes('already been signed')));
    assert.strictEqual(records['eng-signed'].test_type, 'Internal');
    assert.strictEqual(records['eng-signed'].form_test_type, 'External', 'the live form is still External');
  });

  await test('no open form to re-scope: a new one is created at the new scope', async () => {
    reset();
    await setUp({ engagementId: 'eng-gone', clientName: 'Gone Ltd', testType: 'External' });
    reset();
    updateMode = 'missing';
    const r = await setUp({ engagementId: 'eng-gone', clientName: 'Gone Ltd', testType: 'Internal' });
    assert.strictEqual(r.json.formRescope, 'recreated');
    assert.strictEqual(portalCalls.length, 1);
    assert.strictEqual(portalCalls[0].testType, 'Internal');
  });

  await test('a first startDate renames a pending report for that month and fills in its dates', async () => {
    reset();
    await setUp({ engagementId: 'eng-late', clientName: 'Late Ltd', startDate: null, endDate: null });
    reset();
    const r = await setUp({ engagementId: 'eng-late', clientName: 'Late Ltd', startDate: '2026-12-07', endDate: '2026-12-09' });
    assert.strictEqual(r.json.plextrac.reportName, 'Black Box | December 2026');
    assert.strictEqual(r.json.plextrac.startDatePending, false);
    assert.strictEqual(reportUpdates[0].payload.start_date, '2026-12-07T00:00:00.000Z');
    assert.strictEqual(records['eng-late'].start_date_pending, false);
    assert.strictEqual(records['eng-late'].start_date, Date.parse('2026-12-07T00:00:00Z'));
  });

  await test('a call without dates keeps the dates already on record', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-late', clientName: 'Late Ltd', startDate: null, endDate: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(records['eng-late'].start_date, Date.parse('2026-12-07T00:00:00Z'));
  });

  await test('422 when the portal does not recognise the testing type', async () => {
    reset();
    portalMode = 'bad-type';
    const r = await setUp({ engagementId: 'eng-mcp', clientName: 'Mcp Ltd', testType: 'MCP Integration' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'test_type_not_on_auth_form');
    assert.strictEqual(r.json.stage, 'auth_form');
  });

  // ── The portal's own testing types ────────────────────────────────────────
  await test('a portal type goes to the portal exactly and names the report the ClickUp way', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-pt1', clientName: 'Portal Types Ltd', testType: 'paid black box pentest' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(portalCalls[0].testType, 'Paid Black Box Pentest', 'exact portal name, canonical casing');
    assert.strictEqual(reportCalls[0].testingType, 'Black Box', 'template chosen from the Plextrac type');
    assert.strictEqual(r.json.plextrac.reportName, 'Black Box | October 2026');
    assert.strictEqual(records['eng-pt1'].test_type, 'Paid Black Box Pentest');
    assert.strictEqual(records['eng-pt1'].plextrac_type, 'Black Box');
  });

  await test('a portal type break.services has no name for uses the portal name for the report', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-pt2', clientName: 'Portal Types Ltd', testType: 'Red Team' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(portalCalls[0].testType, 'Red Team');
    assert.strictEqual(r.json.plextrac.reportName, 'Red Team | October 2026');
  });

  await test('Signature Only and VMaaS Web App Scanning get a form but no Plextrac report', async () => {
    for (const [id, type] of [['eng-sig', 'Signature Only'], ['eng-vws', 'VMaaS Web App Scanning']]) {
      reset();
      const r = await setUp({ engagementId: id, clientName: 'No Report Ltd', testType: type });
      assert.strictEqual(r.status, 201, type);
      assert.strictEqual(r.json.plextrac.status, 'skipped', type);
      assert.strictEqual(reportCalls.length, 0, type);
      assert.strictEqual(portalCalls[0].testType, type);
    }
  });

  await test('changing between portal types renames the report from the Plextrac types', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-pt1', clientName: 'Portal Types Ltd', testType: 'Grey Box Web App' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(updateCalls[0].previousTestType, 'Paid Black Box Pentest');
    assert.strictEqual(updateCalls[0].testType, 'Grey Box Web App');
    assert.strictEqual(r.json.plextrac.reportName, 'Grey Box | October 2026');
    assert.strictEqual(records['eng-pt1'].plextrac_type, 'Grey Box');
  });

  // ── Free or paid Black Box, from engagementCost ───────────────────────────
  await test('a £0 Black Box is the Free Black Box Web App', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-bb0', clientName: 'Cost Ltd', testType: 'Black Box', engagementCost: 0 });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.testType, 'Free Black Box Web App');
    assert.deepStrictEqual(r.json.blackBox, { tier: 'free', decidedBy: 'engagementCost', requestedTestType: 'Black Box' });
    assert.strictEqual(portalCalls[0].testType, 'Free Black Box Web App');
    assert.strictEqual(r.json.plextrac.reportName, 'Free Black Box Test | October 2026');
    assert.strictEqual(records['eng-bb0'].engagement_cost, 0);
    assert.strictEqual(notices.filter((n) => n.includes('Please check the engagement')).length, 0, 'nothing contradicted');
  });

  await test('a priced Black Box is the Paid Black Box Pentest (cost as a £ string too)', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-bb1', clientName: 'Cost Ltd', testType: 'Black Box', engagementCost: '£1,250.50' });
    assert.strictEqual(r.json.testType, 'Paid Black Box Pentest');
    assert.strictEqual(r.json.blackBox.tier, 'paid');
    assert.strictEqual(r.json.plextrac.reportName, 'Black Box | October 2026');
    assert.strictEqual(records['eng-bb1'].engagement_cost, 1250.5);
  });

  await test('the cost overrides a contradicting tier, and Slack is asked to check it', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-bb2', clientName: 'Mislabelled Ltd', testType: 'Paid Black Box Pentest', engagementCost: 0 });
    assert.strictEqual(r.json.testType, 'Free Black Box Web App');
    assert.ok(notices.some((n) => n.includes('sent "Paid Black Box Pentest" for Mislabelled Ltd') && n.includes('£0')));
  });

  await test('without a cost the Black Box name sent is used as it is', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-bb3', clientName: 'Cost Ltd', testType: 'Free Black Box Web App' });
    assert.strictEqual(r.json.testType, 'Free Black Box Web App');
    assert.deepStrictEqual(r.json.blackBox, { tier: null, decidedBy: 'testType', requestedTestType: 'Free Black Box Web App' });
  });

  await test('a price change on a repeat call moves the engagement to the other tier', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-bb0', clientName: 'Cost Ltd', testType: 'Black Box', engagementCost: 2400 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.testType, 'Paid Black Box Pentest');
    assert.deepStrictEqual(r.json.changes, [{ field: 'testType', from: 'Free Black Box Web App', to: 'Paid Black Box Pentest' }]);
    assert.strictEqual(updateCalls[0].previousTestType, 'Free Black Box Web App');
    assert.strictEqual(r.json.plextrac.reportName, 'Black Box | October 2026');
  });

  await test('other testing types keep their type and just record the cost', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-ext-c', clientName: 'Cost Ltd', testType: 'External', engagementCost: 3000 });
    assert.strictEqual(r.json.testType, 'External');
    assert.strictEqual(r.json.blackBox, undefined);
    assert.strictEqual(records['eng-ext-c'].engagement_cost, 3000);
  });

  await test('400 on a negative or non-numeric cost', async () => {
    for (const engagementCost of [-5, 'free', '12abc']) {
      const r = await setUp({ engagementId: 'eng-badcost', testType: 'Black Box', engagementCost });
      assert.strictEqual(r.status, 400, String(engagementCost));
      assert.strictEqual(r.json.field, 'engagementCost');
    }
  });

  // ── POST /auth-form/update: the test selector changed ─────────────────────
  const U = '/api/deliveryflow/auth-form/update';
  const update = (b) => request(U, { headers: KEY, body: b });

  await test('update: 400 without the new type, 404 for an engagement never set up, 401 without the key', async () => {
    reset();
    assert.strictEqual((await update({ engagementId: 'eng-up1' })).status, 400);
    const r = await update({ engagementId: 'nope-1', testType: 'Internal' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json.error, 'unknown_engagement');
    assert.strictEqual((await request(U, { body: { engagementId: 'eng-up1', testType: 'Internal' } })).status, 401);
  });

  await test('update: the old type\'s element is swapped for the new one and the report renamed', async () => {
    reset();
    await setUp({ engagementId: 'eng-up1', clientName: 'Update Ltd', testType: 'External' });
    reset();
    const r = await update({ engagementId: 'eng-up1', previousTestType: 'External', testType: 'Internal' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changed, true);
    assert.strictEqual(r.json.previousTestType, 'External');
    assert.strictEqual(r.json.testType, 'Internal');
    assert.strictEqual(r.json.formRescope, 'rescoped');
    assert.strictEqual(updateCalls[0].previousTestType, 'External');
    assert.strictEqual(updateCalls[0].testType, 'Internal');
    assert.strictEqual(updateCalls[0].clientName, 'Update Ltd', 'the rest comes from the record');
    assert.strictEqual(r.json.plextrac.reportName, 'Internal | October 2026');
    assert.strictEqual(records['eng-up1'].test_type, 'Internal');
    assert.strictEqual(records['eng-up1'].deal_id, '123456789');
    assert.strictEqual(records['eng-up1'].start_date, Date.parse('2026-10-05T00:00:00Z'), 'dates kept');
  });

  await test('update: the same type again changes nothing', async () => {
    reset();
    const r = await update({ engagementId: 'eng-up1', previousTestType: 'Internal', testType: 'Internal' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changed, false);
    assert.strictEqual(r.json.formRescope, 'not_needed');
    assert.strictEqual(updateCalls.length + reportUpdates.length, 0);
  });

  await test('update: what is on the form wins over a stale previousTestType', async () => {
    reset();
    const r = await update({ engagementId: 'eng-up1', previousTestType: 'Wireless', testType: 'External' });
    assert.strictEqual(r.json.previousTestType, 'Internal');
    assert.strictEqual(updateCalls[0].previousTestType, 'Internal');
  });

  await test('update: a signed form is not rewritten; the type still changes and Slack is told', async () => {
    reset();
    updateMode = 'signed';
    const r = await update({ engagementId: 'eng-up1', previousTestType: 'External', testType: 'Wireless' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.formRescope, 'refused');
    assert.ok(notices.some((n) => n.includes('already been signed')));
    assert.strictEqual(records['eng-up1'].test_type, 'Wireless');
    assert.strictEqual(records['eng-up1'].form_test_type, 'External');
  });

  await test('update: from VMaaS to a pentest creates the Plextrac report the new type needs', async () => {
    reset();
    await setUp({ engagementId: 'eng-up-vm', clientName: 'Scan Ltd', testType: 'VMaaS' });
    reset();
    const r = await update({ engagementId: 'eng-up-vm', previousTestType: 'VMaaS', testType: 'External' });
    assert.strictEqual(r.status, 201, 'the report is new');
    assert.strictEqual(r.json.plextrac.status, 'created');
    assert.strictEqual(r.json.plextrac.reportName, 'External | October 2026');
    assert.strictEqual(r.json.formRescope, 'rescoped');
  });

  await test('update: a Black Box choice is still tiered by the engagement cost', async () => {
    reset();
    await setUp({ engagementId: 'eng-up-bb', clientName: 'Tier Ltd', testType: 'External', engagementCost: 0 });
    reset();
    const r = await update({ engagementId: 'eng-up-bb', previousTestType: 'External', testType: 'Black Box' });
    assert.strictEqual(r.json.testType, 'Free Black Box Web App', 'recorded cost of £0');
    assert.strictEqual(updateCalls[0].testType, 'Free Black Box Web App');
  });

  await test('update: a form a PM linked in the portal is re-scoped, using previousTestType', async () => {
    reset();
    records['eng-up-pm'] = {
      engagement_id: 'eng-up-pm', form_url: 'https://portal.test/f/pm-form-2', form_token: 'pm2',
      form_source: 'portal', form_client_name: 'Hand Made Ltd',
    };
    const r = await update({
      engagementId: 'eng-up-pm', dealId: 'deal-77', previousTestType: 'Paid Black Box Pentest', testType: 'Grey Box Web App',
    });
    assert.strictEqual(r.json.formRescope, 'rescoped');
    assert.strictEqual(updateCalls[0].previousTestType, 'Paid Black Box Pentest');
    assert.strictEqual(updateCalls[0].clientName, 'Hand Made Ltd');
    assert.strictEqual(portalCalls.length, 0, 'no second form');
  });

  await test('update: a PM-linked engagement with no deal on record needs dealId', async () => {
    reset();
    records['eng-up-nodeal'] = { engagement_id: 'eng-up-nodeal', form_url: 'https://portal.test/f/x', form_source: 'portal', form_client_name: 'X Ltd' };
    const r = await update({ engagementId: 'eng-up-nodeal', testType: 'Internal' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'dealId');
  });

  await test('an engagement a PM linked to a portal form keeps that form', async () => {
    reset();
    records['eng-linked'] = {
      engagement_id: 'eng-linked', form_url: 'https://portal.test/f/pm-form', form_token: 'pm-tok',
      form_source: 'portal', form_client_name: 'Linked Ltd',
    };
    const r = await setUp({ engagementId: 'eng-linked', clientName: 'Linked Ltd', testType: 'External' });
    assert.strictEqual(r.status, 201, 'the Plextrac report is new');
    assert.strictEqual(r.json.formUrl, 'https://portal.test/f/pm-form');
    assert.strictEqual(portalCalls.length + updateCalls.length, 0, 'no second form generated');
    assert.strictEqual(r.json.plextrac.status, 'created');
    assert.strictEqual(records['eng-linked'].form_source, 'portal');
    assert.strictEqual(records['eng-linked'].deal_id, '123456789');
  });

  await test('a missing test-files link is fetched on its own', async () => {
    reset();
    portalMode = 'intake-no-files';
    const r = await setUp({ engagementId: 'eng-files', clientName: 'Files Ltd' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.testFilesUrl, 'https://portal.test/u/eng-files');
    assert.strictEqual(records['eng-files'].test_files_url, 'https://portal.test/u/eng-files');
  });

  // ── Deals, line items and report names ───────────────────────────────────
  console.log('\nDeals and line items:');

  await test('an engagement recorded under its line item moves onto the Deal ID, not a 409', async () => {
    reset();
    await setUp({ engagementId: 'eng-legacy', dealId: '4840277874', clientName: 'Legacy Deal Ltd' });
    assert.strictEqual(records['eng-legacy'].deal_id, '4840277874');
    reset();
    const r = await setUp({ engagementId: 'eng-legacy', dealId: '5143712084', lineId: '4840277874', clientName: 'Legacy Deal Ltd' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(records['eng-legacy'].deal_id, '5143712084');
    assert.strictEqual(records['eng-legacy'].line_id, '4840277874');
    assert.strictEqual(r.json.plextrac.status, 'already_linked', 'the same report, not a new one');
  });

  await test('a different deal that is not the line item is still refused with 409', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-legacy', dealId: '999', lineId: '4840277874', clientName: 'Legacy Deal Ltd' });
    assert.strictEqual(r.status, 409);
  });

  await test('the portal gets the line and the other engagements on the deal', async () => {
    reset();
    await setUp({ engagementId: 'eng-d1', dealId: 'deal-a10', lineId: 'A1001', clientName: 'Deal Co', testType: 'External' });
    reset();
    await setUp({ engagementId: 'eng-d2', dealId: 'deal-a10', lineId: 'A1004', clientName: 'Deal Co', testType: 'Internal' });
    const sent = portalCalls[0];
    assert.strictEqual(sent.dealId, 'deal-a10');
    assert.strictEqual(sent.lineId, 'A1004');
    assert.deepStrictEqual(sent.relatedEngagementIds, ['eng-d1']);
  });

  await test('two same-type engagements in one month: the second report is named for its line', async () => {
    reset();
    const a = await setUp({ engagementId: 'eng-api1', dealId: 'deal-pul', lineId: '481403878606', lineLabel: 'Pulsar: Application Testing', clientName: 'Pulsar Group', testType: 'API Testing', startDate: '2026-10-12', endDate: '2026-10-23' });
    assert.strictEqual(a.json.plextrac.reportName, 'API | October 2026', 'the first keeps the plain name');
    reset();
    const b = await setUp({ engagementId: 'eng-api2', dealId: 'deal-pul', lineId: '481403878607', lineLabel: 'Isentia: Application Penetration Testing', clientName: 'Pulsar Group', testType: 'API Testing', startDate: '2026-10-26', endDate: '2026-10-29' });
    assert.strictEqual(b.json.plextrac.status, 'created', 'a report of its own, linked');
    assert.strictEqual(b.json.plextrac.reportName, 'API (Isentia: Application Penetration Testing) | October 2026');
    assert.notStrictEqual(b.json.plextrac.reportId, a.json.plextrac.reportId);
    assert.strictEqual(records['eng-api2'].scope, 'Isentia: Application Penetration Testing');
  });

  await test('the qualifier settled on is kept on later calls that send no scope', async () => {
    reset();
    const r = await setUp({ engagementId: 'eng-api2', dealId: 'deal-pul', lineId: '481403878607', lineLabel: 'Isentia: Application Penetration Testing', clientName: 'Pulsar Group', testType: 'API Testing', startDate: '2026-10-26', endDate: '2026-10-29' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changes, undefined, 'no scope change detected');
    assert.strictEqual(reportUpdates.length, 0, 'the report is not renamed back');
  });

  await test('a call-off name with "|" is cleaned; no label falls back to the line id', async () => {
    reset();
    await setUp({ engagementId: 'eng-co1', dealId: 'deal-sg', lineId: '458713293003-E1', lineLabel: 'Smart Pension | HL', clientName: 'Smart Gaming', testType: 'External', startDate: '2026-09-14', endDate: '2026-09-20' });
    reset();
    const b = await setUp({ engagementId: 'eng-co3', dealId: 'deal-sg', lineId: '458713293003-E3', lineLabel: 'Smart Pensions | New Ireland', clientName: 'Smart Gaming', testType: 'External', startDate: '2026-09-25', endDate: '2026-09-30' });
    assert.strictEqual(b.json.plextrac.reportName, 'External (Smart Pensions - New Ireland) | September 2026');
    reset();
    const c = await setUp({ engagementId: 'eng-co4', dealId: 'deal-sg', lineId: '458713293003-E4', clientName: 'Smart Gaming', testType: 'External', startDate: '2026-09-27', endDate: '2026-09-28' });
    assert.strictEqual(c.json.plextrac.reportName, 'External (458713293003-E4) | September 2026');
  });

  await test('a clash with the report of a ClickUp task is qualified too', async () => {
    reset();
    const clientId = plextracClients['existing corp'];
    (plextracReports[clientId] ||= {})['Internal | November 2026'] = 4242;
    clickupMappings[4242] = 'cu-task-1';
    const r = await setUp({ engagementId: 'eng-vs-cu', dealId: 'deal-x', lineId: 'L-9', lineLabel: 'Internal Network Test', clientName: 'Existing Corp', testType: 'Internal', startDate: '2026-11-02', endDate: '2026-11-04' });
    assert.strictEqual(r.json.plextrac.status, 'created');
    assert.strictEqual(r.json.plextrac.reportName, 'Internal (Internal Network Test) | November 2026');
  });

  await test('consultants from DeliveryFlow replace the portal-booked name, and replaceDates clears dates', async () => {
    reset();
    records['eng-api1'].consultant = 'Old Booked Name';
    await setUp({ engagementId: 'eng-api1', dealId: 'deal-pul', lineId: '481403878606', clientName: 'Pulsar Group', testType: 'API Testing', consultantEmails: ['new@cognisys.group'], startDate: '2026-10-12', endDate: '2026-10-23' });
    assert.deepStrictEqual(records['eng-api1'].consultant_emails, ['new@cognisys.group']);
    assert.strictEqual(records['eng-api1'].consultant, null);
    reset();
    await setUp({ engagementId: 'eng-api1', dealId: 'deal-pul', lineId: '481403878606', clientName: 'Pulsar Group', testType: 'API Testing', consultantEmails: [], startDate: null, endDate: null, replaceDates: true });
    assert.deepStrictEqual(records['eng-api1'].consultant_emails, []);
    assert.strictEqual(records['eng-api1'].start_date, null);
    assert.strictEqual(records['eng-api1'].end_date, null);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
