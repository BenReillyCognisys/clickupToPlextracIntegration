// Building a reply to an existing email thread: who it goes to, its threading headers,
// and the raw RFC 2822 message the Gmail API takes. Pure functions — no Gmail, no
// network — so they can be unit-tested (tests/report-email.test.js).

const { stripFormatting } = require('./html-text');

/**
 * Parses an address header ("To", "Cc", "From") into [{ name, email }].
 * Handles quoted names with commas in them ("Smith, Jane" <jane@acme.com>), bare
 * addresses, and RFC 2047 encoded names. Anything without an @ is dropped.
 */
function parseAddressList(header) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of String(header || '')) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (ch === ',' && !quoted && !angle) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const out = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const m = text.match(/^(.*)<([^<>]+)>\s*$/);
    const email = (m ? m[2] : text).trim().replace(/^mailto:/i, '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) continue;
    const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim() : '';
    out.push({ name, email });
  }
  return out;
}

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
const encodedWord = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

// A header value that may hold non-ASCII text (a subject, a display name).
function encodeHeaderText(s) {
  return isAscii(s) ? s : encodedWord(s);
}

// One address back into header form: "Name" <email>, or just the email.
function formatAddress({ name, email }) {
  if (!name) return email;
  if (/^=\?.+\?=$/.test(name)) return `${name} <${email}>`; // already encoded
  if (!isAscii(name)) return `${encodedWord(name)} <${email}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>`;
}

const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1);

/**
 * Who a reply to `message` goes to, reply-all style, as { to, cc }.
 *   to — the client: every non-Cognisys address on the message (its sender, its To, its Cc)
 *   cc — the Cognisys people on it
 * `exclude` are never recipients: the address the reply is from, and the mailbox it is
 * drafted in. `message` is the header map of the message being replied to ({ from,
 * 'reply-to', to, cc }). Returns to: [] when the message has no client on it.
 */
function replyRecipients(message, { exclude = [], internalDomains }) {
  const internal = new Set((internalDomains || []).map((d) => d.toLowerCase()));
  const everyone = [
    ...parseAddressList(message['reply-to'] || message.from),
    ...parseAddressList(message.to),
    ...parseAddressList(message.cc),
  ];
  const seen = new Set(exclude.map((e) => String(e).toLowerCase()));
  const to = [];
  const cc = [];
  for (const addr of everyone) {
    if (seen.has(addr.email)) continue;
    seen.add(addr.email);
    (internal.has(domainOf(addr.email)) ? cc : to).push(addr);
  }
  return { to, cc };
}

/** "Re: <subject>", without stacking a second "Re:". */
function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The threading headers for a reply to `message`: In-Reply-To is its Message-ID, and
 * References is its References with its Message-ID added. With these, and the same
 * subject, the reply joins the thread in the client's mail client too, not only Gmail.
 */
function threadingHeaders(message) {
  const id = String(message['message-id'] || '').trim();
  if (!id) return {};
  const refs = String(message.references || '').trim();
  return { inReplyTo: id, references: refs ? `${refs} ${id}` : id };
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Paragraphs → the plain-text body and an HTML copy (links clickable, "\n" a <br>).
 * `signatureHtml` — the sender's Gmail signature, as Gmail stores it (HTML) — goes
 * straight under the last paragraph, as is in the HTML copy and as text in the plain one.
 */
function renderBody(paragraphs, { signatureHtml = '' } = {}) {
  const signature = String(signatureHtml || '').trim();
  const signatureText = signature ? stripFormatting(signature) : '';
  const text = paragraphs.join('\n\n') + (signatureText ? `\n${signatureText}` : '');
  const html = paragraphs.map((p) => {
    const lines = p.split('\n').map((line) => escapeHtml(line)
      .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`));
    return `<p>${lines.join('<br>')}</p>`;
  }).join('\n');
  const signatureBlock = signature ? `\n<div class="gmail_signature" data-smartmail="gmail_signature">${signature}</div>` : '';
  return { text, html: `<div style="font-family:Arial,sans-serif;font-size:14px">\n${html}${signatureBlock}\n</div>` };
}

// Base64 in 76-character lines, as MIME bodies are written.
const base64Lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

/**
 * The raw message for gmail.users.drafts.create: From/To/Cc/Subject/threading headers
 * and a text + HTML body, base64url-encoded. `from` ({ name, email }) is the address
 * the reply goes out as — a "Send mail as" alias of the mailbox it is drafted in; left
 * out, Gmail uses the mailbox's own address.
 */
function buildRawMessage({ from = null, to, cc = [], subject, inReplyTo, references, text, html }) {
  const boundary = `report-email-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    ...(from ? [`From: ${formatAddress(from)}`] : []),
    `To: ${to.map(formatAddress).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderText(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [
    `--${boundary}`,
    `Content-Type: ${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(body),
  ].join('\r\n');
  const message = [
    headers.join('\r\n'),
    '',
    part('text/plain', text),
    part('text/html', html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

module.exports = {
  parseAddressList, formatAddress, replyRecipients, replySubject, threadingHeaders,
  renderBody, buildRawMessage, encodeHeaderText,
};
