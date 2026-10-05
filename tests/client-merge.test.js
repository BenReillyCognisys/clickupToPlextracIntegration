const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

process.env.BREAK_SERVICES_API_KEY = 'portal-key';
process.env.PLEXTRAC_INSTANCE = 'test.plextrac.com';
process.env.CLIENT_MERGE_DRIVE_FOLDER_ID = 'ROOT';
process.env.CLIENT_MERGE_IMPORT_WAIT_MS = '50';
process.env.CLIENT_MERGE_POLL_MS = '1';

// ── Stub the outbound helpers ─────────────────────────────────────────────────
// The merge calls through these module objects at runtime, so replacing their exports
// keeps every test off Plextrac, Drive, MongoDB, DeliveryFlow and Slack.
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const store = require('../lib/client-merge-store');
const deliveryflow = require('../lib/deliveryflow-api');
const clientDocuments = require('../pipeline/client-documents');
const suppression = require('../lib/webhook-suppression');
const statusStore = require('../lib/report-status-store');
const reportCounts = require('../lib/plextrac-report-counts');
const log = require('../lib/logger');
const DOCUMENTS = require('../config/client-documents');

const merge = require('../pipeline/client-merge');
const { findOrCreateClient } = require('../pipeline/plextrac-client');

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const PDF = Buffer.from('%PDF-1.7 test');

// ── A tiny Plextrac ───────────────────────────────────────────────────────────
let pt; // { clients: {id: {client_id, name}}, reports: {clientId: [report]}, artifacts: {reportId: [..]} }
let nextReportId;
let calls;
let hooks; // per-test behaviour switches

function report(id, name, { status = 'Published', findings = 2, media = 3, cuid = `cuid-${id}` } = {}) {
  return { id, name, status, cuid, findings, media, edits: 0 };
}

function ptracOf(clientId, r) {
  return {
    report_info: { id: r.id, cuid: r.cuid, client_id: clientId, name: r.name, status: r.status },
    flaws_array: Array.from({ length: r.findings }, (_, i) => ({ flaw_id: i })),
    summary: { ReportMedia: Object.fromEntries(Array.from({ length: r.media }, (_, i) => [`${i}.png`, {}])) },
    evidence: [], client_info: { client_id: clientId },
  };
}

const findReport = (clientId, reportId) => (pt.reports[clientId] || []).find((r) => r.id === Number(reportId));

