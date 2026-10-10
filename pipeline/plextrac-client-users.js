// Plextrac access for the people on a signed auth form: when a client submits their
// authorisation form, the primary contact and every contributor left switched on for
// Plextrac access get a Plextrac user, authorised on the client's Plextrac client
// (the one found or created with the form — pipeline/plextrac-client.js) with the
// Client role and nothing else.
//
//   SFE portal submit ─► POST /api/plextrac/client-users ─► grantClientAccess
//
// For each email, in order:
//   1. Not an email, or a Cognisys address  → skipped (staff are never given client access here)
//   2. No Plextrac user with that email     → created, with the Client role as their default role
//      A user with that email already      → used as is, but only if their role is the
//                                            Client role; anyone else (staff, another
//                                            role) is left alone and flagged
//   3. Already on the client                → nothing to do (or flagged, if not as Client)
//      Not on the client                    → authorised on it with the Client role
//   4. The client is read back: each person must now be on it with the Client role.
//
// No duplicates: emails are compared lower-cased, repeated emails on a form count once,
// existing users are reused (never created again), and runs are serialised, so two
// submissions at once can't both create the same user.
//
// PLEXTRAC_CLIENT_ACCESS   off (default) | on
// PLEXTRAC_CLIENT_ROLE     the Client role's RBAC code. Default TENANT_<tenant id>_ROLE_CLIENT;
//                          check it with `node scripts/inspect-client-role.js`. The
//                          built-in roles (ADMIN, STD_USER, ANALYST) are refused.
// PLEXTRAC_CLIENT_CLASSIFICATION_ID  optional classification tier for the client authorisation
//
// Outcomes go to the logs (every line starts "Plextrac client access") and to
// SLACK_AUTH_FORM_CHANNEL.

const api = require('../lib/plextrac-api');
const taskStore = require('../lib/task-store');
const dfStore = require('../lib/deliveryflow-store');
const { withTaskLock } = require('../lib/task-lock');
const slack = require('../lib/slack');
const EMAIL = require('../config/report-email');
const log = require('../lib/logger');

const BUILT_IN_ROLES = ['ADMIN', 'STD_USER', 'ANALYST'];
// One lock for every client: the same person can be on two clients' forms at once.
const LOCK_KEY = 'plextrac-client-users';

function mode() {
  const m = String(process.env.PLEXTRAC_CLIENT_ACCESS || 'off').trim().toLowerCase();
  return m === 'on' ? 'on' : 'off';
}

/** The Client role's code; throws when it's set to anything but a custom role. */
async function clientRole() {
  const role = String(process.env.PLEXTRAC_CLIENT_ROLE || `TENANT_${await api.tenantId()}_ROLE_CLIENT`).trim();
  if (BUILT_IN_ROLES.includes(role.toUpperCase()) || !/^TENANT_\d+_ROLE_[A-Z0-9_-]+$/.test(role)) {
    throw new Error(`PLEXTRAC_CLIENT_ROLE "${role}" is not a custom RBAC role code (TENANT_<id>_ROLE_<KEY>)`);
  }
  return role;
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const isEmail = (s) => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s);
const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1);

/**
 * The people to give access to: valid, non-Cognisys emails, each once. Returns
 * { people: [{ email, first, last }], skipped: [{ email, outcome }] }.
 */
function cleanPeople(users) {
  const internal = EMAIL.internalDomains();
  const seen = new Set();
  const people = [];
  const skipped = [];
  for (const u of Array.isArray(users) ? users : []) {
    const email = norm(u?.email);
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    if (!isEmail(email)) { skipped.push({ email, outcome: 'invalid_email' }); continue; }
    if (internal.includes(domainOf(email))) { skipped.push({ email, outcome: 'internal' }); continue; }
    const first = String(u.firstName ?? '').trim().slice(0, 100);
    const last = String(u.lastName ?? '').trim().slice(0, 100);
    people.push({ email, first: first || email.split('@')[0], last });
  }
  return { people, skipped };
}

/** Tenant users by lower-cased email: Map<email, { roles, disabled }>. */
function usersByEmail(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.data || raw?.users || [];
  const map = new Map();
  for (const row of rows) {
    const u = row?.data && !Array.isArray(row.data) ? row.data : row;
    const email = norm(u?.email || u?.username || row?.id);
    if (!email || !email.includes('@')) continue;
    map.set(email, { roles: Array.isArray(u.roles) ? u.roles : [], disabled: Boolean(u.disabled) });
  }
  return map;
}

