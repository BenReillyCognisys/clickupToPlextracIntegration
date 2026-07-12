// Daily auth-form check (runs at 14:00 — see index.js).
//
// Scans every task in the Penetration Test space (regardless of start date). For
// each task that has the
// "Pre Recs Received?" checkbox ticked but "Tester OKd Pre-Recs" NOT yet ticked,
// the task's assignee(s) are collected (i.e. we chase the testers who still need
// to check the auth form). A SINGLE message is then posted to the qa-chat
// channel (SLACK_AUTH_FORM_CHANNEL, via the bot token), @-mentioning the assigned
// users so they're pinged to check the authorisation form. Tasks are grouped under
// their start date (chronological; undated tasks last):
//
//   *Check Auth Form*
//   *[23rd July]*
//   <@U012ABC> - ClientA | Blackbox
//   *[24th July]*
//   <@U345DEF> - ClientB | Greybox
//
// No DMs are sent and the SLACK_WEBHOOK_URL summary is no longer used.
//
// After posting, the PREVIOUS day's "Check Auth Form" message is deleted: we
// persist the single most recent message id (plus its per-task entries) in
// MongoDB and delete exactly that one on the next run (so only ever one message
// is removed). Cleanup is best-effort — if it fails, the freshly posted message
// still stands.
//
// reconcileAuthFormMessage() runs every 5 minutes (see index.js): it re-scans the
// space and edits the posted message in place, striking through (~…~) any listed
// task that no longer qualifies because the tester has since OK'd the pre-recs (or
// the task closed). It only edits Slack when something actually changed.

const slack = require('../lib/slack');
const store = require('../lib/auth-form-store');
const { listSpaceTasks } = require('../lib/clickup-api');
const { parseTaskName } = require('./parse-task');

const PRE_RECS_RECEIVED_FIELD = 'Pre Recs Received?';
const TESTER_OKD_FIELD = 'Tester OKd Pre-Recs';

// Timezone the start-date labels are formatted in (kept in step with the cron tz).
const AUTH_FORM_TZ = process.env.AUTH_FORM_CHECK_TZ || 'Europe/London';

// qa-chat channel the bot is a member of (override via env). MUST be a channel
// ID (e.g. C0123ABCD) — chat.postMessage returns channel_not_found for names.
const AUTH_FORM_CHANNEL = process.env.SLACK_AUTH_FORM_CHANNEL || '#qa-chat';

// ClickUp checkbox custom fields come back as boolean true / "true" / "1" when
// ticked, and false / null / undefined when not. Be tolerant of all of them.
function isChecked(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

// Reads a checkbox custom field by name (case-insensitive); true if ticked.
function checkboxChecked(task, fieldName) {
  const target = fieldName.trim().toLowerCase();
  const field = (task.custom_fields || []).find(f => (f.name || '').trim().toLowerCase() === target);
  return field ? isChecked(field.value) : false;
}

// A task needs chasing when it's a top-level task with at least one assignee, whose
// pre-recs are in but the tester hasn't OK'd them yet — regardless of its start date
// (all such tasks are chased, not just those starting in the coming week). Tasks with
// no assignee (no one to ping) are skipped. Once "Tester OKd Pre-Recs" is ticked (or
// the task closes / its last assignee is removed), it no longer qualifies — that's
// the signal the 5-minute reconcile uses to strike its line through.
function qualifies(task) {
  if (task.parent) return false; // skip subtasks
  if (!(task.assignees || []).length) return false; // no one to chase
  return checkboxChecked(task, PRE_RECS_RECEIVED_FIELD) && !checkboxChecked(task, TESTER_OKD_FIELD);
}

// "23rd July" from a ClickUp start_date (ms since epoch, as a string or number),
// formatted in AUTH_FORM_TZ. Returns null when there's no usable date.
function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function formatStartDate(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AUTH_FORM_TZ,
    day: 'numeric',
    month: 'long',
  }).formatToParts(d);
  const day = Number(parts.find(p => p.type === 'day').value);
  const month = parts.find(p => p.type === 'month').value;
  return `${day}${ordinalSuffix(day)} ${month}`;
}

