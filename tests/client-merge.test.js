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

  clientDocuments.startClientDocuments = async ({ reportId }) => DOCUMENTS.map((doc) => (hooks.docFails?.(reportId, doc.key)
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
  keep_client: { id: 10, name: 'Acme Ltd' }, merge_clients: [{ id: 20, name: 'Acme Limited' }],
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
    eq([job.merge_clients[0].state, job.merge_clients[0].deleted], ['merged', true]);
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

  await test('a role that may not delete clients: reports moved, client left empty, the fix named', async () => {
    reset();
    api.deleteClient = async (id) => {
      throw new Error(`Plextrac API DELETE /api/v1/client/${id} failed (HTTP 403): {"statusCode":403,"error":"Forbidden","message":"User is not authorized to perform this action.","status":"error"}`);
    };
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq(calls.deletes, [201, 202]);
    eq([job.merge_clients[0].state, job.merge_clients[0].failed_at, job.merge_clients[0].alias_saved], ['failed', 'deleting', true]);
    eq(/role is not allowed to delete clients.*deleting it by hand in Plextrac finishes this merge/.test(job.error), true);
  });

  await test('a report added to the removed client mid-merge keeps the client', async () => {
    reset();
    let added = false;
    hooks.afterImport = () => {
      if (!added) { added = true; pt.reports[20].push(report(299, 'Brand new')); }
    };
    const job = await quiet(() => merge.runMerge(newJob()));
    eq(job.status, 'failed');
    eq([job.merge_clients[0].state, job.merge_clients[0].failed_at], ['failed', 'deleting']);
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

  await test('startMerge needs the kept client named, different clients, and no merge in flight', async () => {
    reset();
    pt.clients[30] = { client_id: 30, name: 'ACME Corp' };
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 30], confirmClientName: 'Acme' }),
      (err) => err.status === 400 && /being kept \("Acme Ltd"\)/.test(err.message));
    // With several clients, naming one of the removed ones is not enough.
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 30], confirmClientName: 'Acme Limited' }), /being kept/);
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 10], confirmClientName: 'Acme Ltd' }), /kept client cannot also be merged/);
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 20], confirmClientName: 'Acme Ltd' }), /listed twice/);
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [], confirmClientName: 'Acme Ltd' }), /at least one client/);
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 99], confirmClientName: 'Acme Ltd' }), (err) => err.status === 404);
    process.env.CLIENT_MERGE_MAX_CLIENTS = '1';
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 30], confirmClientName: 'Acme Ltd' }), /At most 1 clients/);
    delete process.env.CLIENT_MERGE_MAX_CLIENTS;
    hooks.active = { merge_id: 'OLD', status: 'running' };
    await assert.rejects(merge.startMerge({ keepClientId: 10, mergeClientIds: [20, 30], confirmClientName: ' acme  ltd ' }),
      (err) => err.status === 409);
  });

  await test('one client to merge: the old single-client request still works, confirmed by either name', async () => {
    reset();
    for (const confirmClientName of ['Acme Limited', 'Acme Ltd']) {
      const started = await quiet(() => merge.startMerge({ keepClientId: 10, mergeClientId: 20, confirmClientName }));
      eq(started.merge_clients, [{ id: 20, name: 'Acme Limited', state: 'pending' }]);
      await quiet(() => new Promise((r) => setTimeout(r, 200))); // let the background run finish
      reset();
    }
  });

  // ── Several clients at once ─────────────────────────────────────────────────
  const three = () => {
    pt.clients[30] = { client_id: 30, name: 'ACME Corp' };
    pt.clients[40] = { client_id: 40, name: 'Acme (old)' };
    pt.reports[30] = [report(301, 'Acme | Mobile | Mar 2026')];
    pt.reports[40] = [report(401, 'Acme | API | Apr 2026'), report(402, 'Acme | Cloud | May 2026')];
    return newJob({ merge_clients: [{ id: 20, name: 'Acme Limited' }, { id: 30, name: 'ACME Corp' }, { id: 40, name: 'Acme (old)' }] });
  };

  await test('three clients into one: all backed up once, every report moved, every client deleted', async () => {
    reset();
    const job = await quiet(() => merge.runMerge(three()));
    eq(job.status, 'completed');
    eq(job.merge_clients.map((c) => [c.id, c.state, c.deleted]), [[20, 'merged', true], [30, 'merged', true], [40, 'merged', true]]);
    eq(calls.clientDeletes, [20, 30, 40]);
    eq(calls.aliases.map((a) => [a.aliasName, a.clientId]), [['Acme Limited', 10], ['ACME Corp', 10], ['Acme (old)', 10]]);
    // The kept client's report is backed up once, alongside every report being moved.
    eq(job.reports.map((r) => [r.report_id, r.role, r.backup.ok]),
      [[201, 'move', true], [202, 'move', true], [301, 'move', true], [401, 'move', true], [402, 'move', true], [101, 'keep', true]]);
    eq(calls.imports.map((i) => [i.clientId, i.from]), [[10, 201], [10, 202], [10, 301], [10, 401], [10, 402]]);
    eq(calls.deletes, [201, 202, 301, 401, 402]);
    eq(pt.reports[10].length, 6);
    eq(job.drive_folder.name.startsWith('Acme Limited + 2 more - Acme Ltd Merge - '), true);
    eq(calls.uploads.filter((u) => u.filename === 'client.json').length, 4);
    eq(/"Acme Limited", "ACME Corp", "Acme \(old\)" merged into .*3 old clients deleted/.test(calls.notify[0]), true);
  });

  await test('a client whose backup fails is skipped untouched; the others are merged', async () => {
    reset();
    hooks.exportFails = (reportId) => reportId === 301;
    const job = await quiet(() => merge.runMerge(three()));
    eq(job.status, 'partial');
    eq(job.merge_clients.map((c) => [c.id, c.state]), [[20, 'merged'], [30, 'skipped'], [40, 'merged']]);
    eq(calls.imports.some((i) => i.from === 301), false);
    eq([calls.deletes.includes(301), calls.clientDeletes], [false, [20, 40]]);
    eq(pt.reports[30].map((r) => r.id), [301]);
    eq(/nothing of this client was changed/.test(job.merge_clients[1].error), true);
    eq(/"ACME Corp"/.test(job.error), true);
    eq(/2 of 3 client\(s\) merged.*NOT merged: "ACME Corp"/.test(calls.notify[0]), true);
  });

  await test('a client that fails mid-move keeps its other reports; the merge goes on', async () => {
    reset();
    // The first of 40's two reports is edited during the merge.
    hooks.afterImport = (ptrac) => { if (ptrac.report_info.id === 401) findReport(40, 401).edits++; };
    const job = await quiet(() => merge.runMerge(three()));
    eq(job.status, 'partial');
    eq(job.merge_clients.map((c) => [c.id, c.state]), [[20, 'merged'], [30, 'merged'], [40, 'failed']]);
    eq(job.merge_clients[2].failed_at, 'moving');
    eq(/edited during the merge/.test(job.merge_clients[2].error), true);
    // 401 not deleted, 402 never started, client 40 kept.
    eq(calls.deletes, [201, 202, 301]);
    eq(calls.imports.some((i) => i.from === 402), false);
    eq(job.reports.find((r) => r.report_id === 402).move.state, 'pending');
    eq(pt.clients[40] !== undefined, true);
  });

  await test('a failure on the first client does not stop the ones after it', async () => {
    reset();
    let n = 0;
    api.deleteReport = async (c, r) => { // only the very first delete (client 20's) is ignored
      calls.deletes.push(Number(r));
      if (n++ > 0) pt.reports[Number(c)] = pt.reports[Number(c)].filter((x) => x.id !== Number(r));
    };
    const job = await quiet(() => merge.runMerge(three()));
    eq(job.merge_clients.map((c) => c.state), ['failed', 'merged', 'merged']);
    eq(job.status, 'partial');
    eq(calls.clientDeletes, [30, 40]);
  });

  await test('the kept client failing to back up stops everything, whatever the other clients', async () => {
    reset();
    hooks.exportFails = (reportId) => reportId === 101;
    const job = await quiet(() => merge.runMerge(three()));
    eq(job.status, 'failed');
    eq(/kept client "Acme Ltd" could not be backed up.*nothing was changed in Plextrac/.test(job.error), true);
    eq([calls.imports.length, calls.clientDeletes.length], [0, 0]);
  });

  await test('preview of several clients: each one\'s reports, clashes and totals', async () => {
    reset();
    const job = three();
    const p = await merge.preview({ keepClientId: 10, mergeClientIds: job.merge_clients.map((c) => c.id) });
    eq(p.merges.map((m) => [m.name, m.reports.length, m.nameClashes]),
      [['Acme Limited', 2, ['Acme | Web | Jan 2026']], ['ACME Corp', 1, []], ['Acme (old)', 2, []]]);
    eq(p.nameClashes, ['Acme | Web | Jan 2026']);
    eq(p.backup.reports, 6);
    eq(p.backup.folderName.startsWith('Acme Limited + 2 more - Acme Ltd Merge - '), true);
    eq(p.linkedTotals, { clickupTasks: 0, deliveryflowEngagements: 0 });
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
    eq(v.progress, { reports: 3, backedUp: 3, backupFailed: 0, toMove: 2, moved: 2, clients: 1, clientsMerged: 1, clientsNotMerged: 0 });
    // A record saved before several clients could be merged reads as a list too.
    const old = require('../routes/client-merge').view({ ...job, merge_clients: undefined, merge_client: { id: 20, name: 'Acme Limited', state: 'merged' } });
    eq([old.merge_clients, 'merge_client' in old], [[{ id: 20, name: 'Acme Limited', state: 'merged' }], false]);
  });

  await test('POST /client-merges takes a list of clients, confirmed with the kept client\'s name', async () => {
    reset();
    pt.clients[30] = { client_id: 30, name: 'ACME Corp' };
    pt.reports[30] = [];
    const res = await quiet(() => call('/client-merges', { method: 'POST', body: { keepClientId: 10, mergeClientIds: [20, 30], confirmClientName: 'acme ltd' } }));
    eq(res.status, 202);
    eq(res.body.merge.merge_clients.map((c) => c.id), [20, 30]);
    eq(res.body.merge.progress.clients, 2);
    await quiet(() => new Promise((r) => setTimeout(r, 300)));
  });

  await test('GET /client-merges/preview takes mergeClientIds=20,30', async () => {
    reset();
    pt.clients[30] = { client_id: 30, name: 'ACME Corp' };
    pt.reports[30] = [report(301, 'Acme | Infra | Feb 2026')];
    const res = await call('/client-merges/preview?keepClientId=10&mergeClientIds=20,30');
    eq(res.status, 200);
    eq(res.body.preview.merges.map((m) => [m.id, m.reports.length]), [[20, 2], [30, 1]]);
    eq(res.body.preview.merge, undefined); // the single-client shape only for one client
  });

  server.close();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