/** A client's authorised users by lower-cased email: Map<email, role>. */
function clientUsers(record) {
  const users = record?.users || record?.data?.users || {};
  const map = new Map();
  for (const [email, v] of Object.entries(users && typeof users === 'object' ? users : {})) {
    map.set(norm(email), v?.role ?? null);
  }
  return map;
}

/**
 * The Plextrac client for the form: the id the form carries, else the one recorded for
 * its ClickUp tasks / DeliveryFlow engagements. { clientId } or { error }.
 */
async function resolveClient({ plextracClientId, taskIds }) {
  if (Number.isInteger(Number(plextracClientId)) && Number(plextracClientId) > 0) {
    return { clientId: Number(plextracClientId) };
  }
  const ids = new Set();
  for (const id of (Array.isArray(taskIds) ? taskIds : []).map(String).filter(Boolean)) {
    const mapping = await taskStore.findByTaskId(id).catch(() => null);
    const engagement = mapping ? null : await dfStore.findByEngagementId(id).catch(() => null);
    const clientId = mapping?.plextrac_client_id ?? engagement?.plextrac_client_id;
    if (clientId != null) ids.add(Number(clientId));
  }
  if (ids.size === 1) return { clientId: [...ids][0] };
  if (!ids.size) return { error: 'no_client' };
  return { error: 'ambiguous_client', clientIds: [...ids] };
}

