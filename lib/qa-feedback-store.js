// Which reports have already been asked for Pentest QA feedback, per round
// (pipeline/qa-feedback.js). A report can go through a round of QA more than once (sent
// back and resubmitted); only the first time it leaves each round asks for feedback.
//
// One document per report and round, held for good — a unique index makes the check
// and the record one atomic step, so two webhooks at once can't both ask:
//   { report_id, round: 'first' | 'second', reviewer_email, asked_at }

const { getDb } = require('./mongodb');

let ready = null;
function col() {
  if (!ready) {
    ready = (async () => {
      const c = (await getDb()).collection('qa_feedback_requests');
      await c.createIndex({ report_id: 1, round: 1 }, { unique: true, background: true });
      return c;
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

/**
 * Claims the report's feedback request for this round. True when this is the first
 * time — go ahead and ask; false when it has been asked before.
 */
async function claim(reportId, round, reviewerEmail) {
  const c = await col();
  try {
    await c.insertOne({ report_id: Number(reportId), round, reviewer_email: reviewerEmail || null, asked_at: new Date() });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

/** Gives a claim back, when asking failed, so the round can still be asked about. */
async function release(reportId, round) {
  const c = await col();
  await c.deleteOne({ report_id: Number(reportId), round });
}

module.exports = { claim, release };
