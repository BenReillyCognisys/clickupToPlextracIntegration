const assert = require('assert');
const { spawnSync } = require('child_process');

// Runs the REAL renderer (renderer/render.py) on the real executive-summary template.
// Needs Python with the renderer's requirements (npm run setup:renderer). Where they
// aren't installed the affected tests are reported as SKIPPED — loudly, not silently.

const renderer = require('../lib/pdf-renderer');
const data = require('../pipeline/client-documents/data');
const fx = require('./fixtures/client-report');

const eq = (a, b) => assert.deepStrictEqual(a, b);
const canImport = (mod) => spawnSync(renderer.pythonPath(), ['-c', `import ${mod}`], { stdio: 'ignore' }).status === 0;

let passed = 0, failed = 0, skipped = 0;
function test(description, fn, { skip } = {}) {
  if (skip) {
    console.log(`  -  SKIPPED ${description} (${skip})`);
    skipped++;
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

// The exec summary as a release builds it (Plextrac's own text, no Claude), with two
// hostile images planted in a narrative (narratives reach the PDF through |safe).
function execContext() {
  const report = structuredClone(fx.report);
  report.exec_summary.custom_fields[0].text += '<img src="file:///C:/Windows/win.ini"><img src="http://127.0.0.1:9/x.png">';
  return data.templateContext({
    report, clientRecord: fx.clientRecord, findings: fx.findings,
    exportedAt: new Date('2026-09-26T13:30:00Z'),
  });
}

// The letter's context: a Scope narrative in the shape Plextrac really stores it
// (styled table with a header row and a blank template row, a User Authentication
// table, then the out-of-scope section), and findings as the list endpoint returns them.
const SCOPE = '<h5 style="margin-left:0px;">In-Scope URLs</h5><figure class="table"><table style="border-style:none;"><tbody>'
  + '<tr><td style="background-color:#C2DAFF;"><p style="margin-left:7.05pt;"><span style="color:#0049B8;">URL</span></p></td>'
  + '<td style="background-color:#C2DAFF;"><p><span>Notes</span></p></td><td style="background-color:#C2DAFF;"><span>Environment</span></td></tr>'
  + '<tr><td style="padding:0px 7px;">https://portal.northgate.example</td><td>Customer Portal</td><td>Production</td></tr>'
  + '<tr><td><a href="https://api.northgate.example"><span>https://api.northgate.example</span></a></td><td>Partner&nbsp;API &amp; Gateway</td><td></td></tr>'
  + '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>'
  + '</tbody></table></figure><h5 style="margin-left:0px;">User Authentication</h5><figure class="table"><table><tbody>'
  + '<tr><td>Credentials</td><td>Role</td></tr><tr><td>tester@northgate.example</td><td>Admin</td></tr></tbody></table></figure>'
  + '<p>&nbsp;</p><p style="margin-left:0px;">The following activities were out of scope for this engagement:</p>'
  + '<ul><li>Denial of service testing.</li></ul>';

function letterContext({ scope = SCOPE, severities = ['Critical', 'High', 'Medium', 'Informational'], client = 'Northgate Financial Services Ltd' } = {}) {
  const rows = severities.map((sev, i) => ({ id: `f${i}`, doc_id: [1, i], data: [i, sev, `Finding ${i}`, 'Open'] }));
  return data.templateContext({
    report: { name: 'Web App Test', exec_summary: { custom_fields: [{ label: 'Scope', text: scope }] } },
    clientRecord: { name: client },
    findings: data.normaliseFindings(rows),
    exportedAt: new Date('2026-09-27T10:00:00Z'),
  });
}

// The full report's context: every finding in full, as a release builds it.
function fullContext(findings = Object.values(fx.fullFindings)) {
  return data.templateContext({
    report: fx.report, clientRecord: fx.clientRecord, findings,
    exportedAt: new Date('2026-09-26T13:30:00Z'), detail: 'full',
  });
}

// The findings section of the rendered full report, one entry per finding.
async function fullFindingsHtml(findings) {
  const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-full-report.j2', context: fullContext(findings), output: 'html' }]);
  const r = out.get('x');
  if (!r.ok) throw new Error(r.error);
  return [...r.buffer.toString('utf8').matchAll(/<section class="finding">([\s\S]*?)<\/section>/g)].map((m) => m[1]);
}

async function letterHtml(opts) {
  const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-letter-of-attestation.j2', context: letterContext(opts), output: 'html' }]);
  const r = out.get('x');
  if (!r.ok) throw new Error(r.error);
  const html = r.buffer.toString('utf8');
  return html.slice(html.indexOf('<p class="loa-title">'));
}

// The Host(s) section: Plextrac's Scope HTML, as printed under the "Host(s)" label.
const scopeHtml = (html) => html.slice(html.indexOf('<p class="hosts-head">'), html.indexOf('Summary of the Assessment Results'));
// Each printed table's rows, as cell text.
const tableRows = (html) => [...scopeHtml(html).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
  .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim()));

(async () => {
  const hasJinja = canImport('jinja2');
  const hasWeasy = hasJinja && canImport('weasyprint');
  const noJinja = hasJinja ? null : `no jinja2 for ${renderer.pythonPath()}`;
  const noWeasy = hasWeasy ? null : `WeasyPrint not importable for ${renderer.pythonPath()}`;

  console.log('renderer — the real executive summary template:');

  await test('renders HTML with the full Plextrac executive summary', async () => {
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: execContext(), output: 'html' }]);
    const html = out.get('x').buffer.toString('utf8');
    assert.ok(html.includes(fx.report.exec_summary.custom_fields[5].text), 'executive summary, verbatim');
    assert.ok(html.includes('Executive Summary Report'));
    assert.ok(html.includes('26 September 2026'), 'cover date');
    assert.ok(html.includes('Version 1.2'));
    assert.ok(html.includes('Jane Tester'));
    assert.ok(!html.includes('NOTE: Report Narrative'), 'every narrative found');
  }, { skip: noJinja });

  await test('accents, curly quotes and dashes survive the trip to Python intact', async () => {
    const ctx = execContext();
    ctx.REPORT_INFO.exec_summary.custom_fields[0].text = '<p>Émile’s “café” — naïve</p>';
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: ctx, output: 'html' }]);
    assert.ok(out.get('x').buffer.toString('utf8').includes('<p>Émile’s “café” — naïve</p>'));
  }, { skip: noJinja });

  await test('no finding write-up reaches the document', async () => {
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: execContext(), output: 'html' }]);
    assert.ok(!out.get('x').buffer.toString('utf8').includes(fx.SECRET));
  }, { skip: noJinja });

  await test('a broken document fails alone; the others still render', async () => {
    const out = await renderer.renderTemplates([
      { id: 'good', template: 'cognisys-exec-summary.j2', context: execContext(), output: 'html' },
      { id: 'bad', template: 'no-such-template.j2', context: {}, output: 'html' },
    ]);
    assert.strictEqual(out.get('good').ok, true);
    assert.strictEqual(out.get('bad').ok, false);
    assert.ok(/TemplateNotFound/.test(out.get('bad').error));
  }, { skip: noJinja });

  await test('the startup check says whether PDFs can be made — and if not, why and how to fix it', async () => {
    const c = await renderer.checkRenderer();
    assert.strictEqual(typeof c.ok, 'boolean');
    assert.ok(c.python, 'names the interpreter');
    if (c.ok) {
      assert.ok(c.jinja2 && c.weasyprint, JSON.stringify(c));
    } else {
      // A broken install is a readable one-liner (never "unreadable output"), naming the fix.
      assert.ok(/setup:renderer|apt install/.test(c.error), c.error);
    }
    assert.strictEqual(c.ok, hasWeasy, `check says ok=${c.ok} but WeasyPrint importable=${hasWeasy}: ${c.error}`);
  }, { skip: noJinja });

  console.log('\nrenderer — the real letter of attestation template:');

  await test('(CLIENT NAME) is the Plextrac client, in all four places', async () => {
    const html = await letterHtml();
    assert.strictEqual(html.split('Northgate Financial Services Ltd').length - 1, 4);
    assert.ok(!html.includes('(CLIENT NAME)'));
  });

  await test('(MONTH YEAR) is the month the letter is issued', async () => {
    assert.ok((await letterHtml()).includes('Northgate Financial Services Ltd during September 2026 to identify'));
  });

  await test('(LINKS and APP NAMES): Plextrac\'s own table, printed as-is — header row, styles and all', async () => {
    const html = scopeHtml(await letterHtml());
    assert.ok(html.includes('<div class="scope-table"><table style="border-style:none;">'), 'Plextrac\'s table');
    assert.ok(html.includes('<td style="background-color:#C2DAFF;"><p style="margin-left:7.05pt;"><span style="color:#0049B8;">URL</span></p></td>'),
      'header row with Plextrac\'s fill');
    assert.ok(html.includes('<td style="padding:0px 7px;">https://portal.northgate.example</td><td>Customer Portal</td><td>Production</td>'));
    assert.ok(html.includes('<td>Partner&nbsp;API &amp; Gateway</td>'), 'cell HTML untouched');
    assert.deepStrictEqual(tableRows(html), [
      ['URL', 'Notes', 'Environment'],
      ['https://portal.northgate.example', 'Customer Portal', 'Production'],
      ['https://api.northgate.example', 'Partner&nbsp;API &amp; Gateway', ''],
    ]);
  });

  await test('the scope leaves out blank rows, "In-Scope URLs", test accounts and the out-of-scope section', async () => {
    const html = scopeHtml(await letterHtml());
    for (const s of ['In-Scope URLs', '&nbsp;</td>', 'tester@', 'Credentials', 'User Authentication', 'out of scope', 'Denial']) {
      assert.ok(!html.includes(s), `letter contains "${s}"`);
    }
  });

  await test('test accounts are left out however they are headed, and hosts after them are kept', async () => {
    const hosts = (url) => '<figure class="table"><table><tbody><tr><td>URL</td><td>Notes</td></tr>'
      + `<tr><td>${url}</td><td>App</td></tr></tbody></table></figure>`;
    const creds = '<figure class="table"><table><tbody><tr><td><strong>Credential</strong></td><td>Role</td></tr>'
      + '<tr><td>tester@northgate.example</td><td>Admin</td></tr></tbody></table></figure>';
    const scope = `<h5>In-Scope URLs</h5>${hosts('https://a.example')}`
      + `<p><strong>User Accounts:</strong></p>${creds}<ul><li>password: hunter2</li></ul>`
      + `<h5>In-Scope Subnets</h5>${hosts('10.0.0.0/24')}`
      + creds // no heading at all
      + `<h5>In-Scope AWS Accounts</h5>${hosts('123456789012')}`
      + '<p>The following activities were out of scope for this engagement:</p>';
    const html = scopeHtml(await letterHtml({ scope }));
    for (const s of ['tester@', 'Credential', 'User Accounts', 'hunter2', 'In-Scope']) {
      assert.ok(!html.includes(s), `letter contains "${s}"`);
    }
    for (const s of ['https://a.example', '10.0.0.0/24', '123456789012']) assert.ok(html.includes(s), `letter is missing "${s}"`);
  });

  await test('a scope written as paragraphs or bullets is printed as written', async () => {
    const scope = '<p>In-Scope URL(s):</p><ul><li>https://a.example</li><li>Mobile app (iOS)</li></ul>'
      + '<p>The following activities were out of scope for this engagement:</p><ul><li>x</li></ul>';
    const html = scopeHtml(await letterHtml({ scope }));
    assert.ok(html.includes('<ul><li>https://a.example</li><li>Mobile app (iOS)</li></ul>'));
    assert.ok(!html.includes('In-Scope URL(s)') && !html.includes('<li>x</li>'));
  });

  await test('a scope table left blank shows the red placeholder, never an empty table', async () => {
    const scope = SCOPE.replace(/<tr><td style="padding[\s\S]*?Gateway<\/td><td><\/td><\/tr>/, '');
    const html = scopeHtml(await letterHtml({ scope }));
    assert.ok(html.includes('tpl-missing">(LINKS and APP NAMES)'), 'red placeholder');
    assert.ok(!html.includes('<table'), 'no header-only table');
  });

  await test('(TOTAL ISSUE COUNT) / (INSERT ISSUE COUNT HERE) — zero severities left out', async () => {
    const html = await letterHtml();
    assert.ok(html.includes('identified a total of 4 issues, which consists of 1 Critical, 1 High, 1 Medium and 1 Informational.'));
    const two = await letterHtml({ severities: ['Low', 'Medium', 'Low'] });
    assert.ok(two.includes('identified a total of 3 issues, which consists of 1 Medium and 2 Low.'));
    const one = await letterHtml({ severities: ['High'] });
    assert.ok(one.includes('identified a total of 1 issue, which consists of 1 High.'));
  });

  await test('a client name with & and apostrophes is escaped, not broken', async () => {
    const html = await letterHtml({ client: "O'Neill & Sons" });
    assert.ok(html.includes('engaged by O&#39;Neill &amp; Sons during'));
  });

  console.log('\nrenderer — the real full report template:');

  await test('every finding in full, most severe first', async () => {
    const f = fx.fullFindings;
    const sections = await fullFindingsHtml([f[4], f[3], f[2], f[1]]);
    eq(sections.map((h) => /<h2>([^<]*)<\/h2>/.exec(h)[1]),
      ['Stored XSS', 'SQL Injection in login', 'Missing HSTS', 'Server banner']);
    assert.ok(sections[1].includes(`<p>${fx.SECRET}</p>`), 'the write-up');
    assert.ok(sections[1].includes('<p>Steps for SQL Injection in login</p>'), 'the technical details');
    assert.ok(sections[1].includes('<p>Fix SQL Injection in login</p>'), 'the recommendation');
  }, { skip: noJinja });

  await test('CVSS Score: the score and vector where the finding has one', async () => {
    const [sqli] = await fullFindingsHtml([fx.fullFindings[1]]);
    assert.ok(sqli.includes('<h3>CVSS Score</h3>'));
    assert.ok(sqli.includes('<span class="cvss-score">9.8</span> (CVSS 3.1)<br><span class="cvss-vector">CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H</span>'), sqli);
  }, { skip: noJinja });

  await test('CVSS Score: left out altogether when blank in Plextrac', async () => {
    const blank = (risk) => ({ ...fx.fullFindings[2], risk_score: risk });
    const sections = await fullFindingsHtml([
      blank({}), blank(undefined), blank(null),
      blank({ CVSS3_1: { vector: '', overall: 0 } }), blank({ CVSS3_1: { vector: null, overall: null } }),
    ]);
    for (const h of sections) assert.ok(!h.includes('CVSS'), h);
  }, { skip: noJinja });

  await test('Affected Assets: one line per asset, asset:port where Plextrac lists ports', async () => {
    const f = { ...fx.fullFindings[1], affected_assets: {
      a: { asset: 'https://portal.acme.example', ports: {} },
      b: { asset: '10.0.0.5', ports: { p1: { number: 443, protocol: 'tcp' }, p2: { number: 8443 } } },
    } };
    const [h] = await fullFindingsHtml([f]);
    assert.ok(h.includes('<h3>Affected Assets</h3>'));
    eq([...h.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]), ['https://portal.acme.example', '10.0.0.5:443', '10.0.0.5:8443']);
  }, { skip: noJinja });

  await test('Affected Assets: left out altogether when blank in Plextrac', async () => {
    const blank = (assets) => ({ ...fx.fullFindings[2], affected_assets: assets });
    const sections = await fullFindingsHtml([
      blank({}), blank(undefined), blank({ a: { asset: '', ports: {} }, b: { asset: '   ' } }),
    ]);
    for (const h of sections) assert.ok(!h.includes('Affected Assets') && !h.includes('<li>'), h);
  }, { skip: noJinja });

  await test('a screenshot already inlined as data: prints as an image', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const f = { ...fx.fullFindings[1], fields: { proof_of_concept: { key: 'proof_of_concept', label: 'Technical Details', value: `<p><img src="${png}" /></p>` } } };
    const [h] = await fullFindingsHtml([f]);
    assert.ok(h.includes(`<img src="${png}" />`));
  }, { skip: noJinja });

  await test('renders a PDF', async () => {
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: execContext() }]);
    const r = out.get('x');
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  }, { skip: noWeasy });

  await test('renders the full report to a PDF, with its image options', async () => {
    const { pdfOptions } = require('../config/client-documents').find((d) => d.key === 'full-report');
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-full-report.j2', context: fullContext(), pdf_options: pdfOptions }]);
    const r = out.get('x');
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  }, { skip: noWeasy });

  await test('file:// and http:// resources are refused, not fetched', async () => {
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: execContext() }]);
    const warnings = out.get('x').warnings.join('\n');
    assert.ok(/disallowed protocol: file:/.test(warnings), warnings);
    assert.ok(/disallowed protocol: http:/.test(warnings), warnings);
  }, { skip: noWeasy });

  console.log(`\n${passed + failed + skipped} tests: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failed > 0) process.exit(1);
})();
