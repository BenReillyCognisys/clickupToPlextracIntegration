// Enforces who may move a Plextrac report into which status
// (config/report-status-permissions.js): Approved and Published are restricted; every
// other status is open to everyone.
//
// The Plextrac webhook (routes/plextrac-webhook.js) asks guardStatusChange() first,
// before anything else happens. When the change isn't allowed:
//   1. the report is put back to its previous status (lib/report-status-store.js), and
//      that put-back is marked as ours so its own webhook is ignored;
//   2. the ready-for-release channel and the status-violations channel are told: client -
//      report - who (tagged in Slack) - from/to statuses;
//   3. NOTHING else runs for the change — no QA posts, no release announcement or j2
//      exports, no QA queue / KPI / ClickUp / DeliveryFlow updates.
//
// Fails closed: if Plextrac doesn't say who made a restricted change, or the user list
// can't be read to find out, the change is put back like any other.
//
// Changes this service makes itself (its own API account is the actor, or the change is
// one it marked as expected) are recorded and otherwise ignored.

const api = require('../lib/plextrac-api');
const users = require('../lib/plextrac-users');
const slack = require('../lib/slack');
const statusStore = require('../lib/report-status-store');
const suppression = require('../lib/webhook-suppression');
const PERMS = require('../config/report-status-permissions');
const log = require('../lib/logger');

const READY_FOR_RELEASE_CHANNEL = () => process.env.SLACK_READY_FOR_RELEASE_CHANNEL || 'C0C08NCU0MV';
// Every disallowed change is also posted here, tagging the person who made it.
const STATUS_VIOLATIONS_CHANNEL = () => process.env.SLACK_STATUS_VIOLATIONS_CHANNEL || 'C0B6SN0023D';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const sameStatus = (a, b) => norm(a) === norm(b);

// The emails allowed to set `status`, or null when anyone may.
function allowedFor(status) {
  const key = Object.keys(PERMS.RESTRICTED).find((s) => sameStatus(s, status));
  return key ? PERMS.RESTRICTED[key] : null;
}

const mayDo = (email, status) => {
  const allowed = allowedFor(status);
  return !allowed || Boolean(email && allowed.includes(norm(email)));
};

/**
 * Who made the change, and may they? Resolves to one of
 *   { verdict: 'echo' }      a change this service made and marked as expected
 *   { verdict: 'self' }      made by this service's own API account
 *   { verdict: 'allowed', actor }
 *   { verdict: 'denied', reason, actor, detail }
 *     reason: 'not_permitted' | 'unknown_actor' | 'unknown_user' | 'users_unavailable'
 */
async function checkStatusChange({ cuid, status, actorCuid }) {
  if (await suppression.takeExpectedStatus({ cuid, status })) return { verdict: 'echo' };
  const self = await api.selfUserCuid().catch(() => null);
  if (actorCuid && self && actorCuid === self) return { verdict: 'self' };

  const allowed = allowedFor(status);
  let actor = null;
  if (actorCuid) {
    try {
      actor = (await users.cuidMap()).get(actorCuid)
        // Someone new since the cached list: look again before deciding.
        || (await users.cuidMap({ force: true })).get(actorCuid)
        || null;
    } catch (err) {
      if (allowed) return { verdict: 'denied', reason: 'users_unavailable', actor: null, detail: err.message };
    }
  }
  if (!allowed) return { verdict: 'allowed', actor };
  if (!actorCuid) return { verdict: 'denied', reason: 'unknown_actor', actor: null };
  if (!actor) return { verdict: 'denied', reason: 'unknown_user', actor: null };
  if (mayDo(actor.email, status)) return { verdict: 'allowed', actor };
  return { verdict: 'denied', reason: 'not_permitted', actor };
}

/**
 * The status to put a report back to: the one recorded before this change, or — when
 * none is recorded (or the record is already this status, so a change was missed) —
 * the highest status below the attempted one that the actor is allowed to set.
 */
function choosePrevious({ known, attempted, actorEmail }) {
  if (known && !sameStatus(known, attempted)) return known;
  const at = PERMS.ORDER.findIndex((s) => sameStatus(s, attempted));
  for (let i = (at === -1 ? PERMS.ORDER.length : at) - 1; i >= 0; i--) {
    if (mayDo(actorEmail, PERMS.ORDER[i])) return PERMS.ORDER[i];
  }
  return PERMS.ORDER[0];
}

// "<@U123>" when Slack knows the email, else the name. Never throws.
// Plextrac and Slack don't always hold someone under the same Cognisys domain
// (alice@cognisys.group in one, alice@cognisys.co.uk in the other), so the other one is
// tried too.
const COGNISYS_DOMAINS = ['cognisys.group', 'cognisys.co.uk'];
function emailsToTry(email) {
  const [local, domain] = norm(email).split('@');
  if (!local || !domain) return [];
  return [norm(email), ...COGNISYS_DOMAINS.filter((d) => d !== domain && COGNISYS_DOMAINS.includes(domain)).map((d) => `${local}@${d}`)];
}

async function mention(user, fallback) {
  for (const email of emailsToTry(user?.email)) {
    const id = await slack.lookupUserIdByEmail(email).catch(() => null);
    if (id) return `<@${id}>`;
  }
  return user?.name || user?.email || fallback;
}

function slackEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const WHO = {
  unknown_actor: 'Someone (Plextrac did not say who)',
  unknown_user: 'An unrecognised Plextrac user',
  users_unavailable: 'Someone (the Plextrac user list could not be read to check who)',
};

/**
 * The message for a put-back. Pure, for tests. `verified` is false when it couldn't be
 * established who made the change (Plextrac didn't say, or the user list couldn't be
 * read) — they may well be allowed, so the message doesn't say they aren't.
 */
function buildRevertMessage({ clientName, clientUrl, reportName, reportUrl, who, attempted, previous, verified = true, putBack, error }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  const why = verified
    ? 'they are not authorised to perform second or release QA'
    : 'they could not be confirmed as authorised to perform second or release QA';
  const head = `:no_entry: *Status change not allowed* — Client: ${client} - ${report}\n`
    + `${who} moved the report from *${slackEscape(previous)}* to *${slackEscape(attempted)}*, but ${why}.`;
  return putBack
    ? `${head} It has been moved back to *${slackEscape(previous)}*. Nothing was posted or exported for the change.`
    : `${head}\n:warning: It could NOT be moved back automatically (${slackEscape(error)}) — please set it back to *${slackEscape(previous)}* by hand. Nothing was posted or exported for the change.`;
}

/**
 * Puts a disallowed change back and reports it. Resolves with what happened; never
 * throws (the webhook must not run the automations whatever happens here).
 */
async function putBack({ decision, clientId, reportId, cuid, clientName, reportName, attempted, plextracBase }) {
  const known = await statusStore.get(reportId).catch(() => null);
  const previous = choosePrevious({ known: known?.status, attempted, actorEmail: decision.actor?.email });

  let ok = false;
  let error = null;
  try {
    await suppression.expectStatus({ cuid, status: previous });
    await api.updateReport(clientId, reportId, { status: previous });
    const now = (await api.getReport(clientId, reportId))?.status;
    ok = sameStatus(now, previous);
    if (!ok) error = `Plextrac still shows it as ${now}`;
  } catch (err) {
    error = err.message;
  }
  await statusStore.set({ reportId, clientId, cuid, status: ok ? previous : attempted, source: ok ? 'put-back' : 'put-back-failed' })
    .catch(() => {});

  const who = decision.actor ? await mention(decision.actor, 'Someone') : WHO[decision.reason] || 'Someone';
  // The webhook's mapping often has no client name (ClickUp mappings don't store one),
  // or an old one (a client merge), so ask Plextrac.
  const client = await api.getClient(clientId).catch(() => null);
  const text = buildRevertMessage({
    clientName: client?.name || clientName || `client ${clientId}`, reportName,
    clientUrl: `${plextracBase}/client/${clientId}`,
    reportUrl: `${plextracBase}/client/${clientId}/report/${reportId}`,
    who, attempted, previous, verified: decision.reason === 'not_permitted', putBack: ok, error,
  });
  // The ready-for-release channel, and the status-violations channel — where the
  // person who made the change is tagged so they see it. Each post stands alone.
  await Promise.all([
    [READY_FOR_RELEASE_CHANNEL(), 'ready-for-release'],
    [STATUS_VIOLATIONS_CHANNEL(), 'status-violations'],
  ].map(([channel, label]) => slack.postMessage(channel, text).catch((err) => {
    log.error(`Status guard: could not post to the ${label} channel`, { reason: err.message, channel, report_id: reportId });
  })));

  const data = {
    client: clientName, report: reportName, report_id: reportId, attempted, previous,
    actor: decision.actor?.email || decision.actor?.name || null, reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}),
  };
  if (ok) log.warn('Status guard: change not allowed — put back', data);
  else log.error('Status guard: change not allowed — could NOT be put back', { ...data, error });
  return { previous, putBack: ok, error };
}

/**
 * The webhook's first question about a status change: should its automations run?
 * Records the status the report is now in (or was put back to). Resolves
 * { proceed: boolean, verdict, previous? }.
 */
async function guardStatusChange({ cuid, actorCuid, status, clientId, reportId, clientName, reportName, plextracBase }) {
  const decision = await checkStatusChange({ cuid, status, actorCuid });
  if (decision.verdict === 'denied') {
    const done = await putBack({ decision, clientId, reportId, cuid, clientName, reportName, attempted: status, plextracBase });
    return { proceed: false, verdict: 'denied', ...done };
  }
  await statusStore.set({ reportId, clientId, cuid, status, actorCuid: actorCuid || null, source: decision.verdict })
    .catch((err) => log.warn('Status guard: could not record the report status', { reason: err.message, report_id: reportId }));
  if (decision.verdict !== 'allowed') {
    log.info(`Plextrac webhook ignored — status change made by break.services itself (${decision.verdict})`, { cuid, status, report_id: reportId });
    return { proceed: false, verdict: decision.verdict };
  }
  return { proceed: true, verdict: 'allowed', actor: decision.actor };
}

module.exports = {
  guardStatusChange,
  checkStatusChange,
  choosePrevious,
  buildRevertMessage,
  allowedFor,
  READY_FOR_RELEASE_CHANNEL,
  STATUS_VIOLATIONS_CHANNEL,
  emailsToTry,
};
