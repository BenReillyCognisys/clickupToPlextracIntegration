const assert = require('assert');
const crypto = require('crypto');

// The Plextrac webhook forwards a DeliveryFlow engagement's report status changes to
// DeliveryFlow (report_status). Everything it touches is stubbed BEFORE the route is
// required, since it destructures some helpers on import.
process.env.PLEXTRAC_WEBHOOK_SECRET = 'plex-secret';
process.env.DELIVERYFLOW_EVENTS_URL = 'https://deliveryflow.test/api/public/break-events';
process.env.DELIVERYFLOW_API_KEY = 'df-key';

const taskStore = require('../lib/task-store');
const dfStore = require('../lib/deliveryflow-store');
const deliveryflow = require('../lib/deliveryflow-api');
const plextracApi = require('../lib/plextrac-api');
const lookup = require('../lib/plextrac-lookup');
const clickup = require('../lib/clickup-api');
const qaQueue = require('../lib/qa-queue-store');
const kpiStore = require('../lib/qa-kpi-store');
const submissionStore = require('../lib/qa-submission-store');
const reportsDue = require('../pipeline/reports-due');
const qaReview = require('../pipeline/qa-review');
const secondRound = require('../pipeline/qa-second-round');
const released = require('../pipeline/qa-released');

// ClickUp mappings by cuid, DeliveryFlow engagements by cuid and by report id.
const clickupByCuid = {};
const engagements = [];
taskStore.findByCuid = async (cuid) => clickupByCuid[cuid] || null;
dfStore.findByReportCuid = async (cuid) => engagements.find((e) => e.plextrac_report_cuid === cuid) || null;
dfStore.findByReportId = async (id) => engagements.find((e) => String(e.plextrac_report_id) === String(id)) || null;

const reportStatus = {}; // reportId -> current Plextrac status
plextracApi.getReport = async (clientId, reportId) => ({ name: `Report ${reportId}`, status: reportStatus[reportId] });
plextracApi.listReportFindings = async () => [];
lookup.resolveClientAndReport = async ({ clientName }) => (clientName === 'Named Ltd' ? { clientId: 30, reportId: 3003 } : null);

const clickupUpdates = [];
clickup.updateTaskStatus = async (taskId, status) => { clickupUpdates.push({ taskId, status }); };
clickup.getTask = async () => ({ due_date: null });
qaQueue.upsert = async () => {};
qaQueue.remove = async () => {};
kpiStore.has = async () => true;
kpiStore.record = async () => false;
submissionStore.has = async () => true;
submissionStore.record = async () => false;
reportsDue.crossOffReport = async () => ({ updated: false });
qaReview.runQaReview = async () => {};
secondRound.postSecondRoundQa = async () => {};
released.postReleaseAnnouncement = async () => {};
// Who may set which status is tested in tests/status-guard.test.js; here every change
// is allowed, so the DeliveryFlow forwarding is what's under test.
require('../pipeline/status-guard').guardStatusChange = async () => ({ proceed: true, verdict: 'allowed' });

const events = [];
let sendMode = 'ok';
deliveryflow.sendEvent = async (event, ids, data) => {
  events.push({ event, ...ids, data });
  if (sendMode === 'throw') throw new Error('DeliveryFlow 500 report_status: boom');
  return { ok: true };
};

const handler = require('../routes/plextrac-webhook');

// ── Harness ─────────────────────────────────────────────────────────────────
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

// Calls the handler with a signed payload and waits for the work it does after
// acknowledging (the handler answers 200 first, then carries on).
async function deliver(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', 'plex-secret').update(raw).digest('hex');
  let status = null;
  const res = { status(code) { status = code; return this; }, end() {} };
  await handler({ body: raw, headers: { 'x-authorization-hmac-256': sig } }, res);
  return status;
}

const statusChange = (cuid, extra = {}) => ({ event: 'ReportStatusChanged', targetType: 'report', targetCuid: cuid, ...extra });

(async () => {
  console.log('Plextrac webhook → DeliveryFlow report_status:');

  engagements.push({
    engagement_id: 'eng-1', deal_id: 'deal-1', client_name: 'Acme Ltd',
    plextrac_client_id: 10, plextrac_report_id: 1001, plextrac_report_cuid: 'cuid-1001', report_name: 'External | October 2026',
  });

  await test('a DeliveryFlow report found by cuid sends its new status to DeliveryFlow', async () => {
    events.length = 0;
    reportStatus[1001] = 'Ready For Review';
    assert.strictEqual(await deliver(statusChange('cuid-1001')), 200);
    assert.strictEqual(events.length, 1);
    const [e] = events;
    assert.strictEqual(e.event, 'report_status');
    assert.strictEqual(e.engagementId, 'eng-1');
    assert.strictEqual(e.dealId, 'deal-1');
    assert.strictEqual(e.data.status, 'Ready For Review');
    assert.strictEqual(e.data.reportId, '1001');
    assert.strictEqual(e.data.reportName, 'Report 1001');
    assert.ok(e.data.reportUrl.endsWith('/client/10/report/1001'));
    assert.strictEqual(clickupUpdates.length, 0, 'no ClickUp task to update');
  });

  await test('Published is sent too (DeliveryFlow decides what each status means)', async () => {
    events.length = 0;
    reportStatus[1001] = 'Published';
    await deliver(statusChange('cuid-1001'));
    assert.strictEqual(events[0].data.status, 'Published');
  });

  await test('a report without a recorded cuid is matched by the id the name lookup resolves', async () => {
    events.length = 0;
    engagements.push({ engagement_id: 'eng-3', deal_id: 'deal-3', client_name: 'Named Ltd', plextrac_client_id: 30, plextrac_report_id: 3003, plextrac_report_cuid: null });
    reportStatus[3003] = 'In Review';
    await deliver(statusChange('cuid-unknown', { text: 'Named Ltd||Black Box | October 2026' }));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].engagementId, 'eng-3');
    assert.strictEqual(events[0].data.status, 'In Review');
  });

  await test('a ClickUp report still syncs ClickUp and sends nothing to DeliveryFlow', async () => {
    events.length = 0;
    clickupUpdates.length = 0;
    clickupByCuid['cuid-2002'] = { clickup_task_id: 'cu-1', plextrac_client_id: 20, plextrac_report_id: 2002, client_name: 'Cu Ltd', task_name: 'Cu Ltd | External' };
    reportStatus[2002] = 'Ready For Review';
    await deliver(statusChange('cuid-2002'));
    assert.strictEqual(events.length, 0);
    assert.deepStrictEqual(clickupUpdates, [{ taskId: 'cu-1', status: 'QA / Reviewing' }]);
  });

  await test('a DeliveryFlow failure is logged, not thrown', async () => {
    events.length = 0;
    sendMode = 'throw';
    reportStatus[1001] = 'Ready For Review';
    assert.strictEqual(await deliver(statusChange('cuid-1001')), 200);
    assert.strictEqual(events.length, 1);
    sendMode = 'ok';
  });

  await test('nothing is sent when DeliveryFlow forwarding is not configured', async () => {
    events.length = 0;
    const url = process.env.DELIVERYFLOW_EVENTS_URL;
    delete process.env.DELIVERYFLOW_EVENTS_URL;
    try {
      await deliver(statusChange('cuid-1001'));
      assert.strictEqual(events.length, 0);
    } finally {
      process.env.DELIVERYFLOW_EVENTS_URL = url;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
