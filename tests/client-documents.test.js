const assert = require('assert');

// Read at require time / call time by the modules under test.
process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID = 'FOLDER_REPORTS';
process.env.EXEC_SUMMARY_EDIT_API_KEY = 'test-key';

// ── Stub the outbound helpers ─────────────────────────────────────────────────
// The pipeline calls through these module objects at runtime, so mutating their
// exports keeps every test off Plextrac, Claude, Drive, Slack and the renderer.
const api = require('../lib/plextrac-api');
const aiClient = require('../lib/client-doc-ai');
const renderer = require('../lib/pdf-renderer');
const drive = require('../lib/google-drive');
const slack = require('../lib/slack');
const reportExport = require('../pipeline/report-export');

const fx = require('./fixtures/client-report');
const data = require('../pipeline/client-documents/data');
const { fillPrompt } = require('../lib/prompt-template');
const clientDocuments = require('../pipeline/client-documents');
const { runReleaseExports } = require('../pipeline/release-exports');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 0x20)]);
const EXPORTED_AT = new Date('2026-09-26T13:30:05Z');

const DOCS = [
  {
    key: 'exec-summary', name: 'Executive Summary Report', template: 'exec.j2', prompt: 'exec-summary.md',
    outputs: { executive_summary: 'x' }, replaceNarratives: { 'Executive Summary': 'executive_summary' },
  },
  {
    key: 'letter-of-attestation', name: 'Letter of Attestation', template: 'loa.j2', prompt: 'letter-of-attestation.md',
    outputs: { attestation_body: 'x' },
  },
];

let calls;
function reset() {
  calls = { getReport: [], generate: [], render: [], uploads: [], artifacts: [], replies: [], resolveFolder: [], exportFull: [] };
  api.getReport = async (c, r) => { calls.getReport.push([c, r]); return structuredClone(fx.report); };
  api.getClient = async () => structuredClone(fx.clientRecord);
  api.listReportFindings = async () => structuredClone(fx.findings);
  api.uploadReportArtifact = async (c, r, file) => { calls.artifacts.push({ c, r, filename: file.filename }); return `ART-${calls.artifacts.length}`; };
  api.listReportArtifacts = async () => calls.artifacts.map((_, i) => ({ id: `ART-${i + 1}` }));
  aiClient.generate = async ({ prompt, outputs }) => {
    calls.generate.push(prompt);
    return { values: Object.fromEntries(Object.keys(outputs).map((k) => [k, `<p>AI ${k}</p>`])), model: 'm', usage: {} };
  };
  renderer.templateExists = () => true;
  renderer.renderTemplates = async (jobs) => {
    calls.render.push(jobs);
    return new Map(jobs.map((j) => [j.id, { ok: true, buffer: PDF, warnings: [] }]));
  };
  drive.uploadFile = async (args) => { calls.uploads.push(args); return { fileId: `F${calls.uploads.length}`, folderId: args.folderId, name: args.filename }; };
  slack.postReply = async (channel, threadTs, text) => { calls.replies.push(text); };
  slack.postMessage = async (channel, text) => { calls.replies.push(text); };
  reportExport.resolveReleaseFolder = async (job) => { calls.resolveFolder.push(job); return 'FOLDER_CLIENT_MONTH'; };
  reportExport.exportReleasedReport = async (args) => { calls.exportFull.push(args); return { fileId: 'FULL' }; };
}

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const facts = () => ({ report: fx.report, clientRecord: fx.clientRecord, findings: fx.findings, clientName: 'Acme Corp', exportedAt: EXPORTED_AT });

