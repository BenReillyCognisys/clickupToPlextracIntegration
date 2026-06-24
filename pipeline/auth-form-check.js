// Daily auth-form check (runs at 14:00 — see index.js).
//
// Scans every task in the Penetration Test space. For each task that has BOTH the
// "Pre Recs Received?" and "Tester OKd Pre-Recs" checkboxes ticked, the task's
// assignee(s) are collected. A SINGLE message is then posted to the qa-chat
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
// persist the single most recent message id in MongoDB and delete exactly that
// one on the next run (so only ever one message is removed). Cleanup is
// best-effort — if it fails, the freshly posted message still stands.

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
  const lines = [];

  for (const task of tasks) {
    if (task.parent) continue; // skip subtasks

    const received = checkboxChecked(task, PRE_RECS_RECEIVED_FIELD);
    const okd = checkboxChecked(task, TESTER_OKD_FIELD);
    if (!received || !okd) continue;

    const { client_name, testing_type } = parseTaskName(task.name);
    const engagement = `${client_name} | ${testing_type}`;

    const assignees = task.assignees || [];
    const mentions = assignees.length
      ? (await Promise.all(assignees.map(a => mentionFor(a, emailToId)))).join(' ')
      : '_(unassigned)_';

    console.log(`[auth-form-check] MATCH: "${task.name}" — ${assignees.length} assignee(s) (task ${task.id}).`);
    lines.push(`${mentions} - ${engagement}`);
  }

  if (!lines.length) {
    console.log('[auth-form-check] No matching tasks — nothing to post.');
    return { checked: tasks.length, matched: 0 };
  }

  // One message to the qa-chat channel, @-mentioning the assigned users.
  const message = ['*Check Auth Form*', ...lines].join('\n');
  let newTs;
  try {
    newTs = await slack.postMessage(AUTH_FORM_CHANNEL, message);
    console.log(`[auth-form-check] Posted auth-form message for ${lines.length} engagement(s) to ${AUTH_FORM_CHANNEL}.`);
  } catch (err) {
    console.log(`[auth-form-check] Failed to post message to ${AUTH_FORM_CHANNEL}: ${err.message}`);
    return { checked: tasks.length, matched: lines.length };
  }

  // Now that the new message is up, delete the previous day's one (exactly one).
  await replacePreviousMessage(AUTH_FORM_CHANNEL, newTs);

  console.log('[auth-form-check] Done.');
  return { checked: tasks.length, matched: lines.length };
}

// Deletes the single previously posted "Check Auth Form" message and records the
// new one in its place. Best-effort: any failure (Mongo unavailable, message
// already gone) is logged and ignored so it never affects the run.
async function replacePreviousMessage(channel, newTs) {
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
    await store.setLastMessage(channel, newTs);
  } catch (err) {
    console.log(`[auth-form-check] Failed to record new message id (next run won't delete this one): ${err.message}`);
  }
}

module.exports = { runAuthFormCheck };
