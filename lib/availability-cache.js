/**
 * ClickUp scheduling cache for the /schedule/pentest endpoint.
 *
 * Maintains an in-memory snapshot of consultant availability and the
 * service-types Doc table, refreshed in the background. The POST handler
 * reads from this cache to create a ClickUp engagement task.
 *
 * Ported from the sfe-portal availability API. Uses axios (matching the rest
 * of this codebase) and reads all configuration from environment variables.
 */

const axios = require('axios');

const CLICKUP_V2      = 'https://api.clickup.com/api/v2';
const CLICKUP_V3      = 'https://api.clickup.com/api/v3';
const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID;
const CLICKUP_VIEW_ID = process.env.CLICKUP_VIEW_ID;
const TIMEZONE        = process.env.CLICKUP_TIMEZONE          || 'Europe/London';
const WEEKS           = Number(process.env.CLICKUP_WEEKS)      || 4;
const INCLUDE_CLOSED  = process.env.CLICKUP_INCLUDE_CLOSED === 'true';
const ROSTER_FALLBACK = JSON.parse(process.env.CLICKUP_ROSTER_FALLBACK || '{}');
const REFRESH_MS      = Number(process.env.CLICKUP_REFRESH_INTERVAL_MS) || 2 * 60 * 1000;

// ClickUp task whose assignees form the internal-audit roster. Unlike pentest,
// internal-audit availability has no service-type/skill filtering — it searches
// purely on day count across the people assigned to this task.
const INTERNAL_AUDIT_TASK_ID = process.env.CLICKUP_INTERNAL_AUDIT_TASK_ID || '8cnj048-61655';

// ─── ClickUp HTTP helpers ─────────────────────────────────────────────────────

