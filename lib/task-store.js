const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('task_mappings');
  // Ensure index exists for fast lookup by Plextrac report ID
  await c.createIndex({ plextrac_report_id: 1 }, { unique: true, background: true });
  return c;
}

async function saveMapping({ clickupTaskId, plextracClientId, plextracReportId, taskName }) {
  const c = await col();
  await c.updateOne(
    { plextrac_report_id: plextracReportId },
    {
      $set: {
        clickup_task_id: clickupTaskId,
        plextrac_client_id: plextracClientId,
        task_name: taskName,
        updated_at: new Date(),
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true }
  );
}

async function findByReportId(plextracReportId) {
  const c = await col();
  return c.findOne({ plextrac_report_id: Number(plextracReportId) });
}

module.exports = { saveMapping, findByReportId };
