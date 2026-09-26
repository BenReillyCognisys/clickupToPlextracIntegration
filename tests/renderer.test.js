const assert = require('assert');
const { spawnSync } = require('child_process');

// Runs the REAL renderer (renderer/render.py) on the real executive-summary template.
// Needs Python with the renderer's requirements (npm run setup:renderer). Where they
// aren't installed the affected tests are reported as SKIPPED — loudly, not silently.

const renderer = require('../lib/pdf-renderer');
const data = require('../pipeline/client-documents/data');
const fx = require('./fixtures/client-report');

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

async function letterHtml(opts) {
  const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-letter-of-attestation.j2', context: letterContext(opts), output: 'html' }]);
  const r = out.get('x');
  if (!r.ok) throw new Error(r.error);
  const html = r.buffer.toString('utf8');
  return html.slice(html.indexOf('<p class="loa-title">'));
}

const hostRows = (html) => [...html.matchAll(/<tr class="list[^"]*">([\s\S]*?)<\/tr>/g)]
  .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].trim()));

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

  await test('(LINKS and APP NAMES): one row per host — URL left, notes right', async () => {
    assert.deepStrictEqual(hostRows(await letterHtml()), [
      ['https://portal.northgate.example', 'Customer Portal – Production'],
      ['https://api.northgate.example', 'Partner API &amp; Gateway'],
    ]);
  });

  await test('the scope drops the header row, blank rows, "In-Scope URLs", test accounts and the out-of-scope section', async () => {
    const html = await letterHtml();
    for (const s of ['In-Scope URLs', '>URL<', 'Environment', 'tester@', 'Credentials', 'User Authentication', 'out of scope', 'Denial']) {
      assert.ok(!html.includes(s), `letter contains "${s}"`);
    }
  });

  await test('a scope written as paragraphs or bullets gives one host per line', async () => {
    const scope = '<p>In-Scope URL(s):</p><ul><li>https://a.example</li><li>Mobile app (iOS)</li></ul>'
      + '<p>The following activities were out of scope for this engagement:</p><ul><li>x</li></ul>';
    assert.deepStrictEqual(hostRows(await letterHtml({ scope })), [['https://a.example', ''], ['Mobile app (iOS)', '']]);
  });

  await test('a scope table left blank shows the red placeholder, never an empty list', async () => {
    const scope = SCOPE.replace(/<tr><td style="padding[\s\S]*?Gateway<\/td><td><\/td><\/tr>/, '');
    const html = await letterHtml({ scope });
    assert.ok(html.includes('tpl-missing">(LINKS and APP NAMES)'), 'red placeholder');
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

  await test('renders a PDF', async () => {
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: execContext() }]);
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
