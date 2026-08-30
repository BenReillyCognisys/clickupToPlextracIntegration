/**
 * One-off backfill: gives every August engagement the client test-files upload link
 * that the create pipeline now mints for it.
 *
 * Why this exists: the test-files link (pipeline/auth-form-create.js, phase 4) was
 * added after a lot of the current work was already in ClickUp. Those tasks have an
 * empty "testfilesstorage" field, so there is nowhere for the client to send us the
 * files the engagement needs. This walks the Penetration Test space, finds the tasks
 * that START or END in the target month and have no link, and — with --create —
 * asks the SFE portal for each one and writes the result back to ClickUp. That is
 * exactly what a taskCreated event would have done, minus the Plextrac client and
 * report (those already exist for these tasks).
 *
 * Default is a DRY RUN: it prints the tasks that are missing a link and touches
 * nothing. Add --create to actually mint and write them.
 *
 * The portal endpoint is idempotent on clickupTaskId (one link for the life of the
 * task), so a re-run is safe — but tasks that already carry a link are skipped
 * before the portal is called at all.
 *
 * Run: node scripts/backfill-test-files-links.js [options]
 *
 *   --create           actually create the links on SFE and write them to ClickUp
 *                      (without it, nothing is created and nothing is written)
 *   --month=<m>        month to backfill: 8, "august", or "2026-08". Default: august
 *   --year=<yyyy>      year for a bare --month. Default: the current year
 *   --space=<id>       scan this space only (repeatable). Default: CLICKUP_SPACE_ID
 *   --closed           include closed tasks (default: open tasks only)
 *   --include-unknown  also do tasks whose testing type can't be parsed from the
 *                      name (default: reported and skipped, as the pipeline does)
 *   --limit=<n>        stop after creating n links — for a cautious first run
 *   --delay=<ms>       pause between portal calls (default 300)
 *   --json             emit the result as JSON instead of a text report
 *
 * Required env: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CLICKUP_SPACE_ID.
 * --create additionally needs SECURE_PORTAL_URL and BREAK_SERVICES_API_KEY.
 */
// quiet: the loader's banner goes to stdout, which would corrupt --json output.
require('dotenv').config({ quiet: true });

const { listSpaceTasks } = require('../lib/clickup-api');
const { ensureTestFilesLinkForTask } = require('../pipeline/auth-form-create');
const { parseTaskName } = require('../pipeline/parse-task');
const { isPlaceholderTaskName } = require('../config/placeholder-task-names');

// Same field name (and same override) the create pipeline writes the link to —
// see pipeline/auth-form-create.js. The type list matters: "testfilesstorage" has
// also been used as the name of the checkbox the portal ticks on upload, and a URL
// must never be written into that.
const TEST_FILES_FIELD_NAME = process.env.CLICKUP_TEST_FILES_LINK_FIELD_NAME || 'testfilesstorage';
const LINK_FIELD_TYPES = ['short_text', 'text', 'url'];

