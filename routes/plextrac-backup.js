/**
 * SFE-portal → break.services: the weekly Plextrac backup (pipeline/plextrac-backup.js).
 *
 *   GET /api/plextrac/backups/status   the last finished run (totals, changes, runtime,
 *                                      Drive links), any run in progress, recent runs,
 *                                      and when the next one is due
 *
 * X-API-Key = BREAK_SERVICES_API_KEY, like the portal's other calls. The portal shows it
 * on its (admin-only) Scheduling page.
 */

const express = require('express');
const crypto = require('crypto');
const backup = require('../pipeline/plextrac-backup');
const log = require('../lib/logger');

const router = express.Router();

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

router.use((req, res, next) => {
  const expected = process.env.BREAK_SERVICES_API_KEY;
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
});

router.get('/backups/status', async (req, res) => {
  try {
    res.json({ ok: true, backup: await backup.getStatus() });
  } catch (err) {
    log.error('Plextrac backup status failed', { reason: err.message });
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
