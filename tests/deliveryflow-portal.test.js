const assert  = require('assert');
const http    = require('http');
const express = require('express');

// Read at request time by the routers and lib/deliveryflow-api.
process.env.BREAK_SERVICES_API_KEY = 'portal-key';
process.env.DELIVERYFLOW_API_KEY = 'df-key';
process.env.DELIVERYFLOW_EVENTS_URL = 'https://deliveryflow.test/events';

// ── Stubs, in place BEFORE the routers are required ───────────────────────────
const store = require('../lib/deliveryflow-store');
const deliveryflow = require('../lib/deliveryflow-api');
const plextrac = require('../lib/plextrac-api');
const slack = require('../lib/slack');
const log = require('../lib/logger');

// Engagement records, as the auth-form endpoint leaves them.
let records;
function resetRecords() {
  records = {
    'eng-1': {
      engagement_id: 'eng-1', deal_id: 'deal-9', client_name: 'Acme Ltd', test_type: 'Web App', scope: 'Money Guru',
      plextrac_client_id: 7, plextrac_report_id: 500, start_date_pending: true,
      engagement_url: 'https://deliveryflow.test/engagements/eng-1',
    },
    'eng-2': {
      engagement_id: 'eng-2', deal_id: 'deal-9', client_name: 'Acme Ltd', test_type: 'External',
      plextrac_client_id: 7, plextrac_report_id: 501, start_date_pending: false,
    },
    'eng-free': {
      engagement_id: 'eng-free', deal_id: 'deal-3', client_name: 'Beta', test_type: 'Free Black Box Test',
      plextrac_client_id: 8, plextrac_report_id: 502, start_date_pending: true,
    },
    'eng-vm': { engagement_id: 'eng-vm', deal_id: 'deal-4', client_name: 'Gamma', test_type: 'VMaaS' },
  };
}
resetRecords();

let storeMode = 'ok';
store.findByEngagementId = async (id) => {
  if (storeMode === 'read-fail') throw new Error('mongo down');
  return records[id] || null;
};
store.updateEngagement = async (id, set) => {
  if (!records[id]) return false;
  records[id] = { ...records[id], ...set };
  return true;
};

const events = [];          // forwarded { event, engagementId, dealId, data }
const failFor = new Set();  // engagement ids DeliveryFlow rejects
let dfMode = 'ok';          // 'ok' | 'throw'
deliveryflow.sendEvent = async (event, { engagementId, dealId }, data) => {
  if (dfMode === 'throw' || failFor.has(engagementId)) throw new Error('DeliveryFlow 500 ' + event);
  events.push({ event, engagementId, dealId, data });
  return { ok: true };
};

const reports = { 500: 'Web App (Money Guru) | September 2026', 502: 'Free Black Box Test | September 2026' };
const reportUpdates = [];
let plextracMode = 'ok';
plextrac.getReport = async (clientId, reportId) => {
  if (plextracMode === 'throw') throw new Error('Plextrac 500');
  return { name: reports[reportId] };
};
plextrac.updateReport = async (clientId, reportId, payload) => {
  reportUpdates.push({ clientId, reportId, payload });
  if (payload.name) reports[reportId] = payload.name;
};

const slackPosts = [];
let slackMode = 'ok';
slack.postMessage = async (channel, text) => {
  if (slackMode === 'throw') throw new Error('Slack API error: channel_not_found');
  slackPosts.push({ channel, text });
  return '1.0';
};

const notices = [];
log.notify = (message) => { notices.push(message); };

