// Gmail access to the PMs' own mailboxes, for the report email: search a mailbox for a
// client's onboarding chain, read the chain's headers, and create a draft reply in it.
// Every call names the mailbox it acts in.
//
// A mailbox can only be used once its owner has connected it from the SFE portal
// (lib/gmail-oauth.js) — each call uses that PM's own refresh token
// (lib/gmail-connections.js), with the two permissions they granted:
//   gmail.readonly  search the mailbox, read headers and the PM's signature (and the
//                   signature images Gmail links to inside their own emails)
//   gmail.compose   create drafts, and send one (a PM who chose auto send)
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
 * A Gmail web link to an image inside a message of the signed-in mailbox, as Gmail
 * writes into a signature that was copied from an email:
 *   https://mail.google.com/mail/u/3?…&view=fimg&permmsgid=msg-f:<decimal id>&th=<hex>&attid=0.1&realattid=ii_…
 * Only a browser signed in to that mailbox can open it — anyone else gets Gmail's
 * sign-in page — so it is read through the API instead (getMailImage).
 * Returns { messageId (hex, the API's form), realAttId, partId } or null.
 */
function parseMailImageUrl(src) {
  let url;
  try { url = new URL(src); } catch { return null; }
  if (url.hostname !== 'mail.google.com') return null;
  const p = url.searchParams;
  const perm = /^msg-f:(\d+)$/.exec(p.get('permmsgid') || '');
  const messageId = perm ? BigInt(perm[1]).toString(16) : (/^[0-9a-f]+$/i.test(p.get('th') || '') ? p.get('th') : null);
  if (!messageId) return null;
  return { messageId, realAttId: p.get('realattid') || null, partId: p.get('attid') || null };
}

const headerOf = (part, name) =>
  (part.headers || []).find((h) => String(h.name).toLowerCase() === name)?.value?.trim() || '';

/**
 * The message part an image link points to: the one whose X-Attachment-Id (or
 * Content-ID) is the link's realattid, else the one at its attid part number. Only
 * image parts count. null when none matches.
 */
function findImagePart(payload, { realAttId, partId }) {
  const parts = [];
  const walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(payload);
  const images = parts.filter((p) => /^image\//i.test(p.mimeType || ''));
  if (realAttId) {
    const hit = images.find((p) => headerOf(p, 'x-attachment-id') === realAttId
      || headerOf(p, 'content-id').replace(/^<|>$/g, '') === realAttId);
    if (hit) return hit;
  }
  return (partId && images.find((p) => p.partId === partId)) || null;
}

/**
 * Downloads an image that a Gmail web link (parseMailImageUrl) points to, from
 * `mailbox` through the API — the gmail.readonly permission the PM already granted.
 * Resolves to { data, contentType }; throws with a short reason.
 */
async function getMailImage(mailbox, src) {
  const ref = parseMailImageUrl(src);
  if (!ref) throw new Error('not a Gmail image link');
  const gmail = await gmailClient(mailbox);
  let message;
  try {
    ({ data: message } = await gmail.users.messages.get({ userId: 'me', id: ref.messageId, format: 'full' }));
  } catch (err) {
    if (Number(err?.code ?? err?.response?.status) === 404) throw new Error('the email it was copied from is no longer in the mailbox');
    throw err;
  }
  const part = findImagePart(message.payload, ref);
  if (!part) throw new Error('image not found in the email it was copied from');
  let b64 = part.body?.data;
  if (!b64 && part.body?.attachmentId) {
    const { data } = await gmail.users.messages.attachments.get({ userId: 'me', messageId: ref.messageId, id: part.body.attachmentId });
    b64 = data.data;
  }
  if (!b64) throw new Error('image has no content');
  return { data: Buffer.from(b64, 'base64url'), contentType: String(part.mimeType).toLowerCase() };
}

/**
 * Sends a draft, as it is now in the mailbox (with any edits the PM made). Resolves to
 * { messageId, threadId }. A draft the PM deleted fails with a 404 (isMissingDraft).
 */
async function sendDraft(mailbox, draftId) {
  const gmail = await gmailClient(mailbox);
  const { data } = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
  return { messageId: data.id || null, threadId: data.threadId || null };
}

/** True when Gmail says the draft no longer exists (deleted, or already sent). */
function isMissingDraft(err) {
  const status = err?.code ?? err?.status ?? err?.response?.status;
  return Number(status) === 404 || /not found|requested entity was not found/i.test(String(err?.message || ''));
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

module.exports = {
  searchThreads, getThread, createDraft, sendDraft, isMissingDraft, getSignature, threadUrl, isAccessError,
  parseMailImageUrl, findImagePart, getMailImage,
};
