// Daily auth-form check (runs at 14:00 — see index.js).
//
// Scans every task in the Penetration Test space. For each task that has the
// "Pre Recs Received?" checkbox ticked but "Tester OKd Pre-Recs" NOT yet ticked,
// the task's assignee(s) are collected (i.e. we chase the testers who still need
// to check the auth form). A SINGLE message is then posted to the qa-chat
// channel (SLACK_AUTH_FORM_CHANNEL, via the bot token), @-mentioning the assigned
// users so they're pinged to check the authorisation form:
//
//   *Check Auth Form*
//   <@U012ABC> - ClientA | Blackbox
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

// A task needs chasing when it's a top-level task whose pre-recs are in but the
// tester hasn't OK'd them yet. Once "Tester OKd Pre-Recs" is ticked (or the task
// closes and drops out of the open-task list), it no longer qualifies — that's
// the signal the 5-minute reconcile uses to strike its line through.
function qualifies(task) {
  if (task.parent) return false; // skip subtasks
  return checkboxChecked(task, PRE_RECS_RECEIVED_FIELD) && !checkboxChecked(task, TESTER_OKD_FIELD);
}

// Renders the Slack message from the persisted entries: the header followed by
// one line per task, struck-through (~…~) when the task has been actioned.
function renderMessage(entries) {
  const lines = entries.map(e => (e.struck ? `~${e.line}~` : e.line));
  return ['*Check Auth Form*', ...lines].join('\n');
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

    const { client_name, testing_type } = parseTaskName(task.name);
    const engagement = `${client_name} | ${testing_type}`;

    const assignees = task.assignees || [];
    const mentions = assignees.length
      ? (await Promise.all(assignees.map(a => mentionFor(a, emailToId)))).join(' ')
      : '_(unassigned)_';

    console.log(`[auth-form-check] MATCH: "${task.name}" — ${assignees.length} assignee(s) (task ${task.id}).`);
    entries.push({ taskId: task.id, line: `${mentions} - ${engagement}`, struck: false });
  }

  if (!entries.length) {
    console.log('[auth-form-check] No matching tasks — nothing to post.');
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

// Re-scans the space every few minutes and strikes through any line whose task no
// longer qualifies (the tester has since OK'd the pre-recs, or the task closed).
// A line that qualifies again (e.g. the box was un-ticked) is un-struck. Only
// edits Slack when something actually changed. Best-effort throughout: any failure
// is logged and ignored so it never disrupts the daily post.
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
  if (!state?.ts || !state.entries?.length) return { updated: false };

  let tasks;
  try {
    tasks = await listSpaceTasks(spaceId);
  } catch (err) {
    console.log(`[auth-form-check] Reconcile: failed to list ClickUp tasks — skipping: ${err.message}`);
    return { updated: false };
  }

  // Task ids that still need chasing. Anything listed but absent here is done
  // (OK'd, closed, or pre-recs removed) and should be struck through.
  const stillQualifying = new Set(tasks.filter(qualifies).map(t => t.id));

  let changed = false;
  const entries = state.entries.map((e) => {
    const struck = !stillQualifying.has(e.taskId);
    if (struck !== !!e.struck) changed = true;
    return { ...e, struck };
  });

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
    await store.setLastMessage(channel, newTs, entries);
  } catch (err) {
    console.log(`[auth-form-check] Failed to record new message id (next run won't delete this one): ${err.message}`);
  }
}

module.exports = { runAuthFormCheck, reconcileAuthFormMessage };
