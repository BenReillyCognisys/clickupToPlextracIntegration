// Weekly audit of every Plextrac user — READ-ONLY. It lists the tenant's users and every
// client's authorised users, and flags anyone outside Cognisys who:
//   • has a role other than the client roles (PLEXTRAC_USER_AUDIT_ROLES), or
//   • is authorised on more than one client, or
//   • is in Plextrac's Default Group (which sees every client, now and future).
// Cognisys staff (PLEXTRAC_USER_AUDIT_EXEMPT_DOMAINS, default cognisys.group and cognisys.co.uk) aren't
// checked. Nothing in Plextrac is changed: the only calls are user/list, client/list and
// a GET per client.
//
// Runs weekly (PLEXTRAC_USER_AUDIT_SCHEDULE in index.js, Mondays 07:00 UK by default),
// on POST /jobs/plextrac-user-audit, or `node scripts/plextrac-user-audit.js` to print
// the full report. Findings go to PLEXTRAC_USER_AUDIT_CHANNEL (default: the
// status-violations channel). A clean run is logged, not posted.
//
// The client counts cover the clients the break.services service account can see —
// a client it isn't authorised on isn't counted.

const api = require('../lib/plextrac-api');
const { limiter } = require('../lib/concurrency');
const slack = require('../lib/slack');
const { STATUS_VIOLATIONS_CHANNEL } = require('./status-guard');
const log = require('../lib/logger');

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowedRoles = () => list(process.env.PLEXTRAC_USER_AUDIT_ROLES
  || 'TENANT_0_ROLE_CLIENT,TENANT_0_ROLE_CLIENT__CHANGE_STATUS_ENABLED');
const exemptDomains = () => list(process.env.PLEXTRAC_USER_AUDIT_EXEMPT_DOMAINS || 'cognisys.group,cognisys.co.uk').map((d) => d.toLowerCase());
const channel = () => process.env.PLEXTRAC_USER_AUDIT_CHANNEL || STATUS_VIOLATIONS_CHANNEL();
const concurrency = () => Math.max(1, Number(process.env.PLEXTRAC_USER_AUDIT_CONCURRENCY) || 4);

const norm = (s) => String(s ?? '').trim().toLowerCase();
const domainOf = (email) => (email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '');

/** The tenant's users: [{ email, name, roles, disabled, defaultGroup }]. */
function userRows(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.data || raw?.users || [];
  return rows.map((row) => {
    const u = row?.data && !Array.isArray(row.data) ? row.data : row;
    const name = u?.fullName || [u?.name?.first, u?.name?.last].filter(Boolean).join(' ') || null;
    return {
      email: norm(u?.email || u?.username || row?.id),
      name: name ? String(name).trim() : null,
      roles: Array.isArray(u?.roles) ? u.roles : [],
      disabled: Boolean(u?.disabled),
      defaultGroup: u?.default_group === true,
    };
  }).filter((u) => u.email);
}

const clientRows = (raw) => (raw || []).map((c) => (Array.isArray(c.data)
  ? { id: Number(c.data[0]), name: String(c.data[1] ?? '') }
  : { id: Number(c.client_id ?? c.id), name: String(c.name ?? '') }));

/**
 * Reads Plextrac and works out the findings. Returns
 * { checked, exempt, clients, clientErrors: [..], flagged: [{ email, name, roles, disabled,
 *   clients: [name], reasons: [..] }] }.
 */
