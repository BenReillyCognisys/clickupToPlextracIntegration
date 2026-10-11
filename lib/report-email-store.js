// The report email for each released Plextrac report (pipeline/report-email.js): one
// document per report, so the email is made once however often the report is
// released or its webhook delivered.
//
//   state: 'pending'   a run is making it now
//          'drafted'   a draft reply is waiting in the PM's mailbox for them to send
//          'scheduled' drafted, and sent for the PM at `send_at` (they chose auto send)
//          'sending'   being sent now
//          'sent'      sent for the PM (`sent_at`)
//          'cancelled' not sent: the PM deleted the draft during the hold
//          'pm_off'    the PM whose chain it is has report emails turned off
//          'no_thread' no email chain was found for the client, so nothing was made
//          'no_client' the chain was found but has no client address on it
//          'failed'    something went wrong (`reason`)
//
// 'no_thread', 'no_client', 'pm_off' and 'failed' can be tried again (a later release, or POST
// /jobs/report-email); 'drafted' only with force. A 'pending' left behind by a crash
// can be taken over once it is STALE_MS old.

const { getDb } = require('./mongodb');

const RETRYABLE = ['no_thread', 'no_client', 'pm_off', 'failed'];
const STALE_MS = 15 * 60 * 1000;

let ready = null;
function col() {
  if (!ready) {
    ready = (async () => {
      const c = (await getDb()).collection('report_emails');
      await c.createIndex({ report_id: 1 }, { unique: true, background: true });
      return c;
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

/**
 * Claims the report's email for this run. Returns true when this run should make it,
 * false when it has been made already (or another run is making it). Atomic: two
 * webhooks for one report can't both win, because the second one's upsert hits the
 * unique index.
 */
async function claim(reportId, { force = false } = {}) {
  const c = await col();
  const now = new Date();
  const filter = force
    ? { report_id: Number(reportId) }
    : {
      report_id: Number(reportId),
      $or: [
        { state: { $in: RETRYABLE } },
        { state: 'pending', claimed_at: { $lt: new Date(now.getTime() - STALE_MS) } },
      ],
    };
  try {
    await c.updateOne(
      filter,
      { $set: { state: 'pending', claimed_at: now }, $setOnInsert: { created_at: now } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

/** Records how the run ended: { state, …details }. */
async function finish(reportId, { state, ...details }) {
  const c = await col();
  await c.updateOne(
    { report_id: Number(reportId) },
    { $set: { state, ...details, finished_at: new Date() } },
  );
}

async function get(reportId) {
  const c = await col();
  return c.findOne({ report_id: Number(reportId) });
}

/**
 * Takes the next scheduled email that is due, marking it 'sending' so no other run sends
 * it too. Resolves to its document, or null when none is due.
 */
async function takeDue(now = new Date()) {
  const c = await col();
  return c.findOneAndUpdate(
    { state: 'scheduled', send_at: { $lte: now } },
    { $set: { state: 'sending', sending_at: now } },
    { sort: { send_at: 1 }, returnDocument: 'after' },
  );
}

module.exports = { claim, finish, get, takeDue };
