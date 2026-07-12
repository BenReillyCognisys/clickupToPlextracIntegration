// Tiny persistence for the weekly reports-due check: remembers the single most
// recent "reports due this week" message we posted (channel + ts) plus the per-task
// entries that make up it, so an incoming ClickUp status-change webhook can strike
// through a report once it's completed / ready for release and edit the message in
// place.
//
// Only ever one document (keyed by a fixed _id) — the current week's message.
//
// entries: [{ taskId, label, struck, section, dayKey, dayLabel }] — `label` is the
// rendered text for the report (without any strikethrough); `struck` is whether it's
// currently crossed off; `section` is 'missed' or 'week'; `dayKey` is the deadline
// timestamp used to group and sort the week section (null for the missed section);
// `dayLabel` is the pre-formatted "Tuesday 23rd June" heading (null for missed).
// `weekHeader` is the "22nd" week-commencing label, stored so the message can be
// re-rendered identically without recomputing dates.

const { getDb } = require('./mongodb');

const STATE_ID = 'reports_due_check:last_message';

async function col() {
  const db = await getDb();
  return db.collection('app_state');
}

// Returns { channel, ts, weekHeader, entries } of the last posted message, or null
// if none recorded. `entries` defaults to [] and `weekHeader` to '' for documents
// written before those fields existed.
async function getMessage() {
  const c = await col();
  const doc = await c.findOne({ _id: STATE_ID });
  return doc
    ? { channel: doc.channel, ts: doc.ts, weekHeader: doc.weekHeader || '', entries: doc.entries || [] }
    : null;
}

// Records the message we just posted (and its per-task entries), replacing any
// previous week's record.
async function setMessage(channel, ts, weekHeader, entries = []) {
  const c = await col();
  await c.updateOne(
    { _id: STATE_ID },
    { $set: { channel, ts, weekHeader, entries, updated_at: new Date() } },
    { upsert: true }
  );
}

// Updates just the entries (and their struck flags) for the current message,
// leaving channel/ts/weekHeader untouched. Used after a cross-off edit.
async function updateEntries(entries) {
  const c = await col();
  await c.updateOne(
    { _id: STATE_ID },
    { $set: { entries, updated_at: new Date() } }
  );
}

module.exports = { getMessage, setMessage, updateEntries };
