require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { validateToken } = require('./lib/clickup-api');
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

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  try {
    await validateToken();
    log.info('ClickUp API token validated successfully', {});
  } catch (err) {
    log.error('ClickUp API token validation failed — requests will be rejected', { reason: err.message });
  }
});
