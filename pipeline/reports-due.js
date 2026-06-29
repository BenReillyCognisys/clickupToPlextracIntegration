// Weekly "reports due this week" check (Pentesting space).
//
// Scans every task in the Pentesting space (CLICKUP_SPACE_ID) and works out each
// report's deadline as the task's DUE DATE + EXTERNAL_SLA business days. It then
// posts ONE Slack message to SLACK_REPORTS_DUE_CHANNEL listing:
//
//   *Missed SLA:*
//   @Pratik Khalane - Chart Industries | Tegular, Software & Network
//
//   *Week Commencing 22nd:*
//
//   *Tuesday 23rd June*
//   @Tom Frisenda - Signaloid | API
//   ...
//
// "Missed SLA" are deadlines that fell before this week (within the last
// MISSED_SLA_LOOKBACK_DAYS days); the dated groups are deadlines landing Mon–Fri of
// the current week. Assignees are shown as plain "@name" text (matching the source
// script) — no Slack id lookup.
//
// All date maths is done against Europe/London calendar dates so the result is the
// same whatever timezone the server runs in.
//
// Merged from the standalone clickup-automation/main.js. Fixes vs. the original:
//   • getWeekCommencing returned the *upcoming* Monday on any non-Monday run, so
//     running mid-week dumped the whole week into "Missed SLA" — now Mon–Fri use
//     the current week's Monday (weekends roll to the next Monday).
//   • the within-week day headers were sorted by parsing formatted strings
//     ("Tuesday 23rd June" → Invalid Date/NaN), an effective no-op — now grouped
//     and sorted by the real timestamp.
//   • date maths used server-local time — now pinned to Europe/London.
//   • per-list fetching only read the first page (≤100 tasks) — now paginates.

const { getSpaceListIds, listListTasks } = require('../lib/clickup-api');
const slack = require('../lib/slack');

const TZ = process.env.REPORTS_DUE_TZ || 'Europe/London';

// Report deadline = due date + this many business days.
const EXTERNAL_SLA = Number(process.env.REPORTS_DUE_SLA_DAYS) || 3;

// Show the "Missed SLA" section, and how far back a miss can be to still appear.
const SHOW_MISSED_SLA = process.env.REPORTS_DUE_SHOW_MISSED_SLA !== 'false';
const MISSED_SLA_LOOKBACK_DAYS = Number(process.env.REPORTS_DUE_MISSED_LOOKBACK_DAYS) || 14;

// Channel the report is posted to (the bot must be a member). Use the channel ID,
// not the name — chat.postMessage returns channel_not_found for names.
const REPORTS_DUE_CHANNEL = process.env.SLACK_REPORTS_DUE_CHANNEL || '#qa-chat';

// Statuses to exclude (all others are included). Tasks in a "closed" status type
// are already dropped by include_closed=false at fetch time.
const EXCLUDED_STATUSES = new Set(['scheduled', 'complete']);

// Assignees whose tasks should never appear in the report.
const EXCLUDED_ASSIGNEES = new Set([
  'Harry Savage', 'Sahira Hussain', 'Kathleen Byrom', 'Charlotte Crichton',
  'Alice Elvin', 'Katie Cecilia', 'No Assignee',
]);

// Tasks whose name looks like a "report deadline" placeholder are skipped.
const REPORT_DEADLINE_PATTERN = /report.*deadline|deadline.*report/;

// Lists to exclude from the search.
const EXCLUDED_LIST_IDS = ['901502418560'];

// Only report tasks with at least this many days on the "Days" custom field.
const MIN_DAYS = 0.5;

// ── Date helpers (Europe/London calendar dates as UTC-midnight anchors) ───────
// Every date below is represented as a Date at 00:00:00 UTC standing for a London
// calendar day, so day arithmetic and comparisons are simple and DST-proof.

function toTzDate(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Number(ms)));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

// "Tuesday 23rd June" for a UTC-midnight date.
function formatDate(utcDate) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).formatToParts(utcDate);
  const get = (t) => parts.find((p) => p.type === t).value;
  const day = Number(get('day'));
  return `${get('weekday')} ${day}${ordinalSuffix(day)} ${get('month')}`;
}

// "22nd" for the week-commencing header.
function formatWeekCommencing(utcDate) {
  const day = utcDate.getUTCDate();
  return `${day}${ordinalSuffix(day)}`;
}

// Adds N business days (skipping Sat/Sun) to a UTC-midnight date; returns a new one.
function addBusinessDays(utcDate, days) {
  const d = new Date(utcDate.getTime());
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d;
}

// Monday of the current week for a weekday run; the upcoming Monday at weekends.
function getWeekCommencing(now = new Date()) {
  const today = toTzDate(now.getTime());
  const dow = today.getUTCDay(); // 0 Sun … 6 Sat
  const d = new Date(today.getTime());
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);       // Sunday → next Monday
  else if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);  // Saturday → next Monday
  else d.setUTCDate(d.getUTCDate() - (dow - 1));         // Mon–Fri → this Monday
  return d;
}

// ── Task collection & report building ─────────────────────────────────────────

