const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('task_mappings');
  await c.createIndex({ plextrac_report_id: 1 }, { unique: true, background: true });
  await c.createIndex({ plextrac_report_cuid: 1 }, { sparse: true, background: true });
  return c;
}

async function saveMapping({ clickupTaskId, plextracClientId, plextracReportId, plextracReportCuid, taskName, testingType, startDatePending }) {
  const c = await col();
  await c.updateOne(
    { plextrac_report_id: plextracReportId },
    {
      $set: {
        clickup_task_id:      clickupTaskId,
        plextrac_client_id:   plextracClientId,
        plextrac_report_cuid: plextracReportCuid,
        task_name:            taskName,
        // testing_type is needed to rebuild the report name once a start date
        // appears; start_date_pending flags reports whose name still derives from
        // a fallback date (the task had no start_date when the report was created).
        testing_type:         testingType,
        start_date_pending:   Boolean(startDatePending),
        updated_at:           new Date(),
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true }
  );
}

// Every mapping still awaiting a ClickUp start date — the start-date watcher polls
// these and renames the Plextrac report once a start date is set.
async function findPendingStartDate() {
  const c = await col();
  return c.find({ start_date_pending: true }).toArray();
}

// Clears the pending flag once the report has been renamed from a real start date,
// recording the new name (and the start date that resolved it) for traceability.
async function resolveStartDate(plextracReportId, { reportName, startDate } = {}) {
  const c = await col();
  await c.updateOne(
    { plextrac_report_id: plextracReportId },
    {
      $set: {
        start_date_pending:    false,
        start_date_resolved_at: new Date(),
        resolved_start_date:   startDate ?? null,
        ...(reportName ? { report_name: reportName } : {}),
        updated_at:            new Date(),
      },
    }
  );
}

async function findByReportId(plextracReportId) {
  const c = await col();
  return c.findOne({ plextrac_report_id: Number(plextracReportId) });
}

async function findByCuid(cuid) {
  // Only ever query with a plain string. The cuid comes from the Plextrac webhook
  // payload; rejecting non-strings stops a NoSQL operator object (e.g. {$ne:null})
  // from being smuggled into the query.
  if (typeof cuid !== 'string' || !cuid) return null;
  const c = await col();
  return c.findOne({ plextrac_report_cuid: cuid });
}

module.exports = { saveMapping, findByReportId, findByCuid, findPendingStartDate, resolveStartDate };
