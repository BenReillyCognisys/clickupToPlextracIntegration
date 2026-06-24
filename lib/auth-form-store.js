// Tiny persistence for the daily auth-form check: remembers the single most
// recent "Check Auth Form" message we posted so the next run can delete it.
//
// Only ever one document (keyed by a fixed _id), so we delete at most one
// previous message per run — never more.

const { getDb } = require('./mongodb');

const STATE_ID = 'auth_form_check:last_message';

async function col() {
  const db = await getDb();
  return db.collection('app_state');
}

// Returns { channel, ts } of the last posted message, or null if none recorded.
async function getLastMessage() {
  const c = await col();
  const doc = await c.findOne({ _id: STATE_ID });
  return doc ? { channel: doc.channel, ts: doc.ts } : null;
}

// Records the message we just posted, replacing any previous record.
async function setLastMessage(channel, ts) {
  const c = await col();
  await c.updateOne(
    { _id: STATE_ID },
    { $set: { channel, ts, updated_at: new Date() } },
    { upsert: true }
  );
}

module.exports = { getLastMessage, setLastMessage };
