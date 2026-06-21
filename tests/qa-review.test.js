const assert = require('assert');
const { stripFormatting, hasFormatting, decodeEntities } = require('../lib/html-text');
const {
  getByPath, setByPath, getExecutiveSummarySegments, getFindingSegments, clientNameFromRecord,
} = require('../pipeline/qa-review/report-fields');

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
const eq = (a, b) => assert.deepStrictEqual(a, b);

// ── html-text ─────────────────────────────────────────────────────────────────
console.log('\nstripFormatting:');

test('strips simple tags', () => {
  eq(stripFormatting('<p>Hello <b>world</b></p>'), 'Hello world');
});

test('converts <br> and </p> to line breaks', () => {
  eq(stripFormatting('<p>Line one</p><p>Line two</p>'), 'Line one\nLine two');
});

test('renders list items as dashes', () => {
  eq(stripFormatting('<ul><li>One</li><li>Two</li></ul>'), '- One\n- Two');
});

test('decodes entities', () => {
  eq(stripFormatting('A &amp; B &lt;tag&gt; &nbsp;end'), 'A & B <tag> end');
});

test('collapses excess blank lines and whitespace', () => {
  eq(stripFormatting('<div>a</div>\n\n\n\n<div>b</div>'), 'a\n\nb');
});

test('returns plain text unchanged', () => {
  eq(stripFormatting('Just plain text.'), 'Just plain text.');
});

console.log('\nhasFormatting:');

test('detects tags', () => eq(hasFormatting('<p>x</p>'), true));
test('detects entities', () => eq(hasFormatting('a &amp; b'), true));
test('plain text has no formatting', () => eq(hasFormatting('plain text'), false));
test('non-string is false', () => eq(hasFormatting(null), false));

test('decodeEntities numeric', () => {
  eq(decodeEntities('&#65;&#x42;'), 'AB');
});

// ── report-fields path helpers ────────────────────────────────────────────────
console.log('\ngetByPath / setByPath:');

test('getByPath nested', () => {
  eq(getByPath({ a: { b: 'x' } }, 'a.b'), 'x');
});

test('getByPath array index', () => {
  eq(getByPath({ a: [{ b: 'y' }] }, 'a[0].b'), 'y');
});

test('setByPath is immutable and updates nested array', () => {
  const orig = { exec_summary: [{ text: 'old' }] };
  const updated = setByPath(orig, 'exec_summary[0].text', 'new');
  eq(updated.exec_summary[0].text, 'new');
  eq(orig.exec_summary[0].text, 'old'); // original untouched
});

// ── exec summary extraction ───────────────────────────────────────────────────
console.log('\ngetExecutiveSummarySegments:');

test('string exec_summary', () => {
  const segs = getExecutiveSummarySegments({ exec_summary: 'Summary text' });
  eq(segs.length, 1);
  eq(segs[0].path, 'exec_summary');
  eq(segs[0].text, 'Summary text');
});

test('array of section objects', () => {
  const segs = getExecutiveSummarySegments({
    exec_summary: [{ title: 'Overview', text: 'A' }, { title: 'Scope', custom_field: 'B' }],
  });
  eq(segs.length, 2);
  eq(segs[0].path, 'exec_summary[0].text');
  eq(segs[1].path, 'exec_summary[1].custom_field');
  eq(segs[1].text, 'B');
});

test('executive_summary fallback field', () => {
  const segs = getExecutiveSummarySegments({ executive_summary: 'Alt' });
  eq(segs[0].text, 'Alt');
});

test('no exec summary → empty', () => {
  eq(getExecutiveSummarySegments({ foo: 'bar' }), []);
});

// ── finding extraction ────────────────────────────────────────────────────────
console.log('\ngetFindingSegments:');

test('top-level description + recommendations', () => {
  const segs = getFindingSegments({ description: 'desc', recommendations: 'rec' });
  eq(segs.map(s => s.path).sort(), ['description', 'recommendations']);
});

test('nested under data', () => {
  const segs = getFindingSegments({ data: { description: 'd' } });
  eq(segs[0].path, 'data.description');
});

test('ignores empty fields', () => {
  eq(getFindingSegments({ description: '   ' }), []);
});

// ── client name extraction ────────────────────────────────────────────────────
console.log('\nclientNameFromRecord:');

test('object with name', () => eq(clientNameFromRecord({ name: 'Acme' }, 'fb'), 'Acme'));
test('array data shape', () => eq(clientNameFromRecord({ data: [12, 'Acme Corp'] }, 'fb'), 'Acme Corp'));
test('falls back', () => eq(clientNameFromRecord(null, 'fb'), 'fb'));

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