function authHeaders() {
  return { Authorization: process.env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
}

async function clickupGet(base, path, params) {
  let url = `${base}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of params) qs.append(k, v);
    url += `?${qs.toString()}`;
  }
  try {
    const { data } = await axios.get(url, { headers: authHeaders() });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const body = typeof err.response?.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response?.data ?? err.message);
    throw new Error(`ClickUp ${status} GET ${path}: ${String(body).slice(0, 300)}`);
  }
}

async function clickupPost(path, body) {
  try {
    const { data } = await axios.post(`${CLICKUP_V2}${path}`, body, { headers: authHeaders() });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const txt = typeof err.response?.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response?.data ?? err.message);
    throw new Error(`ClickUp ${status} POST ${path}: ${String(txt).slice(0, 400)}`);
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const ymdFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

const msToYMD      = (ms)  => ymdFmt.format(new Date(Number(ms)));
const ymdToUTC     = (ymd) => new Date(`${ymd}T00:00:00Z`);
const addDays      = (d, n) => new Date(d.getTime() + n * 86400000);
const utcToYMD     = (d)   => d.toISOString().slice(0, 10);
const ymdToUnixMs  = (ymd) => Date.parse(`${ymd}T00:00:00Z`);

const hasTime         = (f) => f === true || f === 'true';
const roundMsToUTCYMD = (ms) => utcToYMD(new Date(Math.round(Number(ms) / 86400000) * 86400000));
const fieldYMD        = (ms, flag) => ms == null ? null : hasTime(flag) ? msToYMD(ms) : roundMsToUTCYMD(ms);
const startYMDof      = (t) => fieldYMD(t.start_date, t.start_date_time);
const dueYMDof        = (t) => fieldYMD(t.due_date,   t.due_date_time);

function dateRange(startYMD, endYMD) {
  const out = [];
  let cur = ymdToUTC(startYMD);
  const end = ymdToUTC(endYMD);
  for (let i = 0; cur <= end && i < 366; i++) {
    out.push(utcToYMD(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

// ─── Members + roster ─────────────────────────────────────────────────────────

async function getMembersMap() {
  const data = await clickupGet(CLICKUP_V2, '/team');
  const team = (data.teams || []).find((t) => String(t.id) === CLICKUP_TEAM_ID) || (data.teams || [])[0];
  const map = {};
  for (const m of (team?.members || [])) {
    const u = m.user || {};
    map[String(u.id)] = {
      id:    Number(u.id),
      name:  u.username || u.email || `User ${u.id}`,
      email: u.email    || null,
    };
  }
  return map;
}

function findAssigneeValues(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.field === 'assignee' && Array.isArray(node.values)) return node.values;
  for (const v of Object.values(node)) {
    const hit = findAssigneeValues(v);
    if (hit && hit.length) return hit;
  }
  return null;
}

async function getRoster(membersMap) {
  const data = await clickupGet(CLICKUP_V2, `/view/${CLICKUP_VIEW_ID}`);
  const sidebar = data.view?.team_sidebar || {};
  let ids = (sidebar.assignees || []).map(String);
  if (!ids.length) ids = (findAssigneeValues(data.view) || []).map(String);

  if (!ids.length) {
    if (Object.keys(ROSTER_FALLBACK).length) {
      return Object.fromEntries(
        Object.entries(ROSTER_FALLBACK).map(([id, n]) => [String(id), n])
      );
    }
    throw new Error(
      'Couldn\'t find the consultant list on the view. Set CLICKUP_ROSTER_FALLBACK in .env.'
    );
  }

  const roster = {};
  for (const id of ids) {
    roster[String(id)] = membersMap[String(id)]?.name || `User ${id}`;
  }
  return roster;
}

async function getTasks(rosterIds) {
  const MAX_PAGES = 50;
  const byId = new Map();
  for (const assignee of rosterIds) {
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      const params = [
        ['page',           String(page)],
        ['include_closed', String(INCLUDE_CLOSED)],
        ['subtasks',       'true'],
        ['assignees[]',    assignee],
      ];
      const data  = await clickupGet(CLICKUP_V2, `/team/${CLICKUP_TEAM_ID}/task`, params);
      const batch = data.tasks || [];
      for (const t of batch) byId.set(t.id, t);
      if (batch.length === 0 || data.last_page === true) break;
    }
    if (page >= MAX_PAGES) {
      console.warn(`[cache] hit ${MAX_PAGES}-page cap for assignee ${assignee}; some tasks may be missing`);
    }
  }
  return [...byId.values()];
}

// ─── Availability computation ─────────────────────────────────────────────────

// Computes busy/free days over the scheduling window for an arbitrary roster
// ({ userId: name }). Shared by both the pentest (view-backed) and internal-audit
// (task-backed) availability fetchers — only the roster source differs.
async function computeAvailability(roster, membersMap) {
  const todayYMD       = ymdFmt.format(new Date());
  const today          = ymdToUTC(todayYMD);
  const offsetToMonday = (today.getUTCDay() + 6) % 7;
  const firstMonday    = addDays(today, -offsetToMonday);

  const weeks      = [];
  const windowDays = new Set();
  for (let w = 0; w < WEEKS; w++) {
    const wdays = [];
    for (let d = 0; d < 5; d++) {
      const ymd = utcToYMD(addDays(firstMonday, w * 7 + d));
      wdays.push(ymd);
      windowDays.add(ymd);
    }
    weeks.push(wdays);
  }

  const rosterIds   = Object.keys(roster);
  const rosterNames = [...new Set(Object.values(roster))];
  const tasks       = await getTasks(rosterIds);

  const busy = {};
  for (const ymd of windowDays) busy[ymd] = new Set();

  for (const task of tasks) {
    const names = (task.assignees || []).map((a) => roster[String(a.id)]).filter(Boolean);
    if (!names.length) continue;
    const hasDue   = task.due_date   != null;
    const hasStart = task.start_date != null;
    if (!hasDue && !hasStart) continue;
    const days = hasDue && hasStart
      ? dateRange(startYMDof(task), dueYMDof(task))
      : hasDue  ? [dueYMDof(task)]
      :           [startYMDof(task)];
    for (const ymd of days) {
      if (busy[ymd]) for (const n of names) busy[ymd].add(n);
    }
  }

  rosterNames.sort((a, b) => a.localeCompare(b));
  const weekdayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'long' });
  const weekdayOf  = (ymd) => weekdayFmt.format(ymdToUTC(ymd));

  const daysOut = [];
  for (const wdays of weeks) {
    const weekOf = wdays[0];
    for (const ymd of wdays) {
      // Only surface future start dates — hide today and anything earlier.
      if (ymd <= todayYMD) continue;
      daysOut.push({
        date:      ymd,
        weekday:   weekdayOf(ymd),
        week_of:   weekOf,
        available: rosterNames.filter((n) => !busy[ymd].has(n)),
        busy:      rosterNames.filter((n) =>  busy[ymd].has(n)),
      });
    }
  }

  const lastWeek = weeks[weeks.length - 1];
  return {
    generated_at: new Date().toISOString(),
    timezone:     TIMEZONE,
    window: {
      start: weeks[0][0],
      end:   lastWeek[lastWeek.length - 1],
      weeks: WEEKS,
    },
    roster:     rosterNames,
    days:       daysOut,
    membersMap,
  };
}

// Pentest roster comes from the team view sidebar.
async function fetchAvailability(membersMap) {
  if (!membersMap) membersMap = await getMembersMap();
  const roster = await getRoster(membersMap);
  return computeAvailability(roster, membersMap);
}

// Internal-audit roster is the set of assignees on INTERNAL_AUDIT_TASK_ID.
async function getInternalAuditRoster(membersMap) {
  if (!CLICKUP_TEAM_ID) throw new Error('CLICKUP_TEAM_ID is not set in .env');

  // 8cnj048-61655 is a custom task id, so try the custom-id lookup first and fall
  // back to a native-id lookup if the workspace doesn't use custom ids.
  let task;
  try {
    task = await clickupGet(CLICKUP_V2, `/task/${INTERNAL_AUDIT_TASK_ID}`,
      [['custom_task_ids', 'true'], ['team_id', CLICKUP_TEAM_ID]]);
  } catch (err) {
    task = await clickupGet(CLICKUP_V2, `/task/${INTERNAL_AUDIT_TASK_ID}`);
  }

  const ids = (task.assignees || []).map((a) => String(a.id));
  if (!ids.length) {
    throw new Error(`Internal-audit task ${INTERNAL_AUDIT_TASK_ID} has no assignees to use as the roster`);
  }
  const roster = {};
  for (const id of ids) roster[id] = membersMap[id]?.name || `User ${id}`;
  return roster;
}

async function fetchInternalAuditAvailability(membersMap) {
  if (!membersMap) membersMap = await getMembersMap();
  const roster = await getInternalAuditRoster(membersMap);
  return computeAvailability(roster, membersMap);
}

// ─── Service types ────────────────────────────────────────────────────────────

const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const SEPARATOR_RE  = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let buf = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') { buf += '|'; i++; continue; }
    if (ch === '|') { cells.push(buf); buf = ''; continue; }
    buf += ch;
  }
  cells.push(buf);
  return cells.map((c) => c.trim());
}

function findTables(markdown) {
  const lines  = markdown.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE_LINE_RE.test(lines[i])) continue;
    if (i + 1 >= lines.length || !SEPARATOR_RE.test(lines[i + 1])) continue;
    const headers = splitRow(lines[i]);
    const rows    = [];
    let j = i + 2;
    while (j < lines.length && TABLE_LINE_RE.test(lines[j])) { rows.push(splitRow(lines[j])); j++; }
    tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

function normalizeHeader(h) {
  return (h || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g,     '$1')
    .replace(/_([^_]+)_/g,       '$1')
    .trim().toLowerCase();
}

function pickServiceTypeTable(tables) {
  const want = ['service type', 'indep'];
  for (const t of tables) {
    const norm = t.headers.map(normalizeHeader);
    if (want.every((w) => norm.some((h) => h.includes(w)))) return t;
  }
  return tables.find((t) => t.headers.length >= 2) || null;
}

function splitConsultants(cell) {
  if (!cell) return [];
  let s = cell.replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n');
  s = s.replace(/^\s*[-*]\s+/gm, '');
  const parts = s.split(/\n|,|;| and | & /i);
  const out = []; const seen = new Set();
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    p = p.replace(/^@/, '').replace(/^[*_]+|[*_]+$/g, '').replace(/[.;:,]+$/, '').trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function columnIndex(headers, needle) {
  const want = needle.toLowerCase();
  return headers.findIndex((h) => normalizeHeader(h).includes(want));
}

async function fetchServiceTypes() {
  const docId  = process.env.CLICKUP_SERVICE_TYPES_DOC_ID;
  const pageId = process.env.CLICKUP_SERVICE_TYPES_PAGE_ID;
  if (!CLICKUP_TEAM_ID || !docId || !pageId) {
    throw new Error('Missing CLICKUP_TEAM_ID / CLICKUP_SERVICE_TYPES_DOC_ID / CLICKUP_SERVICE_TYPES_PAGE_ID in .env');
  }

  const page = await clickupGet(
    CLICKUP_V3,
    `/workspaces/${CLICKUP_TEAM_ID}/docs/${docId}/pages/${pageId}`,
    [['content_format', 'text/md']]
  );

  const markdown = page.content ?? page.markdown ?? page.body ?? page.page?.content ?? '';
  if (!markdown) throw new Error('ClickUp Doc page returned no markdown content');

  const tables = findTables(markdown);
  if (!tables.length) throw new Error('No markdown tables found on the service-types Doc page');

  const table = pickServiceTypeTable(tables);
  if (!table) throw new Error("No table with 'Service Type' + 'Independent' columns found");

  const serviceCol = columnIndex(table.headers, 'service type');
  const indepCol   = columnIndex(table.headers, 'indep');
  if (serviceCol < 0 || indepCol < 0) {
    throw new Error(`Could not locate columns in table. Headers: ${JSON.stringify(table.headers)}`);
  }

  const serviceTypes = [];
  for (const row of table.rows) {
    const name = (row[serviceCol] || '')
      .replace(/<br\s*\/?>/gi, ' ').replace(/\\n/g, ' ').replace(/\s+/g, ' ')
      .replace(/^\*\*(.*)\*\*$/, '$1').trim();
    if (!name) continue;
    serviceTypes.push({ service_type: name, independent: splitConsultants(row[indepCol] || '') });
  }

  return { generated_at: new Date().toISOString(), service_types: serviceTypes };
}

// ─── Name resolution ──────────────────────────────────────────────────────────

function tokens(name) {
  return name.toLowerCase().split(/\s+/).filter(Boolean);
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const at = tokens(a); const bt = tokens(b);
  if (at.length < 2 || bt.length < 2) return false;
  if (at[at.length - 1] !== bt[bt.length - 1]) return false;
  const af = at[0]; const bf = bt[0];
  if (Math.min(af.length, bf.length) < 3) return false;
  return af.startsWith(bf) || bf.startsWith(af);
}

function resolveNames(qualifiedFromDoc, rosterFromAvailability) {
  const matched = []; const unmatched = []; const resolved = [];
  for (const docName of qualifiedFromDoc) {
    const exact = rosterFromAvailability.find((r) => r.toLowerCase() === docName.toLowerCase());
    if (exact) { matched.push({ service_type_name: docName, roster_name: exact }); resolved.push(exact); continue; }
    const fuzzy = rosterFromAvailability.filter((r) => namesMatch(r, docName));
    if (fuzzy.length === 1) { matched.push({ service_type_name: docName, roster_name: fuzzy[0] }); resolved.push(fuzzy[0]); }
    else unmatched.push(docName);
  }
  return { matched, unmatched, resolved };
}

// ─── Slot finding ─────────────────────────────────────────────────────────────

function earliestRun(days, consultant, N) {
  let start = -1; let len = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i].available.includes(consultant)) {
      if (len === 0) start = i;
      if (++len >= N) {
        const slice = days.slice(start, start + N);
        return { consultant, start_date: slice[0].date, end_date: slice[slice.length - 1].date, days: slice.map((d) => d.date) };
      }
    } else { start = -1; len = 0; }
  }
  return null;
}

// ─── Service type matching ────────────────────────────────────────────────────

function matchServiceType(query, serviceTypesPayload) {
  const q   = query.toLowerCase();
  const all = serviceTypesPayload.service_types || [];
  const exact = all.filter((s) => s.service_type.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], all };
  const subs  = all.filter((s) => s.service_type.toLowerCase().includes(q));
  if (subs.length === 1) return { match: subs[0], all };
  if (subs.length > 1)  return { ambiguous: subs.map((s) => s.service_type), all };
  return { none: true, all };
}

// ─── Task creation ────────────────────────────────────────────────────────────

function findUserInMap(identifier, membersMap) {
  if (!identifier) return null;
  const needle = identifier.toLowerCase();
  let partial = null;
  for (const m of Object.values(membersMap)) {
    const uname = (m.name  || '').toLowerCase();
    const email = (m.email || '').toLowerCase();
    if (uname === needle || email === needle) return m.id;
    if (!partial && (uname.includes(needle) || email.includes(needle))) partial = m;
  }
  return partial ? partial.id : null;
}

function findFieldByName(fields, wantedName) {
  if (!wantedName) return null;
  const want  = wantedName.toLowerCase();
  const exact = fields.filter((f) => (f.name || '').toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const subs  = fields.filter((f) => (f.name || '').toLowerCase().includes(want));
  return subs.length === 1 ? subs[0] : null;
}

async function createEngagementTask({ consultant, startDate, endDate, serviceType, days, customerName, email, membersMap, clickupCustomFields }) {
  const listId = process.env.CLICKUP_ENGAGEMENT_LIST_ID;
  if (!listId) throw new Error('CLICKUP_ENGAGEMENT_LIST_ID is not set in .env');

  const assigneeId = findUserInMap(consultant, membersMap);
  if (assigneeId == null) {
    throw new Error(`Could not resolve consultant "${consultant}" to a ClickUp user`);
  }

  const fields = (await clickupGet(CLICKUP_V2, `/list/${listId}/field`)).fields || [];

  const daysFieldName    = process.env.CLICKUP_DAYS_FIELD_NAME;
  const revenueFieldName = process.env.CLICKUP_REVENUE_FIELD_NAME;
  const daysField    = findFieldByName(fields, daysFieldName);
  const revenueField = findFieldByName(fields, revenueFieldName);
  const missing = [];
  if (!daysField)    missing.push(`"${daysFieldName}"`);
  if (!revenueField) missing.push(`"${revenueFieldName}"`);
  if (missing.length) {
    const available = fields.map((f) => `${f.name} (${f.type})`).join(', ');
    throw new Error(`Custom field(s) ${missing.join(', ')} not found on list ${listId}. Available: ${available || '(none)'}`);
  }

  const taskName = customerName ? `${customerName} | ${serviceType}` : serviceType;

  const cf        = clickupCustomFields || {};
  const daysValue = Number(cf.Days) || 0;
  const rValue    = Number(cf.R)    || 0;

  const body = {
    name:             taskName,
    assignees:        [assigneeId],
    start_date:       ymdToUnixMs(startDate),
    start_date_time:  false,
    due_date:         ymdToUnixMs(endDate),
    due_date_time:    false,
    custom_fields: [
      { id: daysField.id,    value: daysValue },
      { id: revenueField.id, value: rValue },
    ],
  };

  const defaultStatus = process.env.CLICKUP_DEFAULT_STATUS;
  if (defaultStatus) body.status = defaultStatus;

  const descLines = [];
  if (customerName) descLines.push(`Customer: ${customerName}`);
  if (email)        descLines.push(`Email: ${email}`);
  if (descLines.length) body.description = descLines.join('\n');

  const created = await clickupPost(`/list/${listId}/task`, body);
  return {
    id:            created.id,
    name:          created.name,
    url:           created.url,
    assignee_id:   assigneeId,
    assignee_name: consultant,
    start_date:    startDate,
    due_date:      endDate,
    status:        created.status?.status ?? null,
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = {
  availability:       null,
  serviceTypes:       null,
  internalAudit:      null,
  internalAuditError: null,
  lastRefresh:        null,
  refreshError:       null,
  refreshing:         false,
};

async function refreshCache() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  try {
    const membersMap = await getMembersMap();
    const [availability, serviceTypes] = await Promise.all([
      fetchAvailability(membersMap),
      fetchServiceTypes(),
    ]);
    cache.availability = availability;
    cache.serviceTypes = serviceTypes;
    cache.lastRefresh  = new Date().toISOString();
    cache.refreshError = null;
    console.log(`[cache] refreshed at ${cache.lastRefresh}`);

    // Internal-audit availability is independent of the pentest data; isolate its
    // failures so a bad task id can't take down /availability/pentest.
    try {
      cache.internalAudit      = await fetchInternalAuditAvailability(membersMap);
      cache.internalAuditError = null;
    } catch (err) {
      cache.internalAuditError = err.message;
      console.error(`[cache] internal-audit refresh failed: ${err.message}`);
    }
  } catch (err) {
    cache.refreshError = err.message;
    console.error(`[cache] refresh failed: ${err.message}`);
  } finally {
    cache.refreshing = false;
  }
}

// Warm the cache immediately, then refresh on a recurring interval. No-op (with a
// warning) when CLICKUP_API_TOKEN is missing, so the rest of the server still boots.
function startAvailabilityCache() {
  if (!process.env.CLICKUP_API_TOKEN) {
    console.warn('CLICKUP_API_TOKEN not set; /schedule/pentest availability cache is disabled');
    return;
  }
  console.log(`[cache] availability refresh every ${REFRESH_MS / 1000}s`);
  refreshCache();
  setInterval(refreshCache, REFRESH_MS);
}

// ─── Route middleware ─────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.AVAILABILITY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}

function requireCache(req, res, next) {
  if (!cache.availability || !cache.serviceTypes) {
    return res.status(503).json({
      error:       'Service unavailable: cache not yet populated',
      cache_error: cache.refreshError,
      retryable:   true,
    });
  }
  next();
}

function requireInternalAuditCache(req, res, next) {
  if (!cache.internalAudit) {
    return res.status(503).json({
      error:       'Service unavailable: internal-audit availability cache not yet populated',
      cache_error: cache.internalAuditError || cache.refreshError,
      retryable:   true,
    });
  }
  next();
}

module.exports = {
  cache,
  refreshCache,
  startAvailabilityCache,
  matchServiceType,
  resolveNames,
  earliestRun,
  createEngagementTask,
  requireApiKey,
  requireCache,
  requireInternalAuditCache,
};
