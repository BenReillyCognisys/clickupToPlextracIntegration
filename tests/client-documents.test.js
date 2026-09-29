const assert = require('assert');

// Read at require time / call time by the modules under test.
process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID = 'FOLDER_REPORTS';

// ── Stub the outbound helpers ─────────────────────────────────────────────────
// The pipeline calls through these module objects at runtime, so mutating their
// exports keeps every test off Plextrac, Drive, Slack and the renderer.
const api = require('../lib/plextrac-api');
const renderer = require('../lib/pdf-renderer');
const drive = require('../lib/google-drive');
const slack = require('../lib/slack');
const reportExport = require('../pipeline/report-export');

const fx = require('./fixtures/client-report');
const data = require('../pipeline/client-documents/data');
const clientDocuments = require('../pipeline/client-documents');
// Kept before any test stubs it, for the tests that run the real thing.
const realGenerate = clientDocuments.generateClientDocuments;
const { runReleaseExports } = require('../pipeline/release-exports');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 0x20)]);
const EXPORTED_AT = new Date('2026-09-26T13:30:05Z');

const DOCS = [
  { key: 'exec-summary', name: 'Executive Summary Report', template: 'exec.j2', enabledBy: 'TEST_EXEC_ENABLED' },
  { key: 'letter-of-attestation', name: 'Letter of Attestation', template: 'loa.j2', enabledBy: 'TEST_LOA_ENABLED' },
];

let calls;
function reset() {
  calls = { getReport: [], render: [], uploads: [], artifacts: [], replies: [], resolveFolder: [], exportFull: [] };
  api.getReport = async (c, r) => { calls.getReport.push([c, r]); return structuredClone(fx.report); };
  api.getClient = async () => structuredClone(fx.clientRecord);
  api.listReportFindings = async () => structuredClone(fx.findings);
  api.uploadReportArtifact = async (c, r, file) => { calls.artifacts.push({ c, r, filename: file.filename }); return `ART-${calls.artifacts.length}`; };
  api.listReportArtifacts = async () => calls.artifacts.map((_, i) => ({ id: `ART-${i + 1}` }));
  renderer.templateExists = () => true;
  renderer.renderTemplates = async (jobs) => {
    calls.render.push(jobs);
    return new Map(jobs.map((j) => [j.id, { ok: true, buffer: PDF, warnings: [] }]));
  };
  drive.uploadFile = async (args) => { calls.uploads.push(args); return { fileId: `F${calls.uploads.length}`, folderId: args.folderId, name: args.filename }; };
  slack.postReply = async (channel, threadTs, text) => { calls.replies.push(text); };
  slack.postMessage = async (channel, text) => { calls.replies.push(text); };
  reportExport.resolveReleaseFolder = async (job) => { calls.resolveFolder.push(job); return 'FOLDER_CLIENT_MONTH'; };
  reportExport.exportReleasedReport = async (args) => {
    calls.exportFull.push(args);
    return { driveFile: args.folderId ? { fileId: 'FULL' } : null, artifactId: 'ART-FULL' };
  };
}

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const facts = () => ({ report: fx.report, clientRecord: fx.clientRecord, findings: fx.findings, exportedAt: EXPORTED_AT });

