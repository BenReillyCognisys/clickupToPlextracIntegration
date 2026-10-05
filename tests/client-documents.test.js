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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const EXPORTED_AT = new Date('2026-09-26T13:30:05Z');

const DOCS = [
  { key: 'exec-summary', name: 'Executive Summary Report', template: 'exec.j2', enabledBy: 'TEST_EXEC_ENABLED' },
  { key: 'letter-of-attestation', name: 'Letter of Attestation', template: 'loa.j2', enabledBy: 'TEST_LOA_ENABLED' },
];
const FULL_DOC = {
  key: 'full-report', name: 'Full Report', filename: 'Full-Pentest-Report-Tech-Details', template: 'full.j2',
  enabledBy: 'TEST_FULL_ENABLED', findings: 'full', pdfOptions: { dpi: 150 },
};

let calls;
function reset() {
  calls = { getReport: [], getFinding: [], fetched: [], render: [], uploads: [], artifacts: [], replies: [], resolveFolder: [], jobs: [] };
  api.getReport = async (c, r) => { calls.getReport.push([c, r]); return structuredClone(fx.report); };
  api.getClient = async () => structuredClone(fx.clientRecord);
  api.listReportFindings = async () => structuredClone(fx.findings);
  api.getFinding = async (c, r, id) => { calls.getFinding.push([c, r, id]); return structuredClone(fx.fullFindings[id]); };
  api.rawBinary = async (method, path) => { calls.fetched.push(path); return { buffer: PNG, contentType: 'image/png' }; };
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

  await test('characters no font can draw are removed; Windows-1252 punctuation read as Latin-1 is repaired', () => {
    eq(data.printable('it\u0092s a\u0096b \u0001\b\u001f\u007f\u0081x'), 'it’s a–b x');
    eq(data.printable('<p>a&#8;b&#x84;c&#X1F;d&#150;e</p>'), '<p>ab„cd–e</p>');
    eq(data.printable('tab\tnew\nline\r &#39; &#x27; &#169; &#1234; café'), 'tab\tnew\nline\r &#39; &#x27; &#169; &#1234; café');
    eq(data.printable({ a: ['x\u0008', { b: 'y\u0095' }], n: 3, z: null }), { a: ['x', { b: 'y•' }], n: 3, z: null });
  });

  await test('every string in the context is made printable', () => {
    const report = { ...fx.report, name: 'Report\u0008 \u0093One\u0094' };
    const findings = [{ title: 'SQLi\u0001', severity: 'High', description: 'raw\u008abytes' }];
    const out = data.templateContext({ ...facts(), report, findings, detail: 'full' });
    eq([out.REPORT_INFO.name, out.FINDINGS[0].title, out.FINDINGS[0].description], ['Report “One”', 'SQLi', 'rawŠbytes']);
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
      ['full-report', 'CLIENT_DOCS_FULL_REPORT_ENABLED'],
      ['exec-summary', 'CLIENT_DOCS_EXEC_SUMMARY_ENABLED'],
      ['letter-of-attestation', 'CLIENT_DOCS_LETTER_OF_ATTESTATION_ENABLED'],
    ]);
  });

  await test('the real full report: Full-Pentest-Report-Tech-Details, every finding in full', () => {
    const full = require('../config/client-documents').find((d) => d.key === 'full-report');
    eq([full.filename, full.template, full.findings], ['Full-Pentest-Report-Tech-Details', 'cognisys-full-report.j2', 'full']);
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

  console.log('\nthe full report — every finding in full:');

  const fullCtx = (findings = Object.values(fx.fullFindings)) => data.templateContext({ ...facts(), findings, detail: 'full' });

  await test('carries each finding\'s write-up, technical details, CVSS score and affected assets', () => {
    const f = fullCtx().FINDINGS[0];
    eq(f.title, 'SQL Injection in login');
    eq(f.description, `<p>${fx.SECRET}</p>`);
    eq(f.fields.proof_of_concept.label, 'Technical Details');
    eq(f.risk_score.CVSS3_1.overall, 9.8);
    eq(f.affected_assets, { asset1: { asset: 'host-1.acme.example', ports: {} } });
  });

  await test('...and nothing else: no assignee, tickets, exhibits, or the other findings on an asset', () => {
    const json = JSON.stringify(fullCtx());
    for (const s of ['INTERNAL-ASSIGNEE', 'INTERNAL-TICKET', 'INTERNAL-EXHIBIT', 'INTERNAL-OTHER-FINDING']) {
      eq([s, json.includes(s)], [s, false]);
    }
  });

  await test('most severe first; Plextrac\'s order kept within a severity', () => {
    const f = fx.fullFindings;
    eq(fullCtx([f[3], f[4], f[2], f[1]]).FINDINGS.map((x) => x.title),
      ['Stored XSS', 'SQL Injection in login', 'Missing HSTS', 'Server banner']);
  });

  const fullJob = { ...job, documents: [FULL_DOC, ...DOCS] };
  const byId = (list) => [...list].sort((a, b) => a[2] - b[2]);

  await test('fetches every finding of THIS report, and renders with the other documents in one run', async () => {
    reset();
    const out = await clientDocuments.generateClientDocuments(fullJob);
    eq(out.map((d) => [d.doc.key, d.ok, d.filename]), [
      ['full-report', true, 'Full-Pentest-Report-Tech-Details 2026-09-26 14-30-05.pdf'],
      ['exec-summary', true, 'Executive Summary Report 2026-09-26 14-30-05.pdf'],
      ['letter-of-attestation', true, 'Letter of Attestation 2026-09-26 14-30-05.pdf'],
    ]);
    eq(byId(calls.getFinding), [[12, 34, 1], [12, 34, 2], [12, 34, 3], [12, 34, 4]]);
    eq(calls.render.length, 1);
    const [full, exec, letter] = calls.render[0];
    eq([full.template, full.pdf_options, exec.pdf_options], ['full.j2', { dpi: 150 }, undefined]);
    eq(JSON.stringify(full.context).includes(fx.SECRET), true);
    // The summary documents still never see a write-up.
    eq(JSON.stringify(exec.context).includes(fx.SECRET), false);
    eq(exec.context, letter.context);
  });

  await test('its screenshots are fetched from Plextrac and printed from inside the document', async () => {
    reset();
    const [full] = await clientDocuments.generateClientDocuments(fullJob);
    eq(calls.fetched.sort(), [1, 2, 3, 4].map((i) => `/api/v2/uploads/shot-${i}.png`));
    const poc = calls.render[0][0].context.FINDINGS[0].fields.proof_of_concept.value;
    eq(poc.includes(`<img src="data:image/png;base64,${PNG.toString('base64')}" />`), true);
    eq([full.screenshots, full.notices], [{ inlined: 4, missing: 0 }, []]);
  });

  await test('a screenshot that cannot be fetched is flagged — the report is still made', async () => {
    reset();
    api.rawBinary = async (method, path) => {
      if (path.endsWith('shot-2.png')) throw new Error('HTTP 404');
      return { buffer: PNG, contentType: 'image/png' };
    };
    const [full] = await clientDocuments.generateClientDocuments(fullJob);
    eq(full.ok, true);
    eq(full.screenshots, { inlined: 3, missing: 1 });
    eq(full.notices, ['a screenshot in "Stored XSS" is missing from the PDF (HTTP 404)']);
    const xss = calls.render[0][0].context.FINDINGS.find((f) => f.title === 'Stored XSS');
    eq(xss.fields.proof_of_concept.value.includes('[Screenshot missing'), true);
  });

  await test('a finding that cannot be fetched fails the full report alone', async () => {
    reset();
    api.getFinding = async (c, r, id) => {
      if (id === 3) throw new Error('Plextrac 502');
      return structuredClone(fx.fullFindings[id]);
    };
    const out = await clientDocuments.generateClientDocuments(fullJob);
    eq(out.map((d) => d.ok), [false, true, true]);
    eq(out[0].error, 'the findings could not be loaded from Plextrac: Plextrac 502');
    eq(calls.render[0].map((j) => j.id), ['exec-summary', 'letter-of-attestation']);
  });

  await test('a finding that says it belongs to another report is refused', async () => {
    reset();
    api.getFinding = async (c, r, id) => ({ ...structuredClone(fx.fullFindings[id]), report_id: 99 });
    const [full] = await clientDocuments.generateClientDocuments(fullJob);
    eq(full.ok, false);
    eq(/finding \d belongs to report 99, not 34/.test(full.error), true);
  });

  await test('switched off, the full report fetches nothing', async () => {
    reset();
    const out = await withEnv({ TEST_FULL_ENABLED: 'false' }, () => clientDocuments.generateClientDocuments(fullJob));
    eq(out.map((d) => d.doc.key), ['exec-summary', 'letter-of-attestation']);
    eq([calls.getFinding.length, calls.fetched.length], [0, 0]);
  });

  console.log('\nscreenshots:');

  const images = require('../pipeline/client-documents/images');

  await test('only this Plextrac instance\'s upload store is ever fetched', () => {
    eq(images.uploadPath('/api/v2/uploads/abc-123.png'), '/api/v2/uploads/abc-123.png');
    eq(images.uploadPath('https://cognisys.plextrac.com/api/v2/uploads/abc.png'), '/api/v2/uploads/abc.png');
    for (const bad of [
      'https://evil.example/api/v2/uploads/a.png', 'http://cognisys.plextrac.com/api/v2/uploads/a.png',
      '//evil.example/api/v2/uploads/a.png', 'file:///etc/passwd', '/api/v1/client/1/report/2',
      '/api/v2/uploads/../users', '', undefined,
    ]) eq([bad, images.uploadPath(bad)], [bad, null]);
  });

  const shot = (src) => [{ title: 'T', description: `<p><img src="${src}"></p>` }];

  await test('what comes back must really be an image', async () => {
    const out = await images.inlineScreenshots(shot('/api/v2/uploads/a.png'), { fetchUpload: async () => ({ buffer: Buffer.from('{"status":"error","message":"nope"}') }) });
    eq(out.missing, [{ title: 'T', reason: 'Plextrac did not return an image' }]);
    eq(out.findings[0].description.includes('[Screenshot missing'), true);
  });

  await test('an image on any other host is never fetched, and is flagged', async () => {
    const fetched = [];
    const out = await images.inlineScreenshots(shot('https://evil.example/x.png'), { fetchUpload: async (p) => { fetched.push(p); return { buffer: PNG }; } });
    eq(fetched, []);
    eq(out.missing.length, 1);
  });

  await test('an upload used twice is fetched once; data: images are left as they are', async () => {
    const fetched = [];
    const findings = [
      { title: 'A', description: '<img src="/api/v2/uploads/same.png">', recommendations: '<img src="data:image/png;base64,AAAA">' },
      { title: 'B', fields: { poc: { value: '<img src="/api/v2/uploads/same.png">' } } },
    ];
    const out = await images.inlineScreenshots(findings, { fetchUpload: async (p) => { fetched.push(p); return { buffer: PNG }; } });
    eq(fetched, ['/api/v2/uploads/same.png']);
    eq([out.inlined, out.missing.length], [2, 0]);
    eq(out.findings[0].recommendations, '<img src="data:image/png;base64,AAAA">');
    eq(out.findings[1].fields.poc.value.startsWith('<img src="data:image/png;base64,'), true);
  });

  await test('Plextrac\'s aspect-ratio style is dropped from images (WeasyPrint warns on every one)', async () => {
    const findings = [{ title: 'A', description: '<img style="aspect-ratio:1300/794" src="/api/v2/uploads/a.png"> <img style="width:50%; aspect-ratio: 4/3;" src="data:image/png;base64,AAAA">' }];
    const out = await images.inlineScreenshots(findings, { fetchUpload: async () => ({ buffer: PNG }) });
    const d = out.findings[0].description;
    eq(/aspect-ratio/.test(d), false);
    eq(d.includes('style="width:50%; "'), true);
    eq(out.inlined, 1);
  });

  console.log('\nrenderer warnings:');

  await test('one line for every character no font can draw, counted; other warnings kept once each', () => {
    const notdef = (cp) => `.notdef glyph rendered for Unicode string unsupported by fonts: "x" (${cp})`;
    const out = clientDocuments.summariseWarnings([
      notdef('U+0008'), notdef('U+0008'), notdef('U+008A'), 'Ignored `aspect-ratio:1/1` at 1:1, unknown property.',
      notdef('U+0008'), 'Ignored `aspect-ratio:1/1` at 1:1, unknown property.',
    ]);
    eq(out, ['4 characters no font can draw were printed as boxes: U+0008 x3, U+008A x1']);
    eq(clientDocuments.summariseWarnings(['a', 'Ignored `margin-trim:block` at 1:1, unknown property.']),
      ['a', 'Ignored `margin-trim:block` at 1:1, unknown property.']);
  });

  await test('aspect-ratio warnings are not logged at all; nothing is logged when they were the only ones', async () => {
    reset();
    const ratio = (r) => `Ignored \`aspect-ratio:${r}\` at 1:1, unknown property.`;
    eq(clientDocuments.summariseWarnings([ratio('3020/1448'), ratio('838/437'), ratio(' 2000 / 1074')]), []);
    renderer.renderTemplates = async (jobs) => new Map(jobs.map((j) => [j.id, { ok: true, buffer: PDF, warnings: [ratio('831/606')] }]));
    const log = require('../lib/logger');
    const warned = [];
    const saved = log.warn;
    log.warn = (msg, data) => warned.push(msg);
    try {
      const out = await clientDocuments.generateClientDocuments({ clientId: 12, reportId: 34, exportedAt: EXPORTED_AT, documents: DOCS });
      eq(out.map((d) => [d.ok, d.warnings]), [[true, []], [true, []]]);
    } finally {
      log.warn = saved;
    }
    eq(warned.filter((m) => /rendered with warnings/.test(m)), []);
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
    clientDocuments.generateClientDocuments = async (j) => {
      calls.jobs.push(j);
      return [FULL_DOC, ...DOCS].map((d) => ({
        doc: d, ok: true, buffer: PDF, filename: `${d.filename || d.name} ${j.exportedAt.toISOString()}.pdf`,
      }));
    };
  };

  await test('resolves the folder ONCE and files everything into it and onto the report, silently', async () => {
    reset(); stubDocuments();
    await runReleaseExports(release);
    eq(calls.resolveFolder.length, 1);
    eq(calls.uploads.map((u) => u.folderId), ['FOLDER_CLIENT_MONTH', 'FOLDER_CLIENT_MONTH', 'FOLDER_CLIENT_MONTH']);
    eq(calls.artifacts.map((a) => [a.c, a.r]), [[12, 34], [12, 34], [12, 34]]);
    eq(calls.uploads[0].filename.startsWith('Full-Pentest-Report-Tech-Details '), true);
    eq(calls.replies, []);
  });

  await test('one export time for every document', async () => {
    reset(); stubDocuments();
    await runReleaseExports(release);
    const t = calls.jobs[0].exportedAt;
    eq(calls.uploads.every((u) => u.filename.includes(t.toISOString())), true);
    // The filename time is claimed in the folder, so it may move on from the time
    // the folder was resolved for — but never backwards.
    eq(t >= calls.resolveFolder[0].exportedAt, true);
  });

  await test('two releases for one client in the same second get different filename times', async () => {
    reset(); stubDocuments();
    await Promise.all([runReleaseExports(release), runReleaseExports({ ...release, reportId: 35 })]);
    const [a, b] = calls.jobs.map((j) => reportExport.documentFilename('Full-Pentest-Report-Tech-Details', { date: j.exportedAt }));
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
    eq(calls.uploads.length, 0);
    eq(calls.artifacts.length, 3);
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

  await test('a screenshot missing from the full report is raised in the thread; the report is still filed', async () => {
    reset();
    clientDocuments.generateClientDocuments = async () => [{
      doc: FULL_DOC, ok: true, buffer: PDF, filename: 'Full-Pentest-Report-Tech-Details x.pdf',
      screenshots: { inlined: 3, missing: 1 },
      notices: ['a screenshot in "Stored XSS" is missing from the PDF (HTTP 404)'],
    }];
    await runReleaseExports(release);
    eq([calls.uploads.length, calls.artifacts.length], [1, 1]);
    eq(calls.replies.length, 1);
    eq(calls.replies[0].includes('• Full Report: a screenshot in "Stored XSS" is missing from the PDF (HTTP 404)'), true);
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
      'info Release export: Full Report rendered',
      'info Release export: Executive Summary Report rendered',
      'info Release export: Letter of Attestation rendered',
      'info Release export: Full Report uploaded to Drive',
      'info Release export: Full Report uploaded to Plextrac',
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
      'Release export: Full Report upload FAILED',
      'Release export: Executive Summary Report upload FAILED',
      'Release export: Letter of Attestation upload FAILED',
    ]);
    const [level, message, data] = lines[lines.length - 1];
    eq([level, message, data.problems, data.plextrac_artifacts], ['warn', 'Release export FINISHED WITH PROBLEMS', 3, 0]);
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
    eq(calls.uploads.length, 0);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
