// Runs the QA check suite over one text segment and returns the new text plus a
// structured record of everything that changed (for the audit log) and anything
// flagged for the author (incomplete sentences).

const { stripFormatting, hasFormatting } = require('../../lib/html-text');
const ai = require('../../lib/ai-review');
const log = require('../../lib/logger');
const { placeholdersPreserved } = require('../../lib/placeholders');
const { namesPreserved } = require('../../lib/protected-names');
const PROTECTED_NAMES = require('../../config/protected-names');

// Each check defaults ON; set the env var to "false" to disable it.
//
// NOTE: stripFormatting is PAUSED. The report fields are rich HTML (headings,
// tables, lists) and a blanket strip would flatten them. It will be redefined to
// strip only the specific formatting we want once examples are provided; until
// then it never runs, regardless of QA_CHECK_STRIP_FORMATTING.
const STRIP_FORMATTING_PAUSED = true;
const ENABLED = {
  stripFormatting: !STRIP_FORMATTING_PAUSED && process.env.QA_CHECK_STRIP_FORMATTING !== 'false',
  clientName: process.env.QA_CHECK_CLIENT_NAME !== 'false',
  deJargon: process.env.QA_CHECK_DEJARGON !== 'false',
  sentences: process.env.QA_CHECK_SENTENCES !== 'false',
};

// Per-edit guard: reject a single edit if applying it would (1) alter a %%...%%
// placeholder or (2) remove/rename a protected organisation name (e.g. Cognisys,
// the testing provider). Returns true if the edit is safe to apply; otherwise
// logs + records a flag. Rejecting one edit no longer discards the others.
function editIsSafe(before, after, change, ctx, flags) {
  if (!placeholdersPreserved(before, after)) {
    log.warn('Edit rejected — would alter a %% placeholder', { label: ctx.label });
    flags.push({
      type: 'placeholder_guard',
      label: ctx.label,
      sentence: `"${change.before}" → "${change.after}"`,
      issue: 'Edit NOT applied — it would have altered a %%...%% template variable',
    });
    return false;
  }
  if (!namesPreserved(before, after, PROTECTED_NAMES)) {
    log.warn('Edit rejected — would change a protected organisation name', { label: ctx.label });
    flags.push({
      type: 'protected_name_guard',
      label: ctx.label,
      sentence: `"${change.before}" → "${change.after}"`,
      issue: 'Edit NOT applied — this is the penetration-testing provider, not the client',
    });
    return false;
  }
  return true;
}

/**
 * @param {string} text             the segment's current text
 * @param {object} ctx
 * @param {string} ctx.label        human label for logging (e.g. "exec_summary")
 * @param {string} ctx.clientName   correct client name
 * @param {boolean} ctx.isExecutiveSummary  whether de-jargon applies
 * @param {boolean} ctx.clientNameOnly  reduced review (Methodology / Issue Matrix /
 *   Limitations): client-name check only — no de-jargon or sentence checks
 * @returns {{ finalText, changed, applied: [], flags: [] }}
 */
async function runChecks(text, ctx) {
  let current = text;
  const applied = [];
  const flags = [];

  // 1. Strip formatting (deterministic) ───────────────────────────────────────
  if (ENABLED.stripFormatting && hasFormatting(current)) {
    const stripped = stripFormatting(current);
    if (stripped !== current) {
      applied.push({ type: 'strip_formatting', label: ctx.label, before: current, after: stripped });
      current = stripped;
    }
  }

  // 2. AI review (client name + de-jargon + incomplete sentences) ───────────────
  // All enabled AI checks run in ONE request per segment to minimise API cost.
  // Reduced-review sections (Methodology, Issue Matrix, Limitations) get the
  // client-name check only — de-jargon and incomplete-sentence checks are skipped.
  const doClientName = ENABLED.clientName && !!ctx.clientName;
  const doDejargon = ENABLED.deJargon && ctx.isExecutiveSummary && !ctx.clientNameOnly;
  const doSentences = ENABLED.sentences && !ctx.clientNameOnly;

  if (doClientName || doDejargon || doSentences) {
    try {
      const res = await ai.reviewSegment(current, {
        clientName: ctx.clientName,
        doClientName,
        doDejargon,
        doSentences,
      });

      // Apply each edit (before→after) in code. Replaces all occurrences of the
      // verbatim "before" span; each edit is guarded individually.
      for (const c of res.changes || []) {
        if (!c.before || c.before === c.after || !current.includes(c.before)) continue;
        const candidate = current.split(c.before).join(c.after);
        if (candidate === current || !editIsSafe(current, candidate, c, ctx, flags)) continue;
        applied.push({ type: c.type, label: ctx.label, before: c.before, after: c.after, reason: c.reason });
        current = candidate;
      }

      // Incomplete sentences are detection-only (never auto-fixed).
      if (doSentences) {
        for (const s of res.incomplete || []) {
          flags.push({ type: 'incomplete_sentence', label: ctx.label, sentence: s.sentence, issue: s.issue });
        }
      }
    } catch (err) {
      log.error('AI review failed', { reason: err.message, label: ctx.label });
    }
  }

  return { finalText: current, changed: current !== text, applied, flags };
}

module.exports = { runChecks, ENABLED };
