const assert = require('assert');

// Read at require time by pipeline/report-export, so it must be set first.
process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID = 'FOLDER_REPORTS';

// ── Stub the outbound helpers ─────────────────────────────────────────────────
// report-export calls through these module objects at runtime, so mutating their
// exports keeps the tests off Drive and Slack.
const drive = require('../lib/google-drive');
const slack = require('../lib/slack');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

let resolved = [];      // resolveFolder args
let replies = [];       // { channel, threadTs, text }

drive.resolveFolder = async (spec) => { resolved.push(spec); return 'FOLDER_RESOLVED'; };
slack.postReply = async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); };
slack.postMessage = async (channel, text) => { replies.push({ channel, threadTs: null, text }); };

const {
  resolveReleaseFolder, releaseFolderPath, postToThread, monthLabel, monthFolder, documentFilename,
  exportTimestamp, clientFolderName, safeFilename, looksLikePdf,
} = require('../pipeline/report-export');

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

(async () => {
  console.log('safeFilename:');

  await test('strips path and reserved characters', () => {
    eq(safeFilename('Acme / Corp: "Q1" <draft>?'), 'Acme Corp Q1 draft');
  });

  await test('collapses whitespace and trims dots', () => {
    eq(safeFilename('  Acme   Corp.  '), 'Acme   Corp'.replace(/\s+/g, ' '));
  });

  await test('keeps ordinary punctuation, digits and accents', () => {
    eq(safeFilename("O'Neill & Sons (2024) — Zürich"), "O'Neill & Sons (2024) — Zürich");
  });

  await test('falls back when nothing usable is left', () => {
    eq(safeFilename('///', 'Unknown client'), 'Unknown client');
    eq(safeFilename(null, 'Unknown client'), 'Unknown client');
  });

  await test('caps the length', () => {
    eq(safeFilename('a'.repeat(200)).length, 120);
  });

  console.log('');
  console.log('monthLabel:');

  await test('"<Month> <Year>" for the given instant', () => {
    eq(monthLabel(new Date('2026-08-29T12:00:00Z')), 'August 2026');
    eq(monthLabel(new Date('2026-07-01T12:00:00Z')), 'July 2026');
  });

  await test('reads the month in the configured timezone, not UTC', () => {
    // 00:30 BST on 1 September is still 23:30 UTC on 31 August. The report was
    // exported in September, so it belongs in the September folder.
    const justAfterMidnightBst = new Date('2026-08-31T23:30:00Z');
    eq(monthLabel(justAfterMidnightBst, 'Europe/London'), 'September 2026');
    eq(monthLabel(justAfterMidnightBst, 'UTC'), 'August 2026');
  });

  await test('defaults to now, so the folder follows export time', () => {
    eq(monthLabel(), monthLabel(new Date()));
  });

  console.log('');
  console.log('monthFolder — the number is anchored to the month, not to Drive:');

  const at = (iso) => monthFolder(new Date(iso));

  await test('counts months forward from the epoch (2026-07 = 001)', () => {
    eq(at('2026-07-15T12:00:00Z'), { label: 'July 2026', sequence: 1 });
    eq(at('2026-08-15T12:00:00Z'), { label: 'August 2026', sequence: 2 });
    eq(at('2026-09-15T12:00:00Z'), { label: 'September 2026', sequence: 3 });
  });

  await test('keeps counting across year boundaries', () => {
    eq(at('2026-12-15T12:00:00Z'), { label: 'December 2026', sequence: 6 });
    eq(at('2027-01-15T12:00:00Z'), { label: 'January 2027', sequence: 7 });
    eq(at('2027-07-15T12:00:00Z'), { label: 'July 2027', sequence: 13 });
  });

  await test('reaches three and four figures far out without special-casing', () => {
    eq(at('2050-12-15T12:00:00Z'), { label: 'December 2050', sequence: 294 });
    eq(at('2109-09-15T12:00:00Z').sequence, 999);
    eq(at('2109-10-15T12:00:00Z').sequence, 1000);
  });

  await test('is a pure function of the month — nothing in Drive can shift it', () => {
    // The property the retention sweep depends on: same month in, same number out,
    // every time, whatever has been deleted in the meantime.
    eq(at('2028-03-15T12:00:00Z').sequence, at('2028-03-01T00:30:00Z').sequence);
    eq(at('2028-03-15T12:00:00Z').sequence, 21);
  });

  await test('consecutive months never share or skip a number', () => {
    let previous = at('2026-07-15T12:00:00Z').sequence;
    for (let i = 1; i < 300; i++) {
      const date = new Date(Date.UTC(2026, 6 + i, 15, 12));
      const { sequence } = monthFolder(date);
      eq(sequence, previous + 1);
      previous = sequence;
    }
  });

  await test('the label and the number agree on the month at a timezone boundary', () => {
    // 23:30 UTC on 31 August is 00:30 BST on 1 September: September in both halves.
    const boundary = new Date('2026-08-31T23:30:00Z');
    eq(monthFolder(boundary, 'Europe/London'), { label: 'September 2026', sequence: 3 });
    eq(monthFolder(boundary, 'UTC'), { label: 'August 2026', sequence: 2 });
  });

  console.log('\nexportTimestamp:');

  await test('"YYYY-MM-DD HH-MM-SS", zero-padded, 24-hour', () => {
    eq(exportTimestamp(new Date('2026-01-05T03:04:05Z'), 'UTC'), '2026-01-05 03-04-05');
    eq(exportTimestamp(new Date('2026-01-05T23:59:59Z'), 'UTC'), '2026-01-05 23-59-59');
  });

  await test('midnight is 00, not 24', () => {
    eq(exportTimestamp(new Date('2026-01-05T00:00:00Z'), 'UTC'), '2026-01-05 00-00-00');
  });

  await test('is wall-clock time in the configured timezone', () => {
    // 23:30 UTC on 31 August is 00:30 BST on 1 September.
    eq(exportTimestamp(new Date('2026-08-31T23:30:00Z'), 'Europe/London'), '2026-09-01 00-30-00');
  });

  await test('contains nothing a filesystem rejects', () => {
    eq(/[<>:"/\\|?*]/.test(exportTimestamp()), false);
  });

  console.log('\ndocumentFilename:');

  await test('"<name> <timestamp>.pdf" — the full report\'s name', () => {
    eq(documentFilename('Full-Pentest-Report-Tech-Details', { date: new Date('2026-09-26T13:30:05Z'), tz: 'Europe/London' }),
      'Full-Pentest-Report-Tech-Details 2026-09-26 14-30-05.pdf');
  });

  await test('carries the output format as the extension', () => {
    eq(documentFilename('Letter of Attestation', { date: new Date('2026-09-26T13:30:05Z'), tz: 'UTC', format: 'html' }),
      'Letter of Attestation 2026-09-26 13-30-05.html');
  });

  await test('defaults to now', () => {
    eq(documentFilename('Executive Summary Report').startsWith('Executive Summary Report 20'), true);
  });

  console.log('\nclientFolderName:');

  await test('is the sanitised client name', () => {
    eq(clientFolderName('Acme / Corp: Ltd'), 'Acme Corp Ltd');
  });

  await test('falls back when the client is unnamed', () => {
    eq(clientFolderName(''), 'Unknown client');
    eq(clientFolderName(undefined), 'Unknown client');
  });

  console.log('\nlooksLikePdf:');

  await test('a real PDF header', () => eq(looksLikePdf(PDF), true));
  await test('a JSON body is not a PDF', () => eq(looksLikePdf(Buffer.from('{"job":"queued"}')), false));
  await test('empty / non-buffer', () => {
    eq(looksLikePdf(Buffer.alloc(0)), false);
    eq(looksLikePdf(null), false);
  });

  console.log('\nresolveReleaseFolder:');

  await test('files under <reports folder>/<NNN. Month YYYY>/<client>/', async () => {
    resolved = [];
    const at = new Date('2026-09-26T13:30:05Z');
    eq(await resolveReleaseFolder({ clientName: 'Acme Corp', exportedAt: at }), 'FOLDER_RESOLVED');
    // { label, sequence } — lib/google-drive names it "<NNN>. <label>".
    eq(resolved, [{ folderId: 'FOLDER_REPORTS', sequencedSubfolder: monthFolder(at), subfolder: 'Acme Corp' }]);
    eq(releaseFolderPath({ clientName: 'Acme Corp', exportedAt: at }), '003. September 2026/Acme Corp');
  });

  await test('an unnamed client still files under a usable folder', async () => {
    resolved = [];
    await resolveReleaseFolder({ clientName: '', exportedAt: new Date() });
    eq(resolved[0].subfolder, 'Unknown client');
  });

  await test('the client name is sanitised into a safe folder name', async () => {
    resolved = [];
    await resolveReleaseFolder({ clientName: 'Acme / Corp: "UK"', exportedAt: new Date() });
    eq(resolved[0].subfolder, 'Acme Corp UK');
  });

  console.log('\npostToThread:');

  await test('replies in the release thread, or posts standalone without one', async () => {
    replies = [];
    await postToThread('C0REL', 'ts-9', 'needs a human');
    await postToThread('C0REL', null, 'no thread');
    await postToThread(null, 'ts-9', 'no channel: dropped');
    eq(replies, [
      { channel: 'C0REL', threadTs: 'ts-9', text: 'needs a human' },
      { channel: 'C0REL', threadTs: null, text: 'no thread' },
    ]);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
