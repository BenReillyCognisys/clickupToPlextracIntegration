// Placeholder task names created by the ClickUp project template before the task
// is renamed to its real "Client | Testing Type". A task still carrying one of
// these names is not a real project yet, so the create pipeline skips it (no
// report, no Slack noise) and waits for the rename — which arrives as a taskUpdated
// webhook and is handled by pipeline/task-rename.js.
//
// Detection is two-layered, because an exact-match list only catches the template
// names we already know about:
//
//   • an exact (trimmed, case-insensitive) match against `names` — set per
//     deployment with CLICKUP_PLACEHOLDER_TASK_NAMES (comma-separated);
//   • a structural pattern that recognises template scaffolding by shape, e.g.
//     "PT - Project Template", "VMaaS Project List Template", "Test Task".
//     Override with CLICKUP_PLACEHOLDER_TASK_PATTERN (a JS regex source string).
//
// The pattern exists because the Penetration Test space's template task
// ("PT - Project Template") was absent from the list, so every templated deal ran
// the full create pipeline against the placeholder name and filed its report under
// a Plextrac client literally called "PT" — one shared client accumulating every
// project, which the rename sync then refuses to rename because it isn't sole-owner
// of its reports. Recognising template scaffolding structurally stops the next
// template name from doing the same thing.
//
// This is a belt-and-braces check: since pipeline/parse-task.js only resolves
// testing types it actually recognises, a placeholder that slips past here parses
// as 'Unknown' and is aborted by pipeline/index.js anyway — just noisily, with a
// Slack notice, rather than silently.
const fromEnv = (process.env.CLICKUP_PLACEHOLDER_TASK_NAMES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const names = fromEnv.length ? fromEnv : ['Test Task', 'PT - Project Template'];

// "<anything> template" / "template <anything>" for project scaffolding nouns, and
// the bare "test task". Anchored on word boundaries so a real client called
// "Template Recruitment Ltd" doesn't match on its own — it would need to look like
// "Template Project" to be skipped.
const DEFAULT_PATTERN = /\b(?:project|task|list|report)\s+template\b|\btemplate\s+(?:project|task|list)\b|\btest\s+task\b/i;

function pattern() {
  const src = (process.env.CLICKUP_PLACEHOLDER_TASK_PATTERN || '').trim();
  if (!src) return DEFAULT_PATTERN;
  try {
    return new RegExp(src, 'i');
  } catch {
    console.warn('[placeholder-task-names] CLICKUP_PLACEHOLDER_TASK_PATTERN is not a valid regex — using the default');
    return DEFAULT_PATTERN;
  }
}

function isPlaceholderTaskName(name) {
  const n = (name || '').trim();
  if (!n) return false;
  if (names.some(p => p.toLowerCase() === n.toLowerCase())) return true;
  return pattern().test(n);
}

module.exports = { names, isPlaceholderTaskName, DEFAULT_PATTERN };