// Timezone the month window is judged in — a task starting at 00:30 on 1 September
// London time is a September task, not an August one. Kept in step with the other
// date-aware jobs (see pipeline/auth-form-check.js).
const TZ = process.env.BACKFILL_TZ || process.env.AUTH_FORM_CHECK_TZ || 'Europe/London';

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// ─── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    create: false, month: null, year: null, spaces: [],
    closed: false, includeUnknown: false, limit: null, delay: 300, json: false,
  };
  for (const arg of argv) {
    const kv = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (kv) {
      const [, key, value] = kv;
      if (key === 'month') { opts.month = value.trim(); continue; }
      if (key === 'year') { opts.year = requireInt(value, '--year'); continue; }
      if (key === 'space') { opts.spaces.push(value.trim()); continue; }
      if (key === 'limit') { opts.limit = requireInt(value, '--limit'); continue; }
      if (key === 'delay') { opts.delay = requireInt(value, '--delay'); continue; }
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (arg === '--create') { opts.create = true; continue; }
    if (arg === '--closed') { opts.closed = true; continue; }
    if (arg === '--include-unknown') { opts.includeUnknown = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function requireInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} must be a whole number, got "${value}"`);
  return n;
}

// The "YYYY-MM" the scan is for. Accepts --month=8, --month=august, --month=2026-08
// (in which case --year is redundant), defaulting to August of the current year.
function resolveMonthKey(opts) {
  const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' })
    .format(new Date()));

  const raw = (opts.month || 'august').toLowerCase();

  const full = /^(\d{4})-(\d{1,2})$/.exec(raw);
  if (full) {
    const month = Number(full[2]);
    if (month < 1 || month > 12) throw new Error(`--month has no month ${month}`);
    return `${full[1]}-${String(month).padStart(2, '0')}`;
  }

  let month;
  if (/^\d{1,2}$/.test(raw)) {
    month = Number(raw);
    if (month < 1 || month > 12) throw new Error(`--month must be 1-12, got "${opts.month}"`);
  } else {
    const index = MONTH_NAMES.findIndex((m) => m.startsWith(raw));
    if (index === -1) throw new Error(`--month is not a month name: "${opts.month}"`);
    month = index + 1;
  }

  return `${opts.year ?? thisYear}-${String(month).padStart(2, '0')}`;
}

// Explicit --space wins; otherwise the Penetration Test space, which is the only
// one whose pipeline mints test-files links (SecOps/VMaaS has its own flow, see
// config/monitored-spaces.js).
function resolveSpaceIds(opts) {
  if (opts.spaces.length) return [...new Set(opts.spaces)];
  const id = (process.env.CLICKUP_SPACE_ID || '').trim();
  return id ? [id] : [];
}

// ─── task fields ──────────────────────────────────────────────────────────────

// "2026-08" for a ClickUp date (epoch ms as a string or number), in TZ. Null when
// the task has no usable date.
function monthKeyOf(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' })
    .format(d);
}

function formatDate(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
}

// The link field as it sits on the task: { present, value }. `present: false` means
// the field isn't on the task's list at all, so there is nowhere to write the link
// even though the portal would happily mint one.
function testFilesField(task) {
  const target = TEST_FILES_FIELD_NAME.trim().toLowerCase();
  const field = (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target && LINK_FIELD_TYPES.includes(f.type)
  );
  if (!field) return { present: false, value: null };
  const value = field.value === null || field.value === undefined ? '' : String(field.value).trim();
  return { present: true, value: value === '' ? null : value };
}

function taskSummary(task) {
  const { present, value } = testFilesField(task);
  const { client_name, testing_type } = parseTaskName(task.name);
  return {
    id: task.id,
    name: task.name,
    url: task.url || `https://app.clickup.com/t/${task.id}`,
    client: client_name,
    testingType: testing_type,
    status: task.status?.status || null,
    list: task.list?.name || null,
    startDate: formatDate(task.start_date),
    dueDate: formatDate(task.due_date),
    fieldPresent: present,
    link: value,
  };
}

// ─── selection ────────────────────────────────────────────────────────────────

// A task is in the window when it STARTS or ENDS in the target month — a project
// running 28 July → 4 August is an August project, and so is one running
// 30 August → 6 September.
function inMonth(task, monthKey) {
  return monthKeyOf(task.start_date) === monthKey || monthKeyOf(task.due_date) === monthKey;
}

/**
 * Splits the month's tasks into what the backfill will do with them:
 *   missing     — no link, field is there to write it into: these get created
 *   haveLink    — already carry a link: skipped before the portal is called
 *   placeholder — still on a template name, not a real project yet
 *   unknownType — the testing type can't be parsed from the name. The space holds
 *                 plenty of non-engagement tasks ("Annual Leave", "Sick Leave",
 *                 bank-of-days tracking) alongside real work whose name doesn't
 *                 name a service ("DealsPlus | Retest"), and the client name we'd
 *                 send the portal for those is whatever the name happens to start
 *                 with. The create pipeline aborts on Unknown (pipeline/index.js
 *                 phase 1), so by default this does too — pass --include-unknown
 *                 once you've read the list and want them anyway.
 *   fieldless   — no link and no field on the task: reported, never touched, since
 *                 a minted link would be invisible to everyone
 */