function reset() {
  pt = {
    clients: { 10: { client_id: 10, name: 'Acme Ltd' }, 20: { client_id: 20, name: 'Acme Limited' } },
    reports: {
      10: [report(101, 'Acme | Web | Jan 2026')],
      20: [report(201, 'Acme | Infra | Feb 2026'), report(202, 'Acme | Web | Jan 2026', { findings: 5 })],
    },
    artifacts: { 202: [{ id: 'A1', filename: 'scope.pdf', content_type: 'application/pdf', size: PDF.length, description: 'scope' }] },
  };
  nextReportId = 900;
  hooks = {};
  calls = { imports: [], deletes: [], clientDeletes: [], uploads: [], artifactUploads: [], repoint: [], aliases: [], saves: 0, events: [], notify: [], statuses: [] };
  suppression.clear();

  api.listClients = async () => Object.values(pt.clients).map((c) => ({ id: `client_${c.client_id}`, data: [c.client_id, c.name, null] }));
  api.getClient = async (id) => {
    const c = pt.clients[Number(id)];
    if (!c) throw new Error(`Plextrac API GET /api/v1/client/${id} failed (HTTP 404): not found`);
    return { ...c, logo: 'BIGLOGO' };
  };
  api.listClientReports = async (id) => (pt.reports[Number(id)] || []).map((r) => ({ id: r.id, data: [r.id, r.name, null, r.status] }));
  api.getReport = async (c, r) => { const x = findReport(Number(c), r); return x && { id: x.id, name: x.name, status: x.status, edits: x.edits }; };
  api.listReportFindings = async (c, r) => {
    const x = findReport(Number(c), r);
    return Array.from({ length: x.findings }, (_, i) => ({ data: [i, 'High', 't', 'Open', 1000 + x.edits] }));
  };
  api.exportReportPtrac = async (c, r) => {
    if (hooks.exportFails?.(Number(r))) throw new Error('export refused');
    const x = findReport(Number(c), r);
    if (!x) throw new Error('404');
    const ptrac = ptracOf(Number(c), x);
    return { buffer: Buffer.from(JSON.stringify(ptrac)), ptrac };
  };
  api.importReportPtrac = async (clientId, buffer) => {
    const ptrac = JSON.parse(buffer.toString('utf8'));
    calls.imports.push({ clientId, from: ptrac.report_info.id });
    const info = ptrac.report_info;
    const copy = report(nextReportId++, hooks.importName ? hooks.importName(info.name) : info.name, {
      status: hooks.importStatus || info.status,
      findings: hooks.importFindings ?? ptrac.flaws_array.length,
      media: Object.keys(ptrac.summary.ReportMedia).length,
    });
    pt.reports[clientId].push(copy);
    hooks.afterImport?.(ptrac);
    return { status: 'success' };
  };
  api.updateReport = async (c, r, payload) => { Object.assign(findReport(Number(c), r), payload); };
  api.deleteReport = async (c, r) => {
    calls.deletes.push(Number(r));
    if (!hooks.deleteIgnored) pt.reports[Number(c)] = pt.reports[Number(c)].filter((x) => x.id !== Number(r));
  };
  api.deleteClient = async (id) => { calls.clientDeletes.push(Number(id)); delete pt.clients[Number(id)]; };
  api.listReportArtifacts = async (c, r) => pt.artifacts[Number(r)] || [];
  api.downloadArtifact = async () => ({ buffer: PDF, contentType: 'application/pdf' });
  api.uploadReportArtifact = async (c, r, file) => {
    calls.artifactUploads.push({ c, r, filename: file.filename });
    (pt.artifacts[r] ||= []).push({ id: `N${calls.artifactUploads.length}`, filename: file.filename });
    return `N${calls.artifactUploads.length}`;
  };

  // Drive: an in-memory file store that reports the real MD5 (or a wrong one, when told).
  const files = {};
  let folderSeq = 0;
  drive.resolveFolder = async ({ folderId, subfolder }) => `${folderId}/${subfolder}#${++folderSeq}`;
  drive.uploadFile = async ({ buffer, filename, folderId }) => {
    const fileId = `file-${Object.keys(files).length + 1}`;
    files[fileId] = Buffer.from(buffer);
    calls.uploads.push({ filename, folderId });
    const sum = hooks.badMd5?.(filename) ? 'deadbeef' : md5(buffer);
    return { fileId, url: `https://drive/${fileId}`, name: filename, folderId, md5Checksum: sum };
  };
  drive.downloadFileById = async (fileId) => ({ buffer: files[fileId], md5Checksum: md5(files[fileId]) });

  clientDocuments.generateClientDocuments = async ({ reportId }) => DOCUMENTS.map((doc) => (hooks.docFails?.(reportId, doc.key)
    ? { doc, ok: false, error: 'Rendering failed: boom' }
    : { doc, ok: true, buffer: PDF, filename: `${doc.name} 2026-10-05 10-00-00.pdf` }));

  // MongoDB
  store.saveMerge = async () => { calls.saves++; };
  store.findActiveMerge = async () => hooks.active || null;
  store.linkedRecords = async () => ({ clickupTasks: [], deliveryflowEngagements: [] });
  store.repointReport = async (args) => {
    calls.repoint.push(args);
    return { counts: { task_mappings: 1 }, engagements: args.oldReportId === 202 ? [{ engagementId: 'E1', dealId: 'D1' }] : [] };
  };
  store.repointClient = async () => ({ task_mappings: 0 });
  store.repointAliases = async () => {};
  store.saveAlias = async (a) => { calls.aliases.push(a); };
  store.findAlias = async () => hooks.alias || null;
  statusStore.set = async ({ reportId, status }) => { calls.statuses.push([reportId, status]); };

  deliveryflow.isConfigured = () => true;
  deliveryflow.sendEvent = async (event, ids, data) => { calls.events.push({ event, ids, data }); };
  log.notify = (text) => calls.notify.push(text);
}

const newJob = (overrides = {}) => ({
  merge_id: 'M1', status: 'queued', stage: 'queued',
  keep_client: { id: 10, name: 'Acme Ltd' }, merge_client: { id: 20, name: 'Acme Limited' },
  requested_by: 'admin@cognisys.co.uk', created_at: new Date(), reports: [], events: [], ...overrides,
});

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.log(`  ✗  ${description}\n     ${err.stack || err.message}`); failed++; });
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

// Silence the merge's own log lines in the test output.
const quiet = async (fn) => {
  const saved = [log.info, log.warn, log.error];
  log.info = log.warn = log.error = () => {};
  try { return await fn(); } finally { [log.info, log.warn, log.error] = saved; }
};

