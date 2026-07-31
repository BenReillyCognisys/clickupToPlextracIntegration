// Slack slash-command endpoint backing /reportqueue, /reportqueueall and /report-kpis.
//
// All three share one Request URL (POST /slack/commands) and are told apart by the
// `command` field:
//   • /reportqueue    → ephemeral reply with the current QA queue (invoking user only)
//   • /reportqueueall → posts the QA queue to the whole channel, PMs only
//     (SLACK_PM_USER_IDS allowlist); non-PMs get an ephemeral "not authorised".
//   • /report-kpis    → ephemeral leaderboard of QAs performed per consultant;
//     PM-only (same SLACK_PM_USER_IDS allowlist as /reportqueueall).
//
// The queue commands render the QA queue (reports in first- and second-round QA,
// maintained by the Plextrac webhook — see routes/plextrac-webhook.js). /report-kpis
// aggregates the QA KPI store and resolves each consultant via the Plextrac users
// API, which can be slow, so it acks within Slack's 3-second window and delivers the
// result over the command's response_url.
//
// Requests are verified with the Slack signing secret (SLACK_SIGNING_SECRET) over the
// raw body, so this route MUST be mounted with a raw body parser (see index.js).

const crypto = require('crypto');
const querystring = require('querystring');
const qaQueue = require('../lib/qa-queue-store');
const slack = require('../lib/slack');
const ptUsers = require('../lib/plextrac-users');
const {
  buildKpiEntries, renderKpis, parseWindow,
  parseUserMention, buildUserPeriods, renderUserStats,
} = require('../lib/qa-kpi');
const log = require('../lib/logger');

// Shown when /report-kpis is given an argument it doesn't understand.
const KPI_USAGE =
  ':information_source: *`/report-kpis` usage*\n' +
  '• `/report-kpis` — last 31 days (default)\n' +
  '• `/report-kpis 90d` — rolling last N days, e.g. `90d`, `180d`, `364d` (1–3650)\n' +
  '• `/report-kpis q1` | `q2` | `q3` | `q4` — a calendar quarter this year ' +
  '(Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec)\n' +
  '• `/report-kpis q2 2025` — that quarter of a specific year\n' +
  '• `/report-kpis @user` — that person\'s stats for the last 30 & 90 days\n' +
  '• `/report-kpis help` — show this help';

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

// Computes the QA KPI leaderboard for `window` ({ label, since, until }) and
// delivers it over the slash command's response_url (the inline ack has already
// been sent). Best-effort — a failure is reported back to the user, not thrown.
async function deliverKpis(responseUrl, window) {
  if (!responseUrl) return;
  // Post the "crunching…" note over response_url (not as the slash reply) so the
  // result below can replace_original it — an ephemeral slash reply can't be.
  try {
    await slack.postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      text: `:bar_chart: Crunching QA KPIs for ${window.label}…`,
    });
  } catch (err) {
    log.error('Failed to post QA KPIs ack to Slack response_url', { reason: err.message });
  }
  let text;
  try {
    text = renderKpis(await buildKpiEntries(window), window && window.label);
  } catch (err) {
    log.error('Failed to build QA KPIs for Slack command', { reason: err.message });
    text = 'Sorry — could not compute QA KPIs right now. Please try again shortly.';
  }
  try {
    // replace_original overwrites the "crunching…" note with the result.
    await slack.postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      replace_original: true,
      text,
    });
  } catch (err) {
    log.error('Failed to post QA KPIs to Slack response_url', { reason: err.message });
  }
}

