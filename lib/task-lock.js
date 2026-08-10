// In-memory per-key async lock.
//
// ClickUp can fire two events for the same task almost simultaneously — a
// taskCreated (when the task is created already bearing its real name) and a
// taskUpdated rename — and both drive the create pipeline. Run concurrently they
// race past createReport's name-based duplicate check and produce two Plextrac
// reports (and two Slack notices). Serialising all processing for a given task id
// through this lock means the second event only starts once the first has fully
// finished (mapping saved), so its idempotency check sees the report and skips.
//
// Single-process only (the map lives in memory); this service runs as one process,
// which is the scope the races occur in.

const tails = new Map(); // key -> Promise for the tail of that key's chain

/**
 * Runs `fn` after any in-flight work for `key` has settled, and returns fn's
 * result (or rejection). Work for different keys runs concurrently; work for the
 * same key is serialised in call order.
 */
function withTaskLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  // Chain after prev regardless of how prev settled, so one failure never wedges
  // the queue for later callers.
  const run = prev.then(() => fn(), () => fn());
  // The stored tail must never reject (see above), so guard it.
  const tail = run.then(() => {}, () => {});
  tails.set(key, tail);
  // Best-effort cleanup: drop the entry once this is the last queued work.
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

module.exports = { withTaskLock };
