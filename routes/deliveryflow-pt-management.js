/**
 * DeliveryFlow → break.services: consultant KPIs and Pentest QA feedback.
 *
 * PT Management (DeliveryFlow's PT Management section only):
 *   GET /api/deliveryflow/pt-management/kpis?window=31d
 *       The /report-kpis leaderboard: QAs performed per consultant in the window.
 *       window: "31d", "90d", "365d", "q1".."q4" (optionally "q2 2026") — as /report-kpis.
 *   GET /api/deliveryflow/pt-management/consultant?email=
 *       One consultant, as /report-kpis @user and /qa-logs @user: QA work and report
 *       submission lateness over the last 30 and 90 days, and their recent QAs.
 *   GET /api/deliveryflow/pt-management/qa-feedback?since=&until=
 *       Every Pentest QA feedback form, pending and submitted, with the answers
 *       (from the secure portal, pipeline/qa-feedback.js).
 *
 * A QA reviewer (anyone signed in to DeliveryFlow):
 *   GET /api/deliveryflow/qa-feedback/pending?email=
 *       Their own forms still to fill in — links only, never any answers.
 *
 * CONFIDENTIAL: the feedback answers pass through here from the portal to DeliveryFlow
 * and are not stored or logged. DeliveryFlow lets only PT Management reach the
 * pt-management routes; this service can't tell its users apart, so that check is
 * DeliveryFlow's (src/lib/ptManagement.functions.ts).
 *
 * X-API-Key: the DeliveryFlow shared secret.
 */

const express = require('express');
const { requireDeliveryFlowKey } = require('../lib/deliveryflow-key-auth');
const { buildKpiEntries, parseWindow, buildUserPeriods, buildUserLogs } = require('../lib/qa-kpi');
const users = require('../lib/plextrac-users');
const { emailsToTry } = require('../lib/slack-people');
const portal = require('../lib/secure-portal-api');
const log = require('../lib/logger');

const isEmail = (s) => /^[^\s@]+@[^\s@]+$/.test(String(s || '').trim());
const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

// ── PT Management ─────────────────────────────────────────────────────────────

const management = express.Router();
management.use(requireDeliveryFlowKey);

management.get('/kpis', async (req, res) => {
  const window = parseWindow(String(req.query.window || ''));
  if (!window) {
    return res.status(400).json({ ok: false, error: 'window must be like 31d, 90d or q2 (optionally with a year)' });
  }
  try {
    const entries = await buildKpiEntries(window);
    res.json({
      ok: true,
      window: { label: window.label, since: iso(window.since), until: iso(window.until) },
      entries,
    });
  } catch (err) {
    log.error('PT Management: could not build the QA leaderboard', { reason: err.message });
    res.status(500).json({ ok: false, error: 'Could not build the QA leaderboard' });
  }
});

// The Plextrac user for an email on either Cognisys domain, or null.
async function plextracUserFor(email) {
  for (const candidate of emailsToTry(email)) {
    const user = await users.findByEmail(candidate);
    if (user) return user;
  }
  return null;
}

management.get('/consultant', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'email is required' });
  try {
    const user = await plextracUserFor(email);
    if (!user) return res.json({ ok: true, consultant: null, periods: [], logs: [] });
    const [periods, logs] = await Promise.all([buildUserPeriods(user.cuid), buildUserLogs(user.cuid, 30)]);
    res.json({
      ok: true,
      consultant: { cuid: user.cuid, name: user.name || null, email: user.email || null },
      periods,
      logs: logs.map((l) => ({ ...l, countedAt: iso(l.countedAt) })),
    });
  } catch (err) {
    log.error('PT Management: could not build consultant stats', { reason: err.message });
    res.status(500).json({ ok: false, error: 'Could not build the consultant\'s stats' });
  }
});

management.get('/qa-feedback', async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const until = req.query.until ? new Date(String(req.query.until)) : null;
  if ((since && Number.isNaN(since.getTime())) || (until && Number.isNaN(until.getTime()))) {
    return res.status(400).json({ ok: false, error: 'since and until must be dates' });
  }
  try {
    const { results } = await portal.qaFeedbackResults({ since, until });
    res.json({ ok: true, results: results || [] });
  } catch (err) {
    log.error('PT Management: could not read QA feedback from the portal', { reason: err.message, status: err.status ?? null });
    res.status(502).json({ ok: false, error: 'Could not read QA feedback' });
  }
});

// ── A reviewer's own pending forms ────────────────────────────────────────────

const reviewer = express.Router();
reviewer.use(requireDeliveryFlowKey);

reviewer.get('/pending', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'email is required' });
  try {
    const { pending } = await portal.pendingQaFeedback(email);
    res.json({ ok: true, pending: pending || [] });
  } catch (err) {
    log.error('QA feedback: could not read pending forms from the portal', { reason: err.message, status: err.status ?? null });
    res.status(502).json({ ok: false, error: 'Could not read pending QA feedback' });
  }
});

module.exports = { management, reviewer };
