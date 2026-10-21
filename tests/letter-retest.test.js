const assert = require('assert');
const { spawnSync } = require('child_process');

// The letter of attestation's retest version: reading whether, and when, a report was
// retested (pipeline/client-documents/retest.js — Claude is never called here, its
// answer is given), handing that to the letter (pipeline/client-documents), and the
// letter's wording (the real template, through the real renderer).

const retest = require('../pipeline/client-documents/retest');
const data = require('../pipeline/client-documents/data');
const clientDocuments = require('../pipeline/client-documents');
const api = require('../lib/plextrac-api');
const renderer = require('../lib/pdf-renderer');

const eq = (a, b) => assert.deepStrictEqual(a, b);
const d = retest.parseIsoDate;

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

const EXEC_SUMMARY = '<p>This assessment was performed between the period of 08-17-2026 and 08-26-2026 by Rajveer Parmar, '
  + 'with a follow-up retest conducted on 10-05-2026.</p><p>Security&nbsp;Posture &amp; Retest Summary</p>';
const report = (execSummary = EXEC_SUMMARY) => ({
  name: 'Userled Web & API', start_date: '2026-08-17T11:34:10.000Z', end_date: '2026-08-26T11:34:12.000Z',
  exec_summary: { custom_fields: [{ label: 'Scope', text: '<p>scope</p>' }, ...(execSummary === null ? [] : [{ label: 'Executive Summary', text: execSummary }])] },
});
const ANSWER = {
  retested: 'yes', initial_start: '2026-08-17', initial_end: '2026-08-26', retest_start: '2026-10-05', retest_end: '2026-10-05',
  test_type: 'grey-box', target: 'the Userled web application and API',
};

