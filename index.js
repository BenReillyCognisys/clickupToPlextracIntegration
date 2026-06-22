require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { validateToken } = require('./lib/clickup-api');
const { runAuthFormCheck } = require('./pipeline/auth-form-check');
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

// Manual trigger for the daily auth-form check (also runs on a 14:00 cron below).
// If AUTH_FORM_CHECK_SECRET is set, callers must send it in the x-job-secret header.
app.post('/jobs/auth-form-check', async (req, res) => {
  const secret = process.env.AUTH_FORM_CHECK_SECRET;
  if (secret && req.get('x-job-secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await runAuthFormCheck();
    res.status(200).json({ status: 'ok', ...result });
  } catch (err) {
    log.error('Auth-form check failed', { reason: err.message });
    res.status(500).json({ status: 'error', reason: err.message });
  }
});

// Daily auth-form check at 14:00 (server timezone unless AUTH_FORM_CHECK_TZ set).
// Override the schedule with AUTH_FORM_CHECK_CRON (standard cron expression).
const AUTH_FORM_CHECK_CRON = process.env.AUTH_FORM_CHECK_CRON || '0 14 * * *';
const AUTH_FORM_CHECK_TZ = process.env.AUTH_FORM_CHECK_TZ || 'Europe/London';
cron.schedule(AUTH_FORM_CHECK_CRON, () => {
  console.log('[cron] Triggering daily auth-form check…');
  runAuthFormCheck().catch(err => log.error('Auth-form check failed', { reason: err.message }));
}, { timezone: AUTH_FORM_CHECK_TZ });

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  try {
    await validateToken();
    log.info('ClickUp API token validated successfully', {});
  } catch (err) {
    log.error('ClickUp API token validation failed — requests will be rejected', { reason: err.message });
  }
});
