// Persistence for report-submission lateness, shown in /report-kpis @user.
//
// One document per report, keyed by the numeric Plextrac report id, recorded the
// FIRST time a report is submitted for QA (moved to "Ready For Review"). The unique
// index makes that idempotent: re-submissions after a bounce-back don't overwrite
// the original delivery. `actor_cuid` is the submitter (the report author), and
// `hours_late` is computed at submit time from the ClickUp due date
// (lib/report-lateness.js). `hours_late` is null when the task had no due date — such
// rows count as a submission but are excluded from the lateness average.

const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('qa_submissions');
  await c.createIndex({ report_id: 1 }, { unique: true, background: true });
  await c.createIndex({ actor_cuid: 1 }, { background: true });
  return c;
}

// True if this report's first submission has already been recorded.
async function has(reportId) {
  const c = await col();
  const doc = await c.findOne({ report_id: Number(reportId) }, { projection: { _id: 1 } });
  return Boolean(doc);
}

// Records a report's first submission. Idempotent (unique report_id + $setOnInsert):
// returns true only when a new row was inserted, false on a duplicate.
async function record({ reportId, actorCuid, clickupTaskId, dueDate, trackingStart, submittedAt, hoursLate }) {
  if (typeof actorCuid !== 'string' || !actorCuid) return false;
  const c = await col();
  const res = await c.updateOne(
    { report_id: Number(reportId) },
    {
      $setOnInsert: {
        report_id:       Number(reportId),
        actor_cuid:      actorCuid,
        clickup_task_id: clickupTaskId || null,
        due_date:        Number.isFinite(dueDate) ? dueDate : null,
        tracking_start:  Number.isFinite(trackingStart) ? trackingStart : null,
        submitted_at:    submittedAt || new Date(),
        // Null when no due date — kept out of the average but still a submission.
        hours_late:      Number.isFinite(hoursLate) ? hoursLate : null,
      },
    },
    { upsert: true }
  );
  return res.upsertedCount === 1;
}

// Submission/lateness stats for one consultant in an optional { since, until }
// window (on submitted_at). Returns { count, withDeadline, lateCount,
// totalHoursLate, avgHoursLate } — avgHoursLate is null when no submission in the
// window had a due date to measure against.
async function lateStatsForActor(actorCuid, { since, until } = {}) {
  if (typeof actorCuid !== 'string' || !actorCuid) {
    return { count: 0, withDeadline: 0, lateCount: 0, totalHoursLate: 0, avgHoursLate: null };
  }
  const c = await col();

  const match = { actor_cuid: actorCuid };
  const range = {};
  if (since) range.$gte = since;
  if (until) range.$lt = until;
  if (Object.keys(range).length) match.submitted_at = range;

  const rows = await c.aggregate([
    { $match: match },
    {
      $group: {
        _id:              '$actor_cuid',
        count:            { $sum: 1 },
        with_deadline:    { $sum: { $cond: [{ $ne: ['$hours_late', null] }, 1, 0] } },
        late_count:       { $sum: { $cond: [{ $gt: [{ $ifNull: ['$hours_late', 0] }, 0] }, 1, 0] } },
        total_hours_late: { $sum: { $ifNull: ['$hours_late', 0] } },
      },
    },
  ]).toArray();

  const r = rows[0];
  const withDeadline = r?.with_deadline || 0;
  const totalHoursLate = r?.total_hours_late || 0;
  return {
    count: r?.count || 0,
    withDeadline,
    lateCount: r?.late_count || 0,
    totalHoursLate,
    avgHoursLate: withDeadline > 0 ? totalHoursLate / withDeadline : null,
  };
}

module.exports = { record, has, lateStatsForActor };