(async () => {
  console.log('prompt placeholders:');

  await test('fills values, narratives and custom fields', () => {
    const out = fillPrompt(
      'For {{client_name}} ({{ start_date }} - {{end_date}}), by {{field:Author 1}}:\n{{narrative:Executive Summary}}',
      data.promptResolvers(facts()),
    );
    eq(out, 'For Acme Corp (1 September 2026 - 5 September 2026), by Jane Tester:\n'
      + '<p>ORIGINAL EXEC SUMMARY: two high-risk issues were found (see section 4.2).</p>');
  });

  await test('narrative labels match like the template (case, trailing "s")', () => {
    const r = data.promptResolvers(facts());
    eq(r.narrative('limitation'), '<p>Testing was performed against staging.</p>');
    eq(r.narrative('SCOPE').includes('portal.acme.example'), true);
  });

  await test('HTML comments are notes for the editor, not sent', () => {
    eq(fillPrompt('<!-- {{nonsense}} -->Hello {{client_name}}', data.promptResolvers(facts())), 'Hello Acme Corp');
  });

  await test('an unknown placeholder is an error naming what is available', () => {
    assert.throws(() => fillPrompt('{{client}}', data.promptResolvers(facts())), /unknown placeholder \{\{client\}\}.*\{\{client_name\}\}/);
  });

  await test('a narrative the report lacks is an error, not a blank', () => {
    assert.throws(() => fillPrompt('{{narrative:Roadmap}}', data.promptResolvers(facts())), /no "Roadmap" narrative/);
  });

  await test('every problem is reported at once', () => {
    assert.throws(() => fillPrompt('{{a}} {{b}}', data.promptResolvers(facts())), /\{\{a\}\}.*\{\{b\}\}/);
  });

  await test('finding counts and titles — never the write-ups', () => {
    const r = data.promptResolvers(facts());
    eq(r.finding_counts(), 'Critical: 0\nHigh: 2\nMedium: 0\nLow: 1\nInformational: 1\nTotal: 4');
    eq(r.findings().split('\n')[0], '- [High] SQL Injection in login');
    eq(r.findings().includes(fx.SECRET), false);
  });

  console.log('\ntemplate context — the client documents get a reduced report:');

  const ctx = () => data.templateContext({
    ...facts(), ai: { executive_summary: '<p>AI text</p>' }, replaceNarratives: { 'Executive Summary': 'executive_summary' },
  });

  await test('no findings, and no write-up text anywhere in the context', () => {
    eq(ctx().FINDINGS, []);
    eq(JSON.stringify(ctx()).includes(fx.SECRET), false);
  });

  await test('only allow-listed report and client keys pass through', () => {
    eq(Object.keys(ctx().REPORT_INFO).sort(), ['custom_field', 'end_date', 'exec_summary', 'export_datetime_us', 'name', 'start_date', 'tags']);
    eq(Object.keys(ctx().CLIENT_INFO).sort(), ['name', 'tags']);
  });

  await test("Claude's text replaces the narrative; the others are untouched", () => {
    const list = ctx().REPORT_INFO.exec_summary.custom_fields;
    eq(list.find((f) => f.label === 'Executive Summary').text, '<p>AI text</p>');
    eq(list.find((f) => f.label === 'Overview').text, fx.report.exec_summary.custom_fields[0].text);
  });

  await test('the source report object is not modified', () => {
    ctx();
    eq(fx.report.exec_summary.custom_fields[5].text.startsWith('<p>ORIGINAL'), true);
  });

  await test('a missing narrative is added rather than silently dropped', () => {
    const report = { ...fx.report, exec_summary: { custom_fields: [] } };
    const c = data.templateContext({ ...facts(), report, ai: { executive_summary: '<p>x</p>' }, replaceNarratives: { 'Executive Summary': 'executive_summary' } });
    eq(c.REPORT_INFO.exec_summary.custom_fields, [{ label: 'Executive Summary', text: '<p>x</p>' }]);
  });

  await test('cover date in the month-first shape the template parses (UK time)', () => {
    eq(ctx().REPORT_INFO.export_datetime_us, '09-26-2026 14:30');
  });

  await test('severity counts in the FINDING_SUMMARY shape', () => {
    eq(ctx().FINDING_SUMMARY.high, { total: 2 });
    eq(ctx().FINDING_SUMMARY.totals, { total_reported: 4 });
  });

  await test('AI values are available to templates as AI', () => {
    eq(ctx().AI, { executive_summary: '<p>AI text</p>' });
  });

  console.log("\ncleanHtml — Claude's output is cut to basic formatting:");

  await test('keeps paragraphs, lists and emphasis', () => {
    eq(data.cleanHtml('<p>A <strong>b</strong> <em>c</em></p><ul><li>d</li></ul>'), '<p>A <strong>b</strong> <em>c</em></p><ul><li>d</li></ul>');
  });

  await test('drops scripts, images, links, styles and every attribute', () => {
    eq(data.cleanHtml('<p style="color:red" onclick="x()">A</p><script>alert(1)</script><img src="file:///etc/passwd"><a href="http://x">link</a>'),
      '<p>A</p>link');
  });

  await test('plain text becomes escaped paragraphs', () => {
    eq(data.cleanHtml('One & two\n\nThree'), '<p>One &amp; two</p><p>Three</p>');
  });

  console.log('\nClaude response handling:');

  const reply = (text, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });

  await test('returns the requested keys', () => {
    eq(aiClient.parseResponse(reply('{"a":"<p>x</p>"}'), { a: '' }), { a: '<p>x</p>' });
  });

  await test('a refusal is an error naming its category', () => {
    assert.throws(() => aiClient.parseResponse({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }, { a: '' }), /refusal, category cyber/);
  });

  await test('a truncated reply is an error', () => {
    assert.throws(() => aiClient.parseResponse(reply('{"a":"', { stop_reason: 'max_tokens' }), { a: '' }), /cut off/);
  });

  await test('an empty value is an error', () => {
    assert.throws(() => aiClient.parseResponse(reply('{"a":"  "}'), { a: '' }), /no text for "a"/);
  });

  await test('the schema requires exactly the output keys', () => {
    const s = aiClient.outputSchema({ a: 'first', b: 'second' });
    eq(s.required, ['a', 'b']);
    eq(s.additionalProperties, false);
    eq(s.properties.a, { type: 'string', description: 'first' });
  });

  console.log('\ngenerateClientDocuments:');

  const job = { clientId: 12, reportId: 34, clientName: 'Acme Corp', exportedAt: EXPORTED_AT, documents: DOCS };

  await test('drafts every document, renders them in ONE renderer run, names them by the release time', async () => {
    reset();
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out.map((d) => [d.doc.key, d.ok, d.filename]), [
      ['exec-summary', true, 'Executive Summary Report 2026-09-26 14-30-05.pdf'],
      ['letter-of-attestation', true, 'Letter of Attestation 2026-09-26 14-30-05.pdf'],
    ]);
    eq(calls.generate.length, 2);
    eq(calls.render.length, 1);
    eq(calls.render[0].map((j) => j.template), ['exec.j2', 'loa.j2']);
    eq(calls.getReport, [[12, 34]]);
  });

  await test("the exec summary's context carries Claude's text in the narrative", async () => {
    reset();
    await clientDocuments.generateClientDocuments(job);
    const list = calls.render[0][0].context.REPORT_INFO.exec_summary.custom_fields;
    eq(list.find((f) => f.label === 'Executive Summary').text, '<p>AI executive_summary</p>');
  });

  await test('a report that belongs to another client is refused outright', async () => {
    reset();
    api.getReport = async () => ({ ...fx.report, client_id: 99 });
    await assert.rejects(clientDocuments.generateClientDocuments(job), /belongs to client 99, not 12/);
    eq(calls.generate.length, 0);
  });

  await test('one document failing leaves the other intact', async () => {
    reset();
    aiClient.generate = async ({ outputs }) => {
      if (outputs.attestation_body) throw new Error('refusal');
      return { values: { executive_summary: '<p>ok</p>' }, model: 'm', usage: {} };
    };
    const out = await clientDocuments.generateClientDocuments(job);
    eq(out[0].ok, true);
    eq(out[1].ok, false);
    eq(out[1].error.includes('refusal'), true);
    eq(calls.render[0].length, 1);
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

  await test('one export time for the folder, the full report and every document', async () => {
    reset(); stubDocuments();
    await runReleaseExports(release);
    const t = calls.resolveFolder[0].exportedAt;
    eq(calls.exportFull[0].exportedAt, t);
    eq(calls.uploads.every((u) => u.filename.includes(t.toISOString())), true);
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
    eq(calls.exportFull.length, 0);
    eq(calls.uploads.length, 0);
    eq(calls.artifacts.length, 2);
    eq(calls.replies.length, 1);
    eq(/nothing was filed in Drive: insufficientPermissions/.test(calls.replies[0]), true);
  });

  await test('document failures are listed together in one thread reply', async () => {
    reset();
    clientDocuments.generateClientDocuments = async () => DOCS.map((d) => ({ doc: d, ok: false, error: 'Drafting failed: refusal' }));
    await runReleaseExports(release);
    eq(calls.replies.length, 1);
    eq(calls.replies[0].includes('Executive Summary Report: Drafting failed'), true);
    eq(calls.replies[0].includes('Letter of Attestation: Drafting failed'), true);
  });

  await test('Plextrac data failing is reported, never thrown into the webhook', async () => {
    reset();
    clientDocuments.generateClientDocuments = async () => { throw new Error('Plextrac 500'); };
    await runReleaseExports(release);
    eq(/could not be generated: Plextrac 500/.test(calls.replies[0]), true);
    eq(calls.exportFull.length, 1);
  });

  await test('without the Claude key the client documents are skipped quietly', async () => {
    reset(); stubDocuments();
    delete process.env.EXEC_SUMMARY_EDIT_API_KEY;
    await runReleaseExports(release);
    process.env.EXEC_SUMMARY_EDIT_API_KEY = 'test-key';
    eq(calls.exportFull.length, 1);
    eq(calls.uploads.length, 0);
    eq(calls.replies, []);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