(async () => {
  console.log('\nclient merge\n');

  await test('a clean merge backs up both clients, moves every report, then deletes the client', async () => {
    reset();
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'completed');
    eq(job.client_deleted, true);
    eq(calls.clientDeletes, [20]);
    eq(pt.clients[20], undefined);

    // Every report of BOTH clients backed up: .ptrac + the three documents (+ artifacts).
    eq(job.reports.length, 3);
    for (const r of job.reports) {
      eq(r.backup.ok, true);
      eq(r.backup.files.filter((f) => f.kind === 'ptrac').length, 1);
      eq(r.backup.files.filter((f) => f.kind === 'document').map((f) => f.document), DOCUMENTS.map((d) => d.key));
    }
    eq(job.reports.find((r) => r.report_id === 202).backup.files.filter((f) => f.kind === 'artifact').length, 1);
    eq(calls.uploads.some((u) => u.filename === 'client.json'), true);
    eq(calls.uploads.some((u) => u.filename === 'manifest.json'), true);
    eq(job.drive_folder.name.startsWith('Acme Limited - Acme Ltd Merge - '), true);

    // Only the removed client's reports were imported, into the kept client, and each
    // original deleted after its copy.
    eq(calls.imports.map((i) => [i.clientId, i.from]), [[10, 201], [10, 202]]);
    eq(calls.deletes, [201, 202]);
    eq(pt.reports[10].map((r) => r.name).sort(), ['Acme | Infra | Feb 2026', 'Acme | Web | Jan 2026', 'Acme | Web | Jan 2026']);
    eq(calls.artifactUploads.map((a) => [a.r, a.filename]), [[901, 'scope.pdf']]);

    // Records re-pointed, DeliveryFlow told the new link, the old name kept as an alias.
    eq(calls.repoint.map((r) => [r.oldReportId, r.newReportId, r.newClientId]), [[201, 900, 10], [202, 901, 10]]);
    eq(calls.events, [{ event: 'report_status', ids: { engagementId: 'E1', dealId: 'D1' },
      data: { status: 'Published', reportId: '901', reportName: 'Acme | Web | Jan 2026', reportUrl: 'https://test.plextrac.com/client/10/report/901' } }]);
    eq(calls.aliases.map((a) => [a.aliasName, a.clientId]), [['Acme Limited', 10]]);
    eq(job.reports.filter((r) => r.role === 'move').map((r) => r.move.state), ['deleted', 'deleted']);
    eq(/merged into/.test(calls.notify[0]), true);
    // The client logo stays out of the merge record (it is in the backup's client.json).
    eq(JSON.stringify(job).includes('BIGLOGO'), false);
  });

  await test('a moved report\'s webhooks are ignored only briefly after its move, then flow again', async () => {
    reset();
    await quiet(() => merge.runMerge(newJob()));
    eq(await suppression.isSuppressed({ text: 'Acme Ltd||Acme | Infra | Feb 2026' }), true);
    eq(await suppression.isSuppressed({ cuid: 'cuid-900' }), true);
    // ...but not other reports of the kept client.
    eq(await suppression.isSuppressed({ text: 'Acme Ltd||Something Else' }), false);
    // Three minutes on, a real change (e.g. submitting it for QA) is handled again.
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000;
    try {
      eq(await quiet(() => suppression.isSuppressed({ text: 'Acme Ltd||Acme | Infra | Feb 2026' })), false);
      eq(await quiet(() => suppression.isSuppressed({ cuid: 'cuid-900' })), false);
    } finally {
      Date.now = realNow;
    }
    // The copies' statuses are on record for the status guard.
    eq(calls.statuses, [[900, 'Published'], [901, 'Published']]);
  });

  await test('the Plextrac webhook drops a suppressed report\'s status change, and handles others', async () => {
    reset();
    process.env.PLEXTRAC_WEBHOOK_SECRET = 'whsec';
    const handler = require('../routes/plextrac-webhook');
    const lookup = require('../lib/plextrac-lookup');
    const looked = [];
    lookup.resolveClientAndReport = async (names) => { looked.push(names.reportName); return null; };
    const deliver = async (text) => {
      const body = Buffer.from(JSON.stringify({ event: 'ReportStatusChanged', targetType: 'report', targetCuid: 'cuid-new', text }));
      const sig = crypto.createHmac('sha256', 'whsec').update(body.toString()).digest('hex');
      const res = { status() { return this; }, end() {} };
      await handler({ body, headers: { 'x-authorization-hmac-256': sig } }, res);
    };
    await suppression.suppress({ clientName: 'ZZ Merge Test B', reportName: 'ZZ Report' });
    await quiet(() => deliver('ZZ Merge Test B||ZZ Report'));
    eq(looked, []);
    await quiet(() => deliver('ZZ Merge Test B||Another Report'));
    eq(looked, ['Another Report']);
    await suppression.release({ clientName: 'ZZ Merge Test B', reportName: 'ZZ Report' });
    eq(await suppression.isSuppressed({ text: 'ZZ Merge Test B||ZZ Report' }), false);
  });

  await test('a document that fails to render stops the merge before anything changes', async () => {
    reset();
    hooks.docFails = (reportId, key) => reportId === 101 && key === 'letter-of-attestation';
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(job.stage, 'backup');
    eq(/nothing was changed in Plextrac/.test(job.error), true);
    eq([calls.imports.length, calls.deletes.length, calls.clientDeletes.length], [0, 0, 0]);
    eq(/Letter of Attestation/.test(job.reports.find((r) => r.report_id === 101).backup.error), true);
  });

  await test('a Drive copy whose MD5 does not match counts as a failed backup', async () => {
    reset();
    hooks.badMd5 = (filename) => filename.endsWith('.ptrac') && filename.startsWith('Acme Infra');
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(calls.imports.length, 0);
    eq(/does not match/.test(job.reports.find((r) => r.report_id === 201).backup.error), true);
  });

  await test('a .ptrac export failure stops the merge before anything changes', async () => {
    reset();
    hooks.exportFails = (reportId) => reportId === 101; // a report of the KEPT client
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq([calls.imports.length, calls.deletes.length], [0, 0]);
  });

  await test('an imported copy missing findings is not trusted: original and client are kept', async () => {
    reset();
    hooks.importFindings = 1;
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(calls.deletes, []);
    eq(calls.clientDeletes, []);
    const first = job.reports.find((r) => r.report_id === 201);
    eq(first.move.state, 'failed');
    eq(first.move.failed_at, 'imported');
    eq(/1 finding\(s\), original has 2/.test(first.move.error), true);
    eq(calls.imports.length, 1); // stopped at the first report
  });

  await test('a report edited during the merge is not deleted', async () => {
    reset();
    hooks.afterImport = (ptrac) => { if (ptrac.report_info.id === 201) findReport(20, 201).edits++; };
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(calls.deletes, []);
    eq(calls.repoint, []);
    eq(/edited during the merge/.test(job.error), true);
  });

  await test('a name or status the import did not keep is put back', async () => {
    reset();
    hooks.importName = (n) => `${n} (imported)`;
    hooks.importStatus = 'Draft';
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'completed');
    const copy = findReport(10, 900);
    eq([copy.name, copy.status], ['Acme | Infra | Feb 2026', 'Published']);
  });

  await test('a delete Plextrac accepts but does not carry out stops the merge', async () => {
    reset();
    hooks.deleteIgnored = true;
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(/still listed/.test(job.error), true);
    eq(calls.clientDeletes, []);
  });

  await test('a report added to the removed client mid-merge keeps the client', async () => {
    reset();
    let added = false;
    hooks.afterImport = () => {
      if (!added) { added = true; pt.reports[20].push(report(299, 'Brand new')); }
    };
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(job.stage, 'delete_client');
    eq(calls.clientDeletes, []);
    eq(calls.aliases, []);
    eq(/still has 1 report/.test(job.error), true);
  });

  await test('an empty client to remove: both backed up, client deleted', async () => {
    reset();
    pt.reports[20] = [];
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'completed');
    eq(calls.imports, []);
    eq(calls.clientDeletes, [20]);
    eq(job.reports.map((r) => r.backup.ok), [true]);
  });

  await test('startMerge needs the removed client named exactly, two different clients, and no merge in flight', async () => {
    reset();
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientId: 20, confirmClientName: 'Acme Ltd' }),
      (err) => err.status === 400 && /Acme Limited/.test(err.message));
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientId: 10, confirmClientName: 'Acme Ltd' }), /two different clients/);
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientId: 99, confirmClientName: 'x' }), (err) => err.status === 404);
    hooks.active = { merge_id: 'OLD', status: 'running' };
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientId: 20, confirmClientName: ' acme  limited ' }),
      (err) => err.status === 409);
  });

  await test('preview lists both clients\' reports and flags same-named reports', async () => {
    reset();
    const p = await merge.preview({ keepClientId: '10', mergeClientId: '20' });
    eq([p.keep.name, p.merge.name], ['Acme Ltd', 'Acme Limited']);
    eq(p.merge.reports.map((r) => r.id), [201, 202]);
    eq(p.nameClashes, ['Acme | Web | Jan 2026']);
    eq(p.backup.reports, 3);
    eq(p.backup.folderName.startsWith('Acme Limited - Acme Ltd Merge - '), true);
  });

  await test('findImported will not guess between two new reports with the same name', async () => {
    reset();
    pt.reports[10].push(report(950, 'Dup'), report(951, 'Dup'));
    await assert.rejects(merge.findImported({ clientId: 10, before: new Set([101]), name: 'Dup', reply: {} }), /2 reports named/);
  });

  await test('findOrCreateClient files a merged-away name under the client it was merged into', async () => {
    reset();
    delete pt.clients[20];
    hooks.alias = { client_id: 10 };
    let created = false;
    api.createClient = async () => { created = true; return { client_id: 77 }; };
    const out = await quiet(() => findOrCreateClient('Acme Limited'));
    eq(out, { clientId: 10, clientCreated: false });
    eq(created, false);
    // An alias store that can't be read doesn't stop a client being created.
    store.findAlias = async () => { throw new Error('mongo down'); };
    eq(await quiet(() => findOrCreateClient('Acme Limited')), { clientId: 77, clientCreated: true });
  });

  // ── Routes ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use('/api/plextrac', require('../routes/client-merge'));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/plextrac`;
  const call = (path, { method = 'GET', key = 'portal-key', body } = {}) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
    body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  await test('routes refuse a missing or wrong key', async () => {
    reset();
    eq((await call('/clients', { key: null })).status, 401);
    eq((await call('/clients', { key: 'nope' })).status, 401);
  });

  await test('GET /clients filters by name', async () => {
    reset();
    pt.clients[30] = { client_id: 30, name: 'Beta Corp' };
    const res = await call('/clients?q=acme');
    eq(res.body.clients.map((c) => c.name), ['Acme Limited', 'Acme Ltd']);
  });

  await test('GET /clients carries each client\'s report and published counts once counted', async () => {
    reset();
    reportCounts.reset();
    pt.reports[20][1].status = 'Draft';
    // Not counted yet: null counts, and a count starts in the background.
    const first = await call('/clients');
    eq(first.body.clients.map((c) => [c.name, c.reports, c.published]), [['Acme Limited', null, null], ['Acme Ltd', null, null]]);
    eq(first.body.counts.ready, false);
    await reportCounts.refreshAll();
    const res = await call('/clients');
    eq(res.body.clients.map((c) => [c.name, c.reports, c.published]), [['Acme Limited', 2, 1], ['Acme Ltd', 1, 1]]);
    eq(res.body.counts.ready, true);
  });

  await test('a merge recounts its two clients straight away', async () => {
    reset();
    reportCounts.reset();
    await reportCounts.refreshAll();
    await quiet(() => merge.runMerge(newJob()));
    const { counts } = reportCounts.current();
    eq(counts.get(10), { reports: 3, published: 3 });
    eq(counts.get(20)?.reports ?? 0, 0); // deleted: no reports (and gone from the client list)
  });

  await test('POST /client-merges answers 202, and a wrong confirmation 400', async () => {
    reset();
    eq((await call('/client-merges', { method: 'POST', body: { keepClientId: 10, mergeClientId: 20, confirmClientName: 'Acme' } })).status, 400);
    const res = await quiet(() => call('/client-merges', { method: 'POST', body: { keepClientId: 10, mergeClientId: 20, confirmClientName: 'Acme Limited', requestedBy: 'ben' } }));
    eq(res.status, 202);
    eq([res.body.merge.status, res.body.merge.requested_by], ['queued', 'ben']);
    await quiet(() => new Promise((r) => setTimeout(r, 300))); // let the background run finish
  });

  await test('the status view hides fingerprints and import replies', async () => {
    reset();
    const job = await quiet(() => merge.runMerge(newJob()));
    const v = require('../routes/client-merge').view(job);
    eq(JSON.stringify(v).includes('fingerprint'), false);
    eq(JSON.stringify(v).includes('import_reply'), false);
    eq(v.progress, { reports: 3, backedUp: 3, backupFailed: 0, toMove: 2, moved: 2 });
  });

  server.close();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