(async () => {
  console.log('Plextrac findings:');

  await test("the list endpoint's positional rows become { severity, title }", () => {
    const rows = [
      { id: 'f1', doc_id: [1, 2], data: [101, 'High', 'SQL Injection', 'Open', 0, {}, 0, {}, 0, {}, 'x', ''] },
      { id: 'f2', doc_id: [1, 2], data: [102, 'Low', 'Missing HSTS', 'Open', 0, {}, 0, {}, 0, {}, 'x', ''] },
    ];
    eq(data.normaliseFindings(rows), [
      { flaw_id: 101, severity: 'High', title: 'SQL Injection', status: 'Open' },
      { flaw_id: 102, severity: 'Low', title: 'Missing HSTS', status: 'Open' },
    ]);
    eq(data.findingSummary(data.normaliseFindings(rows)).high, { total: 1 });
  });

  await test('object-shaped findings and { data: [...] } responses pass through', () => {
    eq(data.normaliseFindings({ data: [{ title: 'A', severity: 'Low' }] }), [{ title: 'A', severity: 'Low' }]);
    eq(data.normaliseFindings(null), []);
  });

  console.log('\ntemplate context — the client documents get a reduced report:');

  const ctx = () => data.templateContext(facts());

  await test('findings carry only title and severity — no write-up text anywhere in the context', () => {
    eq(ctx().FINDINGS[0], { title: 'SQL Injection in login', severity: 'High' });
    eq(ctx().FINDINGS.length, 4);
    eq(JSON.stringify(ctx()).includes(fx.SECRET), false);
  });

  await test('only allow-listed report and client keys pass through', () => {
    eq(Object.keys(ctx().REPORT_INFO).sort(), ['custom_field', 'end_date', 'exec_summary', 'export_datetime_us', 'name', 'start_date', 'tags']);
    eq(Object.keys(ctx().CLIENT_INFO).sort(), ['name', 'tags']);
  });

  await test('narratives are passed through unchanged, in full', () => {
    eq(ctx().REPORT_INFO.exec_summary, fx.report.exec_summary);
  });

  await test('the source report object is not shared with the context', () => {
    ctx().REPORT_INFO.exec_summary.custom_fields[5].text = 'changed';
    eq(fx.report.exec_summary.custom_fields[5].text.startsWith('<p>ORIGINAL'), true);
  });

  await test('issue date in the month-first shape the templates parse (UK time)', () => {
    eq(ctx().REPORT_INFO.export_datetime_us, '09-26-2026 14:30');
  });

  await test('severity counts in the FINDING_SUMMARY shape', () => {
    eq(ctx().FINDING_SUMMARY.high, { total: 2 });
    eq(ctx().FINDING_SUMMARY.totals, { total_reported: 4 });
  });

  console.log('\ngenerateClientDocuments:');

  const job = { clientId: 12, reportId: 34, exportedAt: EXPORTED_AT, documents: DOCS };

  await test('makes every document, renders them in ONE renderer run, names them by the release time', async () => {
    reset();
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out.map((d) => [d.doc.key, d.ok, d.filename]), [
      ['exec-summary', true, 'Executive Summary Report 2026-09-26 14-30-05.pdf'],
      ['letter-of-attestation', true, 'Letter of Attestation 2026-09-26 14-30-05.pdf'],
    ]);
    eq(calls.render.length, 1);
    eq(calls.render[0].map((j) => j.template), ['exec.j2', 'loa.j2']);
    eq(calls.getReport, [[12, 34]]);
  });

  await test('both templates get the same reduced context, built from this report', async () => {
    reset();
    await clientDocuments.generateClientDocuments(job);
    const [a, b] = calls.render[0].map((j) => j.context);
    eq(a, b);
    eq(a.CLIENT_INFO.name, 'Acme Corp');
    eq(a.FINDINGS.length, 4);
  });

  await test('a report that belongs to another client is refused outright', async () => {
    reset();
    api.getReport = async () => ({ ...fx.report, client_id: 99 });
    await assert.rejects(clientDocuments.generateClientDocuments(job), /belongs to client 99, not 12/);
    eq(calls.render.length, 0);
  });

  await test('one document failing leaves the other intact', async () => {
    reset();
    renderer.renderTemplates = async (jobs) => new Map(jobs.map((j) => [j.id, j.id === 'letter-of-attestation'
      ? { ok: false, error: 'UndefinedError: boom' }
      : { ok: true, buffer: PDF, warnings: [] }]));
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out[0].ok, true);
    eq(out[1].ok, false);
    eq(out[1].error, 'Rendering failed: UndefinedError: boom');
  });

  // Runs fn with .env switches set, restoring them afterwards.
  const withEnv = async (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  await test('both documents are made when their switches are unset (on by default)', async () => {
    reset();
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out.map((d) => d.doc.key), ['exec-summary', 'letter-of-attestation']);
  });

  await test('switching off the executive summary leaves only the letter', async () => {
    reset();
    const out = await withEnv({ TEST_EXEC_ENABLED: 'false' }, () => clientDocuments.generateClientDocuments(job));
    eq(out.map((d) => d.doc.key), ['letter-of-attestation']);
    eq(calls.render[0].map((j) => j.template), ['loa.j2']);
  });

  await test('switching off the letter leaves only the executive summary', async () => {
    reset();
    const out = await withEnv({ TEST_LOA_ENABLED: 'false' }, () => clientDocuments.generateClientDocuments(job));
    eq(out.map((d) => d.doc.key), ['exec-summary']);
  });

  await test('both off: nothing made, and Plextrac is not even asked for the data', async () => {
    reset();
    const out = await withEnv({ TEST_EXEC_ENABLED: 'false', TEST_LOA_ENABLED: 'false' },
      () => clientDocuments.generateClientDocuments(job));
    eq(out, []);
    eq(calls.getReport.length, 0);
    eq(calls.render.length, 0);
  });

  await test('false / 0 / off / no (any case) switch off; anything else — or unset — leaves on', () => {
    for (const v of ['false', 'FALSE', '0', 'off', 'Off', 'no', ' false ']) {
      process.env.TEST_EXEC_ENABLED = v;
      eq([v, clientDocuments.isEnabled(DOCS[0])], [v, false]);
    }
    for (const v of ['true', '1', 'on', 'yes', '']) {
      process.env.TEST_EXEC_ENABLED = v;
      eq([v, clientDocuments.isEnabled(DOCS[0])], [v, true]);
    }
    delete process.env.TEST_EXEC_ENABLED;
    eq(clientDocuments.isEnabled(DOCS[0]), true);
  });

  await test('previews ignore the switches', async () => {
    reset();
    const out = await withEnv({ TEST_EXEC_ENABLED: 'off', TEST_LOA_ENABLED: 'off' },
      () => clientDocuments.generateClientDocuments({ ...job, respectSwitches: false }));
    eq(out.map((d) => d.doc.key), ['exec-summary', 'letter-of-attestation']);
  });

  await test('the real config gives each document its own switch', () => {
    const real = require('../config/client-documents');
    eq(real.map((d) => [d.key, d.enabledBy]), [
      ['exec-summary', 'CLIENT_DOCS_EXEC_SUMMARY_ENABLED'],
      ['letter-of-attestation', 'CLIENT_DOCS_LETTER_OF_ATTESTATION_ENABLED'],
    ]);
  });

  await test('a document without its template is skipped, not failed', async () => {
    reset();
    renderer.templateExists = (t) => t === 'exec.j2';
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out.map((d) => d.doc.key), ['exec-summary']);
  });

  await test('renderer output that is not a PDF is not treated as one', async () => {
    reset();
    renderer.renderTemplates = async (jobs) => new Map(jobs.map((j) => [j.id, { ok: true, buffer: Buffer.from('<html>'), warnings: [] }]));
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out.every((d) => !d.ok && /not a PDF/.test(d.error)), true);
  });

  console.log('\npublishClientDocument:');

  const doc = () => ({ doc: DOCS[0], ok: true, buffer: PDF, filename: 'Executive Summary Report 2026-09-26 14-30-05.pdf' });

  await test('files into exactly the folder given, and onto this report in Plextrac', async () => {
    reset();
    const out = await clientDocuments.publishClientDocument({ document: doc(), folderId: 'FOLDER_X', clientId: 12, reportId: 34 });
    eq(calls.uploads.map((u) => [u.folderId, u.sequencedSubfolder, u.subfolder]), [['FOLDER_X', undefined, undefined]]);
    eq(calls.artifacts, [{ c: 12, r: 34, filename: 'Executive Summary Report 2026-09-26 14-30-05.pdf' }]);
    eq(out.errors, []);
  });

  await test('an artifact that does not list on the report is flagged', async () => {
    reset();
    api.listReportArtifacts = async () => [];
    const out = await clientDocuments.publishClientDocument({ document: doc(), folderId: 'FOLDER_X', clientId: 12, reportId: 34 });
    eq(out.errors.length, 1);
    eq(/does not list on report 34/.test(out.errors[0]), true);
  });

  await test('a Drive failure does not stop the Plextrac upload (and vice versa)', async () => {
    reset();
    drive.uploadFile = async () => { throw new Error('quota'); };
    const out = await clientDocuments.publishClientDocument({ document: doc(), folderId: 'FOLDER_X', clientId: 12, reportId: 34 });
    eq(out.artifactId, 'ART-1');
    eq(out.errors, ['Drive upload failed: quota']);
  });

  await test('no folder (Drive off or failed) still uploads to Plextrac', async () => {
    reset();
    await clientDocuments.publishClientDocument({ document: doc(), folderId: null, clientId: 12, reportId: 34 });
    eq(calls.uploads.length, 0);
    eq(calls.artifacts.length, 1);
  });

  console.log('\nrunReleaseExports — the release as a whole:');

  const release = { clientId: 12, reportId: 34, clientName: 'Acme Corp', reportName: 'Web App', channel: 'C1', threadTs: 't1' };
  const stubDocuments = () => {
    clientDocuments.generateClientDocuments = async (j) => DOCS.map((d) => ({
      doc: d, ok: true, buffer: PDF, filename: `${d.name} ${j.exportedAt.toISOString()}.pdf`,
    }));
  };

  await test('resolves the folder ONCE and files everything into it, silently on success', async () => {
    reset(); stubDocuments();
    await runReleaseExports(release);
    eq(calls.resolveFolder.length, 1);
    eq(calls.exportFull.map((a) => a.folderId), ['FOLDER_CLIENT_MONTH']);
    eq(calls.uploads.map((u) => u.folderId), ['FOLDER_CLIENT_MONTH', 'FOLDER_CLIENT_MONTH']);
    eq(calls.artifacts.map((a) => [a.c, a.r]), [[12, 34], [12, 34]]);
    eq(calls.replies, []);
  });

  await test('one export time for the full report and every document', async () => {
    reset(); stubDocuments();
    await runReleaseExports(release);
    const t = calls.exportFull[0].exportedAt;
    eq(calls.uploads.every((u) => u.filename.includes(t.toISOString())), true);
    // The filename time is claimed in the folder, so it may move on from the time
    // the folder was resolved for — but never backwards.
    eq(t >= calls.resolveFolder[0].exportedAt, true);
  });

  await test('two releases for one client in the same second get different filename times', async () => {
    reset(); stubDocuments();
    await Promise.all([runReleaseExports(release), runReleaseExports({ ...release, reportId: 35 })]);
    const [a, b] = calls.exportFull.map((c) => reportExport.reportFilename({ date: c.exportedAt }));
    eq(a === b, false);
  });

  await test('every Drive upload of a release refuses to overwrite', async () => {
    reset(); stubDocuments();
    await runReleaseExports(release);
    eq(calls.uploads.every((u) => u.overwrite === false), true);
  });

  await test('two releases of the same report run one after the other, never interleaved', async () => {
    reset();
    const order = [];
    let n = 0;
    clientDocuments.generateClientDocuments = async () => {
      const run = ++n;
      order.push(`start ${run}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end ${run}`);
      return [];
    };
    await Promise.all([runReleaseExports(release), runReleaseExports(release)]);
    eq(order, ['start 1', 'end 1', 'start 2', 'end 2']);
  });

  await test('different reports are not held up by each other', async () => {
    reset();
    const order = [];
    clientDocuments.generateClientDocuments = async (j) => {
      order.push(`start ${j.reportId}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end ${j.reportId}`);
      return [];
    };
    await Promise.all([runReleaseExports(release), runReleaseExports({ ...release, reportId: 35 })]);
    eq(order.slice(0, 2), ['start 34', 'start 35']);
  });

  await test('a Drive folder failure files nothing in Drive but still uploads to Plextrac, and says so', async () => {
    reset(); stubDocuments();
    reportExport.resolveReleaseFolder = async () => { throw new Error('insufficientPermissions'); };
    await runReleaseExports(release);
    // The full report still runs, told not to file in Drive.
    eq(calls.exportFull.map((a) => a.folderId), [null]);
    eq(calls.uploads.length, 0);
    eq(calls.artifacts.length, 2);
    eq(calls.replies.length, 1);
    eq(/nothing was filed in Drive: insufficientPermissions/.test(calls.replies[0]), true);
  });

  await test('document failures are listed together in one thread reply', async () => {
    reset();
    clientDocuments.generateClientDocuments = async () => DOCS.map((d) => ({ doc: d, ok: false, error: 'Rendering failed: boom' }));
    await runReleaseExports(release);
    eq(calls.replies.length, 1);
    eq(calls.replies[0].includes('Executive Summary Report: Rendering failed'), true);
    eq(calls.replies[0].includes('Letter of Attestation: Rendering failed'), true);
  });

  // Captures what a run writes to the console (PM2), as [level, message, data].
  const captureLog = async (fn) => {
    const log = require('../lib/logger');
    const saved = { info: log.info, warn: log.warn, error: log.error };
    const lines = [];
    for (const level of ['info', 'warn', 'error']) log[level] = (message, data) => lines.push([level, message, data || {}]);
    try { await fn(); } finally { Object.assign(log, saved); }
    return lines.filter(([, m]) => m.startsWith('Release export'));
  };

  await test('the console shows the release start to finish, in order', async () => {
    reset(); stubDocuments();
    const lines = await captureLog(() => runReleaseExports(release));
    eq(lines.map(([level, m]) => `${level} ${m}`), [
      'info Release export STARTED',
      'info Release export: Drive folder ready',
      'info Release export: Executive Summary Report rendered',
      'info Release export: Letter of Attestation rendered',
      'info Release export: Executive Summary Report uploaded to Drive',
      'info Release export: Executive Summary Report uploaded to Plextrac',
      'info Release export: Letter of Attestation uploaded to Drive',
      'info Release export: Letter of Attestation uploaded to Plextrac',
      'info Release export FINISHED',
    ]);
    // Every line can be tied to its release.
    eq(lines.every(([, , d]) => d.report_id === 34), true);
  });

  await test('the start and Plextrac upload lines name the Plextrac project, with a link', async () => {
    reset(); stubDocuments();
    const lines = await captureLog(() => runReleaseExports(release));
    const project = {
      client: 'Acme Corp', report: 'Web App', client_id: 12, report_id: 34,
      plextrac: 'https://cognisys.plextrac.com/client/12/report/34',
    };
    eq(lines[0][2], project);
    const upload = lines.find(([, m]) => m === 'Release export: Letter of Attestation uploaded to Plextrac')[2];
    eq({ ...upload, file: undefined, artifact_id: undefined }, { ...project, file: undefined, artifact_id: undefined });
    eq(typeof upload.artifact_id, 'string');
  });

  await test('the finish line totals what was filed', async () => {
    reset(); stubDocuments();
    const lines = await captureLog(() => runReleaseExports(release));
    const done = lines[lines.length - 1][2];
    eq([done.drive_files, done.plextrac_artifacts], [3, 3]);
    eq(/^\d+\.\ds$/.test(done.took), true);
  });

  await test('a failure is an ERROR line, and the run finishes WITH PROBLEMS', async () => {
    reset(); stubDocuments();
    api.uploadReportArtifact = async () => { throw new Error('HTTP 400'); };
    const lines = await captureLog(() => runReleaseExports(release));
    eq(lines.filter(([level]) => level === 'error').map(([, m]) => m), [
      'Release export: Executive Summary Report upload FAILED',
      'Release export: Letter of Attestation upload FAILED',
    ]);
    const [level, message, data] = lines[lines.length - 1];
    // Only the (stubbed) full report made it onto the Artifacts tab.
    eq([level, message, data.problems, data.plextrac_artifacts], ['warn', 'Release export FINISHED WITH PROBLEMS', 2, 1]);
  });

  await test('a switched-off document shows in the release trail as skipped, and the run is not a problem', async () => {
    reset();
    clientDocuments.generateClientDocuments = realGenerate;
    // The real config, with only the letter switched off; the exec summary still runs
    // through the stubbed Plextrac / renderer / Drive.
    const lines = await withEnv({ CLIENT_DOCS_LETTER_OF_ATTESTATION_ENABLED: 'no' },
      () => captureLog(() => runReleaseExports(release)));
    const skipped = lines.find(([, m]) => m === 'Release export: Letter of Attestation skipped — switched off');
    eq(skipped && skipped[2], { report_id: 34, switch: 'CLIENT_DOCS_LETTER_OF_ATTESTATION_ENABLED=no' });
    eq(lines.some(([, m]) => m === 'Release export: Executive Summary Report uploaded to Plextrac'), true);
    eq(lines[lines.length - 1][1], 'Release export FINISHED');
  });

  await test('Plextrac data failing is reported, never thrown into the webhook', async () => {
    reset();
    clientDocuments.generateClientDocuments = async () => { throw new Error('Plextrac 500'); };
    await runReleaseExports(release);
    eq(/could not be generated: Plextrac 500/.test(calls.replies[0]), true);
    eq(calls.exportFull.length, 1);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
