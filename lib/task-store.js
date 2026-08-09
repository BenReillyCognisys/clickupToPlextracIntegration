const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('task_mappings');
  await c.createIndex({ plextrac_report_id: 1 }, { unique: true, background: true });
  await c.createIndex({ plextrac_report_cuid: 1 }, { sparse: true, background: true });
  // Not unique — a rename can only ever update an existing mapping, but keeping it
  // non-unique avoids surprises if a task ever legitimately spawns two reports.
  await c.createIndex({ clickup_task_id: 1 }, { background: true });
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

// The mapping for a ClickUp task, if a report has already been created for it.
// Used by the rename sync to tell an existing project (update Plextrac) from one
// whose report hasn't been created yet (e.g. the task was still the template
// "Test Task" placeholder at taskCreated time — create it now on the rename).
async function findByTaskId(clickupTaskId) {
  if (clickupTaskId == null) return null;
  const c = await col();
  return c.findOne({ clickup_task_id: String(clickupTaskId) }, { sort: { created_at: -1 } });
}

// Applies a ClickUp rename to an existing mapping: the new task name, its resolved
// testing type, and (when the report was moved to a different Plextrac client) the
// new client id. Leaves the start-date-pending flag untouched — a rename doesn't
// resolve a start date.
async function updateMappingDetails(plextracReportId, { clientId, taskName, testingType } = {}) {
  const c = await col();
  const set = { updated_at: new Date() };
  if (clientId != null)    set.plextrac_client_id = clientId;
  if (taskName != null)    set.task_name = taskName;
  if (testingType != null) set.testing_type = testingType;
  await c.updateOne({ plextrac_report_id: plextracReportId }, { $set: set });
}

async function findByCuid(cuid) {
  // Only ever query with a plain string. The cuid comes from the Plextrac webhook
  // payload; rejecting non-strings stops a NoSQL operator object (e.g. {$ne:null})
  // from being smuggled into the query.
  if (typeof cuid !== 'string' || !cuid) return null;
  const c = await col();
  return c.findOne({ plextrac_report_cuid: cuid });
}

module.exports = {
  saveMapping,
  findByReportId,
  findByCuid,
  findByTaskId,
  updateMappingDetails,
  findPendingStartDate,
  resolveStartDate,
};
