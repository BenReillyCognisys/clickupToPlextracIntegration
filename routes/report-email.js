/**
 * Connecting a PM's Gmail for the report email (lib/gmail-oauth.js).
 *
 * SFE portal → break.services, X-API-Key = BREAK_SERVICES_API_KEY like the portal's other
 * calls. The portal only lets its PMs and admins reach these, and says who is asking:
 *   GET    /api/report-email/connection?portalUserId=…   that user's connection
 *   POST   /api/report-email/connect                     { portalUserId, portalUsername, portalEmail }
 *                                                        → { url }: Google's consent screen
 *   DELETE /api/report-email/connection?portalUserId=…   disconnect (and revoke at Google)
 *
 * Browser, from Google's consent screen (no key — the single-use state is the check):
 *   GET    /report-email/oauth/callback                  → back to the portal's Gmail page
 */

const express = require('express');
const crypto = require('crypto');
const oauth = require('../lib/gmail-oauth');
const log = require('../lib/logger');

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const portal = express.Router();

portal.use((req, res, next) => {
  const expected = process.env.BREAK_SERVICES_API_KEY;
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
});

const userId = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 100) : '');
const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 320) : '');

function fail(res, err, what) {
  const status = err instanceof oauth.ConnectError ? err.status : 502;
  if (status >= 500) log.error(`Gmail connection: ${what} failed`, { reason: err.message });
  res.status(status).json({ ok: false, error: err.message });
}

portal.get('/connection', async (req, res) => {
  try {
    res.json({ ok: true, ...(await oauth.status(userId(req.query.portalUserId))) });
  } catch (err) {
    fail(res, err, 'status');
  }
});

portal.post('/connect', async (req, res) => {
  try {
    const { url } = await oauth.startConnect({
      portalUserId: userId(req.body?.portalUserId),
      portalUsername: text(req.body?.portalUsername),
      portalEmail: text(req.body?.portalEmail),
    });
    res.json({ ok: true, url });
  } catch (err) {
    fail(res, err, 'connect');
  }
});

portal.delete('/connection', async (req, res) => {
  try {
    res.json({ ok: true, ...(await oauth.disconnect(userId(req.query.portalUserId))) });
  } catch (err) {
    fail(res, err, 'disconnect');
  }
});

const callback = express.Router();

callback.get('/oauth/callback', async (req, res) => {
  let outcome;
  try {
    outcome = await oauth.finishConnect({
      code: typeof req.query.code === 'string' ? req.query.code : null,
      state: typeof req.query.state === 'string' ? req.query.state : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    });
  } catch (err) {
    log.error('Gmail connect failed at the callback', { reason: err.message });
    outcome = { result: 'error' };
  }
  const back = oauth.portalReturnUrl(outcome);
  res.set('Cache-Control', 'no-store');
  if (back) return res.redirect(302, back);
  res.status(outcome.result === 'connected' ? 200 : 400).type('text/plain')
    .send(outcome.result === 'connected'
      ? 'Gmail connected. You can close this tab.'
      : `Gmail was not connected (${outcome.result}). Go back to the SFE portal and try again.`);
});

module.exports = { portal, callback };
