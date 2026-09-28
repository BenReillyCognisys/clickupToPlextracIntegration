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
    client_name: rec.clientName, test_type: rec.testType, scope: rec.scope ?? null,
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
    client_name: rec.clientName, test_type: rec.testType, scope: rec.scope ?? null,
    form_url: rec.formUrl, form_token: rec.formToken ?? null,
    form_client_name: rec.formClientName ?? rec.clientName, form_test_type: rec.formTestType ?? rec.testType,
    ...(rec.engagementUrl ? { engagement_url: rec.engagementUrl } : {}),
    ...(rec.startDate != null ? { start_date: rec.startDate } : {}),
    ...(rec.endDate != null ? { end_date: rec.endDate } : {}),
    ...(rec.consultantEmails?.length ? { consultant_emails: rec.consultantEmails } : {}),
    ...(rec.testFilesUrl ? { test_files_url: rec.testFilesUrl, test_files_token: rec.testFilesToken ?? null } : {}),
  };
};
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

  await test('400 on an unknown testType, listing the allowed values', async () => {
    const r = await request(PATH, { headers: KEY, body: valid({ testType: 'Wireless' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'testType');
    assert.ok(r.json.error.includes('Black Box'));
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

  await test('a missing test-files link is fetched on its own', async () => {
    reset();
    portalMode = 'intake-no-files';
    const r = await setUp({ engagementId: 'eng-files', clientName: 'Files Ltd' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.testFilesUrl, 'https://portal.test/u/eng-files');
    assert.strictEqual(records['eng-files'].test_files_url, 'https://portal.test/u/eng-files');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
