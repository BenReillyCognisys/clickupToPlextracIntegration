// Resolves a Plextrac webhook's `actorCuid` to a human name/email.
//
// Plextrac's API looks users up by numeric id, not cuid, so (per Plextrac support)
// the only way to identify who triggered a webhook is to enumerate every user and
// match on their `cuid` field. We do that here and cache the resulting cuid→user
// map — the roster changes rarely and /report-kpis would otherwise re-list every
// user on each invocation.
//
// The users endpoint's response shape varies by Plextrac version, so extraction is
// deliberately tolerant (flat objects, `data`-wrapped objects, and the list-row
// `data: [id, name, ...]` shape are all handled). Run scripts/inspect-users.js
// against the live instance to confirm the shape before relying on it.

const api = require('./plextrac-api');
const log = require('./logger');

const TTL_MS = Number(process.env.PLEXTRAC_USERS_CACHE_MS) || 10 * 60 * 1000;

let _cache = null;     // Map<cuid, user>
let _cachedAt = 0;

// Pulls the array of user rows out of whatever the endpoint returned.
function rowsOf(res) {
  if (Array.isArray(res)) return res;
  return res?.data || res?.users || res?.results || [];
}

// Builds a display name from a user row, tolerating the several shapes Plextrac
// uses: a plain string `name`, an object `name: { first, last }` (the v1
// `user/list` shape), top-level first/last in snake_case or camelCase, or a
// `fullName`. Each part is trimmed (the live data carries stray/doubled spaces).
// Returns null when no name can be assembled.
function nameOf(u) {
  if (typeof u.name === 'string' && u.name.trim()) return u.name.trim();

  const nameObj = u.name && typeof u.name === 'object' ? u.name : u;
  const first = nameObj.first || u.first_name || u.firstName || u.first;
  const last = nameObj.last || u.last_name || u.lastName || u.last;
  const joined = [first, last].map(s => String(s ?? '').trim()).filter(Boolean).join(' ').trim();
  if (joined) return joined;

  if (u.fullName && String(u.fullName).trim()) return String(u.fullName).trim();
  return null;
}

// Normalises one user row to { cuid, id, name, email }. Returns null when there's
// no cuid to key on (that row can never be matched to a webhook actor anyway).
function normaliseUser(row) {
  if (!row || typeof row !== 'object') return null;
  // Some list endpoints wrap the user under `data` (object form); the list-row
  // `data: [id, name, ...]` array form has no cuid, so it's not useful here.
  const u = row.data && !Array.isArray(row.data) ? row.data : row;

  const cuid = u.cuid || u.userCuid || u.user_cuid || null;
  if (!cuid) return null;

  const id = u.id ?? u.userId ?? u.user_id ?? null;
  const email = u.email || u.userEmail || u.user_email || null;
  const name = nameOf(u);

  return { cuid: String(cuid), id, name: name || null, email: email || null };
}

// Returns the cuid→user map, using the cache when fresh. Throws if the API call
// fails (callers decide how to degrade).
async function cuidMap({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cachedAt < TTL_MS) return _cache;

  const res = await api.listTenantUsers();
  const map = new Map();
  for (const row of rowsOf(res)) {
    const user = normaliseUser(row);
    if (user) map.set(user.cuid, user);
  }

  if (map.size === 0) {
    log.warn('Plextrac user enumeration returned no matchable users (cuid field missing?)', {
      hint: 'confirm the endpoint/shape with node scripts/inspect-users.js',
    });
  }

  _cache = map;
  _cachedAt = Date.now();
  return map;
}

// Finds the Plextrac user with the given email (case-insensitive), or null. Used to
// map a Slack user (resolved to their email) to their Plextrac cuid for /report-kpis
// @user lookups.
async function findByEmail(email) {
  if (!email) return null;
  const target = String(email).trim().toLowerCase();
  if (!target) return null;
  const map = await cuidMap();
  for (const user of map.values()) {
    if (user.email && user.email.toLowerCase() === target) return user;
  }
  return null;
}

// Best display label for a resolved user, or a graceful fallback for an unresolved
// cuid (e.g. a user who has since been removed from Plextrac).
function displayName(user, cuid) {
  if (user && user.name) return user.name;
  if (user && user.email) return user.email;
  const short = String(cuid || '').slice(0, 8);
  return `Unknown user (${short || 'unknown'})`;
}

module.exports = { cuidMap, findByEmail, displayName, normaliseUser, rowsOf };
