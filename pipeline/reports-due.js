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
// After posting, the message (channel, ts and its per-task entries) is persisted in
// MongoDB. When a report later moves into a "done" status (Completed / Ready For
// Release), the ClickUp status-change webhook calls crossOffReport(), which strikes
// through (~…~) that report's line and edits the original message in place.
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
const store = require('../lib/reports-due-store');

const TZ = process.env.REPORTS_DUE_TZ || 'Europe/London';

// Report deadline = due date + this many business days.
const EXTERNAL_SLA = Number(process.env.REPORTS_DUE_SLA_DAYS) || 3;

// Show the "Missed SLA" section, and how far back a miss can be to still appear.
const SHOW_MISSED_SLA = process.env.REPORTS_DUE_SHOW_MISSED_SLA !== 'false';
const MISSED_SLA_LOOKBACK_DAYS = Number(process.env.REPORTS_DUE_MISSED_LOOKBACK_DAYS) || 14;

// Channel the report is posted to (the bot must be a member). Use the channel ID,
// not the name — chat.postMessage returns channel_not_found for names.
const REPORTS_DUE_CHANNEL = process.env.SLACK_REPORTS_DUE_CHANNEL || 'C091H6MLS6A';

// Statuses to exclude — every other task (with a due date) is included. Tasks in a
// "closed" status type are also dropped by include_closed=false at fetch time.
// Matching is normalised (case-insensitive, hyphens/spaces equivalent) so "Wash-Up
// Phase" matches the ClickUp status "wash up phase".
const EXCLUDED_STATUSES = new Set(['complete', 'wash up phase', 'rr awaiting payment']);

// Lower-cases, strips decoration (e.g. the asterisks in "**RR Awaiting Payment**"),
// and treats hyphens/spaces as equivalent so set matching is forgiving.
function normalizeStatus(s) {
  return (s || '').toLowerCase().replace(/\*/g, '').replace(/[-\s]+/g, ' ').trim();
}

// Statuses that "finish" a report: once a listed report reaches one of these it's
// struck through on the posted message. Defaults to Completed + Ready For Release;
// override the comma-separated list via REPORTS_DUE_DONE_STATUSES. Matched with the
// same normalisation as EXCLUDED_STATUSES so casing/hyphens/spacing don't matter.
const DONE_STATUSES = new Set(
  (process.env.REPORTS_DUE_DONE_STATUSES || 'Completed,Ready For Release')
    .split(',')
    .map(normalizeStatus)
    .filter(Boolean)
);

// True when a status name counts as "done" (should cross the report off).
function isDoneStatus(status) {
  return DONE_STATUSES.has(normalizeStatus(status));
}

// Assignees whose tasks should never appear in the report.
const EXCLUDED_ASSIGNEES = new Set([
  'Harry Savage', 'Sahira Hussain', 'Kathleen Byrom', 'Charlotte Crichton',
  'Alice Elvin', 'Katie Cecilia', 'No Assignee',
]);

// Tasks whose name looks like a "report deadline" placeholder are skipped.
const REPORT_DEADLINE_PATTERN = /report.*deadline|deadline.*report/;

// Leave / holiday / admin entries (not client reports) are skipped. Kept
// deliberately narrow — whole-word, leave/admin-specific terms — so it can't catch
// a real engagement name. Examples removed: "Annual Leave", "State Holiday",
// "Birthday Leave!", "Sick leave", "Admin day", "Block out", "Onsite", "Upskill",
// "Blog Writing", "Half day - working morning".
const EXCLUDED_NAME_PATTERN =
  /\bleave\b|\bholiday\b|\bsick\b|\bblog\b|\bupskill\b|\bonsite\b|\bblock out\b|\bhalf day\b|\badmin day\b/;

// Lists to exclude from the search.
const EXCLUDED_LIST_IDS = ['901502418560'];

// A task only counts as a real report if at least one of these number custom
// fields is populated with a value above 0 — a positive "this is a billable
// engagement" signal that replaces relying on the task name alone. The OR is
// deliberate: any one field can be blank on a given task (the old Days-only check
// dropped reports whenever Days was missing), so we accept a value in any of them.
const VALUE_FIELDS = ['Revenue', 'Days', 'Days Balance'];

// Reads a number custom field by name (case-insensitive) and returns it as a
// Number, or NaN if the field is absent/empty/non-numeric.
function numberField(task, fieldName) {
  const target = fieldName.trim().toLowerCase();
  const field = (task.custom_fields || []).find(
    (f) => (f.name || '').trim().toLowerCase() === target
  );
  if (!field || field.value === null || field.value === undefined || field.value === '') {
    return NaN;
  }
  return Number(field.value);
}

// True if any of VALUE_FIELDS holds a value above 0.
function hasReportValue(task) {
  return VALUE_FIELDS.some((name) => numberField(task, name) > 0);
}

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
    if (EXCLUDED_STATUSES.has(normalizeStatus(status))) continue;
    if (task.due_date === null || task.due_date === undefined) continue;

    const assignee = (task.assignees && task.assignees.length > 0)
      ? task.assignees[0].username
      : 'No Assignee';
    if (EXCLUDED_ASSIGNEES.has(assignee)) continue;

    const lowerName = (task.name || '').toLowerCase();
    if (REPORT_DEADLINE_PATTERN.test(lowerName)) continue;
    if (EXCLUDED_NAME_PATTERN.test(lowerName)) continue;

    // Must look like a billable engagement: Revenue, Days or Days Balance > 0.
    if (!hasReportValue(task)) continue;

    collected.push({ id: task.id, name: task.name, status, due_date: task.due_date, assignee });
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

