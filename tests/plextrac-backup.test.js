const assert = require('assert');
const os = require('os');
const http = require('http');
const express = require('express');

process.env.BREAK_SERVICES_API_KEY = 'portal-key';
process.env.PLEXTRAC_BACKUP_DRIVE_FOLDER_ID = 'ROOT';
process.env.PLEXTRAC_BACKUP_TZ = 'Europe/London';

// ── Stub the outbound helpers ─────────────────────────────────────────────────
// The backup calls through these module objects at runtime, so replacing their
// exports keeps every test off Plextrac, Drive, MongoDB and Slack.
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const store = require('../lib/plextrac-backup-store');
const reportBackup = require('../pipeline/report-backup');
const log = require('../lib/logger');
const backup = require('../pipeline/plextrac-backup');

// ── A tiny Plextrac ───────────────────────────────────────────────────────────
let pt;     // { clients: [{ id, name }], reports: { clientId: [{ id, name, status, findings, hash }] } }
let calls;
let hooks;
// ── An in-memory store ────────────────────────────────────────────────────────
let runs;   // run_id -> run
let items;  // `${run_id}|${report_id}` -> item

function reset() {
  pt = {
    clients: [{ id: 1, name: 'Acme' }, { id: 2, name: 'Beta' }, { id: 3, name: 'Empty Co' }],
    reports: {
      1: [rep(11, 'Acme | Web', 'Published', [f(1, 'XSS')]), rep(12, 'Acme | Infra', 'Draft', [])],
      2: [rep(21, 'Beta | Web', 'In Review', [f(2, 'SQLi'), f(3, 'CSRF')])],
      3: [],
    },
  };
  hooks = {};
  calls = { backedUp: [], clientRecords: [], uploads: [], notify: [], folders: [] };
  runs = new Map();
  items = new Map();

  api.listClients = async () => pt.clients.map((c) => ({ id: `client_${c.id}`, data: [c.id, c.name, null] }));
  api.listClientReports = async (id) => (pt.reports[id] || []).map((r) => ({ id: r.id, data: [r.id, r.name, null, r.status] }));
  api.getClient = async (id) => ({ client_id: id, name: pt.clients.find((c) => c.id === id)?.name });

  drive.driveClient = async () => ({});
  drive.listSubfolders = async () => hooks.driveFolders || [];
  drive.uploadFile = async ({ filename, buffer, folderId }) => {
    calls.uploads.push({ filename, folderId, text: buffer.toString('utf8') });
    return { fileId: `F-${filename}`, url: `https://drive/${filename}` };
  };
  reportBackup.folderUnder = async (parent, name) => { calls.folders.push([parent, name]); return `${parent}/${name}`; };
  reportBackup.backupClientRecord = async (args) => { calls.clientRecords.push(args); };
  reportBackup.backupReport = async ({ clientId, report, parentFolderId }) => {
    calls.backedUp.push(report.id);
    const r = pt.reports[clientId].find((x) => x.id === report.id);
    if (hooks.fail?.(report.id)) {
      return { ok: false, error: '.ptrac: Plextrac 502', files: [], warnings: [], bytes: 0, report: null, artifacts: 0, folder_url: null };
    }
    return {
      ok: true, error: null, warnings: [], bytes: 1000, artifacts: r.artifacts || 0, folder_url: `${parentFolderId}/${report.name}`,
      files: [{ kind: 'ptrac', size: 600 }, { kind: 'document' }, { kind: 'document' }, { kind: 'document' },
        ...Array.from({ length: r.artifacts || 0 }, () => ({ kind: 'artifact' }))],
      report: { cuid: `c${r.id}`, name: r.name, status: r.status, hash: r.hash || `h-${r.id}`, findings: r.findings, media: 0 },
    };
  };

  store.createRun = async (run) => { runs.set(run.run_id, structuredClone(run)); };
  store.updateRun = async (id, { set = {} } = {}) => {
    const run = runs.get(id);
    for (const [k, v] of Object.entries(set)) {
      const path = k.split('.');
      let o = run;
      while (path.length > 1) o = o[path.shift()] ||= {};
      o[path[0]] = v;
    }
    run.heartbeat_at = new Date();
  };
  store.getRun = async (id) => structuredClone(runs.get(id));
  store.runningRuns = async () => [...runs.values()].filter((r) => r.status === 'running');
  store.maxSequence = async () => Math.max(0, ...[...runs.values()].map((r) => r.sequence || 0));
  store.saveItem = async (item) => { items.set(`${item.run_id}|${item.report_id}`, structuredClone(item)); };
  store.itemsFor = async (id) => [...items.values()].filter((i) => i.run_id === id);
  store.lastFinishedRun = async ({ before } = {}) => [...runs.values()]
    .filter((r) => store.REAL_KINDS.includes(r.kind) && ['completed', 'completed_with_errors'].includes(r.status) && (!before || r.started_at < before))
    .sort((a, b) => b.started_at - a.started_at)[0] || null;
  store.recentRuns = async () => [...runs.values()].filter((r) => r.kind !== 'test').sort((a, b) => b.started_at - a.started_at);
  store.pruneItems = async () => 0;

  log.notify = (text) => calls.notify.push(text);
}
const rep = (id, name, status, findings) => ({ id, name, status, findings });
const f = (id, title, last_update = 1) => ({ id, title, severity: 'High', status: 'Open', last_update });

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.log(`  ✗  ${description}\n     ${err.stack || err.message}`); failed++; });
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const quiet = async (fn) => {
  const saved = [log.info, log.warn, log.error];
  log.info = log.warn = log.error = () => {};
  try { return await fn(); } finally { [log.info, log.warn, log.error] = saved; }
};
const changesText = () => calls.uploads.filter((u) => u.filename === 'changes.md').pop()?.text;
// Each run gets its own start time, so "previous run" ordering is unambiguous.
let clock = Date.parse('2026-10-09T21:00:00Z');
const run = async (args) => {
  const RealDate = Date;
  const at = clock;
  clock += 7 * 24 * 3600 * 1000;
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(at); }
    static now() { return at; }
  };
  try { return await quiet(() => backup.runBackup(args)); } finally { global.Date = RealDate; }
};

