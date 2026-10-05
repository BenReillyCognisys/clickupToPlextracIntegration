// Weekly Plextrac backup (pipeline/plextrac-backup.js): one record per run, and one
// per report backed up in it.
//
//   plextrac_backup_runs    a run: its number and Drive folder, progress while it
//                           runs, totals and the change summary when it ends, and the
//                           client list it saw (for the next run's change log)
//   plextrac_backup_items   a report in a run: what was filed, and what the report
//                           held (status, findings, content hash) — what the next
//                           run's change log is worked out from. Saved as each report
//                           finishes, which is also what lets a run resume.

const { getDb } = require('./mongodb');

let ready = null;
function cols() {
  if (!ready) {
    ready = (async () => {
      const db = await getDb();
      const runs = db.collection('plextrac_backup_runs');
      const items = db.collection('plextrac_backup_items');
      await runs.createIndex({ run_id: 1 }, { unique: true, background: true });
      await runs.createIndex({ started_at: -1 }, { background: true });
      await items.createIndex({ run_id: 1, report_id: 1 }, { unique: true, background: true });
      return { runs, items };
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

const REAL_KINDS = ['scheduled', 'manual'];

async function createRun(run) {
  const { runs } = await cols();
  await runs.insertOne({ ...run });
}

async function updateRun(runId, { set = {}, inc } = {}) {
  const { runs } = await cols();
  await runs.updateOne({ run_id: runId }, { $set: { ...set, heartbeat_at: new Date() }, ...(inc ? { $inc: inc } : {}) });
}

async function getRun(runId) {
  const { runs } = await cols();
  return runs.findOne({ run_id: runId }, { projection: { _id: 0 } });
}

// Runs newest first, without the client lists.
async function recentRuns({ limit = 10, includeTests = false } = {}) {
  const { runs } = await cols();
  return runs.find(includeTests ? {} : { kind: { $in: REAL_KINDS } }, { projection: { _id: 0, clients: 0 } })
    .sort({ started_at: -1 }).limit(limit).toArray();
}

// The most recent finished numbered run — what the next one compares itself with.
async function lastFinishedRun({ before } = {}) {
  const { runs } = await cols();
  return runs.findOne({
    kind: { $in: REAL_KINDS },
    status: { $in: ['completed', 'completed_with_errors'] },
    ...(before ? { started_at: { $lt: before } } : {}),
  }, { sort: { started_at: -1 }, projection: { _id: 0 } });
}

async function runningRuns() {
  const { runs } = await cols();
  return runs.find({ status: 'running' }, { projection: { _id: 0, clients: 0 } }).toArray();
}

async function maxSequence() {
  const { runs } = await cols();
  const top = await runs.find({ sequence: { $type: 'number' } }).sort({ sequence: -1 }).limit(1).toArray();
  return top[0]?.sequence || 0;
}

async function saveItem(item) {
  const { items } = await cols();
  await items.replaceOne({ run_id: item.run_id, report_id: item.report_id }, { ...item, saved_at: new Date() }, { upsert: true });
}

async function itemsFor(runId) {
  const { items } = await cols();
  return items.find({ run_id: runId }, { projection: { _id: 0 } }).toArray();
}

// Report records of all but the newest `keepRuns` runs are dropped: only the last run
// is needed for the change log, and every run's manifest.json in Drive keeps the full
// record anyway.
// Test runs never count towards the numbered runs kept, so a week of test runs can't
// push out the run the next change log needs.
async function pruneItems(keepRuns = 8) {
  const { runs, items } = await cols();
  const ids = (list) => list.map((r) => r.run_id);
  const keep = [
    ...ids(await runs.find({ kind: { $in: REAL_KINDS } }, { projection: { run_id: 1 } }).sort({ started_at: -1 }).limit(keepRuns).toArray()),
    ...ids(await runs.find({}, { projection: { run_id: 1 } }).sort({ started_at: -1 }).limit(3).toArray()),
  ];
  const res = await items.deleteMany({ run_id: { $nin: keep } });
  return res.deletedCount;
}

module.exports = {
  createRun,
  updateRun,
  getRun,
  recentRuns,
  lastFinishedRun,
  runningRuns,
  maxSequence,
  saveItem,
  itemsFor,
  pruneItems,
  REAL_KINDS,
};
