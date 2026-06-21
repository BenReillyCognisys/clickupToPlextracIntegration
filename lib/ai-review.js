// AI-backed QA checks, powered by the Claude API (Anthropic SDK).
//
// IMPORTANT: this uses the Claude *API* (a billed ANTHROPIC_API_KEY from
// console.anthropic.com), NOT a Claude Pro/Max subscription. Pro is for
// interactive use (claude.ai, Claude Code); it cannot be called from a server.
//
// Each function makes a single Messages API call with a JSON-schema-constrained
// response (structured outputs), so we always get back machine-parseable results
// with an explicit list of changes for the audit log.

const Anthropic = require('@anthropic-ai/sdk');
const log = require('./logger');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — required for AI QA checks');
  }
  _client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return _client;
}

// ── Core call helper ──────────────────────────────────────────────────────────
// Sends one structured-output request and returns the parsed object.
async function callJSON({ system, user, schema, effort = 'medium' }) {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude refused the QA request (stop_reason=refusal)');
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude response contained no text block');

  try {
    return JSON.parse(textBlock.text);
  } catch {
    throw new Error('Claude response was not valid JSON');
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────────
const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changed: { type: 'boolean' },
    revised_text: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          original: { type: 'string' },
          replacement: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['original', 'replacement', 'reason'],
      },
    },
  },
  required: ['changed', 'revised_text', 'changes'],
};

const SENTENCES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    incomplete: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sentence: { type: 'string' },
          issue: { type: 'string' },
        },
        required: ['sentence', 'issue'],
      },
    },
  },
  required: ['incomplete'],
};

// ── Check: correct the client name ────────────────────────────────────────────
// Replaces references to the wrong organisation (e.g. a template's example
// client, or a different company) with the correct client name.
async function correctClientName(text, correctName) {
  if (!text || !text.trim()) return { changed: false, revised_text: text, changes: [] };

  const system =
    'You are a meticulous report editor for a UK penetration-testing company. ' +
    'You correct the CLIENT/ORGANISATION name in report narrative text. Use British English. ' +
    'Replace any reference to the wrong client organisation — a different company name, a ' +
    'placeholder, or a leftover example name from a template — with the correct client name. ' +
    'Do NOT change names of third-party vendors, products, technologies, standards, or people ' +
    'that are legitimately mentioned. Preserve all other wording, facts, and meaning exactly. ' +
    'If nothing needs changing, return changed=false and the text unmodified.';

  const user =
    `Correct client / organisation name: "${correctName}"\n\n` +
    `Text to check:\n"""\n${text}\n"""\n\n` +
    'Return the corrected text and the list of replacements you made.';

  return callJSON({ system, user, schema: REWRITE_SCHEMA, effort: 'medium' });
}

// ── Check: de-jargon the executive summary ────────────────────────────────────
// Rewrites for a non-technical executive audience: expands or removes acronyms
// (TLS, SMB, etc.) and replaces deep technical jargon with plain language, while
// preserving the meaning, severity, and facts.
async function deJargonExecutiveSummary(text) {
  if (!text || !text.trim()) return { changed: false, revised_text: text, changes: [] };

  const system =
    'You are an editor making a penetration-test EXECUTIVE SUMMARY readable by a ' +
    'non-technical business audience (executives, board members). Use British English. ' +
    'Rules: (1) Do not use bare technical acronyms such as TLS, SMB, RCE, XSS, CSRF, SQLi, ' +
    'LDAP, RDP, SSH — replace them with plain-language descriptions (e.g. TLS → "the ' +
    'encryption that protects data in transit"; SMB → "the Windows file-sharing service"). ' +
    '(2) Replace deep technical jargon with plain equivalents. (3) Preserve all facts, risk ' +
    'levels, severities, numbers, and the overall meaning — do not soften or exaggerate ' +
    'findings. (4) Keep it concise and professional. If the summary is already suitable for a ' +
    'non-technical reader, return changed=false and the text unmodified.';

  const user =
    `Executive summary to review:\n"""\n${text}\n"""\n\n` +
    'Return the revised summary and a list of the specific jargon/acronym changes you made.';

  return callJSON({ system, user, schema: REWRITE_SCHEMA, effort: 'high' });
}

// ── Check: flag incomplete sentences ──────────────────────────────────────────
// Detection only — we deliberately do NOT auto-complete, because finishing a
// half-written sentence means inventing content the author did not write. These
// are reported to the author via Slack/log instead.
async function findIncompleteSentences(text) {
  if (!text || !text.trim()) return { incomplete: [] };

  const system =
    'You identify incomplete or truncated sentences in report text. Flag sentences that are ' +
    'grammatically unfinished, cut off mid-thought, end abruptly, or contain obvious ' +
    'placeholders (e.g. "TODO", "TBD", "[insert]", a trailing conjunction, or a dangling ' +
    'clause). Do NOT flag correctly-formed short sentences, headings, or bullet fragments that ' +
    'are intentionally terse. Only report genuine problems.';

  const user =
    `Text to check:\n"""\n${text}\n"""\n\n` +
    'Return the list of incomplete sentences with a short note on what is wrong with each.';

  return callJSON({ system, user, schema: SENTENCES_SCHEMA, effort: 'low' });
}

module.exports = {
  correctClientName,
  deJargonExecutiveSummary,
  findIncompleteSentences,
  MODEL,
};
