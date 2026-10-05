const assert = require('assert');
const crypto = require('crypto');

// Report status permissions, end to end through the Plextrac webhook: who may set
// Approved / Published, what a disallowed change is put back to, what is posted, and
// that nothing else runs for it. Everything the webhook touches is stubbed BEFORE the
// route is required, since it destructures some helpers on import.
process.env.PLEXTRAC_WEBHOOK_SECRET = 'plex-secret';
process.env.PLEXTRAC_INSTANCE = 'test.plextrac.com';

const taskStore = require('../lib/task-store');
const dfStore = require('../lib/deliveryflow-store');
const deliveryflow = require('../lib/deliveryflow-api');
const api = require('../lib/plextrac-api');
const users = require('../lib/plextrac-users');
const slack = require('../lib/slack');
const clickup = require('../lib/clickup-api');
const qaQueue = require('../lib/qa-queue-store');
const kpiStore = require('../lib/qa-kpi-store');
const submissionStore = require('../lib/qa-submission-store');
const statusStore = require('../lib/report-status-store');
const suppression = require('../lib/webhook-suppression');
const reportsDue = require('../pipeline/reports-due');
const qaReview = require('../pipeline/qa-review');
const secondRound = require('../pipeline/qa-second-round');
const released = require('../pipeline/qa-released');
const approved = require('../pipeline/qa-approved');
const log = require('../lib/logger');

// ── People ────────────────────────────────────────────────────────────────────
const PEOPLE = {
  'cuid-alice': { cuid: 'cuid-alice', name: 'Alice Elvin', email: 'alice.elvin@cognisys.group' },
  'cuid-ben': { cuid: 'cuid-ben', name: 'Ben Reilly', email: 'ben.reilly@cognisys.group' },
  'cuid-soham': { cuid: 'cuid-soham', name: 'Soham Bakore', email: 'soham.bakore@cognisys.group' },
  'cuid-soham2': { cuid: 'cuid-soham2', name: 'Soham Bakore', email: 'soham.bakore@cognisys.co.uk' },
  'cuid-punit': { cuid: 'cuid-punit', name: 'Punit Sharma', email: 'punit.sharma@cognisys.co.uk' },
  'cuid-karan': { cuid: 'cuid-karan', name: 'Karan Luniyal', email: 'karan.luniyal@cognisys.co.uk' },
  'cuid-rajveer': { cuid: 'cuid-rajveer', name: 'Rajveer Parmar', email: 'rajveer.parmar@cognisys.group' },
  'cuid-jo': { cuid: 'cuid-jo', name: 'Jo Consultant', email: 'jo@cognisys.group' },
};
const SLACK_IDS = { 'jo@cognisys.group': 'UJO', 'alice.elvin@cognisys.group': 'UALICE', 'ben.reilly@cognisys.group': 'UBEN' };

// ── State ─────────────────────────────────────────────────────────────────────
let status;      // the report's status in Plextrac
let recorded;    // plextrac_report_status, by report id
let calls;
let usersDown;

taskStore.findByCuid = async (cuid) => (cuid === 'cuid-r1'
  ? { clickup_task_id: 'cu-1', plextrac_client_id: 10, plextrac_report_id: 101, task_name: 'Acme | Web', client_name: 'Acme Ltd' }
  : null);
dfStore.findByReportCuid = async (cuid) => (cuid === 'cuid-r1' ? null : null);
dfStore.findByReportId = async () => null;
api.getReport = async () => ({ name: 'Acme | Web', status });
api.getClient = async () => ({ name: 'Acme Ltd' });
api.updateReport = async (c, r, payload) => {
  calls.updates.push(payload);
  if (calls.updateFails) throw new Error('Plextrac 500');
  if (payload.status) status = payload.status;
};
api.listReportFindings = async () => [];
api.selfUserCuid = async () => 'cuid-api';
users.cuidMap = async () => {
  if (usersDown) throw new Error('403 Unauthorized');
  return new Map(Object.entries(PEOPLE));
};
slack.postMessage = async (channel, text) => { calls.slack.push({ channel, text }); return 'ts-1'; };
slack.postReply = async () => {};
slack.lookupUserIdByEmail = async (email) => SLACK_IDS[email] || null;
statusStore.get = async (id) => (recorded[id] ? { status: recorded[id] } : null);
statusStore.set = async ({ reportId, status: s }) => { recorded[reportId] = s; };

