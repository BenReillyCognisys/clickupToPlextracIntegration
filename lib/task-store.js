const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('task_mappings');
  await c.createIndex({ plextrac_report_id: 1 }, { unique: true, background: true });
  await c.createIndex({ plextrac_report_cuid: 1 }, { sparse: true, background: true });
  return c;
}

async function saveMapping({ clickupTaskId, plextracClientId, plextracReportId, plextracReportCuid, taskName }) {
  const c = await col();
  await c.updateOne(
    { plextrac_report_id: plextracReportId },
    {
      $set: {
        clickup_task_id:      clickupTaskId,
        plextrac_client_id:   plextracClientId,
        plextrac_report_cuid: plextracReportCuid,
        task_name:            taskName,
        updated_at:           new Date(),
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

async function findByCuid(cuid) {
  const c = await col();
  return c.findOne({ plextrac_report_cuid: cuid });
}

module.exports = { saveMapping, findByReportId, findByCuid };
