require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { validateToken } = require('./lib/clickup-api');
const { runAuthFormCheck, reconcileAuthFormMessage } = require('./pipeline/auth-form-check');
const { runReportsDueCheck } = require('./pipeline/reports-due');
const { runStartDateWatch } = require('./pipeline/start-date-watch');
const { startAvailabilityCache, requireApiKey } = require('./lib/availability-cache');
const log = require('./lib/logger');
const app = express();
const PORT = process.env.PORT || 4000;

// Trust nginx as the first proxy so express-rate-limit can read the real client IP
// from X-Forwarded-For without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
// Test push from VM.
app.set('trust proxy', 1);

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the manual job-trigger endpoints (/jobs/*). Mounted BEFORE the
// X-API-Key check so failed-auth attempts (e.g. brute-forcing the key) are throttled
// too. The scheduling API (/availability, /schedule) is intentionally NOT limited
// here: the frontend calls it frequently and many users share one API key, so an
// IP-based limit would throttle legitimate traffic.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Both webhook routes need raw body buffers for HMAC signature verification.
app.post('/webhook/clickup',
  webhookLimiter,
  express.raw({ type: 'application/json', limit: '100kb' }),
  require('./routes/clickup-webhook')
);

// The Plextrac webhook handles both the ClickUp status sync and (when a report
// enters the QA status) the automated AI QA review — see routes/plextrac-webhook.js.
app.post('/webhook/plextrac',
  webhookLimiter,
  express.raw({ type: 'application/json', limit: '100kb' }),
  require('./routes/plextrac-webhook')
);

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('ClickUp → Plextrac integration API is running.');
});

// CORS for the browser-facing scheduling API. The /webhook/* routes above are
// server-to-server (signed ClickUp/Plextrac callbacks) and intentionally get no
// CORS. Mirrors the permissive, credentialed CORS the sfe-portal previously
// applied to these endpoints, and answers the preflight the X-API-Key header
// triggers. Lock it down by setting SCHEDULING_ALLOWED_ORIGINS to a
// comma-separated allowlist; left blank, any origin is reflected.
const SCHEDULING_ALLOWED_ORIGINS = (process.env.SCHEDULING_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function schedulingCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && (SCHEDULING_ALLOWED_ORIGINS.length === 0 || SCHEDULING_ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ClickUp scheduling API (X-API-Key required), backed by a background-refreshed
// availability/service-types cache started below:
//   GET  /availability/pentest?testType=X&days=N — earliest consultant slots
//   GET  /availability/freeblackbox               — half-day Free Black Box Test slots
//   GET  /availability/internalaudit?days=N       — earliest slots by day count
//   POST /schedule/pentest                        — create an engagement task
app.use('/availability', schedulingCors, require('./routes/availability'));
app.use('/schedule', schedulingCors, require('./routes/schedule'));

// Manual trigger for the daily auth-form check (also runs on a 14:00 cron below).
// Requires the X-API-Key header (AVAILABILITY_API_KEY) and is rate-limited. Always
// responds with a blank 200 and discloses nothing; the check runs fire-and-forget
// with its outcome written to the logs.
app.post('/jobs/auth-form-check', apiLimiter, requireApiKey, (req, res) => {
  res.status(200).end();
  runAuthFormCheck().catch(err => log.error('Auth-form check failed', { reason: err.message }));
});

// Manual trigger for the auth-form reconcile (also runs on a 5-minute cron below).
// Requires the X-API-Key header and is rate-limited. Re-scans the space and strikes
// through any listed task that's since been actioned.
app.post('/jobs/auth-form-reconcile', apiLimiter, requireApiKey, (req, res) => {
  res.status(200).end();
  reconcileAuthFormMessage().catch(err => log.error('Auth-form reconcile failed', { reason: err.message }));
});

// Manual trigger for the weekly reports-due check (also runs on the optional cron
// below if REPORTS_DUE_CRON is set). Requires the X-API-Key header and is
// rate-limited. Posts the "Missed SLA / Week Commencing" report to Slack. Always
// responds with a blank 200; the outcome goes to the logs.
app.post('/jobs/reports-due', apiLimiter, requireApiKey, (req, res) => {
  res.status(200).end();
  runReportsDueCheck().catch(err => log.error('Reports-due check failed', { reason: err.message }));
});

// Manual trigger for the start-date watcher (also runs on the 8-hour cron below).
// Re-checks every Plextrac report created without a ClickUp start date and renames
// it once a start date appears. Requires the X-API-Key header and is rate-limited;
// always responds with a blank 200, with the outcome written to the logs.
app.post('/jobs/start-date-watch', apiLimiter, requireApiKey, (req, res) => {
  res.status(200).end();
  runStartDateWatch().catch(err => log.error('Start-date watch failed', { reason: err.message }));
});

// Daily auth-form check at 14:00 (server timezone unless AUTH_FORM_CHECK_TZ set).
// Override the schedule with AUTH_FORM_CHECK_CRON (standard cron expression).
const AUTH_FORM_CHECK_CRON = process.env.AUTH_FORM_CHECK_CRON || '0 14 * * *';
const AUTH_FORM_CHECK_TZ = process.env.AUTH_FORM_CHECK_TZ || 'Europe/London';
cron.schedule(AUTH_FORM_CHECK_CRON, () => {
  console.log('[cron] Triggering daily auth-form check…');
  runAuthFormCheck().catch(err => log.error('Auth-form check failed', { reason: err.message }));
}, { timezone: AUTH_FORM_CHECK_TZ });

// Every 5 minutes, reconcile the posted message: strike through tasks that have
// been actioned since it went out. Override with AUTH_FORM_RECONCILE_CRON.
const AUTH_FORM_RECONCILE_CRON = process.env.AUTH_FORM_RECONCILE_CRON || '*/5 * * * *';
cron.schedule(AUTH_FORM_RECONCILE_CRON, () => {
  reconcileAuthFormMessage().catch(err => log.error('Auth-form reconcile failed', { reason: err.message }));
}, { timezone: AUTH_FORM_CHECK_TZ });

// Weekly reports-due check — Mondays at 06:00 by default. Override with
// REPORTS_DUE_CRON (standard cron) or set it blank to disable the schedule and
// run manually via POST /jobs/reports-due.
const REPORTS_DUE_CRON = process.env.REPORTS_DUE_CRON ?? '0 6 * * 1';
const REPORTS_DUE_TZ = process.env.REPORTS_DUE_TZ || 'Europe/London';
if (REPORTS_DUE_CRON) {
  cron.schedule(REPORTS_DUE_CRON, () => {
    console.log('[cron] Triggering weekly reports-due check…');
    runReportsDueCheck().catch(err => log.error('Reports-due check failed', { reason: err.message }));
  }, { timezone: REPORTS_DUE_TZ });
}

// Every 8 hours, re-check reports created without a ClickUp start date and rename
// them once a start date is set. Override the schedule with START_DATE_WATCH_CRON
// (standard cron) or set it blank to disable and run manually via
// POST /jobs/start-date-watch.
const START_DATE_WATCH_CRON = process.env.START_DATE_WATCH_CRON ?? '0 */8 * * *';
const START_DATE_WATCH_TZ = process.env.START_DATE_WATCH_TZ || 'Europe/London';
if (START_DATE_WATCH_CRON) {
  cron.schedule(START_DATE_WATCH_CRON, () => {
    console.log('[cron] Triggering start-date watch…');
    runStartDateWatch().catch(err => log.error('Start-date watch failed', { reason: err.message }));
  }, { timezone: START_DATE_WATCH_TZ });
}

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  try {
    await validateToken();
    log.info('ClickUp API token validated successfully', {});
  } catch (err) {
    log.error('ClickUp API token validation failed — requests will be rejected', { reason: err.message });
  }
  // Warm + schedule the availability cache that backs /schedule/pentest.
  startAvailabilityCache();
});