// The /clickup/* routes the portal already calls hand DeliveryFlow ids to the
// handlers above; the ClickUp side records what reached it instead of calling out.
const clickupApi = require('../lib/clickup-api');
const googleDrive = require('../lib/google-drive');
const clickupWrites = []; // { taskId, op }
let drivedownloads = 0;
let lookupMode = 'ok';    // 'ok' | 'throw'
store.findEngagementIds = async (ids) => {
  if (lookupMode === 'throw') throw new Error('mongo down');
  return new Set(ids.filter((id) => records[id]));
};
clickupApi.getTask = async (id) => ({
  id, name: 'Acme Ltd | External', status: { status: 'not started' }, checklists: [],
  custom_fields: [{ id: 'f-auth', name: 'Authorisation Forms', type: 'attachment' }],
});
clickupApi.uploadCustomFieldAttachment = async () => ({ id: 'att-1' });
clickupApi.setTaskCustomField = async (taskId) => { clickupWrites.push({ taskId, op: 'field' }); };
clickupApi.getTaskDescription = async () => '';
clickupApi.updateTaskDescription = async (taskId) => { clickupWrites.push({ taskId, op: 'description' }); };
clickupApi.updateTaskStatus = async (taskId) => { clickupWrites.push({ taskId, op: 'status' }); };
clickupApi.updateTaskSchedule = async (taskId) => { clickupWrites.push({ taskId, op: 'schedule' }); };
clickupApi.createTaskComment = async (taskId) => { clickupWrites.push({ taskId, op: 'comment' }); return 'c1'; };
clickupApi.listTaskComments = async () => [];
clickupApi.updateComment = async () => {};
googleDrive.downloadDriveFile = async () => {
  drivedownloads++;
  return {
    buffer: Buffer.from('%PDF'), filename: 'Signed form.pdf', mimeType: 'application/pdf',
    fileId: 'AbC123_x', canonicalUrl: 'https://drive.google.com/file/d/AbC123_x/view',
  };
};
process.env.CLICKUP_TEAM_ID = 'team-1';

// Mounted as index.js mounts them, so the per-route auth of each is exercised together.
const authFormRouter = require('../routes/deliveryflow');
const portalRouter = require('../routes/deliveryflow-portal');
const clickupRouter = require('../routes/clickup-actions');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

