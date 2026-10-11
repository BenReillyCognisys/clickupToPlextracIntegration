// Persistence for the QA queue that backs the /reportqueue and /reportqueueall Slack
// commands and DeliveryFlow's QA queue page. One document per Plextrac report currently
// in QA, keyed by the numeric Plextrac report id. The Plextrac ReportStatusChanged
// webhook maintains it:
//   • report reaches the first-round QA status  → upsert with stage 'first'
//   • report reaches the second-round QA status → upsert with stage 'second'
//   • report is released (Published)            → removed entirely
//
// `entered_at` is stamped once (when the report first enters the queue) and used to
// order each section oldest-first (longest-waiting at the top); `stage` /
// `updated_at` change as the report moves.
//
// Claims (DeliveryFlow, routes/deliveryflow-qa-queue.js): a consultant claims a report
// for the QA round it is in. `claimed_by` { name, email } and `claimed_at` belong to the
// current stage only. When the report moves to another stage they are cleared, together
// with `stage_entered_at` (reset), `stage_actor_cuid` (who moved it there) and the Slack
// announcement the claim notes are threaded under (`slack_channel` / `slack_ts`).

const { getDb } = require('./mongodb');
const { sameMailbox } = require('../config/qa-queue');

async function col() {
  const db = await getDb();
  const c = db.collection('qa_queue');
  await c.createIndex({ report_id: 1 }, { unique: true, background: true });
  return c;
}

// Adds or updates a report in the queue at the given stage ('first' | 'second' |
// 'release' — approved, waiting to be published). entered_at is preserved across stage
// changes (set only on first insert). A change of stage clears the claim and the Slack
// thread, and restamps stage_entered_at. One report's webhooks run one at a time
// (withTaskLock in routes/plextrac-webhook.js), so the two writes don't interleave.
async function upsert({ reportId, cuid, clientId, clientName, reportName, reportUrl, stage, actorCuid }) {
  const c = await col();
  const now = new Date();
  const id = Number(reportId);

  // Moved on from another stage: the old round's claim and thread no longer apply.
  await c.updateOne(
    { report_id: id, stage: { $ne: stage } },
    {
      $set: {
        stage,
        stage_entered_at: now,
        stage_actor_cuid: actorCuid || null,
        claimed_by:       null,
        claimed_at:       null,
        slack_channel:    null,
        slack_ts:         null,
      },
    }
  );

  await c.updateOne(
    { report_id: id },
    {
      $set: {
        report_cuid:  cuid || null,
        client_id:    clientId ?? null,
        client_name:  clientName || null,
        report_name:  reportName || null,
        report_url:   reportUrl || null,
        updated_at:   now,
      },
      $setOnInsert: {
        entered_at:       now,
        stage,
        stage_entered_at: now,
        stage_actor_cuid: actorCuid || null,
      },
    },
    { upsert: true }
  );
}

// Removes a report from the queue (on release). No-op if it isn't present.
async function remove(reportId) {
  const c = await col();
  await c.deleteOne({ report_id: Number(reportId) });
}

// Returns every queued report, oldest-first (by entered_at) — the report that has
// been waiting in the queue longest at the top.
async function list() {
  const c = await col();
  return c.find({}).sort({ entered_at: 1 }).toArray();
}

async function get(reportId) {
  const c = await col();
  return c.findOne({ report_id: Number(reportId) });
}

// Claims a report for the round it is in. Atomic: of two people claiming at once, one
// wins. `stage` is the round the caller saw, so a claim made on a stale page after the
// report moved on is refused rather than landing on the next round.
//   { ok: true, entry, already }  claimed (already: it was theirs already)
//   { ok: false, reason, entry }  reason: 'not_found' | 'moved' | 'claimed'
async function claim({ reportId, stage, by }) {
  const c = await col();
  const id = Number(reportId);
  const entry = await c.findOneAndUpdate(
    { report_id: id, stage, claimed_by: null },
    { $set: { claimed_by: { name: by.name, email: by.email }, claimed_at: new Date() } },
    { returnDocument: 'after' }
  );
  if (entry) return { ok: true, entry, already: false };

  const current = await c.findOne({ report_id: id });
  if (!current) return { ok: false, reason: 'not_found', entry: null };
  if (current.stage !== stage) return { ok: false, reason: 'moved', entry: current };
  if (sameMailbox(current.claimed_by?.email, by.email)) return { ok: true, entry: current, already: true };
  return { ok: false, reason: 'claimed', entry: current };
}

// Gives up a claim so anyone may claim the report again. Only the person who claimed it
// may, unless `override` (DeliveryFlow sends it for PMs and admins).
//   { ok: true, entry, released }  released: false when nobody had claimed it
//   { ok: false, reason, entry }   reason: 'not_found' | 'moved' | 'not_yours'
async function release({ reportId, stage, by, override = false }) {
  const c = await col();
  const id = Number(reportId);
  const current = await c.findOne({ report_id: id });
  if (!current) return { ok: false, reason: 'not_found', entry: null };
  if (current.stage !== stage) return { ok: false, reason: 'moved', entry: current };
  if (!current.claimed_by) return { ok: true, entry: current, released: false };
  if (!override && !sameMailbox(current.claimed_by.email, by.email)) {
    return { ok: false, reason: 'not_yours', entry: current };
  }
  const entry = await c.findOneAndUpdate(
    { report_id: id, stage, 'claimed_by.email': current.claimed_by.email },
    { $set: { claimed_by: null, claimed_at: null } },
    { returnDocument: 'after' }
  );
  if (!entry) return release({ reportId, stage, by, override }); // changed underneath us: look again
  return { ok: true, entry, released: true, previous: current.claimed_by };
}

// Records the Slack announcement for the report's current round, so claim notes can be
// posted in its thread. Ignored if the report has already moved to another stage.
async function setThread({ reportId, stage, channel, ts }) {
  if (!channel || !ts) return;
  const c = await col();
  await c.updateOne(
    { report_id: Number(reportId), stage },
    { $set: { slack_channel: channel, slack_ts: ts } }
  );
}

// Records when a ClickUp-era report is due (lib/qa-queue-due.js): a 'YYYY-MM-DD' date,
// or null when its task has none. due_checked_at says when it was last looked up.
async function setDueDate(reportId, dueDate) {
  const c = await col();
  await c.updateOne(
    { report_id: Number(reportId) },
    { $set: { due_date: dueDate || null, due_checked_at: new Date() } }
  );
}

module.exports = { upsert, remove, list, get, claim, release, setThread, setDueDate };
