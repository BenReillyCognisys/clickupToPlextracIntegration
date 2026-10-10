// The report email: when a Plextrac report is released, a reply telling the client
// their report is ready in Plextrac is drafted in the client's existing onboarding email
// chain — in the mailbox of the PM who sent it.
//
// REPORT_EMAIL_MODE decides what happens:
//   off   (default) nothing
//   draft the reply is saved as a Gmail draft in that PM's mailbox, and the release
//         thread in Slack says so, @-ing that PM to check it and press send
// Nothing is ever sent to a client from here.
//
// Finding the chain. PMs send onboarding emails from their own inboxes, so the mailboxes
// of the PMs who have connected their Gmail in the SFE portal (lib/gmail-connections.js)
// are searched — no other mailbox can be reached. The onboarding email carries the
// client's portal links — the authorisation form (/form/<uuid>) and test-files upload
// link (/test-files/<uuid>) — so the search is for those tokens:
//   • a DeliveryFlow engagement's tokens, and those of every engagement on its deal
//     (one deal = one combined form = one onboarding email)
//   • a ClickUp task's "authformlink" and "testfilesstorage" fields
// One conversation can sit in several mailboxes (a PM cc'd on another's email); copies
// that share a Message-ID are the same chain. The most recently active chain wins, and
// its draft goes in the copy of the PM who last wrote in it — or, when that PM hasn't
// connected, a connected colleague who holds a copy. A connection Google refuses is
// marked to be reconnected, skipped, and named in the release thread if the chain
// isn't found. The chain is ONLY ever found by a portal link in it: when no chain holds
// one, nothing is drafted and the release thread says the thread couldn't be found.
//
// Who it goes to. Reply-all on the chain's latest message that has the client on it:
// every non-Cognisys address in To, the Cognisys people in Cc (pentestpm@ too, when it
// was on the chain), the PM themselves never. It is from the address the PM last used
// in the chain, and carries In-Reply-To/References so it threads for the client too.
// The wording is config/report-email.js, signed off with the PM's own Gmail signature
// for that address.
//
// Once per report (lib/report-email-store): a second release of the same report, or
// a webhook delivered twice, makes no second draft. A run that found no chain can be
// redone with POST /jobs/report-email { reportId } once the chain exists.
//
// Best-effort, like the rest of the release: never throws. Problems are logged and
// said in the release thread, asking for the email to be sent by hand.
//
// Console (PM2) trail — every line starts "Report email" and carries report_id.

const gmail = require('../lib/gmail');
const connections = require('../lib/gmail-connections');
const store = require('../lib/report-email-store');
const dfStore = require('../lib/deliveryflow-store');
const taskStore = require('../lib/task-store');
const clickup = require('../lib/clickup-api');
const api = require('../lib/plextrac-api');
const slack = require('../lib/slack');
const people = require('../lib/slack-people');
const approvedMessages = require('../lib/approved-message-store');
const fields = require('./qa-review/report-fields');
const { READY_FOR_RELEASE_CHANNEL } = require('./status-guard');
const message = require('../lib/email-message');
const EMAIL = require('../config/report-email');
const log = require('../lib/logger');

// The ClickUp fields the portal links live in (pipeline/auth-form-create.js).
const LINK_FIELDS = [
  process.env.CLICKUP_AUTH_FORM_FIELD_NAME || 'authformlink',
  process.env.CLICKUP_TEST_FILES_LINK_FIELD_NAME || 'testfilesstorage',
].map((n) => n.trim().toLowerCase());

const MODES = ['off', 'draft'];

