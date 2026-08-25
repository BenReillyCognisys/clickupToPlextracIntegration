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

// Most cases carry no scope qualifier; spell it out only where it matters.
function eq(actual, expected) {
  assert.deepStrictEqual(actual, { scope: null, ...expected });
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

test('pipe with an unrecognised type is Unknown, not invented', () => {
  eq(parseTaskName('Acme | Custom Assessment'), { client_name: 'Acme', testing_type: 'Unknown' });
});

test('pipe with multi-word client name', () => {
  eq(parseTaskName('Cognisys Group Ltd | External'), { client_name: 'Cognisys Group Ltd', testing_type: 'External' });
});

test('pipe with multi-word type', () => {
  eq(parseTaskName('Client X | Secure Build Review'), { client_name: 'Client X', testing_type: 'Secure Build Review' });
});

test('text after the type becomes the scope qualifier', () => {
  eq(parseTaskName('Client | Grey Box | Extra'),
     { client_name: 'Client', testing_type: 'Grey Box', scope: 'Extra' });
});

// ── Hyphen-separated format ──────────────────────────────────────────────────
console.log('\nHyphen-separated format:');

test('standard hyphen format', () => {
  eq(parseTaskName('Acme Corp - Grey Box'), { client_name: 'Acme Corp', testing_type: 'Grey Box' });
});

test('hyphen without surrounding spaces', () => {
  eq(parseTaskName('Acme Corp-External'), { client_name: 'Acme Corp', testing_type: 'External' });
});

test('hyphen normalises casing of known type', () => {
  eq(parseTaskName('Acme - secure build review'), { client_name: 'Acme', testing_type: 'Secure Build Review' });
});

test('hyphen with an unrecognised type is Unknown, not invented', () => {
  eq(parseTaskName('Acme - Custom Assessment'), { client_name: 'Acme', testing_type: 'Unknown' });
});

test('hyphenated client name keeps its hyphen when type is known', () => {
  eq(parseTaskName('Smith-Jones Ltd - External'), { client_name: 'Smith-Jones Ltd', testing_type: 'External' });
});

test('hyphenated client name with no type is left intact', () => {
  eq(parseTaskName('Smith-Jones Ltd'), { client_name: 'Smith-Jones Ltd', testing_type: 'Unknown' });
});

test('multiple types — the one ending last wins, client is the first segment', () => {
  eq(parseTaskName('Acme - Internal - External'), { client_name: 'Acme', testing_type: 'External' });
});

test('pipe takes precedence over hyphen for the client cut', () => {
  eq(parseTaskName('Smith-Jones Ltd | Internal'), { client_name: 'Smith-Jones Ltd', testing_type: 'Internal' });
});

// ── No-separator format ──────────────────────────────────────────────────────
console.log('\nNo-separator format:');

test('single-word type at end', () => {
  eq(parseTaskName('Acme Corp External'), { client_name: 'Acme Corp', testing_type: 'External' });
});

test('single-word type — CIS', () => {
  eq(parseTaskName('HMRC CIS'), { client_name: 'HMRC', testing_type: 'CIS' });
});

test('multi-word type wins over shorter match', () => {
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

test('case-insensitive match without a separator', () => {
  eq(parseTaskName('Acme Corp grey box'), { client_name: 'Acme Corp', testing_type: 'Grey Box' });
});

// ── HubSpot deal names ───────────────────────────────────────────────────────
// The real names the HubSpot → ClickUp automation creates: "Client - Deal title -
// Service", with '|' and '-' mixed freely. The service is searched for anywhere in
// the name, so the deal title in the middle is no longer read as the testing type.
console.log('\nHubSpot deal names:');

test('deal title in the middle is not mistaken for the type', () => {
  eq(parseTaskName('Seatmaps Ltd - Penetration Test & DTA - Black Box Penetration Testing'),
     { client_name: 'Seatmaps Ltd', testing_type: 'Black Box' });
});

test('longest service phrase wins over the one nested inside it', () => {
  // "Mobile Device Application Penetration Testing" contains "Application
  // Penetration Testing" (Web App) — the longer, more specific phrase must win.
  eq(parseTaskName('Quint - Web App Testing (Money Guru & Credit Angel) - Mobile Device Application Penetration Testing'),
     { client_name: 'Quint', testing_type: 'Mobile App' });
});

test('per-target qualifier after the service becomes the scope', () => {
  eq(parseTaskName('Quint - Web App Testing (Money Guru & Credit Angel) - Application Penetration Testing- Money Guru'),
     { client_name: 'Quint', testing_type: 'Web App', scope: 'Money Guru' });
});

test('two same-type deals for one client stay distinguishable', () => {
  const a = parseTaskName('Quint - Web App Testing (Money Guru & Credit Angel) - Application Penetration Testing- Money Guru');
  const b = parseTaskName('Quint - Web App Testing (Money Guru & Credit Angel) - Application Penetration Testing- Credit Angel');
  assert.strictEqual(a.client_name, b.client_name);
  assert.strictEqual(a.testing_type, b.testing_type);
  assert.notStrictEqual(a.scope, b.scope);
});

test('"Internal Audit" in a deal title is not an Internal test', () => {
  eq(parseTaskName('Cadensys LTD - Vanta Renewal, Internal Audit, VM Scanning & Pen Testing - Black Box Penetration Test'),
     { client_name: 'Cadensys LTD', testing_type: 'Black Box' });
});

test('mixed pipe and hyphen separators — client is the first segment', () => {
  eq(parseTaskName('Weflayr | Basic Internal Audit ISO 27001 - Free Black Box Pentest'),
     { client_name: 'Weflayr', testing_type: 'Black Box' });
});

test('compliance framework in the middle is not the type', () => {
  eq(parseTaskName('SANDAN AI | 30-Day Fast Start | ISO 27001 | Black Box Pentest'),
     { client_name: 'SANDAN AI', testing_type: 'Black Box' });
});

test('repeated deal title segments do not leak into the client name', () => {
  eq(parseTaskName('Gable Group | Vanta Fast Start - Vanta Fast Start - ISO 27001 | Black Box Pentest'),
     { client_name: 'Gable Group', testing_type: 'Black Box' });
});

test('colourless application testing resolves to Web App', () => {
  eq(parseTaskName('Ballpark Labs Ltd - Additional Testing Days - Application Penetration Testing'),
     { client_name: 'Ballpark Labs Ltd', testing_type: 'Web App' });
});

test('the template placeholder never resolves to a testing type', () => {
  // This is what filed 13 reports under a Plextrac client called "PT": the old
  // parser read "Project Template" as a testing type, so the pipeline ran on it.
  eq(parseTaskName('PT - Project Template'), { client_name: 'PT', testing_type: 'Unknown' });
});

// ── Word boundary ────────────────────────────────────────────────────────────
console.log('\nWord boundary:');

test('does not match a type embedded mid-word', () => {
  eq(parseTaskName('Client ExternalSystem'), { client_name: 'Client ExternalSystem', testing_type: 'Unknown' });
});

// ── Unknown type ─────────────────────────────────────────────────────────────
console.log('\nUnknown type:');

test('no known type → Unknown', () => {
  eq(parseTaskName('Acme Corp Bespoke Work'), { client_name: 'Acme Corp Bespoke Work', testing_type: 'Unknown' });
});

test('unknown type still splits the client off the first separator', () => {
  eq(parseTaskName('Acme Corp - Bespoke - Work'), { client_name: 'Acme Corp', testing_type: 'Unknown' });
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
