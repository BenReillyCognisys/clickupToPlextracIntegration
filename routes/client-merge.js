/**
 * SFE-portal → break.services: merging duplicate Plextrac clients
 * (pipeline/client-merge.js). The portal is only the screen; everything happens here.
 *
 * Server-to-server, authenticated like the portal's other calls: X-API-Key =
 * BREAK_SERVICES_API_KEY. The portal limits the screen to its administrators and
 * sends the signed-in user as `requestedBy`, which is recorded on the merge.
 *
 *   GET  /api/plextrac/clients?q=acme            every client [{ id, name }], A–Z;
 *                                                q filters by name (case-insensitive)
 *   GET  /api/plextrac/client-merges/preview?keepClientId=1&mergeClientId=2
 *                                                both clients' reports, name clashes, the
 *                                                records that move, the backup folder name
 *   POST /api/plextrac/client-merges             { keepClientId, mergeClientId,
 *                                                  confirmClientName, requestedBy }
 *                                                → 202 { merge } — runs in the background
 *   GET  /api/plextrac/client-merges             recent merges, newest first
 *   GET  /api/plextrac/client-merges/:mergeId    one merge, with its progress and step log
 *
 * `confirmClientName` must equal the name of the client being removed (mergeClientId):
 * the merge deletes it, so the caller has to say which one it means twice.
 */

const express = require('express');
const crypto = require('crypto');
const merge = require('../pipeline/client-merge');
const store = require('../lib/client-merge-store');
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
  return {
    reports: reports.length,
    backedUp: reports.filter((r) => r.backup?.ok).length,
    backupFailed: reports.filter((r) => r.backup && !r.backup.ok && r.backup.error).length,
    toMove: moving.length,
    moved: moving.filter((r) => r.move?.state === 'deleted').length,
  };
}

// The record as the portal sees it: no fingerprints or raw import replies.
function view(job, { events = true } = {}) {
  if (!job) return null;
  const { _id, events: log_, ...rest } = job;
  return {
    ...rest,
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
    const clients = await merge.listClients();
    res.json({ ok: true, clients: q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : clients });
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
  const { keepClientId, mergeClientId, confirmClientName, requestedBy } = req.body || {};
  try {
    const job = await merge.startMerge({ keepClientId, mergeClientId, confirmClientName, requestedBy });
    log.info('Client merge requested', {
      merge_id: job.merge_id, keep: job.keep_client.id, merge: job.merge_client.id, requested_by: job.requested_by,
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