/** REPORT_EMAIL_MODE, read on every release so a change needs only a restart. */
function mode() {
  const m = String(process.env.REPORT_EMAIL_MODE || 'off').trim().toLowerCase();
  return MODES.includes(m) ? m : 'off';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The portal tokens (uuids) in any of `values` — urls or bare tokens — lower-cased. */
function tokensIn(...values) {
  return values.flatMap((v) => String(v ?? '').match(UUID) || []).map((t) => t.toLowerCase());
}

// The client's portal tokens, from DeliveryFlow and/or ClickUp. A lookup that fails is
// logged and skipped, so one broken source doesn't stop the search.
async function portalTokens(reportId) {
  const tokens = new Set();
  const add = (...values) => tokensIn(...values).forEach((t) => tokens.add(t));
  const linksOf = (e) => [e.form_token, e.form_url, e.test_files_token, e.test_files_url];

  try {
    const engagement = await dfStore.findByReportId(reportId);
    if (engagement) {
      add(...linksOf(engagement));
      for (const other of await dfStore.findByDealId(engagement.deal_id)) add(...linksOf(other));
    }
  } catch (err) {
    log.warn('Report email: DeliveryFlow lookup failed', { report_id: reportId, reason: err.message });
  }

  try {
    const mapping = await taskStore.findByReportId(reportId);
    if (mapping?.clickup_task_id) {
      const task = await clickup.getTask(mapping.clickup_task_id);
      for (const f of task?.custom_fields || []) {
        if (LINK_FIELDS.includes(String(f.name || '').trim().toLowerCase())) add(f.value);
      }
    }
  } catch (err) {
    log.warn('Report email: ClickUp lookup failed', { report_id: reportId, reason: err.message });
  }

  return [...tokens];
}

// Gmail searches. Drafts are left out, so an earlier report email's draft isn't the chain.
const EXCLUDE = '-in:drafts -in:chats';
function linkQuery(tokens) {
  return `(${tokens.map((t) => `"${t}"`).join(' OR ')}) ${EXCLUDE}`;
}

const sentMessages = (thread) => thread.messages.filter((m) => !m.draft);
const latestDate = (messages) => Math.max(0, ...messages.map((m) => m.date || 0));

// Google refused a mailbox's token: skip it from now on, until its owner reconnects.
async function noteBroken(mailbox, err) {
  if (!gmail.isAccessError(err)) return;
  await connections.markBroken(mailbox, err.message).catch((e) => {
    log.error('Report email: could not mark a Gmail connection as broken', { mailbox, reason: e.message });
  });
}

/**
 * Runs a search in every connected PM mailbox: { copies: [{ mailbox, thread }], order,
 * unsearched }. `unsearched` is the mailboxes whose connection needs reconnecting —
 * already known, or found now — so a missing chain can be explained. Throws only when
 * no PM has a working connection at all.
 */
async function searchMailboxes(q, maxResults) {
  const { usable, broken } = await connections.mailboxes();
  if (!usable.length) {
    throw new Error(broken.length
      ? 'every PM\'s Gmail connection needs reconnecting in the SFE portal'
      : 'no PM has connected their Gmail yet (SFE portal → Gmail)');
  }
  const unsearched = [...broken];
  const failures = [];
  const found = await Promise.all(usable.map(async (mailbox) => {
    try {
      const ids = await gmail.searchThreads(mailbox, q, maxResults);
      const threads = await Promise.all(ids.map((id) => gmail.getThread(mailbox, id)));
      return threads.filter((t) => sentMessages(t).length).map((thread) => ({ mailbox, thread }));
    } catch (err) {
      log.warn('Report email: could not search a mailbox', { mailbox, reason: err.message });
      await noteBroken(mailbox, err);
      unsearched.push(mailbox);
      failures.push(err);
      return [];
    }
  }));
  if (failures.length === usable.length) throw failures[0];
  return { copies: found.flat(), order: usable, unsearched };
}

/**
 * Groups copies of the same conversation from different mailboxes into chains: copies
 * sharing any Message-ID are one chain. Returns [{ copies }].
 */
function groupChains(copies) {
  let chains = [];
  for (const copy of copies) {
    const joined = { ids: new Set(copy.thread.messages.map((m) => m.headers['message-id']).filter(Boolean)), copies: [copy] };
    chains = chains.filter((chain) => {
      if (![...chain.ids].some((id) => joined.ids.has(id))) return true;
      chain.ids.forEach((id) => joined.ids.add(id));
      joined.copies.push(...chain.copies);
      return false;
    });
    chains.push(joined);
  }
  return chains.map((chain) => ({ copies: chain.copies }));
}

const chainActivity = (chain) => Math.max(...chain.copies.map((c) => latestDate(sentMessages(c.thread))));

/**
 * The copy of a chain to draft in: the mailbox that last sent a message in it (the PM
 * running the engagement), then the most recently active copy, then config order.
 */
function pickCopy(chain, order = []) {
  const lastSent = (c) => latestDate(sentMessages(c.thread).filter((m) => m.sent));
  const lastAny = (c) => latestDate(sentMessages(c.thread));
  return [...chain.copies].sort((a, b) => lastSent(b) - lastSent(a)
    || lastAny(b) - lastAny(a)
    || order.indexOf(a.mailbox) - order.indexOf(b.mailbox))[0];
}

/**
 * The client's onboarding chain — the one holding their portal link: { copy: { mailbox,
 * thread }, unsearched }, or { copy: null, unsearched } when no chain holds one (or there
 * are no links to search for). Never guessed from anything else.
 */
async function findThread({ tokens }) {
  if (!tokens.length) return { copy: null, unsearched: [] };
  const result = await searchMailboxes(linkQuery(tokens), 5);
  const chains = groupChains(result.copies).sort((a, b) => chainActivity(b) - chainActivity(a));
  return { copy: chains.length ? pickCopy(chains[0], result.order) : null, unsearched: result.unsearched };
}

// The sender's Gmail signature, or '' — never fails the draft: a signature that can't be
// read just means the PM adds it before sending (Slack says so).
async function signatureFor(mailbox, fromEmail, reportId) {
  try {
    return await gmail.getSignature(mailbox, fromEmail);
  } catch (err) {
    log.warn('Report email: could not read the Gmail signature — drafting without it', { report_id: reportId, mailbox, reason: err.message });
    return '';
  }
}

/**
 * Everything the draft needs, read-only (scripts/preview-report-email.js prints it):
 *   { ok: true, mailbox, from, threadId, tokens, unsearched, to, cc, subject,
 *     inReplyTo, references, text, html, signature: boolean }
 *   { ok: false, state: 'no_thread' | 'no_client', tokens, unsearched, mailbox?, threadId? }
 */
async function prepareReportEmail({ reportId }) {
  const tokens = await portalTokens(reportId);
  const { copy, unsearched } = await findThread({ tokens });
  if (!copy) return { ok: false, state: 'no_thread', tokens, unsearched };

  const { mailbox, thread } = copy;
  const sent = sentMessages(thread);
  const latest = sent[sent.length - 1];
  // From the address this PM last wrote in the chain from; their own address otherwise.
  const theirs = sent.filter((m) => m.sent);
  const from = theirs.length ? message.parseAddressList(theirs[theirs.length - 1].headers.from)[0] || null : null;
  const opts = { exclude: [mailbox, from?.email].filter(Boolean), internalDomains: EMAIL.internalDomains() };
  // The chain may end on an internal-only note; go back to the last message the client was on.
  let recipients = { to: [], cc: [] };
  for (let i = sent.length - 1; i >= 0 && !recipients.to.length; i--) {
    recipients = message.replyRecipients(sent[i].headers, opts);
  }
  if (!recipients.to.length) {
    return { ok: false, state: 'no_client', tokens, unsearched, mailbox, threadId: thread.id };
  }

  const signatureHtml = await signatureFor(mailbox, from?.email, reportId);
  const body = message.renderBody(EMAIL.paragraphs(), { signatureHtml });
  return {
    ok: true,
    mailbox,
    from,
    threadId: thread.id,
    tokens,
    unsearched,
    ...recipients,
    subject: message.replySubject(latest.headers.subject || sent[0].headers.subject),
    ...message.threadingHeaders(latest.headers),
    ...body,
    signature: Boolean(signatureHtml),
  };
}

// ── Slack ─────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const emails = (list) => list.map((a) => a.email).join(', ');

// Replies in the release thread, or posts standalone. Never throws.
async function say(channel, threadTs, text, reportId) {
  if (!channel) return;
  try {
    if (threadTs) await slack.postReply(channel, threadTs, text);
    else await slack.postMessage(channel, text);
  } catch (err) {
    log.error('Report email: Slack notice failed', { report_id: reportId, reason: err.message });
  }
}

function draftedText({ prepared, clientName, mention }) {
  const who = mention ? `<@${mention}> please check it and press send.` : 'Please check it and press send.';
  const from = prepared.from?.email || prepared.mailbox;
  const lines = [
    `:email: Report email for ${esc(clientName)} drafted in ${esc(prepared.mailbox)}'s Drafts, from ${esc(from)}, `
      + `as a reply in "${esc(prepared.subject)}". ${who}`,
    `To: ${esc(emails(prepared.to))}${prepared.cc.length ? ` · Cc: ${esc(emails(prepared.cc))}` : ''}`,
    `<${gmail.threadUrl(prepared.threadId, prepared.mailbox)}|Open the email chain>`,
  ];
  if (!prepared.signature) {
    lines.push(`:warning: No Gmail signature found for ${esc(from)} — add your signature before sending.`);
  }
  return lines.join('\n');
}

function notMadeText({ prepared, clientName }) {
  if (prepared.state === 'no_client') {
    return `:warning: Report email not drafted — the email chain for ${esc(clientName)} in ${esc(prepared.mailbox)} `
      + `has no client address on it (<${gmail.threadUrl(prepared.threadId, prepared.mailbox)}|chain>). Please send the report email by hand.`;
  }
  const why = prepared.tokens.length ? '' : ' (no portal links are on record for this report)';
  const skipped = prepared.unsearched?.length
    ? ` Not searched — Gmail needs reconnecting in the SFE portal: ${esc(prepared.unsearched.join(', '))}.`
    : '';
  return `:warning: Report email not drafted — the onboarding email thread for ${esc(clientName)} couldn't be found${why}.`
    + `${skipped} Please send the report email by hand.`;
}

function failedText(err, mailbox = null) {
  const fix = gmail.isAccessError(err)
    ? ` ${mailbox ? `${esc(mailbox)}'s` : 'The'} Gmail connection needs reconnecting in the SFE portal (Gmail page).`
    : '';
  return `:warning: Report email not drafted — ${esc(err.message)}.${fix} Please send the report email by hand.`;
}

// ── The run ───────────────────────────────────────────────────────────────────

/**
 * Makes the report email for a released report. Called by the release
 * (pipeline/qa-released.js) with its Slack thread; never throws.
 * Returns the state it left: 'off' | 'already' | 'drafted' | 'no_thread' | 'no_client' | 'failed'.
 */
async function draftReportEmail({ reportId, clientName, reportName, channel, threadTs, releaserEmail = null, force = false }) {
  const ctx = { report_id: reportId, client: clientName, report: reportName };
  if (mode() === 'off') {
    log.info('Report email skipped — REPORT_EMAIL_MODE is off', ctx);
    return 'off';
  }

  try {
    if (!(await store.claim(reportId, { force }))) {
      log.info('Report email already made for this report — skipping', ctx);
      return 'already';
    }
  } catch (err) {
    log.error('Report email FAILED — could not record it', { ...ctx, reason: err.message });
    await say(channel, threadTs, failedText(err), reportId);
    return 'failed';
  }

  log.info('Report email STARTED', { ...ctx, mode: mode() });
  let prepared = null;
  try {
    prepared = await prepareReportEmail({ reportId });
    if (!prepared.ok) {
      log.warn(`Report email not drafted — ${prepared.state}`, {
        ...ctx, tokens: prepared.tokens.length, unsearched: prepared.unsearched?.join(', ') || null,
      });
      await store.finish(reportId, {
        state: prepared.state, tokens: prepared.tokens,
        mailbox: prepared.mailbox ?? null, thread_id: prepared.threadId ?? null,
      });
      await say(channel, threadTs, notMadeText({ prepared, clientName }), reportId);
      return prepared.state;
    }

    const draft = await gmail.createDraft(prepared.mailbox, {
      raw: message.buildRawMessage(prepared), threadId: prepared.threadId,
    });
    await store.finish(reportId, {
      state: 'drafted', mailbox: prepared.mailbox, from: prepared.from?.email || null,
      thread_id: draft.threadId, draft_id: draft.draftId, message_id: draft.messageId, subject: prepared.subject,
      to: prepared.to.map((a) => a.email), cc: prepared.cc.map((a) => a.email), signature: prepared.signature,
    });
    log.info('Report email DRAFTED', {
      ...ctx, mailbox: prepared.mailbox, thread_id: draft.threadId,
      to: emails(prepared.to), cc: emails(prepared.cc), signature: prepared.signature,
    });

    // The PM whose Drafts it is in sends it; whoever released the report if Slack can't find them.
    const mention = (await people.slackIdForEmail(prepared.mailbox)) || (await people.slackIdForEmail(releaserEmail));
    await say(channel, threadTs, draftedText({ prepared, clientName, mention }), reportId);
    return 'drafted';
  } catch (err) {
    // A failure after the chain was found is that mailbox's (the draft); before, the search's.
    const mailbox = prepared?.ok ? prepared.mailbox : null;
    if (mailbox) await noteBroken(mailbox, err);
    log.error('Report email FAILED', {
      ...ctx, reason: err.message, ...(mailbox ? { mailbox } : {}),
      ...(gmail.isAccessError(err) ? { fix: 'the PM reconnects Gmail in the SFE portal' } : {}),
    });
    await store.finish(reportId, { state: 'failed', reason: err.message }).catch(() => {});
    await say(channel, threadTs, failedText(err, mailbox), reportId);
    return 'failed';
  }
}

/**
 * A released report's client and names, as the release would have them, from the
 * stores and Plextrac: { clientName, reportName }, or null when break.services has no
 * DeliveryFlow engagement or ClickUp task for the report.
 */
async function reportContext(reportId) {
  const engagement = await dfStore.findByReportId(reportId).catch(() => null);
  const mapping = engagement ? null : await taskStore.findByReportId(reportId).catch(() => null);
  const clientId = engagement?.plextrac_client_id ?? mapping?.plextrac_client_id;
  if (clientId == null) return null;

  const [report, client] = await Promise.all([
    api.getReport(clientId, reportId).catch(() => null),
    api.getClient(clientId).catch(() => null),
  ]);
  return {
    clientName: fields.clientNameFromRecord(client, engagement?.client_name || `client ${clientId}`),
    reportName: report?.name || engagement?.report_name || mapping?.task_name || `report ${reportId}`,
  };
}

/**
 * POST /jobs/report-email — make (or, with force, remake) the email for a report that
 * has already been released: after its chain has been found or fixed, or a draft
 * deleted by mistake. Notices go to the report's release message thread when it has one.
 */
async function rerunReportEmail({ reportId, force = false }) {
  const context = await reportContext(reportId);
  if (!context) {
    log.warn('Report email re-run: no DeliveryFlow engagement or ClickUp task for this report', { report_id: reportId });
    return 'unknown_report';
  }
  const release = await approvedMessages.get(reportId).catch(() => null);
  return draftReportEmail({
    reportId, ...context, force,
    channel: release?.channel || READY_FOR_RELEASE_CHANNEL(),
    threadTs: release?.ts || null,
  });
}

module.exports = {
  draftReportEmail, rerunReportEmail, prepareReportEmail, reportContext, mode,
  // for tests
  tokensIn, linkQuery, findThread, portalTokens, groupChains, pickCopy,
};