clickup.updateTaskStatus = async (taskId, s) => { calls.clickup.push(s); };
clickup.getTask = async () => ({ due_date: null });
qaQueue.upsert = async ({ stage }) => { calls.queue.push(stage); };
qaQueue.remove = async () => { calls.queue.push('removed'); };
kpiStore.has = async () => { calls.kpi++; return true; };
kpiStore.record = async () => false;
submissionStore.has = async () => true;
submissionStore.record = async () => false;
reportsDue.crossOffReport = async () => ({ updated: false });
deliveryflow.sendEvent = async () => { calls.deliveryflow++; };
qaReview.runQaReview = async () => { calls.ran.push('first-round QA'); };
secondRound.postSecondRoundQa = async () => { calls.ran.push('second-round QA'); };
released.postReleaseAnnouncement = async () => { calls.ran.push('release + j2 exports'); };
approved.postApprovedAnnouncement = async () => { calls.ran.push('approved announcement'); };

const handler = require('../routes/plextrac-webhook');
const guard = require('../pipeline/status-guard');
const { buildApprovedMessage } = approved;
const { renderQueue } = require('../routes/slack-command');

function reset({ now, before } = {}) {
  status = now;
  recorded = before ? { 101: before } : {};
  calls = { updates: [], slack: [], clickup: [], queue: [], ran: [], kpi: 0, deliveryflow: 0, updateFails: false };
  usersDown = false;
  suppression.clear();
}

// A webhook: the report has just been moved to `to` by `actorCuid`.
async function moved(to, actorCuid) {
  status = to;
  const raw = Buffer.from(JSON.stringify({ event: 'ReportStatusChanged', targetType: 'report', targetCuid: 'cuid-r1', ...(actorCuid ? { actorCuid } : {}) }));
  const sig = crypto.createHmac('sha256', 'plex-secret').update(raw).digest('hex');
  const res = { status() { return this; }, end() {} };
  const saved = [log.info, log.warn, log.error];
  log.info = log.warn = log.error = () => {};
  try {
    await handler({ body: raw, headers: { 'x-authorization-hmac-256': sig } }, res);
  } finally {
    [log.info, log.warn, log.error] = saved;
  }
}

