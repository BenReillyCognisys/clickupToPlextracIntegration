const assert = require('assert');
const { parseTaskName } = require('../pipeline/parse-task');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}`);
    console.error(`       expected : ${JSON.stringify(err.expected)}`);
    console.error(`       actual   : ${JSON.stringify(err.actual)}`);
    failed++;
  }
}

function eq(actual, expected) {
  assert.deepStrictEqual(actual, expected);
}

// ── Pipe-separated format ────────────────────────────────────────────────────
console.log('\nPipe-separated format:');

test('standard pipe format', () => {
  eq(parseTaskName('Acme Corp | Grey Box'), { client_name: 'Acme Corp', testing_type: 'Grey Box' });
});

test('pipe with extra whitespace', () => {
  eq(parseTaskName('  Acme Corp  |  Grey Box  '), { client_name: 'Acme Corp', testing_type: 'Grey Box' });
});

test('pipe normalises casing of known type', () => {
  eq(parseTaskName('Acme | grey box'), { client_name: 'Acme', testing_type: 'Grey Box' });
});

test('pipe with unknown type preserves raw type', () => {
  eq(parseTaskName('Acme | Custom Assessment'), { client_name: 'Acme', testing_type: 'Custom Assessment' });
});

test('pipe with multi-word client name', () => {
  eq(parseTaskName('Cognisys Group Ltd | External'), { client_name: 'Cognisys Group Ltd', testing_type: 'External' });
});

test('pipe with multi-word type', () => {
  eq(parseTaskName('Client X | Secure Build Review'), { client_name: 'Client X', testing_type: 'Secure Build Review' });
});

test('splits only on first pipe when multiple pipes present', () => {
  eq(parseTaskName('Client | Grey Box | Extra'), { client_name: 'Client', testing_type: 'Grey Box | Extra' });
});

// ── No-pipe format ───────────────────────────────────────────────────────────
console.log('\nNo-pipe format:');

test('single-word type at end', () => {
  eq(parseTaskName('Acme Corp External'), { client_name: 'Acme Corp', testing_type: 'External' });
});

test('single-word type — CIS', () => {
  eq(parseTaskName('HMRC CIS'), { client_name: 'HMRC', testing_type: 'CIS' });
});

test('multi-word type wins over shorter match', () => {
  // "Grey Box" should win, not "Box"
  eq(parseTaskName('Acme Corp Grey Box'), { client_name: 'Acme Corp', testing_type: 'Grey Box' });
});

test('multi-word type — Secure Build Review', () => {
  eq(parseTaskName('Client Ltd Secure Build Review'), { client_name: 'Client Ltd', testing_type: 'Secure Build Review' });
});

test('multi-word type — Cloud Assessment', () => {
  eq(parseTaskName('Some Client Cloud Assessment'), { client_name: 'Some Client', testing_type: 'Cloud Assessment' });
});

test('multi-word type — Code Review', () => {
  eq(parseTaskName('Client Code Review'), { client_name: 'Client', testing_type: 'Code Review' });
});

test('multi-word type — Mobile App', () => {
  eq(parseTaskName('Startup Co Mobile App'), { client_name: 'Startup Co', testing_type: 'Mobile App' });
});

test('case-insensitive match without pipe', () => {
  eq(parseTaskName('Acme Corp grey box'), { client_name: 'Acme Corp', testing_type: 'Grey Box' });
});

// ── Word boundary ────────────────────────────────────────────────────────────
console.log('\nWord boundary:');

test('does not match type embedded mid-word', () => {
  // "ExternalSystem" should not match "External"
  eq(parseTaskName('Client ExternalSystem'), { client_name: 'Client ExternalSystem', testing_type: 'Unknown' });
});

// ── Unknown type ─────────────────────────────────────────────────────────────
console.log('\nUnknown type:');

test('no pipe, no known type → Unknown', () => {
  eq(parseTaskName('Acme Corp Bespoke Work'), { client_name: 'Acme Corp Bespoke Work', testing_type: 'Unknown' });
});

test('empty string → Unknown', () => {
  eq(parseTaskName(''), { client_name: '', testing_type: 'Unknown' });
});

test('only whitespace → Unknown', () => {
  eq(parseTaskName('   '), { client_name: '', testing_type: 'Unknown' });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
