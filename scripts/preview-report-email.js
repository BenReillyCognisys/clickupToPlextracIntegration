// Usage: node scripts/preview-report-email.js <plextracReportId> [more ids…]
//
// Shows the report email a release of each report would draft (pipeline/report-email.js)
// — the portal tokens searched for, the email chain holding them (whose mailbox), the
// signature, who it would go to, and the email itself — WITHOUT creating anything: no
// draft, no Slack message, no record. Gmail is only read. Runs whatever
// REPORT_EMAIL_MODE is set to, so it can check the chain lookup against the real PM
// mailboxes before draft mode is switched on.
//
// Needs the same .env as the app (MongoDB, Plextrac, ClickUp, the Google OAuth client
// and REPORT_EMAIL_TOKEN_KEY), and searches only the PMs who have connected their Gmail
// in the SFE portal.
require('dotenv').config();
const { prepareReportEmail, reportContext } = require('../pipeline/report-email');
const gmail = require('../lib/gmail');
const connections = require('../lib/gmail-connections');

const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (!ids.length) {
  console.error('Usage: node scripts/preview-report-email.js <plextracReportId> [more ids…]');
  process.exit(1);
}

const list = (addrs) => addrs.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ') || '(none)';

(async () => {
  const { usable, broken } = await connections.mailboxes();
  console.log(`Connected mailboxes: ${usable.join(', ') || '(none — PMs connect Gmail in the SFE portal)'}`);
  if (broken.length) console.log(`Need reconnecting:   ${broken.join(', ')}`);
  console.log('');
  for (const reportId of ids) {
    console.log(`── Report ${reportId} ${'─'.repeat(50)}`);
    try {
      const context = await reportContext(reportId);
      if (!context) {
        console.log('No DeliveryFlow engagement or ClickUp task for this report — nothing to search with.\n');
        continue;
      }
      console.log(`Client:  ${context.clientName}\nReport:  ${context.reportName}`);
      const p = await prepareReportEmail({ reportId, ...context });
      console.log(`Tokens:  ${p.tokens.length ? p.tokens.join(', ') : '(none on record)'}`);
      if (p.unsearched?.length) console.log(`Skipped: ${p.unsearched.join(', ')} (Gmail needs reconnecting)`);
      if (!p.ok) {
        console.log(p.state === 'no_client'
          ? `Chain:   ${p.mailbox} ${gmail.threadUrl(p.threadId, p.mailbox)} — but no client address on it`
          : 'Chain:   NOT FOUND — no thread in the connected mailboxes holds the portal links');
        console.log(`Result:  would not draft (${p.state})\n`);
        continue;
      }
      console.log(`Chain:   ${p.mailbox} ${gmail.threadUrl(p.threadId, p.mailbox)}`);
      console.log(`From:    ${p.from ? list([p.from]) : `${p.mailbox} (Gmail's default)`}`);
      console.log(`Signed:  ${p.signature ? 'with the Gmail signature' : 'NO Gmail signature found for that address'}`);
      console.log(`To:      ${list(p.to)}\nCc:      ${list(p.cc)}\nSubject: ${p.subject}`);
      console.log(`Threads: In-Reply-To ${p.inReplyTo || '(none)'}`);
      console.log(`\n${p.text.replace(/^/gm, '  | ')}\n`);
    } catch (err) {
      console.log(`FAILED: ${err.message}${gmail.isAccessError(err) ? '\n  → a Gmail connection needs reconnecting in the SFE portal' : ''}\n`);
    }
  }
  process.exit(0);
})();
