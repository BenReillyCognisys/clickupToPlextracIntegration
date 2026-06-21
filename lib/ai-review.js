// AI-backed QA checks, powered by the Claude API (Anthropic SDK).
//
// IMPORTANT: this uses the Claude *API* (a billed ANTHROPIC_API_KEY from
// console.anthropic.com), NOT a Claude Pro/Max subscription. Pro is for
// interactive use (claude.ai, Claude Code); it cannot be called from a server.
//
// ── Cost ──────────────────────────────────────────────────────────────────────
// All QA checks for one segment run as a SINGLE structured-output request
// (reviewSegment), and the cheap defaults below keep the per-run cost low:
//   * Model defaults to Haiku 4.5 (~5x cheaper than Opus per token).
//   * Extended thinking is OFF by default (thinking tokens bill as output; for
//     these bounded edit tasks they're not needed). Turn on with QA_AI_THINKING.
//   * No `effort` is sent by default (it also isn't supported on Haiku).
// Raise quality at higher cost via ANTHROPIC_MODEL / QA_AI_THINKING / QA_AI_EFFORT.

const Anthropic = require('@anthropic-ai/sdk');
const log = require('./logger');
const PROTECTED_NAMES = require('../config/protected-names');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = Number(process.env.QA_AI_MAX_TOKENS || 4000);
const THINKING = process.env.QA_AI_THINKING === 'true';
// Only sent if explicitly configured (errors on Haiku 4.5, so leave unset there).
const EFFORT = process.env.QA_AI_EFFORT || null;

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
async function callJSON({ system, user, schema }) {
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (THINKING) params.thinking = { type: 'adaptive' };
  if (EFFORT) params.output_config.effort = EFFORT;

  const response = await client().messages.create(params);

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

// ── Combined review schema ────────────────────────────────────────────────────
// Edits-only response — the model returns just the spans to change (not the full
// rewritten text), which keeps output tokens (the expensive part) tiny. We apply
// the edits in code (pipeline/qa-review/checks.js).
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['client_name', 'dejargon'] },
          before: { type: 'string' },
          after: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['type', 'before', 'after', 'reason'],
      },
    },
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
  required: ['changes', 'incomplete'],
};

function buildSystem({ clientName, doClientName, doDejargon, doSentences }) {
  const tasks = [];
  if (doClientName) {
    const protectedList = PROTECTED_NAMES.map(n => `"${n}"`).join(', ');
    tasks.push(
      `- CLIENT NAME: the correct client/organisation name is "${clientName}". Replace any ` +
      'reference to a different, placeholder, or leftover example organisation name THAT REFERS ' +
      'TO THE CLIENT being tested with it. ' +
      `NEVER change ${protectedList} — that is the penetration-testing provider (the report ` +
      'author), NOT the client, so every occurrence is correct and must be left unchanged. Do ' +
      'NOT change third-party vendors, products, technologies, standards, or people. Record each ' +
      'replacement as a change with type "client_name".'
    );
  }
  if (doDejargon) {
    tasks.push(
      '- DE-JARGON: the ONLY goal is to make genuinely technical jargon understandable to a ' +
      'non-technical business audience. Edit a term ONLY when a non-technical reader would not ' +
      'understand it — primarily bare technical acronyms (TLS, SMB, RCE, XSS, CSRF, SQLi, LDAP, ' +
      'RDP, SSH, etc.), which you replace with a plain-language description. ' +
      'STRICT LIMITS — do NOT make any of these edits:\n' +
      '    * NO synonym swaps between words that are already plain English (e.g. do NOT change ' +
      '"assessment"↔"testing", "issue"↔"problem", "checked"↔"reviewed"). If the original word is ' +
      'already understandable to a layperson, leave it EXACTLY as written.\n' +
      '    * NEVER make wording MORE technical or more jargon-heavy (e.g. do NOT change "security ' +
      'issues" → "security vulnerabilities", or "weakness" → "vulnerability"). Simplify only; never ' +
      'escalate.\n' +
      '    * Do NOT rephrase, restyle, or "improve" sentences that contain no technical jargon.\n' +
      '  Preserve all facts, risk levels, severities and numbers. ' +
      'Also do NOT change standard penetration-testing engagement/scope terminology — leave these ' +
      'EXACTLY as written: black-box, grey-box (gray-box), white-box, internal, external, ' +
      'authenticated, unauthenticated, on-site, remote, red team, blue team, web application, ' +
      'infrastructure, assessment, security issue. These are precise terms the audience expects. ' +
      'When in doubt, make NO edit. Record each genuine simplification as a change with type "dejargon".'
    );
  }
  if (doSentences) {
    tasks.push(
      '- INCOMPLETE SENTENCES: identify (do NOT fix) sentences that are unfinished, cut off ' +
      'mid-thought, or contain placeholders (TODO/TBD/[insert], dangling clauses). Report them in ' +
      '"incomplete" only; do not emit edits for them.'
    );
  }

  return (
    'You are a meticulous report editor for a UK penetration-testing company. Use British ' +
    'English. Perform ONLY these tasks on the supplied text:\n' + tasks.join('\n') + '\n\n' +
    'CRITICAL: never add, remove, or alter Plextrac template placeholders of the form %%...%% ' +
    '(e.g. %%CLIENT_FULLNAME%%, %%CLIENT_SHORTNAME%%, %%REPORT_START_DATE%%, %%Author_01%%) — ' +
    'leave them byte-for-byte unchanged; Plextrac substitutes them at render time.\n' +
    'Return ONLY a minimal list of edits — do NOT return the full text. For each edit, "before" ' +
    'MUST be an exact verbatim substring copied from the input (so it can be located and ' +
    'replaced) and "after" is its replacement; keep both as short as possible. Do not emit edits ' +
    'where before == after. Also return "incomplete" (flagged sentences; empty if none or not ' +
    'requested). Make no edits beyond the tasks above.'
  );
}

// ── Single combined review of one segment ─────────────────────────────────────
// Runs the enabled checks in one request and returns just the edits + flags:
//   { changes: [{type,before,after,reason}], incomplete: [{sentence,issue}] }
// The caller applies the edits (before→after) to the text in code.
async function reviewSegment(text, opts = {}) {
  const { clientName, doClientName, doDejargon, doSentences } = opts;
  if (!text || !text.trim() || (!doClientName && !doDejargon && !doSentences)) {
    return { changes: [], incomplete: [] };
  }

  const system = buildSystem({ clientName, doClientName, doDejargon, doSentences });
  const user = `Text:\n"""\n${text}\n"""`;
  const res = await callJSON({ system, user, schema: REVIEW_SCHEMA });

  return {
    changes: Array.isArray(res.changes) ? res.changes : [],
    incomplete: Array.isArray(res.incomplete) ? res.incomplete : [],
  };
}

module.exports = { reviewSegment, MODEL };
