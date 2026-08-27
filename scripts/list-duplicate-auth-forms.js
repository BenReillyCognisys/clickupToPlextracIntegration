/**
 * Lists every auth-form link that is shared by more than one ClickUp task, and
 * which tasks carry it.
 *
 * Why this exists: the portal keys a form on clickupTaskId, but a remap (see
 * docs/portal-auth-form-remap-spec.md) or a hand-copied field can leave the same
 * form URL sitting in the "authformlink" custom field of several tasks. Those are
 * exactly the engagements where the client is asked to authorise the wrong task,
 * or where a signature lands on an abandoned duplicate.
 *
 * Read-only — it never writes to ClickUp.
 *
 * Run: node scripts/list-duplicate-auth-forms.js [options]
 *
 *   --space=<id>    scan this space only (repeatable). Defaults to
 *                   CLICKUP_SPACE_ID + CLICKUP_SECOPS_SPACE_ID when set.
 *   --closed        include closed tasks (default: open tasks only)
 *   --subtasks      include subtasks — walks every list in the space instead of
 *                   the faster team-tasks endpoint (default: top-level only)
 *   --exact         group links byte-for-byte instead of normalising the URL
 *                   (default: trailing slash / case / whitespace are ignored)
 *   --json          emit the result as JSON instead of a text report
 *
 * Required env: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, and at least one space id.
 */
require('dotenv').config();

const {
  listSpaceTasks,
  getSpaceListIds,
  listListTasks,
} = require('../lib/clickup-api');

// Same field (and same override) the create pipeline writes the link to — see
// pipeline/auth-form-create.js.
const AUTH_FORM_FIELD_NAME = process.env.CLICKUP_AUTH_FORM_FIELD_NAME || 'authformlink';

