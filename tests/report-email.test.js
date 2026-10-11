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
const axios = require('axios');
const { inlineImages, sniff } = require('../lib/inline-images');

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
  // Every leaf part (multipart/alternative, and multipart/related inside it when images
  // are embedded), by its own headers.
  const parts = body.split(/--report-email-[^\r\n]*/).map((p) => p.replace(/^\r\n/, ''))
    .filter((p) => /^Content-Type:/m.test(p) && !/^Content-Type: multipart\//m.test(p))
    .map((p) => {
      const [h, ...b] = p.split('\r\n\r\n');
      const ph = Object.fromEntries(h.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      return { headers: ph, data: Buffer.from(b.join('').replace(/\s+/g, ''), 'base64') };
    });
  const of = (type) => parts.find((p) => p.headers['content-type'].startsWith(type));
  return {
    headers,
    text: of('text/plain').data.toString('utf8'),
    html: of('text/html').data.toString('utf8'),
    images: parts.filter((p) => p.headers['content-id']),
  };
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

  await test('renderBody adds the Gmail signature under the last paragraph, as HTML and as text', () => {
    const sig = '<div dir="ltr"><b>Ben Reilly</b><br>Head of Delivery | Cognisys<br><a href="https://cognisys.co.uk">cognisys.co.uk</a></div>';
    const { text, html } = msg.renderBody(['Hi team,', 'Best wishes,'], { signatureHtml: sig });
    eq(text, 'Hi team,\n\nBest wishes,\nBen Reilly\nHead of Delivery | Cognisys\ncognisys.co.uk');
    assert.ok(html.includes('<p>Best wishes,</p>\n<div class="gmail_signature" data-smartmail="gmail_signature">' + sig + '</div>'), html);
    const none = msg.renderBody(['Hi team,', 'Best wishes,']);
    eq(none.text, 'Hi team,\n\nBest wishes,');
    assert.ok(!none.html.includes('gmail_signature'));
  });

  await test('the template: the wording in config/report-email.js, ending "Best wishes,"', () => {
    const paragraphs = require('../config/report-email').paragraphs();
    eq(paragraphs[0], 'Hi team,');
    eq(paragraphs[1], 'Great news, your report is now ready!');
    assert.ok(paragraphs.some((p) => p.includes('head to the artefacts section')));
    assert.ok(paragraphs.some((p) => p.includes('schedule a wash-up call')));
    eq(paragraphs[paragraphs.length - 1], 'Best wishes,');
  });

  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const JPG = Buffer.from('ffd8ffe000104a46494600', 'hex');

  await test('inlineImages: https and data: images become cid: attachments; the rest stay links and are reported', async () => {
    const fetched = [];
    const fetch = async (url) => {
      fetched.push(url);
      if (url.includes('broken')) throw new Error('HTTP 403');
      return { data: url.includes('photo') ? JPG : PNG, contentType: url.includes('photo') ? 'image/jpeg' : 'image/png' };
    };
    const sig = [
      '<img src="https://ci3.googleusercontent.com/mail-sig/logo?a=1&amp;b=2" width="120">',
      '<img alt="me" src=\'https://example.com/photo.jpg\'>',
      '<img src="https://ci3.googleusercontent.com/mail-sig/logo?a=1&amp;b=2">', // the same logo again
      '<img src="http://insecure.example.com/x.png">',
      '<img src="https://drive.google.com/broken">',
      `<img src="data:image/png;base64,${PNG.toString('base64')}">`,
    ].join('');
    const r = await inlineImages(sig, { fetch });
    eq(fetched, ['https://ci3.googleusercontent.com/mail-sig/logo?a=1&b=2', 'https://example.com/photo.jpg', 'https://drive.google.com/broken']);
    eq(r.images.map((i) => [i.contentType, i.filename]), [['image/png', 'signature-1.png'], ['image/jpeg', 'signature-2.jpg'], ['image/png', 'signature-3.png']]);
    eq(r.failed.map((f) => f.reason), ['not an https:// image', 'HTTP 403']);
    const cids = [...r.html.matchAll(/src=["']cid:([^"']+)["']/g)].map((m) => m[1]);
    eq(cids, [r.images[0].cid, r.images[1].cid, r.images[0].cid, r.images[2].cid]);
    assert.ok(r.html.includes('width="120"'), 'other attributes kept');
    assert.ok(r.html.includes('src="http://insecure.example.com/x.png"') && r.html.includes('src="https://drive.google.com/broken"'));
  });

  await test('inlineImages: no images, or no signature, changes nothing', async () => {
    eq(await inlineImages('<div>Ben</div>', { fetch: async () => { throw new Error('no'); } }), { html: '<div>Ben</div>', images: [], failed: [] });
    eq((await inlineImages('')).images, []);
  });

  await test('sniff tells the image type from its bytes when the server doesn\'t say', () => {
    eq([sniff(PNG), sniff(JPG), sniff(Buffer.from('GIF89a')), sniff(Buffer.from('<html>'))], ['image/png', 'image/jpeg', 'image/gif', null]);
  });

  await test('buildRawMessage embeds images as multipart/related, found by Content-ID', () => {
    const images = [{ cid: 'sig1.x@break.services', contentType: 'image/png', filename: 'signature-1.png', data: PNG }];
    const raw = Buffer.from(msg.buildRawMessage({
      to: [{ name: '', email: 'a@b.com' }], subject: 'Re: x', text: 'hi', html: '<p>hi</p><img src="cid:sig1.x@break.services">', inlineImages: images,
    }), 'base64url').toString('utf8');
    assert.ok(/Content-Type: multipart\/alternative/.test(raw));
    assert.ok(/Content-Type: multipart\/related/.test(raw));
    const d = decodeRaw(Buffer.from(raw).toString('base64url'));
    eq(d.text, 'hi');
    assert.ok(d.html.includes('cid:sig1.x@break.services'));
    eq(d.images.length, 1);
    eq(d.images[0].headers['content-id'], '<sig1.x@break.services>');
    eq(d.images[0].headers['content-disposition'], 'inline; filename="signature-1.png"');
    assert.ok(d.images[0].data.equals(PNG), 'image bytes survive');
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
    signature = '<div>Ben Reilly<br>Cognisys</div>', signatureError = null, pmMode = 'draft', optedIn = true,
  } = {}) {
    w = { searches: [], drafts: [], finished: [], slack: [], markedBroken: [], signatures: [], modeAsked: [] };
    connections.modeFor = async (mailbox) => { w.modeAsked.push(mailbox); return typeof pmMode === 'function' ? pmMode(mailbox) : pmMode; };
    connections.anyOptedIn = async () => optedIn;
    gmail.getSignature = async (mailbox, from) => {
      w.signatures.push({ mailbox, from });
      if (signatureError) throw signatureError;
      return signature;
    };
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

  await test('REPORT_EMAIL_MODE=off: does nothing at all, for every PM', async () => {
    stub({ pmMode: 'send' });
    process.env.REPORT_EMAIL_MODE = 'off';
    eq(await reportEmail.draftReportEmail(RELEASE), 'off');
    eq(w.searches.length + w.drafts.length + w.slack.length, 0);
  });

  await test('an unknown REPORT_EMAIL_MODE is treated as off', async () => {
    stub({ pmMode: 'draft' });
    process.env.REPORT_EMAIL_MODE = 'sometimes';
    eq(await reportEmail.draftReportEmail(RELEASE), 'off');
    eq(w.drafts.length, 0);
  });

  await test('REPORT_EMAIL_MODE unset (or "pm") leaves it to each PM', () => {
    delete process.env.REPORT_EMAIL_MODE;
    eq(reportEmail.mode(), 'pm');
    eq(['off', 'draft', 'send'].map(reportEmail.effectiveMode), ['off', 'draft', 'send']);
    eq(reportEmail.effectiveMode(undefined), 'off', 'a PM who never chose is off');
    process.env.REPORT_EMAIL_MODE = 'draft';
    eq(reportEmail.effectiveMode('send'), 'draft', '"draft" never sends');
    process.env.REPORT_EMAIL_MODE = 'PM';
    eq(reportEmail.effectiveMode('send'), 'send');
  });

  delete process.env.REPORT_EMAIL_MODE;

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
    assert.ok(d.text.startsWith('Hi team,\n\nGreat news, your report is now ready!'), d.text);
    assert.ok(d.text.endsWith('Best wishes,\nBen Reilly\nCognisys'), d.text);
    assert.ok(d.html.includes('<div class="gmail_signature" data-smartmail="gmail_signature"><div>Ben Reilly<br>Cognisys</div></div>'));
    eq(w.signatures, [{ mailbox: BEN, from: BEN }]);
    eq(w.finished[0].state, 'drafted');
    eq(w.finished[0].mailbox, BEN);
    eq(w.finished[0].to, ['jane@acme.com', 'bob@acme.com']);
    eq(w.slack.length, 1);
    eq(w.slack[0].ts, '111.222');
    assert.ok(w.slack[0].text.includes(`drafted in ${BEN}'s Drafts, from ${BEN}`));
    assert.ok(w.slack[0].text.includes('<@U_BEN> please check it and press send'));
    assert.ok(w.slack[0].text.includes('#all/b-1'));
    assert.ok(!w.slack[0].text.includes('signature'));
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

  await test('only a portal link matches: a thread with just the client name is never used', async () => {
    stub({ boxes: {
      [BEN]: { name: ['b-1'], threads: { 'b-1': BEN_COPY } },
      [ALICE]: { name: ['a-1'], threads: { 'a-1': ALICE_COPY } },
    } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'no_thread');
    eq(w.drafts.length, 0);
    eq(w.searches.filter((x) => !x.q.startsWith('(')), [], 'no other kind of search');
    eq(w.finished[0].state, 'no_thread');
    eq(w.slack[0].text, ':warning: Report email not drafted — the onboarding email thread for Acme Corp couldn\'t be found. Please send the report email by hand.');
  });

  await test('no portal links on record: nothing searched, and Slack says the thread couldn\'t be found', async () => {
    stub();
    dfStore.findByReportId = async () => null;
    eq(await reportEmail.draftReportEmail(RELEASE), 'no_thread');
    eq(w.searches, []);
    assert.ok(w.slack[0].text.includes('couldn\'t be found (no portal links are on record for this report)'));
  });

  await test('no Gmail signature: still drafted, and Slack says to add it before sending', async () => {
    stub({ signature: '' });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    assert.ok(decodeRaw(w.drafts[0].raw).text.endsWith('Best wishes,'));
    assert.ok(w.slack[0].text.includes(`No Gmail signature found for ${BEN} — add your signature before sending`));
  });

  await test('a signature that can\'t be read never stops the draft, or marks the connection broken', async () => {
    stub({ signatureError: new Error('Request had insufficient authentication scopes.') });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.markedBroken, []);
    assert.ok(w.slack[0].text.includes('No Gmail signature found'));
  });

  await test('signature images are downloaded and embedded in the draft', async () => {
    stub({ signature: '<div>Ben Reilly<br><img src="https://ci3.googleusercontent.com/mail-sig/logo" alt="Cognisys"></div>' });
    const realGet = axios.get;
    axios.get = async (url) => ({ status: 200, headers: { 'content-type': 'image/png' }, data: PNG });
    try {
      eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    } finally {
      axios.get = realGet;
    }
    const d = decodeRaw(w.drafts[0].raw);
    eq(d.images.length, 1);
    assert.ok(d.images[0].data.equals(PNG));
    const cid = d.images[0].headers['content-id'].slice(1, -1);
    assert.ok(d.html.includes(`<img src="cid:${cid}" alt="Cognisys">`), d.html);
    assert.ok(!d.html.includes('googleusercontent'), 'no link left to load');
    assert.ok(!w.slack[0].text.includes('couldn\'t be loaded'));
  });

  await test('a signature image that can\'t be downloaded stays a link, and Slack says to check it', async () => {
    stub({ signature: '<div>Ben<img src="https://drive.google.com/uc?id=private"></div>' });
    const realGet = axios.get;
    axios.get = async () => ({ status: 403, headers: { 'content-type': 'text/html' }, data: Buffer.from('denied') });
    try {
      eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    } finally {
      axios.get = realGet;
    }
    const d = decodeRaw(w.drafts[0].raw);
    eq(d.images, []);
    assert.ok(d.html.includes('https://drive.google.com/uc?id=private'));
    assert.ok(w.slack[0].text.includes('1 signature image(s) couldn\'t be loaded (HTTP 403) — check the signature before sending'), w.slack[0].text);
  });

  await test('no chain at all: nothing drafted, and connections needing reconnecting are named', async () => {
    stub({ boxes: { [BEN]: {} }, broken: ['carl@cognisys.group'], failing: { [ALICE]: new Error('invalid_grant') } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'no_thread');
    eq(w.drafts.length, 0);
    assert.ok(w.slack[0].text.includes('the onboarding email thread for Acme Corp couldn\'t be found'));
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

  // ── Each PM's own choice (SFE portal → Gmail) ─────────────────────────────
  console.log('\neach PM\'s report email choice:');

  await test('no PM has turned report emails on yet: the release stays quiet', async () => {
    stub({ optedIn: false });
    eq(await reportEmail.draftReportEmail(RELEASE), 'off');
    eq(w.searches.length + w.drafts.length + w.slack.length + w.finished.length, 0);
  });

  await test('the PM whose mailbox it is chose off: nothing drafted, and Slack asks for it by hand', async () => {
    stub({ pmMode: 'off' });
    eq(await reportEmail.draftReportEmail(RELEASE), 'pm_off');
    eq(w.modeAsked, [BEN]);
    eq(w.drafts.length, 0);
    eq(w.finished[0].state, 'pm_off');
    eq(w.slack[0].text, `:email: Report email for Acme Corp not made — ${BEN} has report emails turned off (SFE portal → Gmail). Please send the report email by hand.`);
  });

  await test('auto send: drafted now, scheduled after the hold, and Slack says when and how to stop it', async () => {
    stub({ pmMode: 'send' });
    const before = Date.now();
    eq(await reportEmail.draftReportEmail(RELEASE), 'scheduled');
    eq(w.drafts.length, 1);
    const f = w.finished[0];
    eq(f.state, 'scheduled');
    eq(f.draft_id, 'r-1');
    eq([f.client_name, f.channel, f.thread_ts], ['Acme Corp', 'C_RELEASE', '111.222']);
    const hold = f.send_at.getTime() - before;
    assert.ok(hold >= 15 * 60 * 1000 - 50 && hold <= 15 * 60 * 1000 + 1000, `hold ${hold}`);
    const text = w.slack[0].text;
    assert.ok(text.includes('will be sent automatically at'), text);
    assert.ok(text.includes(`<@U_BEN> it's in ${BEN}'s Drafts until then`), text);
    assert.ok(text.includes('delete the draft to stop it'), text);
  });

  await test('auto send with REPORT_EMAIL_SEND_DELAY_MINUTES', async () => {
    stub({ pmMode: 'send' });
    process.env.REPORT_EMAIL_SEND_DELAY_MINUTES = '5';
    const before = Date.now();
    await reportEmail.draftReportEmail(RELEASE);
    delete process.env.REPORT_EMAIL_SEND_DELAY_MINUTES;
    const hold = w.finished[0].send_at.getTime() - before;
    assert.ok(hold >= 5 * 60 * 1000 - 50 && hold <= 5 * 60 * 1000 + 1000, `hold ${hold}`);
  });

  await test('auto send, but REPORT_EMAIL_MODE=draft: only drafted', async () => {
    stub({ pmMode: 'send' });
    process.env.REPORT_EMAIL_MODE = 'draft';
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    delete process.env.REPORT_EMAIL_MODE;
    eq(w.finished[0].state, 'drafted');
    assert.ok(w.slack[0].text.includes('please check it and press send'));
  });

  await test('auto send, but the PM was only cc\'d on the chain: drafted, never sent as them', async () => {
    stub({ pmMode: 'send', boxes: { [BEN]: {}, [ALICE]: { link: ['a-1'], threads: { 'a-1': ALICE_COPY } } } });
    eq(await reportEmail.draftReportEmail(RELEASE), 'drafted');
    eq(w.drafts[0].mailbox, ALICE);
    eq(w.finished[0].state, 'drafted');
  });

  // ── Sending what's due ───────────────────────────────────────────────────────
  console.log('\nscheduled sends:');

  const DUE = {
    report_id: 277397777, state: 'sending', mailbox: BEN, from: BEN, draft_id: 'r-1',
    client_name: 'Acme Corp', channel: 'C_RELEASE', thread_ts: '111.222',
  };
  function stubSend({ pmMode = 'send', sendError = null } = {}) {
    stub({ pmMode });
    w.sent = [];
    gmail.sendDraft = async (mailbox, draftId) => {
      if (sendError) throw sendError;
      w.sent.push({ mailbox, draftId });
      return { messageId: 'sent-1', threadId: 'b-1' };
    };
  }

  await test('sends the draft as it is now, and says so in the release thread', async () => {
    stubSend();
    eq(await reportEmail.sendScheduled(DUE), 'sent');
    eq(w.sent, [{ mailbox: BEN, draftId: 'r-1' }]);
    eq(w.finished[0].state, 'sent');
    eq(w.finished[0].sent_message_id, 'sent-1');
    eq(w.slack, [{ channel: 'C_RELEASE', ts: '111.222', text: `:white_check_mark: Report email for Acme Corp sent from ${BEN}.` }]);
  });

  await test('the PM deleted the draft during the hold: not sent', async () => {
    stubSend({ sendError: Object.assign(new Error('Requested entity was not found.'), { code: 404 }) });
    eq(await reportEmail.sendScheduled(DUE), 'cancelled');
    eq(w.finished[0].state, 'cancelled');
    assert.ok(w.slack[0].text.includes('not sent — the draft was deleted'));
  });

  await test('auto send turned off during the hold: not sent, left in Drafts', async () => {
    stubSend({ pmMode: 'draft' });
    eq(await reportEmail.sendScheduled(DUE), 'drafted');
    eq(w.sent, []);
    eq(w.finished[0].state, 'drafted');
    assert.ok(w.slack[0].text.includes('auto send was turned off'));
  });

  await test('REPORT_EMAIL_MODE=off during the hold: not sent', async () => {
    stubSend();
    process.env.REPORT_EMAIL_MODE = 'off';
    eq(await reportEmail.sendScheduled(DUE), 'drafted');
    delete process.env.REPORT_EMAIL_MODE;
    eq(w.sent, []);
  });

  await test('a revoked connection: not sent, marked to reconnect, left in Drafts', async () => {
    stubSend({ sendError: new Error('invalid_grant: Token has been expired or revoked.') });
    eq(await reportEmail.sendScheduled(DUE), 'failed');
    eq(w.markedBroken.map((b) => b.mailbox), [BEN]);
    assert.ok(w.slack[0].text.includes('needs reconnecting'));
    assert.ok(w.slack[0].text.includes('still in'));
  });

  await test('sendDueEmails sends each due email once', async () => {
    stubSend();
    const queue = [{ ...DUE, report_id: 1 }, { ...DUE, report_id: 2 }];
    store.takeDue = async () => queue.shift() || null;
    eq(await reportEmail.sendDueEmails(), 2);
    eq(w.sent.length, 2);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
