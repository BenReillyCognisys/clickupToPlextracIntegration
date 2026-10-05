// Client merges (pipeline/client-merge): the job records, the re-pointing of this
// service's own records from a moved report to its imported copy, and the aliases that
// stop a merged-away client name being created again.
//
//   client_merges           one document per merge: what was backed up where, what was
//                           moved to which new report, every step's outcome. Written
//                           after every step, so it is an exact account of how far a
//                           merge got even if the process dies part-way.
//   plextrac_client_aliases merged-away name (lower-cased) → the client it was merged
//                           into; read by pipeline/plextrac-client.findOrCreateClient.

const { getDb } = require('./mongodb');

async function merges() {
  const c = (await getDb()).collection('client_merges');
  await c.createIndex({ merge_id: 1 }, { unique: true, background: true });
  await c.createIndex({ created_at: -1 }, { background: true });
  await c.createIndex({ status: 1 }, { background: true });
  return c;
}

const ACTIVE = ['queued', 'running'];

async function saveMerge(job) {
  const c = await merges();
  const { _id, ...doc } = job;
  await c.replaceOne({ merge_id: job.merge_id }, { ...doc, updated_at: new Date() }, { upsert: true });
}

async function getMerge(mergeId) {
  if (typeof mergeId !== 'string' || !mergeId) return null;
  const c = await merges();
  return c.findOne({ merge_id: mergeId }, { projection: { _id: 0 } });
}

// Newest first, without the per-step event log (the detail view has it).
async function listMerges(limit = 25) {
  const c = await merges();
  return c.find({}, { projection: { _id: 0, events: 0 } })
    .sort({ created_at: -1 })
    .limit(Math.min(Math.max(Number(limit) || 25, 1), 100))
    .toArray();
}

// A queued or running merge that involves any of these clients, or null.
async function findActiveMerge(clientIds) {
  const ids = clientIds.map(Number);
  const c = await merges();
  return c.findOne({
    status: { $in: ACTIVE },
    $or: [{ 'keep_client.id': { $in: ids } }, { 'merge_client.id': { $in: ids } }],
  }, { projection: { _id: 0, events: 0 } });
}

// Merges run in this process only, so any still "running" at startup died with the
// last process. Marked interrupted, so they no longer block a new merge of the same
// clients and the record says plainly that it stopped part-way.
async function markInterrupted() {
  const c = await merges();
  const now = new Date();
  const res = await c.updateMany({ status: { $in: ACTIVE } }, {
    $set: { status: 'interrupted', finished_at: now, updated_at: now,
      error: 'break.services restarted while this merge was running — check its steps before re-running' },
  });
  return res.modifiedCount;
}

// ── Re-pointing this service's records ────────────────────────────────────────

// A report id may have been stored as a number or a string.
const idForms = (id) => [...new Set([Number(id), String(id)])].filter((v) => v === v);

/**
 * Re-points every record this service keeps for a moved report — the ClickUp task
 * mapping, the DeliveryFlow engagement, the QA queue, first submission and KPI rows —
 * from the old report to its imported copy. Returns how many of each were updated and
 * the DeliveryFlow engagements touched (so DeliveryFlow can be sent the new link).
 */
