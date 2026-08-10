// Persistence for the QA queue that backs the /reportqueue and /reportqueueall Slack
// commands. One document per Plextrac report currently in QA, keyed by the numeric
// Plextrac report id. The Plextrac ReportStatusChanged webhook maintains it:
//   • report reaches the first-round QA status  → upsert with stage 'first'
//   • report reaches the second-round QA status → upsert with stage 'second'
//   • report is released (Published)            → removed entirely
//
// `entered_at` is stamped once (when the report first enters the queue) and used to
// order each section newest-first (most recently pushed at the top); `stage` /
// `updated_at` change as the report moves.

const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('qa_queue');
  await c.createIndex({ report_id: 1 }, { unique: true, background: true });
  return c;
}

// Adds or updates a report in the queue at the given stage ('first' | 'second').
// entered_at is preserved across stage changes (set only on first insert).
async function upsert({ reportId, cuid, clientId, clientName, reportName, reportUrl, stage }) {
  const c = await col();
  await c.updateOne(
    { report_id: Number(reportId) },
    {
      $set: {
        report_cuid:  cuid || null,
        client_id:    clientId ?? null,
        client_name:  clientName || null,
        report_name:  reportName || null,
        report_url:   reportUrl || null,
        stage,
        updated_at:   new Date(),
      },
      $setOnInsert: { entered_at: new Date() },
    },
    { upsert: true }
  );
}

// Removes a report from the queue (on release). No-op if it isn't present.
async function remove(reportId) {
  const c = await col();
  await c.deleteOne({ report_id: Number(reportId) });
}

// Returns every queued report, newest-first (by entered_at) — most recently pushed
// to the queue at the top.
async function list() {
  const c = await col();
  return c.find({}).sort({ entered_at: -1 }).toArray();
}

module.exports = { upsert, remove, list };
