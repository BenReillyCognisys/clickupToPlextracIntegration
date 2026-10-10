/**
 * SFE portal → break.services: Plextrac access for the people on a signed auth form
 * (pipeline/plextrac-client-users.js). X-API-Key = BREAK_SERVICES_API_KEY, like the
 * portal's other calls.
 *
 *   POST /api/plextrac/client-users
 *     { plextracClientId, taskIds: [..], clientName, formToken,
 *       users: [{ email, firstName, lastName }] }
 *   → { ok: true, state, clientId, role, users: [{ email, outcome, detail? }] }
 *
 * The portal sends the primary contact always, and each contributor the client left
 * switched on for Plextrac access. Answers once Plextrac has been updated and checked.
 */

const express = require('express');
const crypto = require('crypto');
const { grantClientAccess } = require('../pipeline/plextrac-client-users');

const router = express.Router();

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

router.use('/client-users', (req, res, next) => {
  const expected = process.env.BREAK_SERVICES_API_KEY;
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
});

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

router.post('/client-users', async (req, res) => {
  const b = req.body || {};
  const users = (Array.isArray(b.users) ? b.users : []).slice(0, 50).map((u) => ({
    email: text(u?.email, 320), firstName: text(u?.firstName, 100), lastName: text(u?.lastName, 100),
  }));
  const result = await grantClientAccess({
    plextracClientId: b.plextracClientId ?? null,
    taskIds: (Array.isArray(b.taskIds) ? b.taskIds : []).slice(0, 50).map((t) => text(String(t ?? ''), 100)).filter(Boolean),
    clientName: text(b.clientName, 200),
    formToken: text(b.formToken, 100) || null,
    users,
  });
  res.json({ ok: true, ...result });
});

module.exports = router;