(async () => {
  console.log('\nplextrac weekly backup\n');

  await test('the first run backs up every client and report into "0001. <timestamp>"', async () => {
    reset();
    const r = await run();
    eq(r.status, 'completed');
    eq([r.sequence, r.folder.name], [1, '0001. 2026-10-09 22-00-00']);
    eq(calls.folders[0], ['ROOT', '0001. 2026-10-09 22-00-00']);
    // A folder and client.json for every client, the empty one included.
    eq(calls.clientRecords.map((c) => c.folderId).sort(), [
      'ROOT/0001. 2026-10-09 22-00-00/Acme (1)',
      'ROOT/0001. 2026-10-09 22-00-00/Beta (2)',
      'ROOT/0001. 2026-10-09 22-00-00/Empty Co (3)',
    ]);
    eq(calls.backedUp.sort(), [11, 12, 21]);
    eq(r.totals, { clients: 3, reports: 3, reports_ok: 3, reports_failed: 0, ptrac: 3, pdfs: 9, artifacts: 0, files: 15, bytes: 3000, list_errors: 0 });
    eq(r.changes.first, true);
    eq(/First backup/.test(changesText()), true);
    eq(calls.uploads.some((u) => u.filename === 'manifest.json'), true);
    eq(r.changes_file.url, 'https://drive/changes.md');
    eq(/Plextrac weekly backup .*0001\. 2026-10-09 22-00-00.*3 clients, 3 reports, 9 PDFs/.test(calls.notify[0]), true);
  });

  await test('the number follows the highest already in Drive', async () => {
    reset();
    hooks.driveFolders = [{ name: '0001. 2026-01-01 22-00-00' }, { name: '0007. 2026-02-12 22-00-00' }, { name: 'TEST 2026-02-13' }, { name: 'notes' }];
    const r = await run();
    eq(r.sequence, 8);
    eq(r.folder.name.startsWith('0008. '), true);
  });

  await test('the second run\'s changes.md says what changed since the first', async () => {
    reset();
    await run();
    // A week passes in Plextrac.
    pt.clients.push({ id: 4, name: 'Gamma' });
    pt.reports[4] = [rep(41, 'Gamma | Web', 'Draft', [])];
    pt.clients.find((c) => c.id === 3).name = 'Empty Company';
    pt.reports[1][0] = { ...pt.reports[1][0], status: 'Archived', hash: 'h-11-v2' };
    pt.reports[2][0] = { ...pt.reports[2][0], hash: 'h-21-v2', findings: [f(2, 'SQLi', 5), f(4, 'IDOR')] };
    pt.reports[1].splice(1, 1); // Acme | Infra deleted
    const r = await run();
    eq(r.sequence, 2);
    eq(r.changes, {
      first: false, clients_new: 1, clients_removed: 0, clients_renamed: 1,
      reports_new: 1, reports_removed: 1, reports_changed: 2, reports_unchanged: 0, reports_failed: 0,
    });
    const text = changesText();
    eq(r.compared_with.sequence, 1);
    eq(text.includes('Compared with 0001.'), true);
    eq(text.includes('- Gamma (4) — 1 report(s)'), true);
    eq(text.includes('"Empty Co" → "Empty Company" (3)'), true);
    eq(text.includes('- Gamma / Gamma | Web — Draft, 0 finding(s)'), true);
    eq(text.includes('- Acme / Acme | Infra (was Draft)'), true);
    eq(text.includes('- Acme / Acme | Web — status Published → Archived'), true);
    eq(text.includes('- Beta / Beta | Web — 1 finding(s) added: "IDOR"; 1 finding(s) removed: "CSRF"; 1 finding(s) updated: "SQLi"'), true);
  });

  await test('an edit that shows in no detail is still called a change', async () => {
    const p = { name: 'R', client_id: 1, status: 'Draft', findings: [], hash: 'a', artifacts_listed: 0 };
    eq(backup.describeChange(p, { ...p }), []);
    eq(backup.describeChange(p, { ...p, hash: 'b' }), ['content edited (narratives, assets or screenshots)']);
    eq(backup.describeChange(p, { ...p, hash: 'b', artifacts_listed: 2 }), ['artifacts 0 → 2']);
  });

  await test('a report that fails is listed and the run carries on', async () => {
    reset();
    hooks.fail = (id) => id === 12;
    const r = await run();
    eq(r.status, 'completed_with_errors');
    eq([r.totals.reports_ok, r.totals.reports_failed], [2, 1]);
    eq(calls.backedUp.sort(), [11, 12, 21]);
    eq(changesText().includes('## Failed (1)\n\n- Acme / Acme | Infra — .ptrac: Plextrac 502'), true);
    eq(/1 report\(s\) failed/.test(calls.notify[0]), true);
  });

  await test('a resumed run skips the reports it already filed, and redoes failed ones', async () => {
    reset();
    runs.set('R1', {
      run_id: 'R1', kind: 'scheduled', status: 'running', sequence: 1, started_at: new Date('2026-10-09T21:00:00Z'),
      folder: { id: 'ROOT/0001', name: '0001. 2026-10-09 22-00-00', url: 'u' }, client_filter: null,
      progress: {}, owner: { role: 'server', host: os.hostname(), pid: -1 },
    });
    items.set('R1|11', { run_id: 'R1', report_id: 11, client_id: 1, ok: true, ptrac: 1, pdfs: 3, files: 4, bytes: 1000, hash: 'h-11', findings: [] });
    items.set('R1|21', { run_id: 'R1', report_id: 21, client_id: 2, ok: false, error: 'x', files: 0, bytes: 0 });
    const r = await run({ resumeRunId: 'R1' });
    eq(calls.backedUp.sort(), [12, 21]);
    eq([r.status, r.folder.name, r.totals.reports, r.totals.reports_ok], ['completed', '0001. 2026-10-09 22-00-00', 3, 3]);
    eq(r.resumes, 1);
  });

  await test('recovery resumes this server\'s dead run, leaves a live script run, closes off an old one', async () => {
    reset();
    const resumed = [];
    const base = { kind: 'scheduled', status: 'running', progress: {}, folder: { name: 'x' } };
    runs.set('LIVE', { ...base, run_id: 'LIVE', started_at: new Date(), heartbeat_at: new Date(), owner: { role: 'script', host: os.hostname(), pid: 1 } });
    runs.set('OLD', { ...base, run_id: 'OLD', started_at: new Date(Date.now() - 3 * 86400e3), heartbeat_at: new Date(Date.now() - 3 * 86400e3), owner: { role: 'server', host: os.hostname(), pid: 2 } });
    await quiet(() => backup.recoverRuns());
    eq(runs.get('LIVE').status, 'running');
    eq(runs.get('OLD').status, 'interrupted');
    // A dead run of this server's, recent: resumed (straight away, so stop it at the guard).
    runs.get('LIVE').status = 'completed';
    runs.set('DEAD', { ...base, run_id: 'DEAD', started_at: new Date(), heartbeat_at: new Date(), owner: { role: 'server', host: os.hostname(), pid: -5 } });
    store.getRun = async (id) => { resumed.push(id); throw new Error('stop here'); };
    await quiet(() => backup.recoverRuns());
    await new Promise((r) => setTimeout(r, 20));
    eq([...new Set(resumed)], ['DEAD']);
  });

  await test('a run already going elsewhere stops a new one starting', async () => {
    reset();
    runs.set('OTHER', { run_id: 'OTHER', kind: 'manual', status: 'running', heartbeat_at: new Date(), started_at: new Date() });
    const r = await quiet(() => backup.runBackup());
    eq(r, { skipped: 'run OTHER is already running' });
    eq(calls.backedUp, []);
  });

  await test('a test run: own TEST folder, no number, only its clients compared, no Slack', async () => {
    reset();
    await run();
    calls.notify = [];
    pt.reports[2][0] = { ...pt.reports[2][0], status: 'Published', hash: 'changed' };
    const r = await run({ kind: 'test', clientIds: [2] });
    eq([r.kind, r.sequence, r.folder.name.startsWith('TEST ')], ['test', null, true]);
    eq(calls.backedUp.slice(-1), [21]);
    eq(r.changes, {
      first: false, clients_new: 0, clients_removed: 0, clients_renamed: 0,
      reports_new: 0, reports_removed: 0, reports_changed: 1, reports_unchanged: 0, reports_failed: 0,
    });
    eq(changesText().includes('(only the clients in this test run)'), true);
    eq(calls.notify, []);
    // ...and the next real run still compares itself with the last REAL run.
    const next = await run();
    eq([next.sequence, next.compared_with.sequence], [2, 1]);
  });

  await test('status: the last real run, the run in progress, the schedule', async () => {
    reset();
    await run();
    await run({ kind: 'test', clientIds: [1] });
    runs.set('NOW', { run_id: 'NOW', kind: 'scheduled', status: 'running', heartbeat_at: new Date(), started_at: new Date(), progress: { reports_done: 5, reports_total: 900 }, clients: [{}], owner: {} });
    const s = await backup.getStatus();
    eq(s.last.sequence, 1);
    eq(s.last.clients, undefined);
    eq([s.running.run_id, s.running.progress.reports_done], ['NOW', 5]);
    eq(s.schedule.description, 'Every Friday at 22:00 (UK time)');
    eq(s.folder_url, 'https://drive.google.com/drive/folders/ROOT');
  });

  // ── Route ─────────────────────────────────────────────────────────────────────
  const app = express();
  app.use('/api/plextrac', require('../routes/plextrac-backup'));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/plextrac`;

  await test('GET /backups/status needs the portal key', async () => {
    reset();
    eq((await fetch(`${base}/backups/status`)).status, 401);
    const res = await fetch(`${base}/backups/status`, { headers: { 'X-API-Key': 'portal-key' } });
    eq(res.status, 200);
    eq((await res.json()).backup.schedule.timezone, 'Europe/London');
  });

  server.close();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
