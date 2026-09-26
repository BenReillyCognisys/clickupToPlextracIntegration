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

// The exec summary as a release builds it, with two hostile images planted in a
// Plextrac narrative (narratives reach the PDF through |safe, unsanitised).
function execContext() {
  const report = structuredClone(fx.report);
  report.exec_summary.custom_fields[0].text += '<img src="file:///C:/Windows/win.ini"><img src="http://127.0.0.1:9/x.png">';
  return data.templateContext({
    report, clientRecord: fx.clientRecord, findings: fx.findings,
    exportedAt: new Date('2026-09-26T13:30:00Z'),
    ai: { executive_summary: data.cleanHtml('<p>CLAUDE REWRITE of the summary.</p>') },
    replaceNarratives: { 'Executive Summary': 'executive_summary' },
  });
}

(async () => {
  const hasJinja = canImport('jinja2');
  const hasWeasy = hasJinja && canImport('weasyprint');
  const noJinja = hasJinja ? null : `no jinja2 for ${renderer.pythonPath()}`;
  const noWeasy = hasWeasy ? null : `WeasyPrint not importable for ${renderer.pythonPath()}`;

  console.log('renderer — the real executive summary template:');

  await test('renders HTML with Claude\'s text in place of the original summary', async () => {
    const out = await renderer.renderTemplates([{ id: 'x', template: 'cognisys-exec-summary.j2', context: execContext(), output: 'html' }]);
    const html = out.get('x').buffer.toString('utf8');
    assert.ok(html.includes('CLAUDE REWRITE of the summary.'));
    assert.ok(!html.includes('ORIGINAL EXEC SUMMARY'));
    assert.ok(html.includes('Executive Summary Report'));
    assert.ok(html.includes('26 September 2026'), 'cover date');
    assert.ok(html.includes('Version 1.2'));
    assert.ok(html.includes('Jane Tester'));
    assert.ok(!html.includes('NOTE: Report Narrative'), 'every narrative found');
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
