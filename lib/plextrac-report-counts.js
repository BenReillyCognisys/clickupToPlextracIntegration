// How many reports each Plextrac client has, and how many of them are published — for
// the SFE portal's client-merge picker (routes/client-merge.js).
//
// Plextrac has no per-client count, so this lists every client's reports (one call per
// client, ~950 of them) and keeps the result in memory for TTL_MS. A request never
// waits for that: it gets whatever counts are held (none on the very first request
// after a restart) and starts a refresh in the background if they're stale. A merge
// recounts its two clients as soon as it finishes (refreshClients).
//
// Only reads from Plextrac.

const api = require('./plextrac-api');
const { limiter } = require('./concurrency');
const { RELEASED_STATUS } = require('../config/report-status-permissions');
const log = require('./logger');

const TTL_MS = Number(process.env.PLEXTRAC_REPORT_COUNTS_TTL_MS) || 15 * 60 * 1000;
const CONCURRENCY = 6;

let counts = new Map(); // clientId -> { reports, published }
let refreshedAt = null;
let running = null; // the refresh in flight, if any

const isPublished = (status) => String(status ?? '').trim().toLowerCase() === RELEASED_STATUS.trim().toLowerCase();

async function countClient(clientId) {
  const rows = await api.listClientReports(clientId);
  const statuses = (rows || []).map((r) => (Array.isArray(r.data) ? r.data[3] : r.status));
  return { reports: statuses.length, published: statuses.filter(isPublished).length };
}

/** Recounts every client. One refresh at a time; a second caller shares the first. */
function refreshAll() {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const clients = (await api.listClients()).map((c) => Number(Array.isArray(c.data) ? c.data[0] : c.client_id ?? c.id));
    const slots = limiter(CONCURRENCY);
    const next = new Map();
    let failed = 0;
    await Promise.all(clients.map((id) => slots(async () => {
      try {
        next.set(id, await countClient(id));
      } catch {
        failed++;
        // Keep the last known count rather than showing nothing.
        if (counts.has(id)) next.set(id, counts.get(id));
      }
    })));
    counts = next;
    refreshedAt = new Date();
    log.info('Plextrac report counts refreshed', {
      clients: clients.length, failed, took: `${((Date.now() - started) / 1000).toFixed(1)}s`,
    });
  })()
    .catch((err) => log.error('Plextrac report counts refresh failed', { reason: err.message }))
    .finally(() => { running = null; });
  return running;
}

const isStale = () => !refreshedAt || Date.now() - refreshedAt.getTime() > TTL_MS;

/**
 * The counts held now, starting a background refresh when they're stale (or `force`).
 * Never waits for Plextrac. { counts: Map, refreshedAt, refreshing }.
 */
function current({ force = false } = {}) {
  if (force || isStale()) refreshAll();
  return { counts, refreshedAt, refreshing: Boolean(running) };
}

/** Recounts just these clients (after a merge); a client that no longer exists is dropped. */
async function refreshClients(clientIds) {
  await Promise.all(clientIds.map(async (id) => {
    try {
      counts.set(Number(id), await countClient(id));
    } catch {
      counts.delete(Number(id));
    }
  }));
}

function reset() {
  counts = new Map();
  refreshedAt = null;
  running = null;
}

module.exports = { current, refreshAll, refreshClients, reset, isPublished };
