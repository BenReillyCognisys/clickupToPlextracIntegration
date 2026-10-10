// The report email (pipeline/report-email.js, lib/email-message.js): who the reply goes
// to, its threading headers and raw message, the Gmail searches across the PMs'
// mailboxes, and the run itself with Gmail, MongoDB, ClickUp and Slack stubbed.

const assert = require('assert');

const BEN = 'ben@cognisys.group';
const ALICE = 'alice@cognisys.group';
const GROUP = 'pentestpm@cognisys.group';
delete process.env.REPORT_EMAIL_INTERNAL_DOMAINS;

const msg = require('../lib/email-message');
const gmail = require('../lib/gmail');
const connections = require('../lib/gmail-connections');
const store = require('../lib/report-email-store');
const dfStore = require('../lib/deliveryflow-store');
const taskStore = require('../lib/task-store');
const clickup = require('../lib/clickup-api');
const slack = require('../lib/slack');
const people = require('../lib/slack-people');
const reportEmail = require('../pipeline/report-email');

let passed = 0;
let failed = 0;

async function test(description, fn) {
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
const emailsOf = (list) => list.map((a) => a.email);

// Decodes a raw message back into { headers, text, html } to check what Gmail would get.
function decodeRaw(raw) {
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = message.split('\r\n\r\n');
  const headers = Object.fromEntries(head.split('\r\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()];
  }));
  const body = rest.join('\r\n\r\n');
  const parts = body.split(/--report-email-[^\r\n-]+(?:--)?/).filter((p) => p.includes('Content-Type'));
  const decode = (p) => Buffer.from(p.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8');
  return { headers, text: decode(parts[0]), html: decode(parts[1]) };
}
const decodeWord = (s) => Buffer.from(s.slice(10, -2), 'base64').toString('utf8');

const OPTS = { exclude: [BEN], internalDomains: ['cognisys.group', 'cognisys.co.uk'] };

(async () => {
  console.log('\nparseAddressList:');

  await test('quoted names with commas, bare addresses, mixed case', () => {
    eq(msg.parseAddressList('"Smith, Jane" <Jane.Smith@Acme.com>, bob@acme.com ,  Ann Lee <ann@acme.com>'), [
      { name: 'Smith, Jane', email: 'jane.smith@acme.com' },
      { name: '', email: 'bob@acme.com' },
      { name: 'Ann Lee', email: 'ann@acme.com' },
    ]);
  });

  await test('empty, missing and junk entries are dropped', () => {
    eq(msg.parseAddressList(undefined), []);
    eq(msg.parseAddressList('undisclosed-recipients:;, , not-an-address'), []);
  });

  console.log('\nreplyRecipients:');

  await test('the PM\'s own message: the client in To, other Cognisys addresses in Cc, never the PM', () => {
    const r = msg.replyRecipients({
      from: 'Ben <ben@cognisys.group>',
      to: 'Jane <jane@acme.com>, it-sec@acme.com',
      cc: `alice@cognisys.co.uk, ${GROUP}, BEN@cognisys.group`,
    }, OPTS);
    eq(emailsOf(r.to), ['jane@acme.com', 'it-sec@acme.com']);
    eq(emailsOf(r.cc), ['alice@cognisys.co.uk', GROUP]);
  });

  await test('the client\'s message: sender and their Cc in To, deduplicated', () => {
    const r = msg.replyRecipients({
      from: 'Jane <jane@acme.com>', to: BEN, cc: 'jane@acme.com, bob@acme.com',
    }, OPTS);
    eq(emailsOf(r.to), ['jane@acme.com', 'bob@acme.com']);
    eq(r.cc, []);
  });

  await test('Reply-To wins over From', () => {
    const r = msg.replyRecipients({ from: 'noreply@acme.com', 'reply-to': 'security@acme.com', to: BEN }, OPTS);
    eq(emailsOf(r.to), ['security@acme.com']);
  });

  await test('an internal-only message has no client', () => {
    const r = msg.replyRecipients({ from: ALICE, to: BEN }, OPTS);
    eq(r.to, []);
  });

  console.log('\nsubject, threading and the raw message:');

  await test('replySubject adds one "Re:" only', () => {
    eq(msg.replySubject('Acme – Pentest Onboarding'), 'Re: Acme – Pentest Onboarding');
    eq(msg.replySubject('RE: Acme'), 'RE: Acme');
  });

  await test('threadingHeaders chains References', () => {
    eq(msg.threadingHeaders({ 'message-id': '<b@x>', references: '<a@x>' }), { inReplyTo: '<b@x>', references: '<a@x> <b@x>' });
    eq(msg.threadingHeaders({ 'message-id': '<a@x>' }), { inReplyTo: '<a@x>', references: '<a@x>' });
    eq(msg.threadingHeaders({}), {});
  });

  await test('buildRawMessage: From, To, Cc, encoded subject, threading, text and HTML', () => {
    const { text, html } = msg.renderBody(['Hi all,', 'See https://x.plextrac.com', 'Kind regards,\nTeam']);
    const d = decodeRaw(msg.buildRawMessage({
      from: { name: 'Ben Reilly', email: BEN },
      to: [{ name: 'Smith, Jane', email: 'jane@acme.com' }], cc: [{ name: '', email: ALICE }],
      subject: 'Re: Acme – Onboarding', inReplyTo: '<b@x>', references: '<a@x> <b@x>', text, html,
    }));
    eq(d.headers.from, `"Ben Reilly" <${BEN}>`);
    eq(d.headers.to, '"Smith, Jane" <jane@acme.com>');
    eq(d.headers.cc, ALICE);
    eq(decodeWord(d.headers.subject), 'Re: Acme – Onboarding');
    eq(d.headers['in-reply-to'], '<b@x>');
    eq(d.headers.references, '<a@x> <b@x>');
    eq(d.text, 'Hi all,\n\nSee https://x.plextrac.com\n\nKind regards,\nTeam');
    assert.ok(d.html.includes('<a href="https://x.plextrac.com">'), 'links are clickable');
    assert.ok(d.html.includes('Kind regards,<br>Team'));
  });

  await test('buildRawMessage without a From leaves it to Gmail', () => {
    const d = decodeRaw(msg.buildRawMessage({ to: [{ name: '', email: 'a@b.com' }], subject: 'Re: x', text: 'x', html: 'x' }));
    assert.ok(!('from' in d.headers));
  });

  console.log('\nsearches:');

  await test('tokensIn finds portal uuids in urls and bare tokens, lower-cased', () => {
    eq(reportEmail.tokensIn(
      'https://portal.cognisys.group/form/9B2F6C1E-1D2A-4C3B-8E4F-5A6B7C8D9E0F',
      null, '1a2b3c4d-1111-4222-8333-444455556666', 'no token here',
    ), ['9b2f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e0f', '1a2b3c4d-1111-4222-8333-444455556666']);
  });

  await test('linkQuery ORs the quoted tokens and leaves drafts out', () => {
    eq(reportEmail.linkQuery(['a', 'b']), '("a" OR "b") -in:drafts -in:chats');
  });

  await test('clientNameQuery strips quotes and looks back 6 months', () => {
    eq(reportEmail.clientNameQuery(' Acme "Corp" '), 'subject:"Acme Corp" newer_than:6m -in:drafts -in:chats');
    eq(reportEmail.clientNameQuery(''), null);
  });

  await test('reportTitle is the testing type from the report name', () => {
    eq(reportEmail.reportTitle('External Infrastructure | October 2026'), 'External Infrastructure');
    eq(reportEmail.reportTitle(''), 'penetration test');
  });

  // ── Chains across mailboxes ─────────────────────────────────────────────────
  // Ben sent the onboarding from his own address, cc'ing Alice and the pentestpm@
  // group; Jane replied to all. Both Ben and Alice hold a copy (different thread ids).
  const m = (id, date, sent, headers) => ({ id, draft: false, sent, date, headers: { 'message-id': `<${id}@x>`, ...headers } });
  const SUBJECT = 'Acme Corp – Penetration Test Onboarding';
  const onboarding = (sentBy) => [
    m('m1', 1000, sentBy === BEN, {
      from: 'Ben Reilly <ben@cognisys.group>', to: 'Jane <jane@acme.com>', cc: `${GROUP}, ${ALICE}`, subject: SUBJECT,
    }),
    m('m2', 2000, false, {
      from: 'Jane <jane@acme.com>', to: BEN, cc: `bob@acme.com, ${GROUP}, ${ALICE}`, subject: `RE: ${SUBJECT}`, references: '<m1@x>',
    }),
  ];
  const BEN_COPY = { id: 'b-1', messages: onboarding(BEN) };
  const ALICE_COPY = { id: 'a-1', messages: onboarding(null) };

  console.log('\nchains across mailboxes:');

  await test('groupChains: copies sharing a Message-ID are one chain; others are separate', () => {
    const other = { id: 'b-2', messages: [m('z1', 500, true, { from: BEN, to: 'x@other.com' })] };
    const chains = reportEmail.groupChains([
      { mailbox: BEN, thread: BEN_COPY }, { mailbox: BEN, thread: other }, { mailbox: ALICE, thread: ALICE_COPY },
    ]);
    eq(chains.length, 2);
    eq(chains.map((c) => c.copies.map((x) => x.thread.id).sort()).sort(), [['a-1', 'b-1'], ['b-2']]);
  });

  await test('pickCopy: the mailbox that last sent in the chain', () => {
    const chain = { copies: [{ mailbox: ALICE, thread: ALICE_COPY }, { mailbox: BEN, thread: BEN_COPY }] };
    eq(reportEmail.pickCopy(chain, [ALICE, BEN]).mailbox, BEN);
    const aliceFollowedUp = { id: 'a-1', messages: [...onboarding(null), m('m3', 3000, true, { from: ALICE, to: 'jane@acme.com' })] };
    eq(reportEmail.pickCopy({ copies: [{ mailbox: BEN, thread: BEN_COPY }, { mailbox: ALICE, thread: aliceFollowedUp }] }, [BEN, ALICE]).mailbox, ALICE);
  });

  // ── The run, with everything outside stubbed ────────────────────────────────
  console.log('\ndraftReportEmail:');

  const FORM = 'https://portal.cognisys.group/form/9b2f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e0f';
  const TOKEN = '9b2f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e0f';

  let w; // what the stubs saw
  // boxes: mailbox → { link: thread ids the link search finds, name: … the name search, threads }
  function stub({
    boxes = { [BEN]: { link: ['b-1'], threads: { 'b-1': BEN_COPY } }, [ALICE]: {} },
    usable = [BEN, ALICE], broken = [], failing = {}, claim = true, draftError = null,
  } = {}) {
    w = { searches: [], drafts: [], finished: [], slack: [], markedBroken: [] };
    connections.mailboxes = async () => ({ usable, broken });
    connections.markBroken = async (mailbox, reason) => { w.markedBroken.push({ mailbox, reason }); };
    store.claim = async () => claim;
    store.finish = async (reportId, data) => { w.finished.push(data); };
    dfStore.findByReportId = async () => ({ deal_id: 'D1', form_url: FORM, form_token: TOKEN });
    dfStore.findByDealId = async () => [{ form_token: TOKEN }];
    taskStore.findByReportId = async () => null;
    clickup.getTask = async () => { throw new Error('not expected'); };
    gmail.searchThreads = async (mailbox, q) => {
      w.searches.push({ mailbox, q });
      if (failing[mailbox]) throw failing[mailbox];
      const box = boxes[mailbox] || {};
      return (q.startsWith('subject:') ? box.name : box.link) || [];
    };
    gmail.getThread = async (mailbox, id) => boxes[mailbox].threads[id];
    gmail.createDraft = async (mailbox, { raw, threadId }) => {
      if (draftError) throw draftError;
      w.drafts.push({ mailbox, raw, threadId });
      return { draftId: 'r-1', messageId: 'dm-1', threadId };
    };
    slack.postReply = async (channel, ts, text) => { w.slack.push({ channel, ts, text }); };
    slack.postMessage = async (channel, text) => { w.slack.push({ channel, text }); return '1.0'; };
    people.slackIdForEmail = async (email) => ({ [BEN]: 'U_BEN', [ALICE]: 'U_ALICE', 'carol@cognisys.co.uk': 'U_CAROL' }[email] || null);
  }
  const RELEASE = {
    reportId: 277397777, clientName: 'Acme Corp', reportName: 'External Infrastructure | October 2026',
    channel: 'C_RELEASE', threadTs: '111.222', releaserEmail: 'carol@cognisys.co.uk',
  };

  await test('mode off (the default): does nothing at all', async () => {
    stub();
    delete process.env.REPORT_EMAIL_MODE;
    eq(await reportEmail.draftReportEmail(RELEASE), 'off');
    eq(w.searches.length + w.drafts.length + w.slack.length, 0);
  });

  process.env.REPORT_EMAIL_MODE = 'draft';

  await test('an unknown mode is treated as off', async () => {
    stub();
    process.env.REPORT_EMAIL_MODE = 'send';
    eq(await reportEmail.draftReportEmail(RELEASE), 'off');
    eq(w.drafts.length, 0);
    process.env.REPORT_EMAIL_MODE = 'draft';
  });

  await test('drafts a reply-all in the sending PM\'s mailbox, from their address, and @s them in Slack', async () => {
    stub();
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.searches.map((s) => s.mailbox), [BEN, ALICE]);
    eq(w.searches[0].q, `("${TOKEN}") -in:drafts -in:chats`);
    eq(w.drafts.length, 1);
    eq(w.drafts[0].mailbox, BEN);
    eq(w.drafts[0].threadId, 'b-1');
    const d = decodeRaw(w.drafts[0].raw);
    eq(d.headers.from, `"Ben Reilly" <${BEN}>`);
    eq(d.headers.to, '"Jane" <jane@acme.com>, bob@acme.com');
    eq(d.headers.cc, `${GROUP}, ${ALICE}`);
    eq(decodeWord(d.headers.subject), `RE: ${SUBJECT}`);
    eq(d.headers['in-reply-to'], '<m2@x>');
    eq(d.headers.references, '<m1@x> <m2@x>');
    assert.ok(d.text.includes('your External Infrastructure report has been completed and released'));
    eq(w.finished[0].state, 'drafted');
    eq(w.finished[0].mailbox, BEN);
    eq(w.finished[0].to, ['jane@acme.com', 'bob@acme.com']);
    eq(w.slack.length, 1);
    eq(w.slack[0].ts, '111.222');
    assert.ok(w.slack[0].text.includes(`drafted in ${BEN}'s Drafts, from ${BEN}`));
    assert.ok(w.slack[0].text.includes('<@U_BEN> please check it and press send'));
    assert.ok(w.slack[0].text.includes('#all/b-1'));
    assert.ok(!w.slack[0].text.includes('client\'s name only'));
  });

  await test('the chain in two mailboxes (Alice cc\'d) is one chain, drafted in Ben\'s — he sent it', async () => {
    stub({ boxes: {
      [BEN]: { link: ['b-1'], threads: { 'b-1': BEN_COPY } },
      [ALICE]: { link: ['a-1'], threads: { 'a-1': ALICE_COPY } },
    } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.drafts.length, 1);
    eq(w.drafts[0].mailbox, BEN);
  });

  await test('only a cc\'d PM holds it: drafted there, with Ben (the sender) kept in Cc', async () => {
    stub({ boxes: { [BEN]: {}, [ALICE]: { link: ['a-1'], threads: { 'a-1': ALICE_COPY } } } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.drafts[0].mailbox, ALICE);
    const d = decodeRaw(w.drafts[0].raw);
    assert.ok(!('from' in d.headers), 'Alice never wrote in it, so Gmail uses her own address');
    eq(d.headers.to, '"Jane" <jane@acme.com>, bob@acme.com');
    eq(d.headers.cc, `${BEN}, ${GROUP}`);
    assert.ok(w.slack[0].text.includes('<@U_ALICE>'));
  });

  await test('a revoked connection is skipped and marked to reconnect; the chain is still found in another', async () => {
    stub({ failing: { [ALICE]: new Error('invalid_grant: Token has been expired or revoked.') } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.drafts[0].mailbox, BEN);
    eq(w.markedBroken.map((b) => b.mailbox), [ALICE]);
  });

  await test('a passing Gmail error doesn\'t mark the connection broken', async () => {
    stub({ failing: { [ALICE]: new Error('Gmail 503') } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.markedBroken, []);
  });

  await test('only connected mailboxes are searched', async () => {
    stub({ usable: [BEN], broken: [ALICE] });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.searches.map((x) => x.mailbox), [BEN]);
  });

  await test('already made for this report: no search, no draft, no Slack', async () => {
    stub({ claim: false });
    eq(await reportEmail.draftReportEmail(RELEASE), 'already');
    eq(w.searches.length + w.drafts.length + w.slack.length, 0);
  });

  await test('ignores drafts in the chain and replies to the last sent message', async () => {
    stub({ boxes: { [BEN]: { link: ['b-1'], threads: { 'b-1': { id: 'b-1', messages: [...onboarding(BEN), {
      ...m('m3', 3000, false, { from: BEN, to: 'someone-else@other.com' }), draft: true,
    }] } } } } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    const d = decodeRaw(w.drafts[0].raw);
    eq(d.headers['in-reply-to'], '<m2@x>');
    assert.ok(!d.headers.to.includes('someone-else'));
  });

  await test('a chain ending on an internal note still goes to the client from the message before', async () => {
    stub({ boxes: { [BEN]: { link: ['b-1'], threads: { 'b-1': { id: 'b-1', messages: [
      ...onboarding(BEN), m('m3', 3000, false, { from: ALICE, to: BEN, subject: 'RE: Acme' }),
    ] } } } } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    const d = decodeRaw(w.drafts[0].raw);
    eq(d.headers.to, '"Jane" <jane@acme.com>, bob@acme.com');
    eq(d.headers['in-reply-to'], '<m3@x>');
  });

  await test('no link match: one chain with the client name in its subject (in two mailboxes) is used, flagged', async () => {
    stub({ boxes: {
      [BEN]: { name: ['b-1'], threads: { 'b-1': BEN_COPY } },
      [ALICE]: { name: ['a-1'], threads: { 'a-1': ALICE_COPY } },
    } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.finished[0].match, 'client-name');
    assert.ok(w.slack[0].text.includes('client\'s name only'));
  });

  await test('no link match and two different chains by name: nothing drafted, asks for it by hand', async () => {
    const other = { id: 'b-2', messages: [m('z1', 500, true, { from: BEN, to: 'x@acme.com', subject: 'Acme Corp renewal' })] };
    stub({ boxes: { [BEN]: { name: ['b-1', 'b-2'], threads: { 'b-1': BEN_COPY, 'b-2': other } } } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'no_thread');
    eq(w.drafts.length, 0);
    eq(w.finished[0].state, 'no_thread');
    assert.ok(w.slack[0].text.includes('2 chains have "Acme Corp" in the subject'));
    assert.ok(w.slack[0].text.includes('Please send the report email by hand'));
  });

  await test('no chain at all: nothing drafted, and connections needing reconnecting are named', async () => {
    stub({ boxes: { [BEN]: {} }, broken: ['carl@cognisys.group'], failing: { [ALICE]: new Error('invalid_grant') } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'no_thread');
    eq(w.drafts.length, 0);
    assert.ok(w.slack[0].text.includes('no onboarding email chain for Acme Corp'));
    assert.ok(w.slack[0].text.includes(`Gmail needs reconnecting in the SFE portal: carl@cognisys.group, ${ALICE}`));
  });

  await test('a chain with no client address on it: nothing drafted', async () => {
    stub({ boxes: { [BEN]: { link: ['b-1'], threads: { 'b-1': { id: 'b-1', messages: [
      m('m1', 1000, true, { from: BEN, to: ALICE, subject: 'Acme' }),
    ] } } } } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'no_client');
    eq(w.drafts.length, 0);
    assert.ok(w.slack[0].text.includes('has no client address on it'));
  });

  await test('ClickUp report: tokens come from the task\'s link fields', async () => {
    stub();
    dfStore.findByReportId = async () => null;
    taskStore.findByReportId = async () => ({ clickup_task_id: 'cu1' });
    clickup.getTask = async () => ({ custom_fields: [
      { name: 'authformlink', value: FORM },
      { name: 'Something else', value: 'https://x/form/00000000-0000-4000-8000-000000000000' },
    ] });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.searches[0].q, `("${TOKEN}") -in:drafts -in:chats`);
  });

  await test('every connection refused: fails, says to reconnect, never throws', async () => {
    const err = new Error('invalid_grant: Token has been expired or revoked.');
    stub({ failing: { [BEN]: err, [ALICE]: err } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'failed');
    eq(w.finished[0].state, 'failed');
    eq(w.markedBroken.map((b) => b.mailbox).sort(), [ALICE, BEN]);
    assert.ok(w.slack[0].text.includes('Gmail connection needs reconnecting in the SFE portal'));
  });

  await test('no PM has connected Gmail: fails and says so', async () => {
    stub({ usable: [], broken: [] });
    eq(await reportEmail.draftReportEmail(RELEASE), 'failed');
    eq(w.searches.length, 0);
    assert.ok(w.slack[0].text.includes('no PM has connected their Gmail yet'));
  });

  await test('the draft refused (connection revoked meanwhile): that mailbox is marked and named', async () => {
    stub({ draftError: new Error('invalid_grant: Token has been expired or revoked.') });
    eq(await reportEmail.draftReportEmail(RELEASE), 'failed');
    eq(w.markedBroken.map((b) => b.mailbox), [BEN]);
    assert.ok(w.slack[0].text.includes(`${BEN}'s Gmail connection needs reconnecting`));
  });

  await test('a failed draft is recorded as failed (so it can be tried again)', async () => {
    stub({ draftError: new Error('Gmail 500') });
    eq(await reportEmail.draftReportEmail(RELEASE), 'failed');
    eq(w.finished[0], { state: 'failed', reason: 'Gmail 500' });
    assert.ok(w.slack[0].text.includes('Gmail 500'));
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
