// Slack slash-command endpoint backing /reportqueue and /reportqueueall.
//
// Both commands render the current QA queue (reports in first- and second-round QA,
// maintained by the Plextrac webhook — see routes/plextrac-webhook.js). They share
// one Request URL (POST /slack/commands) and are told apart by the `command` field:
//   • /reportqueue    → ephemeral reply (only the invoking user sees it)
//   • /reportqueueall → posts the queue to the whole channel, PMs only
//     (SLACK_PM_USER_IDS allowlist); non-PMs get an ephemeral "not authorised".
//
// Requests are verified with the Slack signing secret (SLACK_SIGNING_SECRET) over the
// raw body, so this route MUST be mounted with a raw body parser (see index.js).

const crypto = require('crypto');
const querystring = require('querystring');
const qaQueue = require('../lib/qa-queue-store');
const log = require('../lib/logger');

// Escapes the three characters that are special in Slack mrkdwn.
function slackEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Verifies a Slack request signature: HMAC-SHA256 over `v0:<timestamp>:<rawBody>`,
// compared constant-time against the X-Slack-Signature header. Also rejects stale
// timestamps (>5 min) to blunt replay attacks.
function verifySlackSignature(signingSecret, timestamp, rawBody, signature) {
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(computed);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Renders one queue line: "• <url|Report name> — Client" (link omitted when no url).
function queueLine(e) {
  const name = slackEscape(e.report_name || `Report ${e.report_id}`);
  const label = e.report_url ? `<${e.report_url}|${name}>` : name;
  return e.client_name ? `• ${label} — ${slackEscape(e.client_name)}` : `• ${label}`;
}

// Builds the full queue message from the stored entries, grouped into the two QA
// rounds. Empty sections render as "_None_" so the shape is always predictable.
function renderQueue(entries) {
  const section = (title, stage) => {
    const items = entries.filter((e) => e.stage === stage);
    return `*${title}:*\n${items.length ? items.map(queueLine).join('\n') : '_None_'}`;
  };
  return [
    '*QA Queue*',
    '',
    section('First Round QA', 'first'),
    '',
    section('Second Round QA', 'second'),
  ].join('\n');
}

// Fallback PM allowlist, baked in so /reportqueueall still works if SLACK_PM_USER_IDS
// is left blank in the environment. Setting SLACK_PM_USER_IDS overrides this list.
const DEFAULT_PM_USER_IDS = ['U06V88B1MEK', 'U0811891NTU', 'U09CF6MLUF3', 'U07R28NJ0KS'];

function pmUserIds() {
  const fromEnv = (process.env.SLACK_PM_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_PM_USER_IDS;
}

async function handler(req, res) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    log.error('SLACK_SIGNING_SECRET is not set — cannot verify Slack commands', {});
    return res.status(500).end();
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    log.warn('Slack command rejected — invalid signature', {});
    return res.status(401).end();
  }

  const params = querystring.parse(rawBody);
  const command = String(params.command || '').trim();
  const userId = String(params.user_id || '');

  let entries;
  try {
    entries = await qaQueue.list();
  } catch (err) {
    log.error('Failed to read QA queue for Slack command', { reason: err.message, command });
    return res.json({
      response_type: 'ephemeral',
      text: 'Sorry — could not read the QA queue right now. Please try again shortly.',
    });
  }

  const text = renderQueue(entries);

  if (command === '/reportqueueall') {
    if (!pmUserIds().includes(userId)) {
      log.info('Rejected /reportqueueall — user not a PM', { user_id: userId });
      return res.json({
        response_type: 'ephemeral',
        text: ':lock: `/reportqueueall` is restricted to PMs. Use `/reportqueue` to see the queue privately.',
      });
    }
    return res.json({ response_type: 'in_channel', text });
  }

  // /reportqueue (default) — private to the invoking user.
  return res.json({ response_type: 'ephemeral', text });
}

module.exports = handler;
module.exports.verifySlackSignature = verifySlackSignature;
module.exports.renderQueue = renderQueue;
