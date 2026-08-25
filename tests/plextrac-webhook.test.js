const assert = require('assert');

// buildSecondRoundMessage doesn't touch Mongo/Slack/Plextrac at require time, but the
// module it lives in requires lib/logger, lib/slack, etc. — none of which need env
// vars to load, so this is safe to require directly for the pure message builder.
const { buildSecondRoundMessage } = require('../routes/plextrac-webhook');

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

console.log('\nbuildSecondRoundMessage:');

test('hyperlinks the client and report names and tags the second-round reviewers', () => {
  eq(
    buildSecondRoundMessage({
      clientName: 'Acme Corp',
      clientUrl: 'https://x/client/1',
      reportName: 'Web App Pentest',
      reportUrl: 'https://x/client/1/report/2',
    }),
    'Client: <https://x/client/1|Acme Corp> - <https://x/client/1/report/2|Web App Pentest> ready for second round of QA <@U07LSK8F8DN> <@U07PYU23RN3>',
  );
});

test('escapes mrkdwn-special characters in link text', () => {
  const msg = buildSecondRoundMessage({
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
    buildSecondRoundMessage({ clientName: 'Acme', reportName: 'Report 5' }),
    'Client: Acme - Report 5 ready for second round of QA <@U07LSK8F8DN> <@U07PYU23RN3>',
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