// ─── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { spaces: [], closed: false, subtasks: false, exact: false, json: false };
  for (const arg of argv) {
    const space = /^--space=(.+)$/.exec(arg);
    if (space) { opts.spaces.push(space[1].trim()); continue; }
    if (arg === '--closed') { opts.closed = true; continue; }
    if (arg === '--subtasks') { opts.subtasks = true; continue; }
    if (arg === '--exact') { opts.exact = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// Every space we scan: explicit --space wins, otherwise the two spaces the
// integration monitors (see config/monitored-spaces.js).
function resolveSpaceIds(opts) {
  if (opts.spaces.length) return [...new Set(opts.spaces)];
  const ids = [process.env.CLICKUP_SPACE_ID, process.env.CLICKUP_SECOPS_SPACE_ID]
    .map((id) => (id == null ? '' : String(id).trim()))
    .filter(Boolean);
  return [...new Set(ids)];
}

// ─── field reading ────────────────────────────────────────────────────────────

// The auth-form link as stored on the task, or null when the field is absent or
// unset. ClickUp returns url/short-text fields as plain strings.
function authFormLink(task) {
  const target = AUTH_FORM_FIELD_NAME.trim().toLowerCase();
  const field = (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target
  );
  const value = field ? field.value : null;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// Grouping key. Two tasks pointing at the same form via URLs that differ only by
// trailing slash, host case or stray whitespace are still duplicates, so fold
// those away unless --exact was asked for.
function linkKey(link, { exact }) {
  if (exact) return link;
  let key = link.trim().replace(/\/+$/, '');
  try {
    const url = new URL(key);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '');
    key = url.toString().replace(/\/+$/, '');
  } catch {
    // Not a URL (someone typed a note into the field) — fall back to the
    // whitespace/slash-trimmed string, lowercased so casing doesn't split it.
    key = key.toLowerCase();
  }
  return key;
}

// ─── fetching ─────────────────────────────────────────────────────────────────

// Top-level open (or closed too) tasks in a space via the team-tasks endpoint;
// with --subtasks, walks every list in the space so subtasks are covered.
async function fetchSpaceTasks(spaceId, opts) {
  if (!opts.subtasks) {
    return listSpaceTasks(spaceId, { includeClosed: opts.closed });
  }

  const listIds = await getSpaceListIds(spaceId);
  const byId = new Map(); // a task can surface under more than one list query
  for (const listId of listIds) {
    const tasks = await listListTasks(listId, { subtasks: true, includeClosed: opts.closed });
    for (const task of tasks) byId.set(task.id, task);
  }
  return [...byId.values()];
}

// ─── reporting ────────────────────────────────────────────────────────────────

function formatDate(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function taskSummary(task) {
  return {
    id: task.id,
    name: task.name,
    url: task.url || `https://app.clickup.com/t/${task.id}`,
    status: task.status?.status || null,
    list: task.list?.name || null,
    folder: task.folder?.name || null,
    space: task.space?.id || null,
    parent: task.parent || null,
    startDate: formatDate(task.start_date),
    dueDate: formatDate(task.due_date),
    assignees: (task.assignees || []).map((a) => a.username || a.email).filter(Boolean),
    link: authFormLink(task),
  };
}

// key -> { link, variants:Set, tasks:[] }, keeping only keys held by >1 task.
function findDuplicates(tasks, opts) {
  const groups = new Map();
  for (const task of tasks) {
    const link = authFormLink(task);
    if (!link) continue;
    const key = linkKey(link, opts);
    if (!groups.has(key)) groups.set(key, { link, variants: new Set(), tasks: [] });
    const group = groups.get(key);
    group.variants.add(link);
    group.tasks.push(taskSummary(task));
  }

  return [...groups.entries()]
    .filter(([, g]) => g.tasks.length > 1)
    .map(([key, g]) => ({
      link: g.link,
      key,
      variants: [...g.variants],
      count: g.tasks.length,
      tasks: g.tasks.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    // Worst offenders first, then stable by link.
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function printReport(duplicates, stats) {
  console.log('');
  console.log(`Scanned ${stats.taskCount} task(s) across ${stats.spaceCount} space(s); ` +
    `${stats.withLink} carry an "${AUTH_FORM_FIELD_NAME}" value.`);

  if (!duplicates.length) {
    console.log('\nNo duplicate auth-form links found.\n');
    return;
  }

  const affected = duplicates.reduce((n, d) => n + d.tasks.length, 0);
  console.log(`\n${duplicates.length} auth-form link(s) shared by ${affected} task(s):\n`);

  for (const dup of duplicates) {
    console.log(`${dup.link}   (${dup.count} tasks)`);
    if (dup.variants.length > 1) {
      console.log(`  stored as: ${dup.variants.join(' | ')}`);
    }
    for (const task of dup.tasks) {
      const bits = [
        task.status ? `status: ${task.status}` : null,
        task.list ? `list: ${task.list}` : null,
        task.startDate ? `start: ${task.startDate}` : null,
        task.assignees.length ? `assignees: ${task.assignees.join(', ')}` : 'unassigned',
        task.parent ? `subtask of ${task.parent}` : null,
      ].filter(Boolean);
      console.log(`  - ${task.name}  [${task.id}]`);
      console.log(`      ${task.url}`);
      console.log(`      ${bits.join(' · ')}`);
    }
    console.log('');
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.CLICKUP_API_TOKEN) {
    throw new Error('CLICKUP_API_TOKEN is not set — check your .env');
  }
  if (!opts.subtasks && !process.env.CLICKUP_TEAM_ID) {
    throw new Error('CLICKUP_TEAM_ID is not set — required to list space tasks');
  }

  const spaceIds = resolveSpaceIds(opts);
  if (!spaceIds.length) {
    throw new Error('No space to scan — set CLICKUP_SPACE_ID (and/or CLICKUP_SECOPS_SPACE_ID), or pass --space=<id>');
  }

  const tasks = [];
  const seen = new Set();
  for (const spaceId of spaceIds) {
    if (!opts.json) console.error(`[list-duplicate-auth-forms] scanning space ${spaceId}…`);
    for (const task of await fetchSpaceTasks(spaceId, opts)) {
      if (seen.has(task.id)) continue; // same space listed twice, or a shared task
      seen.add(task.id);
      tasks.push(task);
    }
  }

  const duplicates = findDuplicates(tasks, opts);
  const stats = {
    spaceCount: spaceIds.length,
    spaceIds,
    taskCount: tasks.length,
    withLink: tasks.filter((t) => authFormLink(t)).length,
    field: AUTH_FORM_FIELD_NAME,
    includeClosed: opts.closed,
    includeSubtasks: opts.subtasks,
  };

  if (opts.json) {
    console.log(JSON.stringify({ stats, duplicates }, null, 2));
  } else {
    printReport(duplicates, stats);
  }
})().catch((err) => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