// The current calendar date (YYYY-MM-DD) in AUTH_FORM_TZ, used to stamp/compare the
// day a message was posted for so the reconcile can tell "already handled today"
// from "no message yet today".
function todayStr(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: AUTH_FORM_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// Renders the Slack message from the persisted entries: the header, then the
// tasks grouped under a "[23rd July]" start-date heading (chronological, undated
// last). Each task line is struck-through (~…~) when it's been actioned.
function renderMessage(entries) {
  const groups = new Map(); // label -> { sortKey, lines: [] }
  for (const e of entries) {
    const label = formatStartDate(e.startDate) || 'No start date';
    const sortKey = e.startDate ? Number(e.startDate) : Number.POSITIVE_INFINITY;
    if (!groups.has(label)) groups.set(label, { sortKey, lines: [] });
    const g = groups.get(label);
    g.sortKey = Math.min(g.sortKey, sortKey);
    g.lines.push(e.struck ? `~${e.line}~` : e.line);
  }

  const out = ['*Check Auth Form*'];
  for (const [label, g] of [...groups.entries()].sort((a, b) => a[1].sortKey - b[1].sortKey)) {
    out.push(`*[${label}]*`);
    out.push(...g.lines);
  }
  return out.join('\n');
}

// Turns a ClickUp assignee into a Slack @-mention by resolving their Slack id
// from their email (cached per run). Falls back to plain "@username" if the
// email can't be resolved to a Slack user.
async function mentionFor(assignee, cache) {
  const name = assignee?.username || assignee?.email || 'Unassigned';
  const email = assignee?.email;
  if (!email) return `@${name}`;

  if (!cache.has(email)) {
    try {
      cache.set(email, await slack.lookupUserIdByEmail(email));
    } catch (err) {
      console.log(`[auth-form-check] Slack lookup failed for ${email}: ${err.message}`);
      cache.set(email, null);
    }
  }
  const id = cache.get(email);
  return id ? `<@${id}>` : `@${name}`;
}

// Builds the persisted entry for a qualifying task: resolves its assignees to Slack
// @-mentions and formats the "mentions - Client | Type" line. `cache` maps email ->
// Slack id so lookups are shared across tasks in a single run.
async function buildEntry(task, cache) {
  const { client_name, testing_type } = parseTaskName(task.name);
  const engagement = `${client_name} | ${testing_type}`;

  // qualifies() guarantees at least one assignee, so there's always someone to ping.
  const assignees = task.assignees || [];
  const mentions = (await Promise.all(assignees.map(a => mentionFor(a, cache)))).join(' ');

  return { taskId: task.id, line: `${mentions} - ${engagement}`, struck: false, startDate: task.start_date || null };
}

async function runAuthFormCheck() {
  const spaceId = process.env.CLICKUP_SPACE_ID;
  if (!spaceId) {
    console.log('[auth-form-check] CLICKUP_SPACE_ID not set — aborting.');
    return { checked: 0, matched: 0 };
  }

  console.log('[auth-form-check] Starting daily auth-form check…');

  let tasks;
  try {
    tasks = await listSpaceTasks(spaceId);
  } catch (err) {
    console.log(`[auth-form-check] Failed to list ClickUp tasks: ${err.message}`);
    return { checked: 0, matched: 0 };
  }

  console.log(`[auth-form-check] Retrieved ${tasks.length} task(s) from the Penetration Test space.`);

  const emailToId = new Map(); // cache Slack lookups across tasks
  const entries = [];

  for (const task of tasks) {
    if (!qualifies(task)) continue;

    console.log(`[auth-form-check] MATCH: "${task.name}" — ${(task.assignees || []).length} assignee(s) (task ${task.id}).`);
    entries.push(await buildEntry(task, emailToId));
  }

  if (!entries.length) {
    // Nothing to post — but still delete any previous message and stamp today's date
    // (with a null ts) so the reconcile knows the run happened and can post the first
    // message itself if a task starts qualifying later today.
    console.log('[auth-form-check] No matching tasks — nothing to post.');
    await replacePreviousMessage(AUTH_FORM_CHANNEL, null, []);
    return { checked: tasks.length, matched: 0 };
  }

  // One message to the qa-chat channel, @-mentioning the assigned users.
  const message = renderMessage(entries);
  let newTs;
  try {
    newTs = await slack.postMessage(AUTH_FORM_CHANNEL, message);
    console.log(`[auth-form-check] Posted auth-form message for ${entries.length} engagement(s) to ${AUTH_FORM_CHANNEL}.`);
  } catch (err) {
    console.log(`[auth-form-check] Failed to post message to ${AUTH_FORM_CHANNEL}: ${err.message}`);
    return { checked: tasks.length, matched: entries.length };
  }

  // Now that the new message is up, delete the previous day's one (exactly one)
  // and record this message + its entries for the 5-minute reconcile.
  await replacePreviousMessage(AUTH_FORM_CHANNEL, newTs, entries);

  console.log('[auth-form-check] Done.');
  return { checked: tasks.length, matched: entries.length };
}

// Re-scans the space every few minutes and reconciles the posted message against
// what currently qualifies: any line whose task no longer qualifies (the tester has
// since OK'd the pre-recs, or the task closed) is struck through, a line that
// qualifies again (e.g. the box was un-ticked) is un-struck, and any task that has
// newly started qualifying since the daily post is appended as a fresh line. If the
// 14:00 run found nothing (so no message went out) but a task has since started
// qualifying, it posts the first message itself. Only edits Slack when something
// actually changed. Best-effort throughout: any failure is logged and ignored so it
// never disrupts the daily post.
async function reconcileAuthFormMessage() {
  const spaceId = process.env.CLICKUP_SPACE_ID;
  if (!spaceId) return { updated: false };

  let state;
  try {
    state = await store.getLastMessage();
  } catch (err) {
    console.log(`[auth-form-check] Reconcile: could not read last message — skipping: ${err.message}`);
    return { updated: false };
  }

  // Only act once the daily run has stamped today's date — before that (or on a day
  // it hasn't run) there's no message anchor and we leave posting to the 14:00 run.
  if (!state || state.postedDate !== todayStr()) return { updated: false };

  let tasks;
  try {
    tasks = await listSpaceTasks(spaceId);
  } catch (err) {
    console.log(`[auth-form-check] Reconcile: failed to list ClickUp tasks — skipping: ${err.message}`);
    return { updated: false };
  }

  const qualifyingTasks = tasks.filter(qualifies);

  // No message was posted today (the 14:00 run found nothing) but tasks have since
  // started qualifying — post the first message ourselves instead of just editing.
  if (!state.ts) {
    if (!qualifyingTasks.length) return { updated: false };
    return await postReconcileMessage(qualifyingTasks);
  }

  // A message exists for today: reconcile it. Anything already listed but no longer
  // qualifying is done (OK'd, closed, or pre-recs removed) and should be struck
  // through; anything qualifying but not yet listed has newly started and is appended.
  const stillQualifying = new Set(qualifyingTasks.map(t => t.id));

  let changed = false;
  const entries = state.entries.map((e) => {
    const struck = !stillQualifying.has(e.taskId);
    if (struck !== !!e.struck) changed = true;
    return { ...e, struck };
  });

  // Append any newly-qualifying tasks that aren't already on the message.
  const listedIds = new Set(state.entries.map(e => e.taskId));
  const newTasks = qualifyingTasks.filter(t => !listedIds.has(t.id));
  if (newTasks.length) {
    const emailToId = new Map();
    for (const task of newTasks) {
      console.log(`[auth-form-check] Reconcile: adding newly-qualifying "${task.name}" (task ${task.id}).`);
      entries.push(await buildEntry(task, emailToId));
    }
    changed = true;
  }

  if (!changed) return { updated: false };

  try {
    await slack.updateMessage(state.channel, state.ts, renderMessage(entries));
    console.log(`[auth-form-check] Reconcile: updated message (ts ${state.ts}) — struck ${entries.filter(e => e.struck).length}/${entries.length}.`);
  } catch (err) {
    console.log(`[auth-form-check] Reconcile: failed to update message (ts ${state.ts}) — leaving entries as-is: ${err.message}`);
    return { updated: false };
  }

  try {
    await store.updateEntries(entries);
  } catch (err) {
    console.log(`[auth-form-check] Reconcile: failed to persist updated entries: ${err.message}`);
  }

  return { updated: true };
}

// Posts the first "Check Auth Form" message of the day from the reconcile, for the
// case where the 14:00 run found nothing but tasks have since started qualifying.
// Records it (with today's stamp) so subsequent reconciles edit it in place.
async function postReconcileMessage(qualifyingTasks) {
  const emailToId = new Map();
  const entries = [];
  for (const task of qualifyingTasks) {
    console.log(`[auth-form-check] Reconcile: posting first message — including "${task.name}" (task ${task.id}).`);
    entries.push(await buildEntry(task, emailToId));
  }

  let newTs;
  try {
    newTs = await slack.postMessage(AUTH_FORM_CHANNEL, renderMessage(entries));
    console.log(`[auth-form-check] Reconcile: posted first auth-form message for ${entries.length} engagement(s) to ${AUTH_FORM_CHANNEL}.`);
  } catch (err) {
    console.log(`[auth-form-check] Reconcile: failed to post first message to ${AUTH_FORM_CHANNEL}: ${err.message}`);
    return { updated: false };
  }

  await replacePreviousMessage(AUTH_FORM_CHANNEL, newTs, entries);
  return { updated: true };
}

// Deletes the single previously posted "Check Auth Form" message and records the
// new one (with its entries) in its place. Best-effort: any failure (Mongo
// unavailable, message already gone) is logged and ignored so it never affects
// the run.
async function replacePreviousMessage(channel, newTs, entries) {
  let previous;
  try {
    previous = await store.getLastMessage();
  } catch (err) {
    console.log(`[auth-form-check] Could not read previous message id — skipping delete: ${err.message}`);
    return;
  }

  if (previous?.ts && previous.ts !== newTs) {
    try {
      await slack.deleteMessage(previous.channel || channel, previous.ts);
      console.log(`[auth-form-check] Deleted previous auth-form message (ts ${previous.ts}).`);
    } catch (err) {
      console.log(`[auth-form-check] Failed to delete previous message (ts ${previous.ts}): ${err.message}`);
    }
  }

  try {
    // Stamp today's date so the reconcile can tell this run already happened, even
    // when newTs is null (nothing posted). `entries` is [] in that case.
    await store.setLastMessage(channel, newTs, entries, todayStr());
  } catch (err) {
    console.log(`[auth-form-check] Failed to record new message id (next run won't delete this one): ${err.message}`);
  }
}

module.exports = { runAuthFormCheck, reconcileAuthFormMessage };
