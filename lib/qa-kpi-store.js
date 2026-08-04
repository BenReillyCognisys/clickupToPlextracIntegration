// Persistence for the QA KPI leaderboard that backs the /report-kpis Slack command.
//
// One document per (report, consultant) pair — the Plextrac ReportStatusChanged
// webhook records who (the payload's actorCuid) moved each report through the QA
// workflow. The unique { report_id, actor_cuid } index is what enforces the
// anti-abuse rule: a consultant earns AT MOST ONE QA credit per report, no matter
// how many times they change its status. `record` upserts with $setOnInsert, so
// only the FIRST qualifying status change a consultant makes on a report is stored;
// every later flip is a no-op.
//
// The initial "Ready For Review" (author submitting their own report for QA) is
// excluded upstream in routes/plextrac-webhook.js before it ever reaches here, so
// authoring your own report never counts as a QA performed.

const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('qa_kpi_events');
  // Unique per (report, actor) — this is the dedup that caps a consultant at one
  // QA credit per report.
  await c.createIndex({ report_id: 1, actor_cuid: 1 }, { unique: true, background: true });
  await c.createIndex({ actor_cuid: 1 }, { background: true });
  return c;
}

// True if this consultant already holds a QA credit for this report. Lets callers
// avoid the (Plextrac) work of gathering a new credit's context on a duplicate.
async function has(reportId, actorCuid) {
  if (typeof actorCuid !== 'string' || !actorCuid) return false;
  const c = await col();
  const doc = await c.findOne(
    { report_id: Number(reportId), actor_cuid: actorCuid },
    { projection: { _id: 1 } }
  );
  return Boolean(doc);
}

// Records one QA credit for `actorCuid` on `reportId`, stamped with the status that
// earned it and the report's findings count at that moment (report size — surfaces
// consultants only QA'ing short reports). Idempotent: if this consultant already
// has a credit for this report, nothing changes. Returns true only when a NEW credit
// was inserted (useful for logging), false when it was a duplicate.
async function record({ reportId, actorCuid, status, reportCuid, clientName, reportName, findingsCount }) {
  if (typeof actorCuid !== 'string' || !actorCuid) return false;
  const c = await col();
  const res = await c.updateOne(
    { report_id: Number(reportId), actor_cuid: actorCuid },
    {
      $setOnInsert: {
        report_id:      Number(reportId),
        actor_cuid:     actorCuid,
        report_cuid:    reportCuid || null,
        client_name:    clientName || null,
        report_name:    reportName || null,
        counted_status: status || null,
        // Null when the count couldn't be determined — excluded from the findings
        // total/average so it doesn't distort report-size stats.
        findings_count: Number.isFinite(findingsCount) ? findingsCount : null,
        counted_at:     new Date(),
      },
    },
    { upsert: true }
  );
  return res.upsertedCount === 1;
}

// QA counts grouped by consultant (actor_cuid), highest first. Each row is
// { cuid, count, last_at } where count is the number of DISTINCT reports that
// consultant has QA'd (guaranteed distinct by the unique index).
//
// Pass { since, until } (Dates) to restrict to credits earned in a window —
// counted_at >= since and < until — for the /report-kpis time filters (last 31
// days, a quarter, …). Either bound may be omitted.
async function aggregateByActor({ since, until } = {}) {
  const c = await col();

  const range = {};
  if (since) range.$gte = since;
  if (until) range.$lt = until;

  const pipeline = [];
  if (Object.keys(range).length) pipeline.push({ $match: { counted_at: range } });
  pipeline.push(
    {
      $group: {
        _id:            '$actor_cuid',
        count:          { $sum: 1 },
        // Sum findings across QA'd reports, and count how many reports had a known
        // findings figure — so the average can ignore reports with an unknown count.
        total_findings: { $sum: { $ifNull: ['$findings_count', 0] } },
        reports_with_findings: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ['$findings_count', -1] }, -1] }, 1, 0] },
        },
        last_at:        { $max: '$counted_at' },
      },
    },
    { $sort: { count: -1, last_at: -1 } },
  );

  const rows = await c.aggregate(pipeline).toArray();
  return rows.map(r => ({
    cuid: r._id,
    count: r.count,
    totalFindings: r.total_findings,
    reportsWithFindings: r.reports_with_findings,
    last_at: r.last_at,
  }));
}

// QA stats for a single consultant in an optional { since, until } window. Returns
// { count, totalFindings, reportsWithFindings } — the same shape one leaderboard
// row exposes — with zeros when they have no activity in the window. Backs the
// /report-kpis @user lookup.
async function statsForActor(actorCuid, { since, until } = {}) {
  if (typeof actorCuid !== 'string' || !actorCuid) {
    return { count: 0, totalFindings: 0, reportsWithFindings: 0 };
  }
  const c = await col();

  const match = { actor_cuid: actorCuid };
  const range = {};
  if (since) range.$gte = since;
  if (until) range.$lt = until;
  if (Object.keys(range).length) match.counted_at = range;

  const rows = await c.aggregate([
    { $match: match },
    {
      $group: {
        _id:            '$actor_cuid',
        count:          { $sum: 1 },
        total_findings: { $sum: { $ifNull: ['$findings_count', 0] } },
        reports_with_findings: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ['$findings_count', -1] }, -1] }, 1, 0] },
        },
      },
    },
  ]).toArray();

  const r = rows[0];
  return {
    count: r?.count || 0,
    totalFindings: r?.total_findings || 0,
    reportsWithFindings: r?.reports_with_findings || 0,
  };
}

// The most recent QA credits earned by one consultant, newest first. Backs the
// /qa-logs @user command — each row carries what that command shows: when the QA
// was performed, the report title & client, and the findings count at QA time.
// `limit` is clamped to 1..100 (default 30). Returns [] for a missing/blank cuid.
async function recentByActor(actorCuid, limit = 30) {
  if (typeof actorCuid !== 'string' || !actorCuid) return [];
  const c = await col();
  const n = Math.max(1, Math.min(Math.trunc(Number(limit)) || 30, 100));
  const docs = await c
    .find({ actor_cuid: actorCuid })
    .sort({ counted_at: -1 })
    .limit(n)
    .toArray();
  return docs.map(d => ({
    reportId:      d.report_id,
    reportName:    d.report_name || null,
    clientName:    d.client_name || null,
    // Null when the count couldn't be determined at QA time (kept distinct from 0).
    findingsCount: Number.isFinite(d.findings_count) ? d.findings_count : null,
    countedAt:     d.counted_at || null,
    status:        d.counted_status || null,
  }));
}

module.exports = { record, has, aggregateByActor, statsForActor, recentByActor };
