// Gmail access to the PMs' own mailboxes, for the report email: search a mailbox for a
// client's onboarding chain, read the chain's headers, and create a draft reply in it.
// Every call names the mailbox it acts in.
//
// A mailbox can only be used once its owner has connected it from the SFE portal
// (lib/gmail-oauth.js) — each call uses that PM's own refresh token
// (lib/gmail-connections.js), with the two permissions they granted:
//   gmail.readonly  search the mailbox, read headers and the PM's signature
//   gmail.compose   create drafts
// There is no domain-wide access: an unconnected mailbox can't be reached at all.

const { google } = require('googleapis');
const connections = require('./gmail-connections');
const { oauthClient } = require('./gmail-oauth');

// The headers read from each message of a thread.
const HEADERS = ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'References'];

// One client per mailbox, reused while the connection is the same one (the auth
// client caches and refreshes its access token); a reconnect builds a new one.
const clients = new Map();
async function gmailClient(mailbox) {
  const creds = await connections.credentials(mailbox);
  if (!creds) throw new Error(`${mailbox} has not connected Gmail`);
  const cached = clients.get(mailbox);
  if (cached && cached.connectedAt === String(creds.connectedAt)) return cached.gmail;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: creds.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  clients.set(mailbox, { connectedAt: String(creds.connectedAt), gmail });
  return gmail;
}

/** Ids of the threads in `mailbox` matching a Gmail search, most recently active first. */
async function searchThreads(mailbox, q, maxResults = 10) {
  const gmail = await gmailClient(mailbox);
  const { data } = await gmail.users.threads.list({ userId: 'me', q, maxResults });
  return (data.threads || []).map((t) => t.id);
}

/**
 * A thread's messages, oldest first, as { id, draft, sent, date, headers }: `sent` is
 * whether this mailbox sent it, and `headers` maps lower-cased header names to values
 * ({ from, to, cc, subject, 'message-id', … }).
 */
async function getThread(mailbox, threadId) {
  const gmail = await gmailClient(mailbox);
  const { data } = await gmail.users.threads.get({
    userId: 'me', id: threadId, format: 'metadata', metadataHeaders: HEADERS,
  });
  return {
    id: data.id,
    messages: (data.messages || []).map((m) => ({
      id: m.id,
      draft: (m.labelIds || []).includes('DRAFT'),
      sent: (m.labelIds || []).includes('SENT'),
      date: Number(m.internalDate) || null,
      headers: Object.fromEntries((m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])),
    })),
  };
}

/** Saves `raw` (lib/email-message buildRawMessage) as a draft in the thread. */
async function createDraft(mailbox, { raw, threadId }) {
  const gmail = await gmailClient(mailbox);
  const { data } = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId } },
  });
  return { draftId: data.id, messageId: data.message?.id || null, threadId: data.message?.threadId || threadId };
}

/**
 * The Gmail signature (HTML, as Gmail stores it) for the address a draft is sent from:
 * that "Send mail as" address's own signature, else the mailbox's default one. '' when
 * none is set. Read with the gmail.readonly permission the PM already granted.
 */
async function getSignature(mailbox, fromEmail = null) {
  const gmail = await gmailClient(mailbox);
  const { data } = await gmail.users.settings.sendAs.list({ userId: 'me' });
  const entries = data.sendAs || [];
  const want = String(fromEmail || mailbox).trim().toLowerCase();
  const entry = entries.find((s) => String(s.sendAsEmail || '').toLowerCase() === want)
    || entries.find((s) => s.isDefault)
    || entries.find((s) => s.isPrimary);
  return String(entry?.signature || '').trim();
}

/** A link that opens the thread in `mailbox` (for its owner, signed in to it). */
function threadUrl(threadId, mailbox) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailbox)}#all/${threadId}`;
}

/**
 * True when an error means the mailbox's connection no longer works — its owner revoked
 * it, changed their password, or Google expired it — so they need to reconnect in the
 * portal. Not a passing failure: retrying won't help.
 */
function isAccessError(err) {
  const text = `${err?.message || ''} ${err?.response?.data?.error || ''} ${err?.response?.data?.error_description || ''}`;
  return /invalid_grant|unauthorized_client|insufficient authentication scopes|insufficientPermissions|invalid credentials|has not connected gmail/i.test(text);
}

module.exports = { searchThreads, getThread, createDraft, getSignature, threadUrl, isAccessError };
