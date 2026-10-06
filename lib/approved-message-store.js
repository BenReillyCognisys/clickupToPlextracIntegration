// The "approved — ready for release" Slack message posted for each Plextrac report
// (pipeline/qa-approved.js): its channel and ts, and who approved it. When the report
// is released, pipeline/qa-released.js edits that same message into the release line
// ("Second QA by <approver> - Release by <releaser>") instead of posting a new one.
//
// One document per report; approving the report again replaces it.

const { getDb } = require('./mongodb');

let ready = null;
function col() {
  if (!ready) {
    ready = (async () => {
      const c = (await getDb()).collection('approved_announcements');
      await c.createIndex({ report_id: 1 }, { unique: true, background: true });
      return c;
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

// { channel, ts, approverName } for the report's approved message, or null.
async function get(reportId) {
  const c = await col();
  const doc = await c.findOne({ report_id: Number(reportId) });
  return doc ? { channel: doc.channel, ts: doc.ts, approverName: doc.approver_name || null } : null;
}

async function set({ reportId, channel, ts, approverName }) {
  const c = await col();
  await c.updateOne(
    { report_id: Number(reportId) },
    { $set: { channel, ts, approver_name: approverName, at: new Date() } },
    { upsert: true },
  );
}

module.exports = { get, set };
