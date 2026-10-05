/**
 * SFE-portal → break.services: merging duplicate Plextrac clients — one or more of them
 * into the one being kept
 * (pipeline/client-merge.js). The portal is only the screen; everything happens here.
 *
 * Server-to-server, authenticated like the portal's other calls: X-API-Key =
 * BREAK_SERVICES_API_KEY. The portal limits the screen to its administrators and
 * sends the signed-in user as `requestedBy`, which is recorded on the merge.
 *
 *   GET  /api/plextrac/clients?q=acme            every client [{ id, name, reports,
 *                                                published }], A–Z; q filters by name
 *                                                (case-insensitive). The counts are cached
 *                                                and null until the first count finishes;
 *                                                ?refresh=1 recounts
 *   GET  /api/plextrac/client-merges/preview?keepClientId=1&mergeClientIds=2,3,4
 *                                                every client's reports, name clashes, the
 *                                                records that move, the backup folder name
 *   POST /api/plextrac/client-merges             { keepClientId, mergeClientIds: [..],
 *                                                  confirmClientName, requestedBy }
 *                                                → 202 { merge } — runs in the background
 *   GET  /api/plextrac/client-merges             recent merges, newest first
 *   GET  /api/plextrac/client-merges/:mergeId    one merge, with its progress and step log
 *
 * `confirmClientName` must equal the name of the client being KEPT, typed after seeing
 * the list of clients the merge will delete. A single `mergeClientId` is still accepted
 * (and, for one client, its own name as the confirmation), as the portal used to send.
 */

const express = require('express');
const crypto = require('crypto');
const merge = require('../pipeline/client-merge');
const store = require('../lib/client-merge-store');
const reportCounts = require('../lib/plextrac-report-counts');
const log = require('../lib/logger');

const router = express.Router();

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requirePortalKey(req, res, next) {
  const expected = process.env.BREAK_SERVICES_API_KEY;
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}

router.use(requirePortalKey);

function fail(res, err, what) {
  const status = err instanceof merge.MergeError ? err.status : 502;
  if (status >= 500) log.error(`Client merge API: ${what} failed`, { reason: err.message });
  res.status(status).json({ ok: false, error: err.message });
}

// Progress the screen can draw, from the record.
function progress(job) {
  const reports = job.reports || [];
  const moving = reports.filter((r) => r.role === 'move');
  const clients = merge.mergeClientsOf(job);
  return {
    reports: reports.length,
    backedUp: reports.filter((r) => r.backup?.ok).length,
    backupFailed: reports.filter((r) => r.backup && !r.backup.ok && r.backup.error).length,
    toMove: moving.length,
    moved: moving.filter((r) => r.move?.state === 'deleted').length,
    clients: clients.length,
    clientsMerged: clients.filter((c) => c.state === 'merged').length,
    clientsNotMerged: clients.filter((c) => ['failed', 'skipped'].includes(c.state)).length,
  };
}

// The record as the portal sees it: no fingerprints or raw import replies.
function view(job, { events = true } = {}) {
  if (!job) return null;
  const { _id, events: log_, merge_client: _single, ...rest } = job;
  return {
    ...rest,
    // Always a list, whichever shape the record was saved in.
    merge_clients: merge.mergeClientsOf(job),
    reports: (job.reports || []).map(({ fingerprint, move, ...r }) => ({
      ...r,
      ...(move ? { move: (({ import_reply, ...m }) => m)(move) } : {}),
    })),
    progress: progress(job),
    ...(events ? { events: log_ || [] } : {}),
  };
}

router.get('/clients', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const all = await merge.listClients();
    // Report counts come from a background cache (lib/plextrac-report-counts.js): null
    // for a client until the first count has finished. ?refresh=1 recounts now.
    const held = reportCounts.current({ force: req.query.refresh === '1' });
    const clients = (q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all).map((c) => {
      const n = held.counts.get(c.id);
      return { ...c, reports: n ? n.reports : null, published: n ? n.published : null };
    });
    res.json({
      ok: true,
      clients,
      counts: { ready: Boolean(held.refreshedAt), refreshed_at: held.refreshedAt, refreshing: held.refreshing },
    });
  } catch (err) {
    fail(res, err, 'client list');
  }
});

router.get('/client-merges/preview', async (req, res) => {
  try {
    res.json({ ok: true, preview: await merge.preview(req.query) });
  } catch (err) {
    fail(res, err, 'preview');
  }
});

router.post('/client-merges', async (req, res) => {
  const { keepClientId, mergeClientIds, mergeClientId, confirmClientName, requestedBy } = req.body || {};
  try {
    const job = await merge.startMerge({ keepClientId, mergeClientIds, mergeClientId, confirmClientName, requestedBy });
    log.info('Client merge requested', {
      merge_id: job.merge_id, keep: job.keep_client.id, merge: job.merge_clients.map((c) => c.id).join(','), requested_by: job.requested_by,
    });
    res.status(202).json({ ok: true, merge: view(job) });
  } catch (err) {
    fail(res, err, 'start');
  }
});

router.get('/client-merges', async (req, res) => {
  try {
    const jobs = await store.listMerges(req.query.limit);
    res.json({ ok: true, merges: jobs.map((j) => view(j, { events: false })) });
  } catch (err) {
    fail(res, err, 'list');
  }
});

router.get('/client-merges/:mergeId', async (req, res) => {
  try {
    const job = await store.getMerge(req.params.mergeId);
    if (!job) return res.status(404).json({ ok: false, error: 'No such merge' });
    res.json({ ok: true, merge: view(job) });
  } catch (err) {
    fail(res, err, 'status');
  }
});

module.exports = router;
module.exports.view = view;