// Filters raw ClickUp tasks down to the report-relevant ones.
function collectFromTasks(tasks) {
  const collected = [];
  for (const task of tasks) {
    const status = task.status && task.status.status;
    if (EXCLUDED_STATUSES.has(status)) continue;
    if (task.due_date === null || task.due_date === undefined) continue;

    const assignee = (task.assignees && task.assignees.length > 0)
      ? task.assignees[0].username
      : 'No Assignee';
    if (EXCLUDED_ASSIGNEES.has(assignee)) continue;

    if (REPORT_DEADLINE_PATTERN.test((task.name || '').toLowerCase())) continue;

    const daysField = (task.custom_fields || []).find((f) => f.name === 'Days');
    const days = parseFloat(daysField && daysField.value);
    if (!(days >= MIN_DAYS)) continue;

    collected.push({ name: task.name, status, due_date: task.due_date, assignee });
  }
  return collected;
}

// De-duplicates by name and sorts by due date (ascending).
function dedupeAndSort(tasks) {
  const seen = new Set();
  return tasks
    .filter((t) => typeof t.name === 'string' && !seen.has(t.name) && seen.add(t.name))
    .sort((a, b) => a.due_date - b.due_date);
}

// Buckets tasks into missed-SLA and the current week (grouped by deadline day).
function bucketTasks(tasks, weekCommencing, weekEnd) {
  const missedSLA = [];
  const currentWeek = new Map(); // dayTimestamp -> { date, labels: [] }

  const missedCutoff = new Date(weekCommencing.getTime());
  missedCutoff.setUTCDate(missedCutoff.getUTCDate() - MISSED_SLA_LOOKBACK_DAYS);

  for (const item of tasks) {
    const deadline = addBusinessDays(toTzDate(item.due_date), EXTERNAL_SLA);
    const label = `@${item.assignee} - ${item.name}`;

    if (deadline < weekCommencing) {
      if (deadline >= missedCutoff) missedSLA.push(label); // older misses are dropped
    } else if (deadline <= weekEnd) {
      const key = deadline.getTime();
      if (!currentWeek.has(key)) currentWeek.set(key, { date: deadline, labels: [] });
      currentWeek.get(key).labels.push(label);
    }
    // else: due later than this week — skip
  }

  return { missedSLA, currentWeek };
}

// Builds the Slack message from the buckets.
function buildReport(missedSLA, currentWeek, weekCommencing) {
  const days = [...currentWeek.values()].sort((a, b) => a.date - b.date);
  const weekHeader = formatWeekCommencing(weekCommencing);

  let message = '';
  if (SHOW_MISSED_SLA) {
    message += '*Missed SLA:*\n';
    message += missedSLA.map((l) => `${l}\n`).join('');
    message += '\n';
  }
  message += `*Week Commencing ${weekHeader}:*\n`;
  for (const { date, labels } of days) {
    message += `\n*${formatDate(date)}*\n`;
    message += labels.map((l) => `${l}\n`).join('');
  }

  return message;
}

async function runReportsDueCheck() {
  const spaceId = process.env.CLICKUP_SPACE_ID;
  if (!spaceId) {
    console.log('[reports-due] CLICKUP_SPACE_ID not set — aborting.');
    return { posted: false, missed: 0, thisWeek: 0 };
  }

  console.log('[reports-due] Starting reports-due check…');

  let listIds;
  try {
    listIds = await getSpaceListIds(spaceId, { excludeListIds: EXCLUDED_LIST_IDS });
  } catch (err) {
    console.log(`[reports-due] Failed to list ClickUp lists: ${err.message}`);
    return { posted: false, missed: 0, thisWeek: 0 };
  }

  // Fetch every list concurrently; a failed list logs and contributes nothing.
  const results = await Promise.all(listIds.map((id) =>
    listListTasks(id, { subtasks: true, includeClosed: false }).catch((err) => {
      console.log(`[reports-due] List ${id} failed: ${err.message}`);
      return [];
    })
  ));
  const allTasks = results.flat();
  console.log(`[reports-due] Retrieved ${allTasks.length} task(s) across ${listIds.length} list(s).`);

  const weekCommencing = getWeekCommencing();
  const weekEnd = new Date(weekCommencing.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 4); // Friday

  const tasks = dedupeAndSort(collectFromTasks(allTasks));
  const { missedSLA, currentWeek } = bucketTasks(tasks, weekCommencing, weekEnd);
  const message = buildReport(missedSLA, currentWeek, weekCommencing);
  const thisWeek = [...currentWeek.values()].reduce((n, d) => n + d.labels.length, 0);

  try {
    await slack.postMessage(REPORTS_DUE_CHANNEL, message);
    console.log(`[reports-due] Posted to ${REPORTS_DUE_CHANNEL}: ${missedSLA.length} missed, ${thisWeek} due this week.`);
    return { posted: true, missed: missedSLA.length, thisWeek };
  } catch (err) {
    console.log(`[reports-due] Failed to post to ${REPORTS_DUE_CHANNEL}: ${err.message}`);
    return { posted: false, missed: missedSLA.length, thisWeek };
  }
}

module.exports = {
  runReportsDueCheck,
  // exported for tests / reuse
  addBusinessDays, getWeekCommencing, formatDate, toTzDate, bucketTasks, buildReport,
};
