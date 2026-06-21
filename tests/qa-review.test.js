const assert = require('assert');
const { stripFormatting, hasFormatting, decodeEntities } = require('../lib/html-text');
const {
  getByPath, setByPath, getExecutiveSummarySegments, getFindingSegments, clientNameFromRecord,
  isExcludedSection,
} = require('../pipeline/qa-review/report-fields');
const { extractPlaceholders, placeholdersPreserved } = require('../lib/placeholders');
const { namesPreserved, countOccurrences } = require('../lib/protected-names');
const { buildThreadBody } = require('../pipeline/qa-review');

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

test('real Plextrac exec_summary.custom_fields shape', () => {
  const segs = getExecutiveSummarySegments({
    exec_summary: {
      custom_fields: [
        { label: 'Overview', text: '<p>One</p>' },
        { label: 'Roadmap', text: '<p>Two</p>' },
      ],
    },
  });
  eq(segs.length, 2);
  eq(segs[0].path, 'exec_summary.custom_fields[0].text');
  eq(segs[0].label, 'exec_summary: Overview');
  eq(segs[1].path, 'exec_summary.custom_fields[1].text');
  eq(segs[1].text, '<p>Two</p>');
});

test('no exec summary → empty', () => {
  eq(getExecutiveSummarySegments({ foo: 'bar' }), []);
});

// ── reduced-review sections (Methodology / Issue Matrix / Limitations) ────────
console.log('\nreduced-review sections:');

test('isExcludedSection matches case-insensitively and as substring', () => {
  eq(isExcludedSection('Methodology'), true);
  eq(isExcludedSection('issue matrix'), true);
  eq(isExcludedSection('Testing Methodology'), true);
  eq(isExcludedSection('Limitations'), true);
  eq(isExcludedSection('Overview'), false);
  eq(isExcludedSection(undefined), false);
});

test('reduced-review sections are kept but tagged clientNameOnly', () => {
  const segs = getExecutiveSummarySegments({
    exec_summary: {
      custom_fields: [
        { label: 'Overview', text: '<p>One</p>' },
        { label: 'Methodology', text: '<p>Method</p>' },
        { label: 'Issue Matrix', text: '<p>Matrix</p>' },
        { label: 'Limitations', text: '<p>Limits</p>' },
        { label: 'Roadmap', text: '<p>Two</p>' },
      ],
    },
  });
  // All sections are retained (none dropped) so client-name still gets checked.
  eq(segs.map(s => s.label), [
    'exec_summary: Overview', 'exec_summary: Methodology', 'exec_summary: Issue Matrix',
    'exec_summary: Limitations', 'exec_summary: Roadmap',
  ]);
  // Narrative sections get the full review; boilerplate ones get client-name only.
  eq(segs.map(s => !!s.clientNameOnly), [false, true, true, true, false]);
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

// ── placeholder guard ─────────────────────────────────────────────────────────
console.log('\nplaceholders:');

test('extracts and sorts %% placeholders', () => {
  eq(extractPlaceholders('a %%CLIENT_SHORTNAME%% b %%REPORT_START_DATE%%'),
    ['%%CLIENT_SHORTNAME%%', '%%REPORT_START_DATE%%']);
});

test('none found → empty', () => eq(extractPlaceholders('plain text'), []));

test('preserved when unchanged (reorder allowed)', () => {
  eq(placeholdersPreserved('x %%A%% y %%B%%', 'y %%B%% then %%A%% rewritten'), true);
});

test('rejected when a placeholder is removed', () => {
  eq(placeholdersPreserved('Engaged by %%CLIENT_SHORTNAME%%.', 'Engaged by Bank of Days.'), false);
});

test('rejected when a placeholder is altered', () => {
  eq(placeholdersPreserved('%%CLIENT_SHORTNAME%%', '%%CLIENT_NAME%%'), false);
});

test('rejected when a placeholder is added', () => {
  eq(placeholdersPreserved('no tokens', 'now has %%CLIENT_SHORTNAME%%'), false);
});

// ── protected names guard ─────────────────────────────────────────────────────
console.log('\nprotected names:');

const COG = ['Cognisys Group Limited', 'Cognisys Group', 'Cognisys'];

test('counts occurrences case-insensitively', () => {
  eq(countOccurrences('Cognisys and COGNISYS again', 'Cognisys'), 2);
});

test('preserved when Cognisys is left intact', () => {
  eq(namesPreserved('Cognisys were engaged by %%CLIENT_SHORTNAME%%.',
    'Cognisys were engaged by Acme.', COG), true);
});

test('rejected when Cognisys is replaced (the reported bug)', () => {
  eq(namesPreserved('Cognisys were engaged to test.', 'Ben Test were engaged to test.', COG), false);
});

test('preserved when an unrelated client name is corrected', () => {
  eq(namesPreserved('MMA Guru asked Cognisys to test.', 'Mental Outlaw Inc asked Cognisys to test.', COG), true);
});

// ── first-round QA thread body ────────────────────────────────────────────────
console.log('\nbuildThreadBody:');

test('lists applied changes and flags', () => {
  const body = buildThreadBody(
    [{ label: 'exec_summary: Overview', type: 'dejargon', before: 'TLS', after: 'encryption' }],
    [{ label: 'exec_summary: Roadmap', issue: 'placeholder text', sentence: 'Lorem Ipsum' }],
    'https://x/report/1');
  eq(body.includes('1 change(s) applied, 1 item(s) flagged.'), true);
  eq(body.includes('_dejargon_: "TLS" → "encryption"'), true);
  eq(body.includes('Lorem Ipsum'), true);
});

test('says nothing found when empty', () => {
  eq(buildThreadBody([], [], 'https://x').includes('No changes or issues found.'), true);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
