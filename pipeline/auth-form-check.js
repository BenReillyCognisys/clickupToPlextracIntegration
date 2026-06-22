// Daily auth-form check (runs at 14:00 — see index.js).
//
// Scans every task in the Penetration Test space. For each task that has BOTH the
// "Pre Recs Received?" and "Tester OKd Pre-Recs" checkboxes ticked, the task's
// assignee is DM'd on Slack to remind them to check the authorisation form, and a
// summary paragraph is posted to the channel (SLACK_WEBHOOK_URL):
//
//   Check Auth Form Messages Sent
//   @Ben Reilly - ClientA | Blackbox
//   @Karan Luniyal - ClientB | Greybox
//
// ⚠️ TESTING MODE: while we validate this, every DM is sent to ONE person
// (SLACK_TEST_DM_USER_ID — Ben Reilly) regardless of the real assignee, so we
// don't spam the team. The summary still shows the real assignee names.

const slack = require('../lib/slack');
const log = require('../lib/logger');
const { listSpaceTasks } = require('../lib/clickup-api');
const { parseTaskName } = require('./parse-task');

const PRE_RECS_RECEIVED_FIELD = 'Pre Recs Received?';
const TESTER_OKD_FIELD = 'Tester OKd Pre-Recs';

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

async function runAuthFormCheck() {
  const spaceId = process.env.CLICKUP_SPACE_ID;
  if (!spaceId) {
    console.log('[auth-form-check] CLICKUP_SPACE_ID not set — aborting.');
    return { checked: 0, matched: 0, sent: [] };
  }

  console.log('[auth-form-check] Starting daily auth-form check…');

  let tasks;
  try {
    tasks = await listSpaceTasks(spaceId);
  } catch (err) {
    console.log(`[auth-form-check] Failed to list ClickUp tasks: ${err.message}`);
    return { checked: 0, matched: 0, sent: [] };
  }

  console.log(`[auth-form-check] Retrieved ${tasks.length} task(s) from the Penetration Test space.`);

  // TESTING: all DMs go here regardless of the real assignee.
  const testDmUserId = process.env.SLACK_TEST_DM_USER_ID;
  const sent = [];

  for (const task of tasks) {
    if (task.parent) continue; // skip subtasks

    const received = checkboxChecked(task, PRE_RECS_RECEIVED_FIELD);
    const okd = checkboxChecked(task, TESTER_OKD_FIELD);
    if (!received || !okd) continue;

    const assignee = (task.assignees || [])[0];
    const assigneeName = assignee?.username || assignee?.email || 'Unassigned';
    const { client_name, testing_type } = parseTaskName(task.name);
    const engagement = `${client_name} | ${testing_type}`;

    console.log(`[auth-form-check] MATCH: "${task.name}" — assignee "${assigneeName}" (task ${task.id}).`);

    const dmText =
      `Hi ${assigneeName}, the pre-requisites for *${engagement}* have been received and OK'd. ` +
      'Please check the authorisation form for this engagement before testing begins.';

    if (testDmUserId) {
      try {
        await slack.postDirectMessage(testDmUserId, dmText);
        console.log(`[auth-form-check] DM sent to test user for "${engagement}" (real assignee: "${assigneeName}").`);
      } catch (err) {
        console.log(`[auth-form-check] Failed to send DM for "${engagement}": ${err.message}`);
      }
    } else {
      console.log('[auth-form-check] SLACK_TEST_DM_USER_ID not set — DM not sent (logged only).');
    }

    sent.push({ assigneeName, engagement });
  }

  // Summary paragraph → channel (SLACK_WEBHOOK_URL, via logger.notify).
  if (sent.length) {
    const summary = ['Check Auth Form Messages Sent', ...sent.map(s => `@${s.assigneeName} - ${s.engagement}`)].join('\n');
    log.notify(summary);
    console.log(`[auth-form-check] Posted summary for ${sent.length} engagement(s) to the Slack channel.`);
  } else {
    console.log('[auth-form-check] No matching tasks — nothing to send.');
  }

  console.log('[auth-form-check] Done.');
  return { checked: tasks.length, matched: sent.length, sent };
}

module.exports = { runAuthFormCheck };