function classify(tasks, monthKey, { includeUnknown = false } = {}) {
  const buckets = { missing: [], fieldless: [], haveLink: [], placeholder: [], unknownType: [] };
  for (const task of tasks) {
    if (!inMonth(task, monthKey)) continue;
    const summary = taskSummary(task);
    if (isPlaceholderTaskName(task.name)) buckets.placeholder.push(summary);
    else if (summary.link) buckets.haveLink.push(summary);
    else if (summary.testingType === 'Unknown' && !includeUnknown) buckets.unknownType.push(summary);
    else if (!summary.fieldPresent) buckets.fieldless.push(summary);
    else buckets.missing.push(summary);
  }
  const byDate = (a, b) => (a.startDate || '9999').localeCompare(b.startDate || '9999')
    || a.name.localeCompare(b.name);
  for (const key of Object.keys(buckets)) buckets[key].sort(byDate);
  return buckets;
}

// ─── creating ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mints the portal link for each missing task and writes it to ClickUp, one at a
 * time. This is the same call the create pipeline makes, so the portal sees exactly
 * what a real taskCreated would have produced.
 *
 * Never throws: a task the portal or ClickUp refuses is recorded as failed and the
 * run carries on, so one bad task can't strand the rest of the backfill.
 */
async function createLinks(missing, byId, opts) {
  const results = [];
  const targets = opts.limit === null ? missing : missing.slice(0, opts.limit);

  for (const [index, summary] of targets.entries()) {
    if (index > 0 && opts.delay > 0) await sleep(opts.delay);

    if (!opts.json) {
      console.log(`  [${index + 1}/${targets.length}] ${summary.name} [${summary.id}] …`);
    }

    let link = null;
    let error = null;
    try {
      link = await ensureTestFilesLinkForTask(byId.get(summary.id), { clientName: summary.client });
    } catch (err) {
      // ensureTestFilesLinkForTask swallows its own failures, but a programming
      // error (or an env var it can't see) would still surface here.
      error = err.message;
    }

    results.push({ ...summary, created: Boolean(link), link: link || null, error });
    if (!opts.json) {
      console.log(link
        ? `        → ${link}`
        : `        → FAILED${error ? `: ${error}` : ' (see the log lines above)'}`);
    }
  }

  const skipped = missing.length - targets.length;
  return { results, skipped };
}

// ─── reporting ────────────────────────────────────────────────────────────────

function printTasks(heading, tasks, { showLink = false } = {}) {
  if (!tasks.length) return;
  console.log(`${heading} (${tasks.length}):\n`);
  for (const t of tasks) {
    const bits = [
      `start: ${t.startDate || '—'}`,
      `due: ${t.dueDate || '—'}`,
      t.status ? `status: ${t.status}` : null,
      t.list ? `list: ${t.list}` : null,
      `type: ${t.testingType}`,
    ].filter(Boolean);
    console.log(`  - ${t.name}  [${t.id}]`);
    console.log(`      ${t.url}`);
    console.log(`      ${bits.join(' · ')}`);
    if (showLink && t.link) console.log(`      link: ${t.link}`);
  }
  console.log('');
}

function printDryRun(buckets, stats) {
  console.log('');
  console.log(`Scanned ${stats.taskCount} task(s) across ${stats.spaceIds.length} space(s) ` +
    `(${stats.includeClosed ? 'open + closed' : 'open only'}); ` +
    `${stats.inMonth} start or end in ${stats.monthLabel} (${TZ}).`);
  console.log('');

  printTasks(`MISSING a "${TEST_FILES_FIELD_NAME}" link — these are what --create would do`, buckets.missing);
  printTasks('Testing type unrecognised — skipped, as the create pipeline does. Re-run with '
    + '--include-unknown if these should be done anyway', buckets.unknownType);
  printTasks(`No "${TEST_FILES_FIELD_NAME}" field on the task — skipped, the link would be invisible`, buckets.fieldless);
  printTasks('Already have a link — skipped', buckets.haveLink, { showLink: true });
  printTasks('Template placeholder names — not real projects yet, skipped', buckets.placeholder);

  console.log(`Summary: ${buckets.missing.length} to create · ${buckets.haveLink.length} already done · ` +
    `${buckets.unknownType.length} unrecognised type · ${buckets.fieldless.length} without the field · ` +
    `${buckets.placeholder.length} placeholder(s).`);
  console.log(buckets.missing.length
    ? '\nDry run — nothing was created. Re-run with --create to mint these links and write them to ClickUp.\n'
    : '\nNothing to backfill.\n');
}