async function repointReport({ oldClientId, oldReportId, oldCuid, newClientId, newReportId, newCuid, newReportUrl, mergeId }) {
  const db = await getDb();
  const movedFrom = { client_id: Number(oldClientId), report_id: Number(oldReportId), cuid: oldCuid ?? null, merge_id: mergeId, at: new Date() };
  const old = { $in: idForms(oldReportId) };
  const out = {};

  out.task_mappings = (await db.collection('task_mappings').updateMany({ plextrac_report_id: old }, {
    $set: {
      plextrac_report_id: Number(newReportId), plextrac_client_id: Number(newClientId),
      plextrac_report_cuid: newCuid ?? null, moved_from: movedFrom, updated_at: new Date(),
    },
  })).modifiedCount;

  const engagements = await db.collection('deliveryflow_auth_forms')
    .find({ plextrac_report_id: old }, { projection: { engagement_id: 1, deal_id: 1, report_name: 1 } }).toArray();
  out.deliveryflow_auth_forms = (await db.collection('deliveryflow_auth_forms').updateMany({ plextrac_report_id: old }, {
    $set: {
      plextrac_report_id: Number(newReportId), plextrac_client_id: Number(newClientId),
      plextrac_report_cuid: newCuid ?? null, moved_from: movedFrom, updated_at: new Date(),
    },
  })).modifiedCount;

  out.qa_queue = (await db.collection('qa_queue').updateMany({ report_id: old }, {
    $set: { report_id: Number(newReportId), report_cuid: newCuid ?? null, client_id: Number(newClientId), report_url: newReportUrl, updated_at: new Date() },
  })).modifiedCount;
  out.qa_submissions = (await db.collection('qa_submissions').updateMany({ report_id: old }, {
    $set: { report_id: Number(newReportId) },
  })).modifiedCount;
  out.qa_kpi = (await db.collection('qa_kpi').updateMany({ report_id: old }, {
    $set: { report_id: Number(newReportId) },
  })).modifiedCount;

  return { counts: out, engagements: engagements.map((e) => ({ engagementId: e.engagement_id, dealId: e.deal_id ?? null })) };
}

/**
 * Re-points the client id on records that name the merged-away client without naming
 * one of its reports (e.g. a DeliveryFlow engagement whose report was never created).
 */
async function repointClient({ oldClientId, newClientId }) {
  const db = await getDb();
  const old = { $in: idForms(oldClientId) };
  const set = { plextrac_client_id: Number(newClientId), updated_at: new Date() };
  return {
    task_mappings: (await db.collection('task_mappings').updateMany({ plextrac_client_id: old }, { $set: set })).modifiedCount,
    deliveryflow_auth_forms: (await db.collection('deliveryflow_auth_forms').updateMany({ plextrac_client_id: old }, { $set: set })).modifiedCount,
    qa_queue: (await db.collection('qa_queue').updateMany({ client_id: old }, { $set: { client_id: Number(newClientId) } })).modifiedCount,
  };
}

// How many of this service's records point at each of the client's reports — shown in
// the merge preview so the operator can see what moves with them.
async function linkedRecords(clientId) {
  const db = await getDb();
  const ids = idForms(clientId);
  const [tasks, engagements] = await Promise.all([
    db.collection('task_mappings').find({ plextrac_client_id: { $in: ids } },
      { projection: { _id: 0, clickup_task_id: 1, plextrac_report_id: 1, task_name: 1 } }).toArray(),
    db.collection('deliveryflow_auth_forms').find({ plextrac_client_id: { $in: ids } },
      { projection: { _id: 0, engagement_id: 1, plextrac_report_id: 1, report_name: 1 } }).toArray(),
  ]);
  return { clickupTasks: tasks, deliveryflowEngagements: engagements };
}

// ── Aliases ───────────────────────────────────────────────────────────────────

const aliasKey = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

async function aliases() {
  const c = (await getDb()).collection('plextrac_client_aliases');
  await c.createIndex({ alias: 1 }, { unique: true, background: true });
  return c;
}

async function saveAlias({ aliasName, clientId, clientName, mergeId }) {
  const c = await aliases();
  await c.updateOne({ alias: aliasKey(aliasName) }, {
    $set: { alias_name: aliasName, client_id: Number(clientId), client_name: clientName, merge_id: mergeId, updated_at: new Date() },
    $setOnInsert: { created_at: new Date() },
  }, { upsert: true });
}

// Aliases that pointed at the merged-away client (from an earlier merge into it) now
// point at the kept one.
async function repointAliases({ oldClientId, newClientId, newClientName }) {
  const c = await aliases();
  await c.updateMany({ client_id: { $in: idForms(oldClientId) } },
    { $set: { client_id: Number(newClientId), client_name: newClientName, updated_at: new Date() } });
}

async function findAlias(name) {
  const c = await aliases();
  return c.findOne({ alias: aliasKey(name) }, { projection: { _id: 0 } });
}

module.exports = {
  saveMerge,
  getMerge,
  listMerges,
  findActiveMerge,
  markInterrupted,
  repointReport,
  repointClient,
  linkedRecords,
  saveAlias,
  repointAliases,
  findAlias,
  aliasKey,
};