function request(path, { headers = { 'X-API-Key': 'portal-key' }, body } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/deliveryflow', authFormRouter);
    app.use('/api/deliveryflow', portalRouter);
    app.use('/clickup', clickupRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request({
        port, path, method: 'POST',
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

function reset() {
  resetRecords();
  events.length = 0;
  reportUpdates.length = 0;
  slackPosts.length = 0;
  notices.length = 0;
  failFor.clear();
  clickupWrites.length = 0;
  drivedownloads = 0;
  lookupMode = 'ok';
  dfMode = 'ok';
  plextracMode = 'ok';
  slackMode = 'ok';
  storeMode = 'ok';
  reports[500] = 'Web App (Money Guru) | September 2026';
  reports[502] = 'Free Black Box Test | September 2026';
}

const S = '/api/deliveryflow/schedule-task';

(async () => {
  console.log('DeliveryFlow portal callbacks:');

  // ── Auth and routing ──────────────────────────────────────────────────────
  await test('401 without the portal key; DeliveryFlow\'s key is not the portal\'s', async () => {
    reset();
    const none = await request(S, { headers: {}, body: { engagementId: 'eng-1', reportDeadline: '2026-11-01' } });
    assert.strictEqual(none.status, 401);
    const df = await request(S, { headers: { 'X-API-Key': 'df-key' }, body: { engagementId: 'eng-1', reportDeadline: '2026-11-01' } });
    assert.strictEqual(df.status, 401);
    assert.strictEqual(events.length, 0);
  });

  await test('the auth-form endpoint on the same prefix still takes only DeliveryFlow\'s key', async () => {
    const r = await request('/api/deliveryflow/auth-form', { body: {} });
    assert.strictEqual(r.status, 401);
    const withDf = await request('/api/deliveryflow/auth-form', { headers: { 'X-API-Key': 'df-key' }, body: {} });
    assert.strictEqual(withDf.status, 400, 'got past auth to validation');
  });

  await test('503 when DELIVERYFLOW_EVENTS_URL is not set', async () => {
    reset();
    delete process.env.DELIVERYFLOW_EVENTS_URL;
    try {
      const r = await request(S, { body: { engagementId: 'eng-1', reportDeadline: '2026-11-01' } });
      assert.strictEqual(r.status, 503);
    } finally {
      process.env.DELIVERYFLOW_EVENTS_URL = 'https://deliveryflow.test/events';
    }
  });

  // ── schedule-task ─────────────────────────────────────────────────────────
  await test('schedule-task: 400 without dates or a deadline, and on a bad id', async () => {
    reset();
    const r = await request(S, { body: { engagementId: 'eng-1' } });
    assert.strictEqual(r.status, 400);
    const bad = await request(S, { body: { engagementId: 'eng 1!', reportDeadline: '2026-11-01' } });
    assert.strictEqual(bad.status, 400);
    const noId = await request(S, { body: { reportDeadline: '2026-11-01' } });
    assert.strictEqual(noId.status, 400);
  });

  await test('schedule-task: 404 for an engagement break.services never set up', async () => {
    reset();
    const r = await request(S, { body: { clickupTaskId: '86c1ab2xy', startDate: '2026-10-05', endDate: '2026-10-07' } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json.error, 'unknown_engagement');
    assert.strictEqual(events.length, 0);
  });

  await test('schedule-task: forwards the booking and renames a pending report', async () => {
    reset();
    const r = await request(S, {
      body: {
        engagementId: 'eng-1', startDate: '2026-10-05', endDate: '2026-10-07', consultant: 'Jane Smith',
        testType: 'Web App', days: 3, reportDeadline: '2026-10-20', note: 'Avoid Fridays',
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.deliveryflow, 'sent');
    assert.strictEqual(r.json.plextrac, 'renamed');

    assert.strictEqual(events.length, 1);
    const e = events[0];
    assert.strictEqual(e.event, 'schedule_set');
    assert.strictEqual(e.dealId, 'deal-9');
    assert.deepStrictEqual(e.data, {
      startDate: '2026-10-05', endDate: '2026-10-07', consultant: 'Jane Smith', reportDeadline: '2026-10-20',
      days: 3, testType: 'Web App', clientNote: 'Avoid Fridays',
    });

    // Renamed with the scope, dates filled in, flag cleared, Slack told.
    assert.strictEqual(reportUpdates[0].payload.name, 'Web App (Money Guru) | October 2026');
    assert.strictEqual(reportUpdates[0].payload.start_date, '2026-10-05T00:00:00.000Z');
    assert.strictEqual(reportUpdates[0].payload.end_date, '2026-10-07T00:00:00.000Z');
    assert.strictEqual(records['eng-1'].start_date_pending, false);
    assert.strictEqual(records['eng-1'].start_date, Date.parse('2026-10-05T00:00:00Z'));
    assert.strictEqual(records['eng-1'].report_deadline, Date.parse('2026-10-20T00:00:00Z'));
    assert.ok(notices[0].includes('renamed from "Web App (Money Guru) | September 2026" to "Web App (Money Guru) | October 2026"'));
  });

  await test('schedule-task: a pending report already named for the booked month just gets its dates', async () => {
    reset();
    const r = await request(S, { body: { engagementId: 'eng-1', startDate: '2026-09-28', endDate: '2026-09-30' } });
    assert.strictEqual(r.json.plextrac, 'dates_set');
    assert.strictEqual(reportUpdates[0].payload.name, undefined);
    assert.strictEqual(notices.length, 0);
  });

  await test('schedule-task: a report created with dates is left alone; the clickupTaskId alias works', async () => {
    reset();
    const r = await request(S, { body: { clickupTaskId: 'eng-2', startDate: '2026-10-05', endDate: '2026-10-06' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.plextrac, 'not_pending');
    assert.strictEqual(reportUpdates.length, 0);
    assert.strictEqual(events[0].engagementId, 'eng-2');
  });

  await test('schedule-task: VMaaS has no report to touch', async () => {
    reset();
    const r = await request(S, { body: { engagementId: 'eng-vm', startDate: '2026-10-05', endDate: '2026-10-06' } });
    assert.strictEqual(r.json.plextrac, 'no_report');
  });

  await test('schedule-task: a deadline on its own is forwarded with no dates', async () => {
    reset();
    const r = await request(S, { body: { engagementId: 'eng-1', reportDeadline: '2026-11-01', consultant: 'Jane' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.plextrac, 'not_booked');
    assert.strictEqual(events[0].data.startDate, null);
    assert.strictEqual(events[0].data.consultant, null, 'no booking, nobody to assign');
    assert.strictEqual(events[0].data.reportDeadline, '2026-11-01');
    assert.strictEqual(records['eng-1'].start_date, undefined);
    assert.strictEqual(reportUpdates.length, 0);
  });

  await test('schedule-task: a Free Black Box is collapsed to one day', async () => {
    reset();
    const r = await request(S, { body: { engagementId: 'eng-free', startDate: '2026-10-05', endDate: '2026-10-06' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(events[0].data.endDate, '2026-10-05');
    assert.strictEqual(r.json.endDate, '2026-10-05');
  });

  await test('schedule-task: a repeat Free Black Box booking does not move the first', async () => {
    // eng-free was booked by the previous test.
    events.length = 0;
    const r = await request(S, { body: { engagementId: 'eng-free', startDate: '2026-10-12', endDate: '2026-10-12' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.skipped, true);
    assert.strictEqual(r.json.startDate, '2026-10-05');
    assert.strictEqual(events.length, 0, 'nothing new to tell DeliveryFlow');

    const withDeadline = await request(S, { body: { engagementId: 'eng-free', startDate: '2026-10-12', endDate: '2026-10-12', reportDeadline: '2026-10-30' } });
    assert.strictEqual(withDeadline.json.skipped, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.startDate, null, 'the booking is not resent');
    assert.strictEqual(events[0].data.reportDeadline, '2026-10-30');
    assert.strictEqual(records['eng-free'].start_date, Date.parse('2026-10-05T00:00:00Z'));
  });

  await test('schedule-task: 502 when DeliveryFlow fails, and nothing is recorded or renamed', async () => {
    reset();
    dfMode = 'throw';
    const r = await request(S, { body: { engagementId: 'eng-1', startDate: '2026-10-05', endDate: '2026-10-07' } });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.stage, 'deliveryflow');
    assert.strictEqual(records['eng-1'].start_date, undefined);
    assert.strictEqual(reportUpdates.length, 0);
  });

  await test('schedule-task: a Plextrac failure still answers 200 and leaves the report pending', async () => {
    reset();
    plextracMode = 'throw';
    const r = await request(S, { body: { engagementId: 'eng-1', startDate: '2026-10-05', endDate: '2026-10-07' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.plextrac, 'failed');
    assert.strictEqual(records['eng-1'].start_date_pending, true);
  });

  await test('schedule-task: 500 when the engagement record cannot be read', async () => {
    reset();
    storeMode = 'read-fail';
    const r = await request(S, { body: { engagementId: 'eng-1', reportDeadline: '2026-11-01' } });
    assert.strictEqual(r.status, 500);
  });

  // ── test-files-uploaded ───────────────────────────────────────────────────
  const T = '/api/deliveryflow/test-files-uploaded';

  await test('test-files-uploaded: forwarded on every upload', async () => {
    reset();
    const body = { engagementId: 'eng-1', clientName: 'Acme Ltd', fileCount: 3, archiveName: 'src.zip', submittedAt: '2026-09-28T10:00:00Z' };
    const r1 = await request(T, { body });
    const r2 = await request(T, { body });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events[0].data, { fileCount: 3, archiveName: 'src.zip', submittedAt: '2026-09-28T10:00:00Z' });
    assert.strictEqual(records['eng-1'].test_files_last_uploaded_at, '2026-09-28T10:00:00Z');
  });

  await test('test-files-uploaded: 404 unknown, 502 when DeliveryFlow fails', async () => {
    reset();
    assert.strictEqual((await request(T, { body: { engagementId: 'nope' } })).status, 404);
    dfMode = 'throw';
    assert.strictEqual((await request(T, { body: { engagementId: 'eng-1' } })).status, 502);
  });

  // ── finalised-auth-form ───────────────────────────────────────────────────
  const F = '/api/deliveryflow/finalised-auth-form';
  const drive = 'https://drive.google.com/file/d/AbC123_x/view?usp=sharing';

  await test('finalised-auth-form: 400 on a link that is not Google Drive', async () => {
    reset();
    const r = await request(F, { body: { engagementId: 'eng-1', driveUrl: 'https://evil.test/file/d/AbC/view' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(events.length, 0);
  });

  await test('finalised-auth-form: the canonical link goes to every engagement the form covers', async () => {
    reset();
    const r = await request(F, { body: { clientName: 'Acme Ltd', driveUrl: drive, engagementIds: ['eng-1', 'eng-2'] } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['sent', 'sent']);
    assert.strictEqual(events[0].event, 'auth_form_finalised');
    assert.deepStrictEqual(events[0].data, { signedFormUrl: 'https://drive.google.com/file/d/AbC123_x/view', driveFileId: 'AbC123_x' });
    assert.strictEqual(records['eng-2'].signed_form_url, 'https://drive.google.com/file/d/AbC123_x/view');
  });

  await test('finalised-auth-form: one unknown id is a partial success; all failing is a 502', async () => {
    reset();
    const partial = await request(F, { body: { driveUrl: drive, clickupTaskIds: ['eng-1', 'ghost'] } });
    assert.strictEqual(partial.status, 200);
    assert.strictEqual(partial.json.results[1].action, 'failed');
    dfMode = 'throw';
    const all = await request(F, { body: { driveUrl: drive, clickupTaskId: 'eng-1' } });
    assert.strictEqual(all.status, 502);
    assert.strictEqual(all.json.ok, false);
  });

  // ── merged-auth-form ──────────────────────────────────────────────────────
  const M = '/api/deliveryflow/merged-auth-form';

  await test('merged-auth-form: forwarded to each engagement with the full set', async () => {
    reset();
    const r = await request(M, {
      body: {
        clientName: 'Acme Ltd', mergedFormUrl: 'https://portal.test/m/xyz', mergedFormToken: 'm-xyz',
        engagementIds: ['eng-1', 'eng-2'], testTypes: ['Web App', 'External'], dayCount: 5,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].event, 'merged_auth_form');
    assert.deepStrictEqual(events[1].data, {
      mergedFormUrl: 'https://portal.test/m/xyz', mergedFormToken: 'm-xyz',
      testTypes: ['Web App', 'External'], dayCount: 5, engagementIds: ['eng-1', 'eng-2'],
    });
    assert.strictEqual(records['eng-1'].merged_form_token, 'm-xyz');
  });

  await test('merged-auth-form: one engagement failing does not stop the others', async () => {
    reset();
    failFor.add('eng-1');
    const r = await request(M, { body: { mergedFormUrl: 'https://portal.test/m/xyz', engagementIds: ['eng-1', 'eng-2'] } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['failed', 'sent']);
  });

  await test('merged-auth-form: 400 without a URL or ids', async () => {
    reset();
    assert.strictEqual((await request(M, { body: { engagementIds: ['eng-1'] } })).status, 400);
    assert.strictEqual((await request(M, { body: { mergedFormUrl: 'https://portal.test/m/1', engagementIds: [] } })).status, 400);
    assert.strictEqual((await request(M, { body: { mergedFormUrl: 'javascript:alert(1)', engagementIds: ['eng-1'] } })).status, 400);
  });

  // ── extra-urls ────────────────────────────────────────────────────────────
  const X = '/api/deliveryflow/extra-urls';
  const extra = (over = {}) => ({
    clientName: 'Beta', engagementId: 'eng-1', formUrl: 'https://portal.test/f/eng-1',
    urls: ['https://a.test', 'https://b.test'], ...over,
  });

  await test('extra-urls: Slack alert with the engagement link, and a DeliveryFlow event', async () => {
    reset();
    const r = await request(X, { body: extra() });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, deliveryflow: 'sent', slack: 'sent' });
    assert.strictEqual(slackPosts[0].channel, 'C0AA3SNQUKE');
    assert.ok(slackPosts[0].text.includes('submitted 2 URLs'));
    assert.ok(slackPosts[0].text.includes('DeliveryFlow engagement: https://deliveryflow.test/engagements/eng-1'));
    assert.deepStrictEqual(events[0].data, { urls: ['https://a.test', 'https://b.test'], urlCount: 2, formUrl: 'https://portal.test/f/eng-1' });
  });

  await test('extra-urls: an unknown engagement still alerts Slack', async () => {
    reset();
    const r = await request(X, { body: extra({ engagementId: 'ghost' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.deliveryflow, 'failed');
    assert.strictEqual(r.json.slack, 'sent');
  });

  await test('extra-urls: no engagement id skips DeliveryFlow; both failing is a 502', async () => {
    reset();
    const noId = await request(X, { body: extra({ engagementId: undefined }) });
    assert.strictEqual(noId.json.deliveryflow, 'skipped');
    slackMode = 'throw';
    dfMode = 'throw';
    const both = await request(X, { body: extra() });
    assert.strictEqual(both.status, 502);
  });

  await test('extra-urls: works without DELIVERYFLOW_EVENTS_URL (Slack only)', async () => {
    reset();
    delete process.env.DELIVERYFLOW_EVENTS_URL;
    try {
      const r = await request(X, { body: extra() });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.slack, 'sent');
      assert.strictEqual(r.json.deliveryflow, 'failed');
    } finally {
      process.env.DELIVERYFLOW_EVENTS_URL = 'https://deliveryflow.test/events';
    }
  });

  // ── The portal's existing /clickup/* calls ────────────────────────────────
  console.log('\n/clickup/* routing of DeliveryFlow ids:');

  await test('/clickup/schedule-task with an engagement id goes to DeliveryFlow, not ClickUp', async () => {
    reset();
    const r = await request('/clickup/schedule-task', {
      body: { clickupTaskId: 'eng-1', startDate: '2026-10-05', endDate: '2026-10-07', reportDeadline: '2026-10-20' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.deliveryflow, 'sent');
    assert.strictEqual(events[0].event, 'schedule_set');
    assert.strictEqual(clickupWrites.length, 0);
  });

  await test('/clickup/schedule-task with a ClickUp id still books the ClickUp task', async () => {
    reset();
    const r = await request('/clickup/schedule-task', {
      body: { clickupTaskId: '86c1ab2xy', startDate: '2026-10-05', endDate: '2026-10-07' },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(clickupWrites.map((w) => w.op), ['schedule']);
    assert.strictEqual(events.length, 0);
  });

  await test('/clickup/test-files-uploaded and /clickup/extra-urls route an engagement to DeliveryFlow', async () => {
    reset();
    const t = await request('/clickup/test-files-uploaded', { body: { clickupTaskId: 'eng-1', fileCount: 1 } });
    assert.strictEqual(t.status, 200);
    const x = await request('/clickup/extra-urls', {
      body: { clientName: 'Beta', clickupTaskId: 'eng-1', urls: ['https://a.test', 'https://b.test'] },
    });
    assert.strictEqual(x.status, 200);
    assert.deepStrictEqual(events.map((e) => e.event), ['test_files_uploaded', 'extra_urls']);
    assert.strictEqual(slackPosts.length, 1);
    assert.strictEqual(clickupWrites.length, 0, 'no ClickUp comment for an engagement');
  });

  await test('/clickup/finalised-auth-form splits one form across DeliveryFlow and ClickUp', async () => {
    reset();
    const r = await request('/clickup/finalised-auth-form', {
      body: { clientName: 'Acme Ltd', driveUrl: drive, clickupTaskIds: ['eng-1', '86c1ab2xy'] },
    });
    assert.strictEqual(r.status, 200);
    const byId = Object.fromEntries(r.json.results.map((x) => [x.taskId, x]));
    assert.strictEqual(byId['eng-1'].action, 'sent');
    assert.strictEqual(byId['eng-1'].destination, 'deliveryflow');
    assert.strictEqual(byId['86c1ab2xy'].action, 'attached');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].engagementId, 'eng-1');
    assert.ok(clickupWrites.every((w) => w.taskId === '86c1ab2xy'));
    assert.strictEqual(drivedownloads, 1);
  });

  await test('/clickup/finalised-auth-form for engagements only downloads nothing', async () => {
    reset();
    const r = await request('/clickup/finalised-auth-form', { body: { driveUrl: drive, clickupTaskIds: ['eng-1', 'eng-2'] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(drivedownloads, 0);
  });

  await test('/clickup/merged-auth-form splits the same way', async () => {
    reset();
    const r = await request('/clickup/merged-auth-form', {
      body: { clientName: 'Acme Ltd', mergedFormUrl: 'https://portal.test/m/1', mergedFormToken: 'm1', clickupTaskIds: ['eng-2', '86c1ab2xy'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(events[0].engagementId, 'eng-2');
    assert.deepStrictEqual(clickupWrites, [{ taskId: '86c1ab2xy', op: 'comment' }]);
  });

  await test('a failed engagement lookup falls back to ClickUp for every id', async () => {
    reset();
    lookupMode = 'throw';
    const r = await request('/clickup/schedule-task', {
      body: { clickupTaskId: 'eng-1', startDate: '2026-10-05', endDate: '2026-10-07' },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(clickupWrites.map((w) => w.op), ['schedule']);
    assert.strictEqual(events.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
