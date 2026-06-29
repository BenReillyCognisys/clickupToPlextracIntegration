// Tiny persistence for the daily auth-form check: remembers the single most
// recent "Check Auth Form" message we posted so the next run can delete it, plus
// the per-task entries that make up that message so the 5-minute reconcile can
// strike through tasks that have since been actioned.
//
// Only ever one document (keyed by a fixed _id), so we delete at most one
// previous message per run — never more.
//
// entries: [{ taskId, line, struck, startDate }] — `line` is the rendered text for
// the task (without any strikethrough); `struck` is whether it's currently struck
// through; `startDate` is the task's ClickUp start_date (ms since epoch) used to
// group lines under a date heading when rendering, or null if unset.

const { getDb } = require('./mongodb');

const STATE_ID = 'auth_form_check:last_message';

async function col() {
  const db = await getDb();
  return db.collection('app_state');
}

// Returns { channel, ts, entries } of the last posted message, or null if none
// recorded. `entries` defaults to [] for documents written before entries existed.
async function getLastMessage() {
  const c = await col();
  const doc = await c.findOne({ _id: STATE_ID });
  return doc ? { channel: doc.channel, ts: doc.ts, entries: doc.entries || [] } : null;
}

// Records the message we just posted (and its per-task entries), replacing any
// previous record.
async function setLastMessage(channel, ts, entries = []) {
  const c = await col();
  await c.updateOne(
    { _id: STATE_ID },
    { $set: { channel, ts, entries, updated_at: new Date() } },
    { upsert: true }
  );
}

// Updates just the entries (and their struck flags) for the current message,
// leaving channel/ts untouched. Used by the reconcile after a strike-through edit.
async function updateEntries(entries) {
  const c = await col();
  await c.updateOne(
    { _id: STATE_ID },
    { $set: { entries, updated_at: new Date() } }
  );
}

module.exports = { getLastMessage, setLastMessage, updateEntries };
