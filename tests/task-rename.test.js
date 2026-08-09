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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
