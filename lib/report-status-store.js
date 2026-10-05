// The last status break.services saw each Plextrac report in (plextrac_report_status).
//
// Plextrac's ReportStatusChanged webhook says THAT a report's status changed, not
// what it changed from. When someone sets a status they aren't allowed to
// (pipeline/status-guard.js), the report is put back to the status recorded here.
//
// Written on every status change the webhook handles (and on every put-back), so it
// only stays right if the Plextrac webhook fires for EVERY status, Draft and Approved
// included. Seeded for every existing report by scripts/seed-report-statuses.js.

const { getDb } = require('./mongodb');

let ready = null;
function col() {
  if (!ready) {
    ready = (async () => {
      const c = (await getDb()).collection('plextrac_report_status');
      await c.createIndex({ report_id: 1 }, { unique: true, background: true });
      return c;
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

async function get(reportId) {
  const c = await col();
  return c.findOne({ report_id: Number(reportId) }, { projection: { _id: 0 } });
}

async function set({ reportId, clientId, cuid, status, actorCuid = null, source }) {
  const c = await col();
  await c.updateOne(
    { report_id: Number(reportId) },
    {
      $set: {
        client_id: clientId != null ? Number(clientId) : null,
        ...(cuid ? { cuid } : {}),
        status,
        actor_cuid: actorCuid,
        source,
        at: new Date(),
      },
    },
    { upsert: true },
  );
}

// Seeding: record a status only for reports with no record yet, so a seed never
// overwrites what the webhook has seen since.
async function seed(rows) {
  if (!rows.length) return 0;
  const c = await col();
  const res = await c.bulkWrite(rows.map((r) => ({
    updateOne: {
      filter: { report_id: Number(r.reportId) },
      update: { $setOnInsert: { client_id: Number(r.clientId), status: r.status, actor_cuid: null, source: 'seed', at: new Date() } },
      upsert: true,
    },
  })), { ordered: false });
  return res.upsertedCount;
}

module.exports = { get, set, seed };