let passed = 0, failed = 0;
async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}\n       ${err.stack || err.message}`);
    failed++;
  }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const nothingRan = () => {
  eq(calls.ran, []);
  eq(calls.queue, []);
  eq(calls.clickup, []);
  eq([calls.kpi, calls.deliveryflow], [0, 0]);
};

(async () => {
  console.log('\nreport status permissions\n');

  await test('a consultant setting Approved is put back, reported, and nothing else runs', async () => {
    reset({ before: 'In Review' });
    await moved('Approved', 'cuid-jo');
    eq(calls.updates, [{ status: 'In Review' }]);
    eq(status, 'In Review');
    eq(recorded[101], 'In Review');
    nothingRan();
    // The ready-for-release channel and the status-violations channel, same message.
    eq(calls.slack.map((m) => m.channel), ['C0C08NCU0MV', 'C0B6SN0023D']);
    eq(calls.slack[0].text, calls.slack[1].text);
    const { text } = calls.slack[1];
    assert.ok(text.includes('Client: <https://test.plextrac.com/client/10|Acme Ltd> - <https://test.plextrac.com/client/10/report/101|Acme | Web>'), text);
    assert.ok(text.includes('<@UJO> moved the report from *In Review* to *Approved*'), text);
    assert.ok(text.endsWith('<@UJO> moved the report from *In Review* to *Approved*, but they are not authorised to perform second or release QA. '
      + 'It has been moved back to *In Review*. Nothing was posted or exported for the change.'), text);
  });

  await test('the put-back\'s own webhook is ignored — by actor, and by the expected status without one', async () => {
    reset({ before: 'In Review' });
    await moved('Approved', 'cuid-jo');
    calls.slack = [];
    await moved('In Review', 'cuid-api'); // Plextrac reports our own change
    eq(calls.ran, []);
    // Without an actor, the expected-status mark recognises it — once.
    reset({ before: 'In Review' });
    await moved('Approved', 'cuid-jo');
    await moved('In Review', null);
    eq(calls.ran, []);
    await moved('In Review', null); // a real change later is handled
    eq(calls.ran, ['second-round QA']);
  });

  await test('anyone can set Draft, Ready For Review and In Review', async () => {
    reset({ before: 'Draft' });
    await moved('Ready For Review', 'cuid-jo');
    await moved('In Review', 'cuid-jo');
    await moved('Draft', 'cuid-jo');
    eq(calls.updates, []);
    eq(calls.ran, ['first-round QA', 'second-round QA']);
    eq(recorded[101], 'Draft');
  });

  await test('every approver can set Approved: announcement, Ready for Release queue', async () => {
    for (const who of ['cuid-alice', 'cuid-ben', 'cuid-soham', 'cuid-punit', 'cuid-karan', 'cuid-rajveer']) {
      reset({ before: 'In Review' });
      await moved('Approved', who);
      eq(calls.updates, []);
      eq(calls.ran, ['approved announcement']);
      eq(calls.queue, ['release']);
      eq(recorded[101], 'Approved');
    }
  });

  await test('an approver who isn\'t a publisher can\'t set Published — back to Approved, no exports', async () => {
    reset({ before: 'Approved' });
    await moved('Published', 'cuid-soham');
    eq(calls.updates, [{ status: 'Approved' }]);
    nothingRan();
    assert.ok(calls.slack[0].text.includes('to *Published*, but they are not authorised to perform second or release QA.'), calls.slack[0].text);
    assert.ok(calls.slack[0].text.includes('Soham Bakore moved the report from *Approved* to *Published*'), calls.slack[0].text);
  });

  await test('Alice and Ben can publish: release announcement, j2 exports, ClickUp Completed', async () => {
    for (const who of ['cuid-alice', 'cuid-ben']) {
      reset({ before: 'Approved' });
      await moved('Published', who);
      eq(calls.updates, []);
      eq(calls.ran, ['release + j2 exports']);
      eq(calls.clickup, ['Completed']);
      eq(calls.queue, ['removed']);
    }
  });

  await test('only the main account counts — Soham\'s second account can\'t approve', async () => {
    reset({ before: 'In Review' });
    await moved('Approved', 'cuid-soham2');
    eq(calls.updates, [{ status: 'In Review' }]);
    nothingRan();
  });

  await test('with no previous status on record, it goes back to the highest status the person may set', async () => {
    reset({});
    await moved('Published', 'cuid-jo');
    eq(calls.updates, [{ status: 'In Review' }]);
    reset({});
    await moved('Published', 'cuid-rajveer');
    eq(calls.updates, [{ status: 'Approved' }]);
    // A record already showing the attempted status means a change was missed: same fallback.
    reset({ before: 'Approved' });
    await moved('Approved', 'cuid-jo');
    eq(calls.updates, [{ status: 'In Review' }]);
  });

  await test('fails closed: no actor, or the user list unreadable, on a restricted status', async () => {
    reset({ before: 'In Review' });
    await moved('Approved', null);
    eq(calls.updates, [{ status: 'In Review' }]);
    assert.ok(calls.slack[0].text.includes('Someone (Plextrac did not say who) moved the report from *In Review* to *Approved*, '
      + 'but they could not be confirmed as authorised to perform second or release QA.'), calls.slack[0].text);
    nothingRan();

    reset({ before: 'Approved' });
    usersDown = true;
    await moved('Published', 'cuid-alice');
    eq(calls.updates, [{ status: 'Approved' }]);
    assert.ok(calls.slack[0].text.includes('the Plextrac user list could not be read'));
    nothingRan();

    // ...but an open status still goes through when the user list is down.
    reset({ before: 'Ready For Review' });
    usersDown = true;
    await moved('In Review', 'cuid-jo');
    eq(calls.ran, ['second-round QA']);
  });

  await test('a put-back that fails says so, and still nothing runs', async () => {
    reset({ before: 'In Review' });
    calls.updateFails = true;
    await moved('Approved', 'cuid-jo');
    nothingRan();
    assert.ok(calls.slack[0].text.includes('could NOT be moved back automatically (Plextrac 500) — please set it back to *In Review* by hand'), calls.slack[0].text);
    eq(recorded[101], 'Approved');
  });

  await test('a non-approver taking a Published report down to Approved is put back to Published', async () => {
    reset({ before: 'Published' });
    await moved('Approved', 'cuid-jo');
    eq(calls.updates, [{ status: 'Published' }]);
    nothingRan();
    // ...and the put-back's echo doesn't re-run the release.
    await moved('Published', 'cuid-api');
    eq(calls.ran, []);
  });

  await test('the person is tagged even when Slack knows them under the other Cognisys domain', async () => {
    reset({ before: 'In Review' });
    PEOPLE['cuid-sam'] = { cuid: 'cuid-sam', name: 'Sam Tester', email: 'sam.tester@cognisys.co.uk' };
    SLACK_IDS['sam.tester@cognisys.group'] = 'USAM';
    await moved('Approved', 'cuid-sam');
    assert.ok(calls.slack[1].text.includes('<@USAM> moved the report from *In Review* to *Approved*'), calls.slack[1].text);
    // Not in Slack at all: named instead.
    reset({ before: 'In Review' });
    PEOPLE['cuid-kim'] = { cuid: 'cuid-kim', name: 'Kim Nobody', email: 'kim@cognisys.group' };
    await moved('Approved', 'cuid-kim');
    assert.ok(calls.slack[1].text.includes('Kim Nobody moved the report'), calls.slack[1].text);
  });

  await test('one channel failing does not stop the other', async () => {
    reset({ before: 'In Review' });
    const real = slack.postMessage;
    slack.postMessage = async (channel, text) => {
      if (channel === 'C0C08NCU0MV') throw new Error('not_in_channel');
      calls.slack.push({ channel, text });
    };
    try {
      await moved('Approved', 'cuid-jo');
    } finally {
      slack.postMessage = real;
    }
    eq(calls.slack.map((m) => m.channel), ['C0B6SN0023D']);
    eq(calls.updates, [{ status: 'In Review' }]);
    nothingRan();
  });

  await test('choosePrevious', async () => {
    eq(guard.choosePrevious({ known: 'Draft', attempted: 'Approved', actorEmail: 'x@y' }), 'Draft');
    eq(guard.choosePrevious({ known: null, attempted: 'Approved', actorEmail: 'x@y' }), 'In Review');
    eq(guard.choosePrevious({ known: null, attempted: 'Published', actorEmail: 'punit.sharma@cognisys.co.uk' }), 'Approved');
    eq(guard.choosePrevious({ known: null, attempted: 'Published', actorEmail: null }), 'In Review');
  });

  await test('the Approved announcement and the Ready for Release queue section', async () => {
    eq(buildApprovedMessage({
      clientName: 'Acme', clientUrl: 'https://p/c', reportName: 'Web', reportUrl: 'https://p/r', approverName: 'Soham Bakore', mentions: ['UALICE', 'UBEN'],
    }), ':large_green_circle: Client: <https://p/c|Acme> - <https://p/r|Web> approved — ready for release <@UALICE> <@UBEN>. Approved by Soham Bakore :large_green_circle:');
    const text = renderQueue([{ stage: 'release', client_name: 'Acme', report_name: 'Web', report_url: 'https://p/r', entered_at: new Date() }]);
    assert.ok(/\*Ready for Release:\*\n• Acme - /.test(text), text);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
