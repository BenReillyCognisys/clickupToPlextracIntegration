// Tiny persistence for the daily MFA check: remembers the single most recent
// MFA-status message we posted so the next run can delete it, plus the list of
// users who lacked MFA in that run so the next run can tell which of them have
// since enrolled (the "fixed" list).
//
// Only ever one document (keyed by a fixed _id), so we delete at most one
// previous message per run — never more.

const { getDb } = require('./mongodb');

const STATE_ID = 'mfa_check:last_message';

async function col() {
  const db = await getDb();
  return db.collection('app_state');
}

// Returns { channel, ts, users } of the last posted message, or null if none
// recorded. `users` is the list of primary emails that lacked MFA in that run
// (defaults to [] for documents written before it existed).
async function getLastMessage() {
  const c = await col();
  const doc = await c.findOne({ _id: STATE_ID });
  return doc ? { channel: doc.channel, ts: doc.ts, users: doc.users || [] } : null;
}

// Records the message we just posted (channel, ts) and the emails that lacked
// MFA at that point, replacing any previous record.
async function setLastMessage(channel, ts, users = []) {
  const c = await col();
  await c.updateOne(
    { _id: STATE_ID },
    { $set: { channel, ts, users, updated_at: new Date() } },
    { upsert: true }
  );
}

module.exports = { getLastMessage, setLastMessage };