// Resolves an @-mentioned Slack user to their Plextrac stats and delivers them over
// the slash command's response_url. The chain is Slack id → email (users.info) →
// Plextrac user (match on email) → cuid → per-window stats. Each hop that can't
// resolve returns a specific, actionable message instead of throwing.
async function deliverUserKpis(responseUrl, slackUserId) {
  if (!responseUrl) return;
  // Transient note over response_url so the result below can replace_original it.
  try {
    await slack.postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      text: `:bar_chart: Looking up <@${slackUserId}>'s QA stats…`,
    });
  } catch (err) {
    log.error('Failed to post user QA KPIs ack to Slack response_url', { reason: err.message });
  }
  let text;
  try {
    const slackUser = await slack.lookupUserById(slackUserId);
    if (!slackUser || !slackUser.email) {
      text = `:warning: Couldn't read an email for <@${slackUserId}> — the bot needs the ` +
        '`users:read.email` scope and the user must have a visible email address.';
    } else {
      const ptUser = await ptUsers.findByEmail(slackUser.email);
      if (!ptUser) {
        text = `:warning: No Plextrac user matches <@${slackUserId}> (\`${slackEscape(slackUser.email)}\`). ` +
          'They may have no Plextrac account, or it uses a different email.';
      } else {
        const periods = await buildUserPeriods(ptUser.cuid);
        const name = slackUser.name || ptUser.name || slackUser.email;
        text = renderUserStats(name, periods);
      }
    }
  } catch (err) {
    log.error('Failed to build QA KPIs for user', { reason: err.message, slack_user: slackUserId });
    text = 'Sorry — could not look up that user right now. Please try again shortly.';
  }
  try {
    await slack.postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      replace_original: true,
      text,
    });
  } catch (err) {
    log.error('Failed to post user QA KPIs to Slack response_url', { reason: err.message });
  }
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

  // /report-kpis [help | Nd | qN [year]] — resolving consultants via the Plextrac
  // users API can exceed Slack's 3-second window, so ack immediately and deliver
  // over response_url. `help`/`-h`/`--help`/`?` shows usage; an unrecognised
  // argument shows the same usage prefixed with what wasn't understood.
  if (command === '/report-kpis') {
    // Restricted to the same PM allowlist as /reportqueueall.
    if (!pmUserIds().includes(userId)) {
      log.info('Rejected /report-kpis — user not a PM', { user_id: userId });
      return res.json({
        response_type: 'ephemeral',
        text: ':lock: `/report-kpis` is restricted to PMs.',
      });
    }

    const arg = String(params.text || '').trim();
    if (/^(help|--help|-h|-\?|\/\?|\?)$/i.test(arg)) {
      return res.json({ response_type: 'ephemeral', text: KPI_USAGE });
    }

    // @user lookup — that person's stats for the last 30 & 90 days.
    const mentionId = parseUserMention(arg);
    if (mentionId) {
      // Ack with an empty 200; the note + result are delivered over response_url
      // (see deliverUserKpis) so the result can replace the note.
      res.status(200).end();
      deliverUserKpis(String(params.response_url || ''), mentionId).catch(err =>
        log.error('QA KPIs user command failed', { reason: err.message }));
      return;
    }
    // A bare "@name" means Slack didn't escape the mention — resolution is impossible.
    if (/(^|\s)@/.test(arg)) {
      return res.json({
        response_type: 'ephemeral',
        text: ':warning: To look up a person, enable *Escape channels, users, and links sent to your app* on the ' +
          '`/report-kpis` command (Slack app → Slash Commands), then `/report-kpis @Name` will resolve them.',
      });
    }

    const window = parseWindow(arg);
    if (!window) {
      return res.json({
        response_type: 'ephemeral',
        text: `:warning: Didn't recognise \`${slackEscape(arg)}\`.\n\n${KPI_USAGE}`,
      });
    }
    // Ack with an empty 200; the note + result are delivered over response_url
    // (see deliverKpis) so the result can replace the note.
    res.status(200).end();
    deliverKpis(String(params.response_url || ''), window).catch(err =>
      log.error('QA KPIs command failed', { reason: err.message }));
    return;
  }

  // Queue commands (/reportqueue, /reportqueueall) below.
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
module.exports.deliverKpis = deliverKpis;
