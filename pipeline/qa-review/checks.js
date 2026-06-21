// Runs the QA check suite over one text segment and returns the new text plus a
// structured record of everything that changed (for the audit log) and anything
// flagged for the author (incomplete sentences).

const { stripFormatting, hasFormatting } = require('../../lib/html-text');
const ai = require('../../lib/ai-review');
const log = require('../../lib/logger');
const { placeholdersPreserved } = require('../../lib/placeholders');

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

// Guard: accept an AI revision only if it leaves every %%...%% placeholder
// untouched. Returns true if safe to apply; otherwise logs + records a flag.
function placeholderGuard(checkLabel, before, after, ctx, flags) {
  if (placeholdersPreserved(before, after)) return true;
  log.warn('AI revision rejected — would alter %% placeholders', {
    check: checkLabel, label: ctx.label,
  });
  flags.push({
    type: 'placeholder_guard',
    label: ctx.label,
    sentence: `${checkLabel} suggested an edit that changed a Plextrac %% placeholder`,
    issue: 'Edit NOT applied — it would have altered a %%...%% template variable',
  });
  return false;
}

/**
 * @param {string} text             the segment's current text
 * @param {object} ctx
 * @param {string} ctx.label        human label for logging (e.g. "exec_summary")
 * @param {string} ctx.clientName   correct client name
 * @param {boolean} ctx.isExecutiveSummary  whether de-jargon applies
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

  // 2. Correct client name (AI) ────────────────────────────────────────────────
  if (ENABLED.clientName && ctx.clientName) {
    try {
      const res = await ai.correctClientName(current, ctx.clientName);
      if (res.changed && res.revised_text && res.revised_text !== current
          && placeholderGuard('client_name', current, res.revised_text, ctx, flags)) {
        for (const c of res.changes || []) {
          applied.push({ type: 'client_name', label: ctx.label, before: c.original, after: c.replacement, reason: c.reason });
        }
        current = res.revised_text;
      }
    } catch (err) {
      log.error('Client-name check failed', { reason: err.message, label: ctx.label });
    }
  }

  // 3. De-jargon (AI) — executive summary only ─────────────────────────────────
  if (ENABLED.deJargon && ctx.isExecutiveSummary) {
    try {
      const res = await ai.deJargonExecutiveSummary(current);
      if (res.changed && res.revised_text && res.revised_text !== current
          && placeholderGuard('dejargon', current, res.revised_text, ctx, flags)) {
        for (const c of res.changes || []) {
          applied.push({ type: 'dejargon', label: ctx.label, before: c.original, after: c.replacement, reason: c.reason });
        }
        current = res.revised_text;
      }
    } catch (err) {
      log.error('De-jargon check failed', { reason: err.message, label: ctx.label });
    }
  }

  // 4. Flag incomplete sentences (AI) — detection only, never auto-completed ────
  if (ENABLED.sentences) {
    try {
      const res = await ai.findIncompleteSentences(current);
      for (const s of res.incomplete || []) {
        flags.push({ type: 'incomplete_sentence', label: ctx.label, sentence: s.sentence, issue: s.issue });
      }
    } catch (err) {
      log.error('Incomplete-sentence check failed', { reason: err.message, label: ctx.label });
    }
  }

  return { finalText: current, changed: current !== text, applied, flags };
}

module.exports = { runChecks, ENABLED };
