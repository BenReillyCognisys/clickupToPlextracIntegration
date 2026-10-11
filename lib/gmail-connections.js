// The PMs' Gmail connections: a PM or admin connects their own Gmail from the SFE
// portal (lib/gmail-oauth.js), and the report email (pipeline/report-email.js) then
// searches — and drafts in — the connected mailboxes only. Nobody else's mailbox can
// be reached: there is no domain-wide access.
//
// One document per mailbox (email is unique), and one mailbox per portal user —
// connecting another account replaces the old one:
//   { email, portal_user_id, portal_username, refresh_token (sealed, lib/secret-box),
//     scopes, connected_at, status: 'ok' | 'broken', broken_reason, broken_at,
//     email_mode: 'off' | 'draft' | 'send' }
// email_mode is the PM's own choice, set on their Gmail page in the SFE portal, for what
// the report email does in their mailbox: nothing, a draft for them to send, or a draft
// that is sent for them after a short hold (pipeline/report-email.js). A new connection
// starts on 'draft'; reconnecting a mailbox that is still connected (e.g. after Google
// broke it) keeps their choice. A connection from before the choice existed counts as
// 'off' until they choose.
// 'broken' is set when Google refuses the token (the PM revoked access, changed their
// password, or the token expired); the mailbox is then skipped until they reconnect.
//
// Short-lived OAuth states (the link between the portal's "Connect" and Google's
// callback) live in gmail_oauth_states, single-use, removed by a TTL index.

const crypto = require('crypto');
const { getDb } = require('./mongodb');
const box = require('./secret-box');

let ready = null;
function cols() {
  if (!ready) {
    ready = (async () => {
      const db = await getDb();
      const connections = db.collection('gmail_connections');
      await connections.createIndex({ email: 1 }, { unique: true, background: true });
      await connections.createIndex({ portal_user_id: 1 }, { background: true });
      const states = db.collection('gmail_oauth_states');
      await states.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, background: true });
      return { connections, states };
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── Connections ───────────────────────────────────────────────────────────────

/** Saves a connection, replacing any other mailbox the same portal user had connected. */
async function save({ email, portalUserId, portalUsername, refreshToken, scopes }) {
  const { connections } = await cols();
  const now = new Date();
  await connections.deleteMany({ portal_user_id: String(portalUserId), email: { $ne: norm(email) } });
  await connections.updateOne(
    { email: norm(email) },
    {
      $set: {
        portal_user_id: String(portalUserId),
        portal_username: portalUsername || null,
        refresh_token: box.seal(refreshToken),
        scopes,
        connected_at: now,
        status: 'ok',
        broken_reason: null,
        broken_at: null,
      },
      // A first connection drafts report emails until the PM chooses otherwise.
      $setOnInsert: { email_mode: 'draft', email_mode_set_at: now },
    },
    { upsert: true },
  );
}

/** The connection for a portal user (without its token), or null. */
async function forPortalUser(portalUserId) {
  const { connections } = await cols();
  return connections.findOne({ portal_user_id: String(portalUserId) }, { projection: { refresh_token: 0 } });
}

/** The decrypted refresh token for a mailbox, with when it was connected; null if not connected. */
async function credentials(email) {
  const { connections } = await cols();
  const doc = await connections.findOne({ email: norm(email) });
  if (!doc) return null;
  return { refreshToken: box.open(doc.refresh_token), connectedAt: doc.connected_at };
}

/** The mailboxes to search: { usable: [email], broken: [email] }, oldest connection first. */
async function mailboxes() {
  const { connections } = await cols();
  const docs = await connections.find({}, { projection: { email: 1, status: 1 } }).sort({ connected_at: 1 }).toArray();
  return {
    usable: docs.filter((d) => d.status === 'ok').map((d) => d.email),
    broken: docs.filter((d) => d.status !== 'ok').map((d) => d.email),
  };
}

/** Google refused the mailbox's token: skip it until its owner reconnects. */
async function markBroken(email, reason) {
  const { connections } = await cols();
  await connections.updateOne(
    { email: norm(email), status: 'ok' },
    { $set: { status: 'broken', broken_reason: String(reason || '').slice(0, 500), broken_at: new Date() } },
  );
}

/** Removes a portal user's connection; returns { email, refreshToken } so it can be revoked, or null. */
async function remove(portalUserId) {
  const { connections } = await cols();
  const removed = await connections.findOneAndDelete({ portal_user_id: String(portalUserId) });
  if (!removed) return null;
  let refreshToken = null;
  try { refreshToken = box.open(removed.refresh_token); } catch { /* unreadable — nothing to revoke */ }
  return { email: removed.email, refreshToken };
}

const EMAIL_MODES = ['off', 'draft', 'send'];

/** A mailbox owner's report email choice: 'off' (also when unset or not connected), 'draft' or 'send'. */
async function modeFor(email) {
  const { connections } = await cols();
  const doc = await connections.findOne({ email: norm(email) }, { projection: { email_mode: 1 } });
  return EMAIL_MODES.includes(doc?.email_mode) ? doc.email_mode : 'off';
}

/** True when any connected PM has report emails on (draft or auto send). */
async function anyOptedIn() {
  const { connections } = await cols();
  return Boolean(await connections.findOne({ email_mode: { $in: ['draft', 'send'] } }, { projection: { _id: 1 } }));
}

/** Sets a portal user's report email choice; returns the mailbox, or null when they haven't connected. */
async function setMode(portalUserId, mode) {
  if (!EMAIL_MODES.includes(mode)) throw new Error(`mode must be one of ${EMAIL_MODES.join(', ')}`);
  const { connections } = await cols();
  const doc = await connections.findOneAndUpdate(
    { portal_user_id: String(portalUserId) },
    { $set: { email_mode: mode, email_mode_set_at: new Date() } },
    { returnDocument: 'after', projection: { email: 1, email_mode: 1 } },
  );
  return doc ? doc.email : null;
}

// ── OAuth states ──────────────────────────────────────────────────────────────

/** Stores a new state for 10 minutes; only its hash is kept. */
async function createState({ state, codeVerifier, portalUserId, portalUsername, portalEmail }) {
  const { states } = await cols();
  await states.insertOne({
    _id: hash(state),
    code_verifier: codeVerifier,
    portal_user_id: String(portalUserId),
    portal_username: portalUsername || null,
    portal_email: norm(portalEmail),
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
  });
}

/** Takes (and deletes) a state; null when unknown, used already or expired. */
async function takeState(state) {
  if (typeof state !== 'string' || !state) return null;
  const { states } = await cols();
  const found = await states.findOneAndDelete({ _id: hash(state) });
  if (!found || found.expires_at < new Date()) return null;
  return {
    codeVerifier: found.code_verifier,
    portalUserId: found.portal_user_id,
    portalUsername: found.portal_username,
    portalEmail: found.portal_email,
  };
}

module.exports = {
  save, forPortalUser, credentials, mailboxes, markBroken, remove, createState, takeState,
  modeFor, setMode, anyOptedIn, EMAIL_MODES,
};
