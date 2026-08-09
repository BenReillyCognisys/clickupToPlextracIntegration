// Placeholder task names created by the ClickUp project template before ClickBot
// renames the task to its real "Client | Testing Type". A task still carrying one
// of these names is not a real project yet, so the create pipeline skips it (no
// report, no Slack noise) and waits for the rename — which arrives as a taskUpdated
// webhook and is handled by pipeline/task-rename.js.
//
// Override/extend with CLICKUP_PLACEHOLDER_TASK_NAMES (comma-separated).
const fromEnv = (process.env.CLICKUP_PLACEHOLDER_TASK_NAMES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const names = fromEnv.length ? fromEnv : ['Test Task'];

function isPlaceholderTaskName(name) {
  const n = (name || '').trim().toLowerCase();
  return names.some(p => p.toLowerCase() === n);
}

module.exports = { names, isPlaceholderTaskName };