function printCreateRun({ results, skipped }, buckets) {
  const created = results.filter((r) => r.created);
  const failed = results.filter((r) => !r.created);

  console.log('');
  console.log(`Created ${created.length} link(s); ${failed.length} failed.`);
  if (skipped) console.log(`${skipped} task(s) left untouched by --limit.`);
  console.log('');

  if (created.length) {
    console.log('Created:\n');
    for (const r of created) console.log(`  ✓ ${r.name}  [${r.id}]\n      ${r.link}`);
    console.log('');
  }
  if (failed.length) {
    console.log('Failed — re-run to retry (the portal is idempotent, so nothing is duplicated):\n');
    for (const r of failed) console.log(`  ✗ ${r.name}  [${r.id}]${r.error ? `\n      ${r.error}` : ''}`);
    console.log('');
  }
  if (buckets.fieldless.length) {
    console.log(`${buckets.fieldless.length} task(s) have no "${TEST_FILES_FIELD_NAME}" field and were not ` +
      'touched — add the field to their list, then re-run.\n');
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const monthKey = resolveMonthKey(opts);
  const monthName = MONTH_NAMES[Number(monthKey.slice(5)) - 1];
  const monthLabel = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${monthKey.slice(0, 4)}`;

  if (!process.env.CLICKUP_API_TOKEN) {
    throw new Error('CLICKUP_API_TOKEN is not set — check your .env');
  }
  if (!process.env.CLICKUP_TEAM_ID) {
    throw new Error('CLICKUP_TEAM_ID is not set — required to list space tasks');
  }
  // Checked up front rather than per task: a --create run with no portal configured
  // would otherwise log a warning for every task and create nothing.
  if (opts.create) {
    for (const key of ['SECURE_PORTAL_URL', 'BREAK_SERVICES_API_KEY']) {
      if (!process.env[key]) throw new Error(`${key} is not set — required for --create`);
    }
  }

  const spaceIds = resolveSpaceIds(opts);
  if (!spaceIds.length) {
    throw new Error('No space to scan — set CLICKUP_SPACE_ID, or pass --space=<id>');
  }

  const byId = new Map(); // task id -> raw task, for the create call
  for (const spaceId of spaceIds) {
    if (!opts.json) console.error(`[backfill-test-files-links] scanning space ${spaceId}…`);
    for (const task of await listSpaceTasks(spaceId, { includeClosed: opts.closed })) {
      byId.set(task.id, task); // a shared task can surface under more than one space
    }
  }

  const tasks = [...byId.values()];
  const buckets = classify(tasks, monthKey, { includeUnknown: opts.includeUnknown });
  const stats = {
    monthKey,
    monthLabel,
    timezone: TZ,
    spaceIds,
    taskCount: tasks.length,
    includeClosed: opts.closed,
    field: TEST_FILES_FIELD_NAME,
    includeUnknown: opts.includeUnknown,
    inMonth: Object.values(buckets).reduce((n, list) => n + list.length, 0),
  };

  if (!opts.create || !buckets.missing.length) {
    if (opts.json) {
      console.log(JSON.stringify({ mode: opts.create ? 'create' : 'dry-run', stats, buckets, results: [] }, null, 2));
    } else {
      printDryRun(buckets, stats);
    }
    return;
  }

  if (!opts.json) {
    console.log(`\nCreating test-files links for ${buckets.missing.length} task(s) in ${monthLabel}…\n`);
  }
  const outcome = await createLinks(buckets.missing, byId, opts);

  if (opts.json) {
    console.log(JSON.stringify({ mode: 'create', stats, buckets, ...outcome }, null, 2));
  } else {
    printCreateRun(outcome, buckets);
  }

  if (outcome.results.some((r) => !r.created)) process.exitCode = 1;
})().catch((err) => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
