const assert = require('assert');
const { isPlaceholderTaskName } = require('../config/placeholder-task-names');
const { buildReportName } = require('../pipeline/plextrac-report');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

// ── Placeholder detection ────────────────────────────────────────────────────
// The template's "Test Task" placeholder must be skipped by the create pipeline so
// it doesn't create a report / post to Slack before ClickBot renames it.
console.log('\nPlaceholder task names:');

test('matches the default "Test Task" placeholder', () => {
  assert.strictEqual(isPlaceholderTaskName('Test Task'), true);
});

test('is case-insensitive and trims', () => {
  assert.strictEqual(isPlaceholderTaskName('  test task '), true);
});

test('a real project name is not a placeholder', () => {
  assert.strictEqual(isPlaceholderTaskName('Acme Corp | Grey Box'), false);
});

test('matches the Penetration Test template task by name', () => {
  // "PT - Project Template" ran the full create pipeline and filed every templated
  // deal under a Plextrac client called "PT" until it was recognised here.
  assert.strictEqual(isPlaceholderTaskName('PT - Project Template'), true);
});

test('recognises template scaffolding structurally, not just by exact name', () => {
  assert.strictEqual(isPlaceholderTaskName('VMaaS Project List Template'), true);
  assert.strictEqual(isPlaceholderTaskName('Project Template'), true);
  assert.strictEqual(isPlaceholderTaskName('CE - Task Template'), true);
});

test('a client whose name merely contains "template" is not a placeholder', () => {
  assert.strictEqual(isPlaceholderTaskName('Template Recruitment Ltd | Black Box'), false);
});

test('empty / missing names are not placeholders', () => {
  assert.strictEqual(isPlaceholderTaskName(''), false);
  assert.strictEqual(isPlaceholderTaskName(undefined), false);
});

// ── Report name reflects the testing type ────────────────────────────────────
// A Black Box → Grey Box change must produce a different report name for the same
// start date — this is what the rename sync PUTs back to Plextrac.
console.log('\nReport name on type change:');

test('changing the testing type changes the report name', () => {
  const startMs = Date.UTC(2026, 7, 15); // 15 Aug 2026 — mid-month, timezone-safe
  const blackBox = buildReportName('Black Box', startMs);
  const greyBox = buildReportName('Grey Box', startMs);
  assert.notStrictEqual(blackBox, greyBox);
  assert.ok(greyBox.startsWith('Grey Box | '), `unexpected name: ${greyBox}`);
});

test('a scope qualifier keeps same-type reports for one client distinct', () => {
  const startMs = Date.UTC(2026, 7, 15);
  const moneyGuru = buildReportName('Web App', startMs, 'Money Guru');
  const creditAngel = buildReportName('Web App', startMs, 'Credit Angel');
  assert.strictEqual(moneyGuru, 'Web App (Money Guru) | August 2026');
  assert.notStrictEqual(moneyGuru, creditAngel);
});

test('no scope leaves the report name unchanged', () => {
  const startMs = Date.UTC(2026, 7, 15);
  assert.strictEqual(buildReportName('Black Box', startMs, null), 'Black Box | August 2026');
  assert.strictEqual(buildReportName('Black Box', startMs), 'Black Box | August 2026');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