// Turns the collected tasks into a flat list of persistable entries: one per report
// that lands in the missed-SLA window or the current week. Each entry carries its
// ClickUp task id (so a status webhook can find it later), its rendered label, the
// section it belongs to, and — for the week section — the deadline day it groups
// under. Reports due later than this week are dropped. `struck` starts false.
function buildEntries(tasks, weekCommencing, weekEnd) {
  const missedCutoff = new Date(weekCommencing.getTime());
  missedCutoff.setUTCDate(missedCutoff.getUTCDate() - MISSED_SLA_LOOKBACK_DAYS);

  const entries = [];
  for (const item of tasks) {
    const deadline = addBusinessDays(toTzDate(item.due_date), EXTERNAL_SLA);
    const label = `@${item.assignee} - ${item.name}`;

    if (deadline < weekCommencing) {
      if (deadline >= missedCutoff) { // older misses are dropped
        entries.push({ taskId: item.id, label, struck: false, section: 'missed', dayKey: null, dayLabel: null });
      }
    } else if (deadline <= weekEnd) {
      entries.push({
        taskId: item.id, label, struck: false,
        section: 'week', dayKey: deadline.getTime(), dayLabel: formatDate(deadline),
      });
    }
    // else: due later than this week — skip
  }

  return entries;
}

// Renders the Slack message from the persisted entries: the Missed SLA section, then
// the week-commencing header, then the week's reports grouped under their deadline
// day (chronological). A struck entry's label is wrapped in ~…~ so it shows crossed
// off. Produces byte-identical output to the original builder when nothing is struck.
function renderReport(entries, weekHeader) {
  const decorate = (e) => (e.struck ? `~${e.label}~` : e.label);

  let message = '';
  if (SHOW_MISSED_SLA) {
    message += '*Missed SLA:*\n';
    message += entries.filter((e) => e.section === 'missed').map((e) => `${decorate(e)}\n`).join('');
    message += '\n';
  }

  message += `*Week Commencing ${weekHeader}:*\n`;

  const byDay = new Map(); // dayKey -> { dayLabel, items: [] }
  for (const e of entries.filter((e) => e.section === 'week')) {
    if (!byDay.has(e.dayKey)) byDay.set(e.dayKey, { dayLabel: e.dayLabel, items: [] });
    byDay.get(e.dayKey).items.push(e);
  }
  for (const [, { dayLabel, items }] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    message += `\n*${dayLabel}*\n`;
    message += items.map((e) => `${decorate(e)}\n`).join('');
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
  const entries = buildEntries(tasks, weekCommencing, weekEnd);
  const weekHeader = formatWeekCommencing(weekCommencing);
  const message = renderReport(entries, weekHeader);
  const missed = entries.filter((e) => e.section === 'missed').length;
  const thisWeek = entries.filter((e) => e.section === 'week').length;

  let ts;
  try {
    ts = await slack.postMessage(REPORTS_DUE_CHANNEL, message);
    console.log(`[reports-due] Posted to ${REPORTS_DUE_CHANNEL}: ${missed} missed, ${thisWeek} due this week.`);
  } catch (err) {
    console.log(`[reports-due] Failed to post to ${REPORTS_DUE_CHANNEL}: ${err.message}`);
    return { posted: false, missed, thisWeek };
  }

  // Record the message + entries so the status webhook can cross reports off later.
  // Best-effort: a persistence failure just means cross-offs won't work this week.
  try {
    await store.setMessage(REPORTS_DUE_CHANNEL, ts, weekHeader, entries);
  } catch (err) {
    console.log(`[reports-due] Failed to record posted message (cross-offs disabled this week): ${err.message}`);
  }

  return { posted: true, missed, thisWeek };
}

// Crosses a report off the current week's message when it reaches a done status
// (Completed / Ready For Release). Called by the ClickUp status-change webhook with
// the task id and its new status. No-ops (returns { updated: false }) when the status
// isn't a done one, the task isn't on the current message, or it's already struck.
// Best-effort throughout: any failure is logged and swallowed.
async function crossOffReport(taskId, newStatus) {
  if (!isDoneStatus(newStatus)) return { updated: false };

  let state;
  try {
    state = await store.getMessage();
  } catch (err) {
    console.log(`[reports-due] Cross-off: could not read stored message — skipping: ${err.message}`);
    return { updated: false };
  }
  if (!state?.ts || !state.entries?.length) return { updated: false };

  const idx = state.entries.findIndex((e) => String(e.taskId) === String(taskId));
  if (idx === -1) return { updated: false };      // not on this week's message
  if (state.entries[idx].struck) return { updated: false }; // already crossed off

  const entries = state.entries.map((e, i) => (i === idx ? { ...e, struck: true } : e));

  try {
    await slack.updateMessage(state.channel, state.ts, renderReport(entries, state.weekHeader));
    console.log(`[reports-due] Cross-off: struck "${state.entries[idx].label}" (task ${taskId}, status "${newStatus}").`);
  } catch (err) {
    console.log(`[reports-due] Cross-off: failed to edit message (ts ${state.ts}) — leaving as-is: ${err.message}`);
    return { updated: false };
  }

  try {
    await store.updateEntries(entries);
  } catch (err) {
    console.log(`[reports-due] Cross-off: failed to persist struck entry: ${err.message}`);
  }

  return { updated: true };
}

module.exports = {
  runReportsDueCheck,
  crossOffReport,
  // exported for tests / reuse
  addBusinessDays, getWeekCommencing, formatDate, toTzDate,
  collectFromTasks, dedupeAndSort, buildEntries, renderReport,
  numberField, hasReportValue, isDoneStatus,
};