// Checks the role exists, when the service account may list roles. A refusal isn't
// fatal: the read-back at the end still proves what Plextrac set.
async function checkRoleExists(role) {
  let roles;
  try {
    const res = await api.listSecurityRoles();
    roles = Array.isArray(res) ? res : res?.data;
  } catch (err) {
    log.warn('Plextrac client access: could not list RBAC roles to check the Client role — continuing', { role, reason: err.message });
    return;
  }
  if (!Array.isArray(roles)) return;
  if (!roles.some((r) => r?.key === role)) {
    const known = roles.map((r) => `${r?.name} (${r?.key})`).join(', ');
    throw new Error(`the Client role ${role} doesn't exist in Plextrac — roles are: ${known}`);
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

const LABELS = {
  created: 'new Plextrac user, added',
  added: 'existing client user, added',
  already_on_client: 'already had access',
  invalid_email: 'not an email address — not added',
  internal: 'Cognisys address — not added',
  other_role: 'has a Plextrac user with another role (not Client) — left alone, add by hand if right',
  disabled: 'has a disabled Plextrac user — not added',
  on_client_other_role: 'already on the client with another role — left alone, check it',
  failed: 'FAILED',
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slackText({ clientName, clientId, result }) {
  const head = `:bust_in_silhouette: Plextrac access for ${esc(clientName || `client ${clientId}`)}`;
  if (result.state !== 'done') {
    return `${head} — :warning: nobody was added: ${esc(result.reason)}. Please add the auth form's contacts to Plextrac by hand.`;
  }
  const lines = result.users.map((u) => `• ${esc(u.email)} — ${LABELS[u.outcome] || u.outcome}${u.detail ? ` (${esc(u.detail)})` : ''}`);
  const attention = result.users.some((u) => !['created', 'added', 'already_on_client', 'internal'].includes(u.outcome));
  return [`${head} (client ${clientId}, role ${result.role})${attention ? ' — :warning: some need checking' : ''}`, ...lines].join('\n');
}

async function say(text) {
  const channel = process.env.SLACK_AUTH_FORM_CHANNEL;
  if (!channel) return;
  await slack.postMessage(channel, text).catch((err) => {
    log.error('Plextrac client access: Slack notice failed', { reason: err.message });
  });
}

// ── The run ───────────────────────────────────────────────────────────────────

async function grantLocked({ clientId, people, skipped }) {
  const role = await clientRole();
  await checkRoleExists(role);

  const [tenant, record] = await Promise.all([api.listTenantUsers(), api.getClient(clientId)]);
  if (!record) throw new Error(`Plextrac client ${clientId} not found`);
  const existing = usersByEmail(tenant);
  const onClient = clientUsers(record);

  const results = new Map(skipped.map((s) => [s.email, { ...s }]));
  const toCreate = [];
  const toAssign = [];
  for (const p of people) {
    const user = existing.get(p.email);
    const clientRoleNow = onClient.get(p.email);
    if (user && user.disabled) { results.set(p.email, { email: p.email, outcome: 'disabled' }); continue; }
    if (user && !user.roles.includes(role)) {
      results.set(p.email, { email: p.email, outcome: 'other_role', detail: user.roles.join(', ') || 'no role' });
      continue;
    }
    if (clientRoleNow !== undefined) {
      results.set(p.email, clientRoleNow === role
        ? { email: p.email, outcome: 'already_on_client' }
        : { email: p.email, outcome: 'on_client_other_role', detail: String(clientRoleNow) });
      continue;
    }
    if (!user) toCreate.push(p);
    toAssign.push(p);
    results.set(p.email, { email: p.email, outcome: user ? 'added' : 'created' });
  }

  const fail = (email, detail) => results.set(email, { email, outcome: 'failed', detail });

  if (toCreate.length) {
    try {
      await api.bulkCreateUsers(toCreate.map((p) => ({
        email: p.email, name: { first: p.first, last: p.last }, role, default_group: true,
      })));
    } catch (err) {
      log.error('Plextrac client access: creating users failed', { client_id: clientId, reason: err.message });
    }
    // Plextrac only says "Users created." — look, so a failure isn't taken for a user.
    const after = usersByEmail(await api.listTenantUsers());
    for (const p of toCreate) {
      const made = after.get(p.email);
      if (!made) fail(p.email, 'user was not created');
      else if (!made.roles.includes(role)) fail(p.email, `user was created with role ${made.roles.join(', ') || 'none'}, not ${role}`);
    }
  }

  const assignable = toAssign.filter((p) => results.get(p.email).outcome !== 'failed');
  if (assignable.length) {
    const classificationId = process.env.PLEXTRAC_CLIENT_CLASSIFICATION_ID || undefined;
    try {
      const res = await api.assignClientUsers(clientId, assignable.map((p) => ({
        username: p.email, role, ...(classificationId ? { classificationId } : {}),
      })));
      const rejected = new Set((res?.users_rejected || []).map(norm));
      for (const p of assignable) if (rejected.has(p.email)) fail(p.email, 'Plextrac rejected the client authorisation');
    } catch (err) {
      for (const p of assignable) fail(p.email, err.message);
    }

    // The proof: everyone is now on the client, as Client.
    const now = clientUsers(await api.getClient(clientId));
    for (const p of assignable) {
      if (results.get(p.email).outcome === 'failed') continue;
      const got = now.get(p.email);
      if (got === undefined) fail(p.email, 'not on the client after authorising');
      else if (got !== role) fail(p.email, `on the client as ${got}, not ${role}`);
    }
  }

  return { state: 'done', role, users: [...results.values()] };
}

/**
 * Gives the auth form's people access to their Plextrac client. Never throws; returns
 * { state: 'off' | 'done' | 'no_client' | 'ambiguous_client' | 'failed', clientId?, role?,
 *   users?: [{ email, outcome, detail? }], reason? }.
 */
async function grantClientAccess({ plextracClientId = null, taskIds = [], clientName = '', formToken = null, users = [] }) {
  if (mode() === 'off') return { state: 'off' };
  const ctx = { client: clientName, form: formToken };

  const { people, skipped } = cleanPeople(users);
  if (!people.length && !skipped.length) return { state: 'done', users: [] };

  const resolved = await resolveClient({ plextracClientId, taskIds });
  if (resolved.error) {
    const reason = resolved.error === 'ambiguous_client'
      ? `the form's tasks are on different Plextrac clients (${resolved.clientIds.join(', ')})`
      : 'no Plextrac client is recorded for this form';
    log.warn(`Plextrac client access not given — ${resolved.error}`, { ...ctx, ...(resolved.clientIds ? { client_ids: resolved.clientIds.join(', ') } : {}) });
    const result = { state: resolved.error, reason };
    await say(slackText({ clientName, clientId: null, result }));
    return result;
  }
  const { clientId } = resolved;

  let result;
  try {
    result = await withTaskLock(LOCK_KEY, () => grantLocked({ clientId, people, skipped }));
  } catch (err) {
    log.error('Plextrac client access FAILED', { ...ctx, client_id: clientId, reason: err.message });
    result = { state: 'failed', reason: err.message };
    await say(slackText({ clientName, clientId, result }));
    return { ...result, clientId };
  }

  for (const u of result.users) {
    const line = u.outcome === 'failed' ? log.error : ['created', 'added', 'already_on_client'].includes(u.outcome) ? log.info : log.warn;
    line(`Plextrac client access: ${u.email} — ${u.outcome}`, { ...ctx, client_id: clientId, ...(u.detail ? { detail: u.detail } : {}) });
  }
  if (result.users.some((u) => u.outcome !== 'already_on_client')) {
    await say(slackText({ clientName, clientId, result }));
  }
  return { ...result, clientId };
}

module.exports = {
  grantClientAccess, mode,
  // for tests
  cleanPeople, usersByEmail, clientUsers, resolveClient, clientRole,
};