(async () => {
  console.log('testing periods:');

  await test('one day, same month, across months and across a year end', () => {
    eq(retest.formatPeriod(d('2026-10-05'), null), 'on 5 October 2026');
    eq(retest.formatPeriod(d('2026-10-05'), d('2026-10-05')), 'on 5 October 2026');
    eq(retest.formatPeriod(d('2026-08-17'), d('2026-08-26')), 'between 17 and 26 August 2026');
    eq(retest.formatPeriod(d('2026-08-28'), d('2026-09-03')), 'between 28 August and 3 September 2026');
    eq(retest.formatPeriod(d('2026-12-29'), d('2027-01-04')), 'between 29 December 2026 and 4 January 2027');
  });

  await test('only real calendar dates are read', () => {
    eq(d('2026-02-30'), null);
    eq(d('10-05-2026'), null);
    eq(d(''), null);
    eq(d('2024-02-29'), { y: 2024, m: 2, d: 29 });
  });

  await test("a Plextrac timestamp is read as its UK date (BST midnight is the day before in UTC)", () => {
    eq(retest.ukDate('2026-08-31T23:00:00.000Z'), { y: 2026, m: 9, d: 1 });
    eq(retest.ukDate(''), null);
    eq(retest.ukDate('not a date'), null);
  });

  console.log("\nClaude's answer:");

  await test('a retest: both periods and the assessment, as the letter words them', () => {
    const { retest: r, unsure } = retest.interpret(ANSWER);
    eq(unsure, null);
    eq(retest.templateRetest(r), {
      initial_period: 'between 17 and 26 August 2026',
      retest_period: 'on 5 October 2026',
      assessment: 'a grey-box security assessment of the Userled web application and API',
    });
  });

  await test('not a retest: the standard letter, nothing to check', () => {
    eq(retest.interpret({ ...ANSWER, retested: 'no' }), { retest: null, unsure: null });
  });

  await test("unclear, or retested with no readable retest date: can't tell", () => {
    assert.match(retest.interpret({ ...ANSWER, retested: 'unclear' }).unsure, /does not make clear/);
    assert.match(retest.interpret({ ...ANSWER, retest_start: '' }).unsure, /no retest date/);
    assert.match(retest.interpret({ ...ANSWER, retest_start: '2026-13-01' }).unsure, /no retest date/);
    assert.match(retest.interpret({}).unsure, /does not make clear/);
  });

  await test("the initial assessment falls back to the report's Plextrac dates", () => {
    const { retest: r } = retest.interpret({ ...ANSWER, initial_start: '', initial_end: '' }, { start: d('2026-08-18'), end: d('2026-08-25') });
    eq(retest.templateRetest(r).initial_period, 'between 18 and 25 August 2026');
    const { retest: none } = retest.interpret({ ...ANSWER, initial_start: '', initial_end: '' });
    eq(retest.templateRetest(none).initial_period, null);
  });

  await test('an end before its start is dropped, leaving a one-day period', () => {
    const { retest: r } = retest.interpret({ ...ANSWER, retest_end: '2026-10-01' });
    eq(retest.templateRetest(r).retest_period, 'on 5 October 2026');
  });

  await test('no test type or target: the standard wording; "an" before a vowel', () => {
    eq(retest.templateRetest(retest.interpret({ ...ANSWER, test_type: '' }).retest).assessment, null);
    eq(retest.templateRetest(retest.interpret({ ...ANSWER, target: ' ' }).retest).assessment, null);
    eq(retest.templateRetest(retest.interpret({ ...ANSWER, test_type: 'External', target: 'the Acme perimeter' }).retest).assessment,
      'an external security assessment of the Acme perimeter');
  });

  console.log('\nreading a report:');

  await test("Claude is given the Executive Summary as text, and the report's Plextrac dates", async () => {
    let asked;
    const out = await retest.readRetest({ report: report(), clientName: 'Userled', reportId: 1, ask: async (a) => { asked = a; return ANSWER; } });
    eq(asked.text, 'This assessment was performed between the period of 08-17-2026 and 08-26-2026 by Rajveer Parmar, with a follow-up retest conducted on 10-05-2026.\nSecurity Posture & Retest Summary');
    eq([asked.clientName, asked.reportName, asked.start, asked.end], ['Userled', 'Userled Web & API', d('2026-08-17'), d('2026-08-26')]);
    eq(out.notice, null);
    eq(out.retest.retest_period, 'on 5 October 2026');
  });

  await test('Claude failing: the standard letter, with a notice saying why', async () => {
    const out = await retest.readRetest({ report: report(), reportId: 1, ask: async () => { throw new Error('overloaded'); } });
    eq(out.retest, null);
    assert.match(out.notice, /could not tell whether this report was retested \(reading the Executive Summary with Claude failed: overloaded\)/);
  });

  await test('no Executive Summary: the standard letter, with a notice, and Claude is not asked', async () => {
    let askedAtAll = false;
    const out = await retest.readRetest({ report: report(null), reportId: 1, ask: async () => { askedAtAll = true; return ANSWER; } });
    eq([out.retest, askedAtAll], [null, false]);
    assert.match(out.notice, /it has no Executive Summary/);
  });

  await test('not a retest: the standard letter, no notice', async () => {
    eq(await retest.readRetest({ report: report(), reportId: 1, ask: async () => ({ ...ANSWER, retested: 'no' }) }), { retest: null, notice: null });
  });

  console.log('\nthe release:');

  const LOA = { key: 'letter-of-attestation', name: 'Letter of Attestation', template: 'loa.j2', retest: true };
  const EXEC = { key: 'exec-summary', name: 'Executive Summary Report', template: 'exec.j2' };
  const realRead = retest.readRetest;
  const realRender = renderer.renderTemplates;
  const realExists = renderer.templateExists;
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 0x20)]);
  async function release(read) {
    api.getReport = async () => ({ ...report(), client_id: 12 });
    api.getClient = async () => ({ name: 'Userled' });
    api.listReportFindings = async () => [];
    renderer.templateExists = () => true;
    const jobs = [];
    renderer.renderTemplates = async (js) => { jobs.push(...js); return new Map(js.map((j) => [j.id, { ok: true, buffer: PDF, warnings: [] }])); };
    retest.readRetest = read;
    try {
      const out = await clientDocuments.generateClientDocuments({ clientId: 12, reportId: 34, exportedAt: new Date('2026-10-21T10:00:00Z'), documents: [EXEC, LOA], respectSwitches: false });
      return { out, job: (id) => jobs.find((j) => j.id === id) };
    } finally {
      retest.readRetest = realRead;
      renderer.renderTemplates = realRender;
      renderer.templateExists = realExists;
    }
  }

  await test('the letter gets the retest details; the executive summary does not', async () => {
    const details = retest.templateRetest(retest.interpret(ANSWER).retest);
    const { out, job } = await release(async () => ({ retest: details, notice: null }));
    eq(out.map((o) => [o.doc.key, o.ok, o.notices]), [['exec-summary', true, undefined], ['letter-of-attestation', true, undefined]]);
    eq(job('letter-of-attestation').context.REPORT_INFO.retest, details);
    eq(job('letter-of-attestation').context.REPORT_INFO.issue_date, '21 October 2026');
    eq('retest' in job('exec-summary').context.REPORT_INFO, false);
  });

  await test("can't tell: the letter is still made, and its notice goes to the release thread", async () => {
    const { out, job } = await release(async () => ({ retest: null, notice: 'could not tell (because)' }));
    eq(out[1].ok, true);
    eq(out[1].notices, ['could not tell (because)']);
    eq('retest' in job('letter-of-attestation').context.REPORT_INFO, false);
  });

  await test('the real config asks for the retest on the letter only', () => {
    const docs = require('../config/client-documents');
    eq(docs.filter((doc) => doc.retest).map((doc) => doc.key), ['letter-of-attestation']);
  });

  console.log('\nthe letter (real template):');

  const hasJinja = spawnSync(renderer.pythonPath(), ['-c', 'import jinja2'], { stdio: 'ignore' }).status === 0;
  const noJinja = hasJinja ? null : `no jinja2 for ${renderer.pythonPath()}`;
  const USERLED = retest.templateRetest(retest.interpret(ANSWER).retest);

  // The letter's text for these findings ([severity, status] pairs), one line per paragraph.
  async function letterText(findings, rt = USERLED) {
    const rows = findings.map(([sev, status], i) => ({ id: `f${i}`, doc_id: [1, i], data: [i, sev, `Finding ${i}`, status] }));
    const context = data.templateContext({
      report: { name: 'Web App Test', start_date: '2026-08-17T11:34:10.000Z', exec_summary: { custom_fields: [] } },
      clientRecord: { name: 'Userled' },
      findings: data.normaliseFindings(rows),
      exportedAt: new Date('2026-10-21T10:00:00Z'),
      retest: rt,
    });
    const r = (await renderer.renderTemplates([{ id: 'x', template: 'cognisys-letter-of-attestation.j2', context, output: 'html' }])).get('x');
    if (!r.ok) throw new Error(r.error);
    const html = r.buffer.toString('utf8');
    return {
      html,
      lines: html.slice(html.indexOf('<body>')).replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '').split('\n').map((l) => l.trim()).filter(Boolean),
    };
  }
  const n = (k, sev, status) => Array(k).fill([sev, status]);
  const results = (lines) => lines.find((l) => l.startsWith('During'));

  await test('the Userled retest letter, line by line', async () => {
    const { lines, html } = await letterText([...n(5, 'Medium', 'Closed'), ...n(3, 'Low', 'Closed'), ['Low', 'Open']]);
    eq(lines.slice(0, 4), ['Date: 21 October 2026', 'Letter of Attestation', 'Introduction',
      'Cognisys Group were engaged by Userled to perform a grey-box security assessment of the Userled web application and API. '
      + 'The initial assessment was performed between 17 and 26 August 2026, followed by a retest on 5 October 2026 to verify remediation.']);
    eq(results(lines), 'During the initial assessment, Cognisys Group identified 9 issues: 5 Medium and 4 Low. '
      + 'No Critical or High severity issues were identified. On retest, 8 of the 9 issues were confirmed as remediated, '
      + 'including all Medium severity issues. 1 Low severity issue remains open.');
    const crest = lines.indexOf('Cognisys Group is a CREST-accredited penetration testing provider.');
    eq(lines.slice(crest), ['Cognisys Group is a CREST-accredited penetration testing provider.', 'Best regards,',
      'Ben Reilly', 'Pentest Delivery Lead', 'Cognisys Group']);
    assert.ok(html.includes('class="loa-crest"'), 'CREST logo');
  }, { skip: noJinja });

  await test('everything remediated, several open, nothing remediated, one issue', async () => {
    eq(results((await letterText([['High', 'Closed'], ...n(3, 'Low', 'Closed')])).lines),
      'During the initial assessment, Cognisys Group identified 4 issues: 1 High and 3 Low. No Critical severity issues were identified. '
      + 'On retest, all 4 issues were confirmed as remediated.');
    eq(results((await letterText([['Critical', 'Closed'], ...n(2, 'High', 'Closed'), ...n(2, 'Medium', 'Closed'), ['Medium', 'Open'], ...n(3, 'Low', 'In Process')])).lines),
      'During the initial assessment, Cognisys Group identified 9 issues: 1 Critical, 2 High, 3 Medium and 3 Low. '
      + 'On retest, 5 of the 9 issues were confirmed as remediated, including all Critical and High severity issues. 4 issues remain open: 1 Medium and 3 Low.');
    eq(results((await letterText([['Medium', 'Open'], ['Low', 'Open'], ['Low', '']])).lines),
      'During the initial assessment, Cognisys Group identified 3 issues: 1 Medium and 2 Low. No Critical or High severity issues were identified. '
      + 'On retest, none of the 3 issues were confirmed as remediated. 3 issues remain open: 1 Medium and 2 Low.');
    eq(results((await letterText([['Medium', 'Closed'], ['Low', 'Open']])).lines),
      'During the initial assessment, Cognisys Group identified 2 issues: 1 Medium and 1 Low. No Critical or High severity issues were identified. '
      + 'On retest, 1 of the 2 issues was confirmed as remediated, including all Medium severity issues. 1 Low severity issue remains open.');
    eq(results((await letterText([['Low', 'Closed']])).lines),
      'During the initial assessment, Cognisys Group identified 1 issue: 1 Low. No Critical or High severity issues were identified. '
      + 'On retest, the issue was confirmed as remediated.');
  }, { skip: noJinja });

  await test('no test type: the standard engagement wording, with both periods', async () => {
    const rt = { ...USERLED, assessment: null, initial_period: 'between 28 August and 3 September 2026' };
    eq((await letterText([['Low', 'Open']], rt)).lines[3],
      'Cognisys Group were engaged by Userled to identify potential security vulnerabilities that may compromise the confidentiality, '
      + 'integrity, and availability of the Userled application. The initial assessment was performed between 28 August and 3 September 2026, '
      + 'followed by a retest on 5 October 2026 to verify remediation.');
  }, { skip: noJinja });

  await test('no initial dates: a red placeholder, never a silent gap', async () => {
    const { html } = await letterText([['Low', 'Open']], { ...USERLED, initial_period: null });
    assert.ok(html.includes('<span class="tpl-missing">(INITIAL ASSESSMENT DATES)</span>'));
  }, { skip: noJinja });

  await test('not a retest: the standard letter, unchanged', async () => {
    const { lines, html } = await letterText([['Medium', 'Closed'], ['Low', 'Open']], null);
    eq(lines[0], 'Letter of Attestation');
    eq(results(lines), 'During the assessment, Cognisys Group identified a total of 1 issue, which consists of 1 Low.');
    assert.ok(lines.includes('Best regards,') && !lines.includes('Ben Reilly'));
    assert.ok(!html.includes('CREST-accredited') && !html.includes('class="loa-crest"'));
  }, { skip: noJinja });

  console.log(`\n${passed + failed + skipped} tests: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
})();
