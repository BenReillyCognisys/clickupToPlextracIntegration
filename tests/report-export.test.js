const assert = require('assert');

// Read at require time by pipeline/report-export, so it must be set first.
process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID = 'FOLDER_REPORTS';

// ── Stub the outbound helpers ─────────────────────────────────────────────────
// report-export holds module references and calls through them at runtime, so
// mutating the exports here keeps the tests off Plextrac, Drive and Slack.
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const slack = require('../lib/slack');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

let exportCalls = [];   // [clientId, reportId, format]
let uploads = [];       // uploadFile args
let replies = [];       // { channel, threadTs, text }
let exportResult = { buffer: PDF, contentType: 'application/pdf' };
let uploadResult = { fileId: 'FILE1', url: 'https://drive.google.com/file/d/FILE1/view', name: 'x.pdf', replaced: false };

api.exportReport = async (clientId, reportId, format) => {
  exportCalls.push([clientId, reportId, format]);
  if (exportResult instanceof Error) throw exportResult;
  return exportResult;
};
drive.uploadFile = async (args) => { uploads.push(args); return { ...uploadResult, name: args.filename }; };
slack.postReply = async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); };
slack.postMessage = async (channel, text) => { replies.push({ channel, threadTs: null, text }); };

const {
  exportReleasedReport, reportFilename, safeFilename, looksLikePdf, buildExportMessage,
} = require('../pipeline/report-export');

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

function reset() {
  exportCalls = []; uploads = []; replies = [];
  exportResult = { buffer: PDF, contentType: 'application/pdf' };
  uploadResult = { fileId: 'FILE1', url: 'https://drive.google.com/file/d/FILE1/view', name: 'x.pdf', replaced: false };
}

const RELEASE = {
  clientId: 12, reportId: 34, clientName: 'Acme Corp', reportName: 'Web App Pentest',
  channel: 'C0REL', threadTs: 'ts-9',
};

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

  console.log('\nreportFilename:');

  await test('"<client> - <report>.pdf"', () => {
    eq(reportFilename({ clientName: 'Acme Corp', reportName: 'Web App Pentest', reportId: 34 }),
      'Acme Corp - Web App Pentest.pdf');
  });

  await test('falls back to the report id when names are missing', () => {
    eq(reportFilename({ reportId: 34 }), 'Unknown client - Report 34.pdf');
  });

  await test('is deterministic, so a re-release replaces rather than duplicates', () => {
    eq(reportFilename({ clientName: 'A', reportName: 'B', reportId: 1 }),
      reportFilename({ clientName: 'A', reportName: 'B', reportId: 1 }));
  });

  console.log('\nlooksLikePdf:');

  await test('a real PDF header', () => eq(looksLikePdf(PDF), true));
  await test('a JSON body is not a PDF', () => eq(looksLikePdf(Buffer.from('{"job":"queued"}')), false));
  await test('empty / non-buffer', () => {
    eq(looksLikePdf(Buffer.alloc(0)), false);
    eq(looksLikePdf(null), false);
  });

  console.log('\nbuildExportMessage:');

  await test('new file vs replaced file', () => {
    eq(buildExportMessage({ name: 'a.pdf', url: 'https://d/1', replaced: false }),
      ':page_facing_up: Report saved to Drive: <https://d/1|a.pdf>');
    eq(buildExportMessage({ name: 'a.pdf', url: 'https://d/1', replaced: true }),
      ':page_facing_up: Report updated in Drive: <https://d/1|a.pdf>');
  });

  console.log('\nexportReleasedReport:');

  await test('exports the PDF, files it under the client subfolder, and links it in the thread', async () => {
    reset();
    const result = await exportReleasedReport(RELEASE);
    eq(exportCalls, [[12, 34, 'pdf']]);
    eq(uploads.length, 1);
    eq(uploads[0].filename, 'Acme Corp - Web App Pentest.pdf');
    eq(uploads[0].folderId, 'FOLDER_REPORTS');
    eq(uploads[0].subfolder, 'Acme Corp');
    eq(uploads[0].mimeType, 'application/pdf');
    eq(uploads[0].buffer, PDF);
    eq(result.fileId, 'FILE1');
    eq(replies.length, 1);
    eq(replies[0].channel, 'C0REL');
    eq(replies[0].threadTs, 'ts-9');
    eq(replies[0].text.includes(':page_facing_up: Report saved to Drive:'), true);
    eq(replies[0].text.includes('Acme Corp - Web App Pentest.pdf'), true);
  });

  await test('a JSON body instead of a PDF is not filed, and is flagged in the thread', async () => {
    reset();
    exportResult = { buffer: Buffer.from('{"status":"queued","id":9}'), contentType: 'application/json' };
    const result = await exportReleasedReport(RELEASE);
    eq(result, null);
    eq(uploads.length, 0);
    eq(replies.length, 1);
    eq(replies[0].text.includes(':warning:'), true);
    eq(replies[0].text.includes('PLEXTRAC_EXPORT_PATH'), true);
  });

  await test('a Plextrac failure is flagged, not thrown', async () => {
    reset();
    exportResult = new Error('Plextrac API GET /export failed: 404');
    const result = await exportReleasedReport(RELEASE);
    eq(result, null);
    eq(uploads.length, 0);
    eq(replies[0].text.includes('needs saving manually'), true);
    eq(replies[0].text.includes('404'), true);
  });

  await test('a Drive failure is flagged, not thrown', async () => {
    reset();
    drive.uploadFile = async () => { throw new Error('insufficientFilePermissions'); };
    const result = await exportReleasedReport(RELEASE);
    eq(result, null);
    eq(replies[0].text.includes('insufficientFilePermissions'), true);
    drive.uploadFile = async (args) => { uploads.push(args); return { ...uploadResult, name: args.filename }; };
  });

  await test('an unnamed client still files under a usable folder and name', async () => {
    reset();
    await exportReleasedReport({ ...RELEASE, clientName: '', reportName: '' });
    eq(uploads[0].subfolder, 'Unknown client');
    eq(uploads[0].filename, 'Unknown client - Report 34.pdf');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
