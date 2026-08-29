const assert = require('assert');
const { stripFormatting, hasFormatting, decodeEntities } = require('../lib/html-text');
const {
  getByPath, setByPath, getExecutiveSummarySegments, getFindingSegments, clientNameFromRecord,
  isExcludedSection, getReportCustomFields, findEmptyCustomFields, isOptionalField, isBlankValue,
} = require('../pipeline/qa-review/report-fields');
const { extractPlaceholders, placeholdersPreserved } = require('../lib/placeholders');
const { namesPreserved, countOccurrences } = require('../lib/protected-names');
const { buildThreadBody, buildFirstRoundMessage } = require('../pipeline/qa-review');
const { postSecondRoundQa, buildSecondRoundMessage } = require('../pipeline/qa-second-round');
const { postReleaseAnnouncement, buildReleaseMessage } = require('../pipeline/qa-released');
const { emptyFieldsLines } = require('../pipeline/qa-review/empty-fields');

// -- Stub the outbound helpers -------------------------------------------------
// The pipelines look these up on the module object at call time, so mutating the
// exports here is enough to keep the announcement tests off Slack and Plextrac.
const slack = require('../lib/slack');
const users = require('../lib/plextrac-users');
const plextrac = require('../lib/plextrac-api');

const posts = [];   // { channel, text } from postMessage
const replies = []; // { channel, threadTs, text } from postReply
slack.postMessage = async (channel, text) => { posts.push({ channel, text }); return 'ts-1'; };
slack.postReply = async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); };
slack.lookupUserIdByEmail = async (email) => (email === 'ada@example.com' ? 'U777' : null);
users.cuidMap = async () => new Map([
  ['cuid-ada', { cuid: 'cuid-ada', name: 'Ada Lovelace', email: 'ada@example.com' }],
]);
plextrac.getClient = async () => ({ name: 'Acme Corp' });

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
// Async variant of test(), for the pipeline functions that await Slack.
async function atest(description, fn) {
  try {
    await fn();
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

test('Limitation and Roadmap sections are tagged noDejargon (de-jargon skipped only)', () => {
  const segs = getExecutiveSummarySegments({
    exec_summary: {
      custom_fields: [
        { label: 'Overview', text: '<p>One</p>' },
        { label: 'Methodology', text: '<p>Method</p>' },
        { label: 'Limitation', text: '<p>Limit</p>' },   // singular still matches
        { label: 'Project Roadmap', text: '<p>Plans</p>' },
      ],
    },
  });
  // De-jargon is skipped on Limitation / Roadmap only; the others are unaffected.
  eq(segs.map(s => !!s.noDejargon), [false, false, true, true]);
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

// ── report custom fields ──────────────────────────────────────────────────────
console.log('\ncustom fields:');

// The real shape: a flat list of label/value pairs on the report.
const CUSTOM_FIELDS = {
  custom_fields: [
    { label: 'Team Name',        value: 'Red Team' },
    { label: 'Author 1',         value: 'Ada Lovelace' },
    { label: 'Author 1 Title',   value: '' },
    { label: 'Author 1 Email',   value: '<p><br></p>' },
    { label: 'Client Acronym',   value: '' },
    { label: 'Client Full Name', value: '' },
    { label: 'Version',          value: '' },
    { label: 'Report Title',     value: '' },
  ],
};

test('reads label/value pairs off the report', () => {
  const read = getReportCustomFields(CUSTOM_FIELDS);
  eq(read.length, 8);
  eq(read[0], { path: 'custom_fields[0]', label: 'Team Name', value: 'Red Team' });
});

test('flags empty required fields only', () => {
  eq(findEmptyCustomFields(CUSTOM_FIELDS), ['Author 1 Title', 'Author 1 Email']);
});

test('nothing flagged when every required field is filled', () => {
  eq(findEmptyCustomFields({ custom_fields: [{ label: 'Team Name', value: 'Red Team' }] }), []);
});

test('no custom fields on the report → nothing flagged', () => {
  eq(findEmptyCustomFields({}), []);
});

test('optional labels match exactly, case- and whitespace-insensitively', () => {
  eq(isOptionalField('client acronym'), true);
  eq(isOptionalField('  Client   Full Name '), true);
  eq(isOptionalField('Client Contact Name'), false);
  eq(isOptionalField('Author 1'), false);
});

test('blank values: whitespace, empty markup and entities count as empty', () => {
  eq(isBlankValue(''), true);
  eq(isBlankValue('   '), true);
  eq(isBlankValue('<p>&nbsp;</p>'), true);
  eq(isBlankValue(null), true);
  eq(isBlankValue(undefined), true);
  eq(isBlankValue([]), true);
  eq(isBlankValue('<p>Ada</p>'), false);
  eq(isBlankValue(0), false);
});

test('tolerates title/text key names', () => {
  eq(findEmptyCustomFields({ custom_fields: [{ title: 'Team Name', text: '' }] }), ['Team Name']);
});

test('an unlabelled empty field is reported by its path', () => {
  eq(findEmptyCustomFields({ custom_fields: [{ value: '' }] }), ['custom_fields[0]']);
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
  eq(body.includes('1 change(s) suggested, 1 item(s) flagged, 0 empty custom field(s).'), true);
  eq(body.includes('_dejargon_: "TLS" → "encryption"'), true);
  eq(body.includes('Lorem Ipsum'), true);
});

test('says nothing found when empty', () => {
  eq(buildThreadBody([], [], 'https://x').includes('No changes or issues found.'), true);
});

test('lists empty custom fields and @-mentions the submitter', () => {
  const body = buildThreadBody([], [], 'https://x', {
    emptyFields: ['Author 1 Title', 'Author 1 Email'],
    submitter: '<@U123>',
  });
  eq(body.includes('2 empty custom field(s)'), true);
  eq(body.includes('*Empty custom fields* — <@U123> please fill these in:'), true);
  eq(body.includes('• Author 1 Title'), true);
  eq(body.includes('No changes or issues found.'), false);
});

test('empty custom fields still listed when the submitter cannot be resolved', () => {
  const body = buildThreadBody([], [], 'https://x', { emptyFields: ['Team Name'] });
  eq(body.includes('*Empty custom fields* — please fill these in:'), true);
});

console.log('\nbuildFirstRoundMessage:');

test('hyperlinks the client and report names', () => {
  eq(
    buildFirstRoundMessage({
      clientName: 'Acme Corp',
      clientUrl: 'https://x/client/1',
      reportName: 'Web App Pentest',
      reportUrl: 'https://x/client/1/report/2',
    }),
    'Client: <https://x/client/1|Acme Corp> - <https://x/client/1/report/2|Web App Pentest> ready for first round of QA',
  );
});

test('escapes mrkdwn-special characters in link text', () => {
  const msg = buildFirstRoundMessage({
    clientName: 'A & B <Ltd>',
    clientUrl: 'https://x/client/1',
    reportName: 'Q1 <draft>',
    reportUrl: 'https://x/report/2',
  });
  eq(msg.includes('A &amp; B &lt;Ltd&gt;'), true);
  eq(msg.includes('Q1 &lt;draft&gt;'), true);
});

test('falls back to plain text when a url is missing', () => {
  eq(
    buildFirstRoundMessage({ clientName: 'Acme', reportName: 'Report 5' }),
    'Client: Acme - Report 5 ready for first round of QA',
  );
});

console.log('\nbuildSecondRoundMessage:');

test('hyperlinks names, pings reviewers, and credits the first QA', () => {
  eq(
    buildSecondRoundMessage({
      clientName: 'Acme Corp',
      clientUrl: 'https://x/client/1',
      reportName: 'Web App Pentest',
      reportUrl: 'https://x/client/1/report/2',
      firstQaName: 'Ben Reilly',
      mentions: ['U111', 'U222'],
    }),
    'Client: <https://x/client/1|Acme Corp> - <https://x/client/1/report/2|Web App Pentest> ready for second round of QA <@U111> <@U222>. First QA done by Ben Reilly',
  );
});

test('uses the built-in reviewer list when mentions are omitted', () => {
  const msg = buildSecondRoundMessage({
    clientName: 'Acme', reportName: 'Report 5', firstQaName: 'Ada Lovelace',
  });
  eq(msg.includes('<@U0811891NTU> <@U07R28NJ0KS> <@U07LSK8F8DN> <@U07PYU23RN3>'), true);
  eq(msg.includes('First QA done by Ada Lovelace'), true);
});

test('escapes mrkdwn-special characters in names and the first-QA name', () => {
  const msg = buildSecondRoundMessage({
    clientName: 'A & B <Ltd>',
    reportName: 'Q1 <draft>',
    firstQaName: 'A<b>',
    mentions: [],
  });
  eq(msg.includes('A &amp; B &lt;Ltd&gt;'), true);
  eq(msg.includes('Q1 &lt;draft&gt;'), true);
  eq(msg.includes('First QA done by A&lt;b&gt;'), true);
});

test('omits the mention block when the reviewer list is empty', () => {
  eq(
    buildSecondRoundMessage({ clientName: 'Acme', reportName: 'Report 5', firstQaName: 'Grace', mentions: [] }),
    'Client: Acme - Report 5 ready for second round of QA. First QA done by Grace',
  );
});

console.log('\nbuildReleaseMessage:');

test('hyperlinks names, pings reviewers, credits release QA, and bookends with a check', () => {
  eq(
    buildReleaseMessage({
      clientName: 'Acme Corp',
      clientUrl: 'https://x/client/1',
      reportName: 'Web App Pentest',
      reportUrl: 'https://x/client/1/report/2',
      releaseQaName: 'Ben Reilly',
      mentions: ['U111', 'U222'],
    }),
    ':white_check_mark: Client: <https://x/client/1|Acme Corp> - <https://x/client/1/report/2|Web App Pentest> released <@U111> <@U222>. Release QA done by Ben Reilly :white_check_mark:',
  );
});

test('uses the built-in release reviewer list when mentions are omitted', () => {
  const msg = buildReleaseMessage({
    clientName: 'Acme', reportName: 'Report 5', releaseQaName: 'Ada Lovelace',
  });
  eq(msg.includes('<@U09CF6MLUF3> <@U06NJCD93RT> <@U06V88B1MEK>'), true);
  eq(msg.includes('Release QA done by Ada Lovelace'), true);
});

test('escapes mrkdwn-special characters in names and the release-QA name', () => {
  const msg = buildReleaseMessage({
    clientName: 'A & B <Ltd>',
    reportName: 'Q1 <draft>',
    releaseQaName: 'A<b>',
    mentions: [],
  });
  eq(msg.includes('A &amp; B &lt;Ltd&gt;'), true);
  eq(msg.includes('Q1 &lt;draft&gt;'), true);
  eq(msg.includes('Release QA done by A&lt;b&gt;'), true);
});

test('omits the mention block when the release reviewer list is empty', () => {
  eq(
    buildReleaseMessage({ clientName: 'Acme', reportName: 'Report 5', releaseQaName: 'Grace', mentions: [] }),
    ':white_check_mark: Client: Acme - Report 5 released. Release QA done by Grace :white_check_mark:',
  );
});

console.log('');
console.log('emptyFieldsLines:');

test('no empty fields → no lines', () => {
  eq(emptyFieldsLines([]), []);
  eq(emptyFieldsLines(undefined), []);
});

test('the release round says the report has already gone out', () => {
  const lines = emptyFieldsLines(['Team Name'], '<@U777>', 'released');
  eq(lines[1].includes('Released with empty custom fields'), true);
  eq(lines[1].includes('ALREADY GONE OUT'), true);
  eq(lines[1].includes('re-issue'), true);
  eq(lines[1].includes('<@U777>'), true);
  // The first two rounds keep the routine wording.
  eq(emptyFieldsLines(['Team Name'], '<@U777>', 'second')[1].includes('please fill these in:'), true);
});

test('lists the fields under a mention-led heading', () => {
  eq(emptyFieldsLines(['Team Name', 'Author 1'], '<@U777>'), [
    '',
    '*Empty custom fields* — <@U777> please fill these in:',
    '• Team Name',
    '• Author 1',
  ]);
});

test('omits the mention when the actor could not be resolved, and escapes labels', () => {
  eq(emptyFieldsLines(['A & B <x>']), [
    '',
    '*Empty custom fields* — please fill these in:',
    '• A &amp; B &lt;x&gt;',
  ]);
});

// ── second-round / release empty-field notices ────────────────────────────────
// Both announcements run the same check as the first round and report it in their
// own message's thread, @-ing the actor who moved the report into that round.
const REPORT_WITH_GAPS = {
  custom_fields: [
    { label: 'Team Name', value: 'Red Team' },
    { label: 'Author 1 Email', value: '' },
    { label: 'Version', value: '' },   // exempt — never reported
  ],
};
const ANNOUNCEMENT = {
  clientId: 1, clientName: 'Acme Corp', clientUrl: 'https://x/client/1',
  reportName: 'Web App Pentest', reportUrl: 'https://x/client/1/report/2',
  actorCuid: 'cuid-ada', reportId: 2,
};

function resetSlack() { posts.length = 0; replies.length = 0; }

(async () => {
  console.log('');
  console.log('second-round / release empty-field notices:');

  await atest('second round replies in its own thread, @-ing whoever sent it on', async () => {
    resetSlack();
    await postSecondRoundQa({ ...ANNOUNCEMENT, report: REPORT_WITH_GAPS });
    eq(posts.length, 1);
    eq(posts[0].text.includes('ready for second round of QA'), true);
    eq(replies.length, 1);
    eq(replies[0].threadTs, 'ts-1');
    eq(replies[0].channel, posts[0].channel);
    eq(replies[0].text.split('\n'), [
      '*Empty custom fields* — <@U777> please fill these in:',
      '• Author 1 Email',
    ]);
  });

  await atest('release replies in its own thread, @-ing whoever released it', async () => {
    resetSlack();
    await postReleaseAnnouncement({ ...ANNOUNCEMENT, report: REPORT_WITH_GAPS });
    eq(posts.length, 1);
    eq(posts[0].text.includes('released'), true);
    eq(replies.length, 1);
    eq(replies[0].threadTs, 'ts-1');
    eq(replies[0].text.includes('<@U777>'), true);
    eq(replies[0].text.includes('• Author 1 Email'), true);
    // Release uses its own, louder wording — not the routine "please fill these in".
    eq(replies[0].text.includes('Released with empty custom fields'), true);
  });

  await atest('nothing extra is posted when every required field is filled', async () => {
    resetSlack();
    const report = {
      custom_fields: [{ label: 'Team Name', value: 'Red Team' }, { label: 'Version', value: '' }],
    };
    await postSecondRoundQa({ ...ANNOUNCEMENT, report });
    await postReleaseAnnouncement({ ...ANNOUNCEMENT, report });
    eq(posts.length, 2);
    eq(replies.length, 0);
  });

  await atest('a missing report object is skipped, not crashed on', async () => {
    resetSlack();
    await postSecondRoundQa({ ...ANNOUNCEMENT });
    eq(posts.length, 1);
    eq(replies.length, 0);
  });

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