async function auditUsers() {
  const [rawUsers, rawClients] = await Promise.all([api.listTenantUsers(), api.listClients()]);
  const users = userRows(rawUsers);
  const clients = clientRows(rawClients).filter((c) => Number.isFinite(c.id));

  // email → the clients they're authorised on
  const authorisations = new Map();
  const clientErrors = [];
  const slot = limiter(concurrency());
  await Promise.all(clients.map((c) => slot(async () => {
    try {
      const record = await api.getClient(c.id);
      const onClient = record?.users || record?.data?.users || {};
      for (const email of Object.keys(onClient && typeof onClient === 'object' ? onClient : {})) {
        const key = norm(email);
        if (!authorisations.has(key)) authorisations.set(key, []);
        authorisations.get(key).push(c.name || `client ${c.id}`);
      }
    } catch (err) {
      clientErrors.push(`${c.name || 'client'} (${c.id}): ${err.message}`);
    }
  })));

  const allowed = allowedRoles();
  const exempt = exemptDomains();
  const flagged = [];
  let exemptCount = 0;
  for (const u of users) {
    if (exempt.includes(domainOf(u.email))) { exemptCount++; continue; }
    const onClients = (authorisations.get(u.email) || []).sort((a, b) => a.localeCompare(b));
    const reasons = [];
    const otherRoles = u.roles.filter((r) => !allowed.includes(r));
    if (!u.roles.length) reasons.push('no role');
    else if (otherRoles.length) reasons.push(`role ${otherRoles.join(', ')}`);
    if (onClients.length > 1) reasons.push(`authorised on ${onClients.length} clients`);
    if (u.defaultGroup) reasons.push('in the Default Group (sees every client)');
    if (reasons.length) flagged.push({ ...u, clients: onClients, reasons });
  }
  flagged.sort((a, b) => a.email.localeCompare(b.email));
  return { checked: users.length, exempt: exemptCount, clients: clients.length, clientErrors, flagged };
}

// ── Slack ─────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SLACK_MAX_USERS = 40;
const SHOW_CLIENTS = 5;

function slackText(result) {
  const lines = [
    `:mag: *Plextrac user audit* — ${result.flagged.length} of ${result.checked - result.exempt} non-Cognisys user(s) flagged `
      + `(${result.clients} clients checked; allowed roles: ${allowedRoles().join(', ')}).`,
  ];
  for (const u of result.flagged.slice(0, SLACK_MAX_USERS)) {
    const shown = u.clients.slice(0, SHOW_CLIENTS).map(esc).join(', ');
    const more = u.clients.length > SHOW_CLIENTS ? ` +${u.clients.length - SHOW_CLIENTS} more` : '';
    lines.push(`• ${esc(u.email)}${u.disabled ? ' _(disabled)_' : ''} — ${esc(u.reasons.join('; '))}`
      + (u.clients.length ? `\n      on: ${shown}${more}` : ''));
  }
  if (result.flagged.length > SLACK_MAX_USERS) {
    lines.push(`…and ${result.flagged.length - SLACK_MAX_USERS} more — run \`node scripts/plextrac-user-audit.js\` for the full list.`);
  }
  if (result.clientErrors.length) {
    lines.push(`:warning: ${result.clientErrors.length} client(s) couldn't be read, so some counts may be low: `
      + esc(result.clientErrors.slice(0, 5).join('; ')));
  }
  return lines.join('\n');
}

// ── The run ───────────────────────────────────────────────────────────────────

let running = null;

/** Runs the audit (one at a time) and posts findings to Slack. Never throws. */
function runUserAudit({ notify = true } = {}) {
  if (running) {
    log.info('Plextrac user audit already running — skipping', {});
    return running;
  }
  running = (async () => {
    log.info('Plextrac user audit STARTED', {});
    try {
      const result = await auditUsers();
      log.info('Plextrac user audit FINISHED', {
        users: result.checked, exempt: result.exempt, clients: result.clients,
        flagged: result.flagged.length, unreadable_clients: result.clientErrors.length,
      });
      for (const u of result.flagged) {
        log.warn(`Plextrac user audit: ${u.email} — ${u.reasons.join('; ')}`, { clients: u.clients.join(', ') || '(none)' });
      }
      if (notify && (result.flagged.length || result.clientErrors.length)) {
        await slack.postMessage(channel(), slackText(result)).catch((err) => {
          log.error('Plextrac user audit: Slack post failed', { reason: err.message });
        });
      }
      return result;
    } catch (err) {
      log.error('Plextrac user audit FAILED', { reason: err.message });
      if (notify) {
        await slack.postMessage(channel(), `:warning: Plextrac user audit failed — ${esc(err.message)}`).catch(() => {});
      }
      return null;
    }
  })().finally(() => { running = null; });
  return running;
}

module.exports = { runUserAudit, auditUsers, slackText, userRows };
