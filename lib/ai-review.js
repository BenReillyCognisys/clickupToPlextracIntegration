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
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revised_text: { type: 'string' },
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
  required: ['revised_text', 'changes', 'incomplete'],
};

function buildSystem({ clientName, doClientName, doDejargon, doSentences }) {
  const tasks = [];
  if (doClientName) {
    tasks.push(
      `- CLIENT NAME: the correct client/organisation name is "${clientName}". Replace any ` +
      'reference to a different, placeholder, or leftover example organisation name with it. Do ' +
      'NOT change third-party vendors, products, technologies, standards, or people. Record each ' +
      'replacement as a change with type "client_name".'
    );
  }
  if (doDejargon) {
    tasks.push(
      '- DE-JARGON: make the text readable by a non-technical business audience. Do not use bare ' +
      'technical acronyms (TLS, SMB, RCE, XSS, CSRF, SQLi, LDAP, RDP, SSH, etc.) — replace with ' +
      'plain-language descriptions; replace deep jargon with plain equivalents. Preserve all ' +
      'facts, risk levels, severities and numbers. Record each edit as a change with type ' +
      '"dejargon".'
    );
  }
  if (doSentences) {
    tasks.push(
      '- INCOMPLETE SENTENCES: identify (do NOT fix) sentences that are unfinished, cut off ' +
      'mid-thought, or contain placeholders (TODO/TBD/[insert], dangling clauses). Report them in ' +
      '"incomplete"; do not alter them in revised_text.'
    );
  }

  return (
    'You are a meticulous report editor for a UK penetration-testing company. Use British ' +
    'English. Perform ONLY these tasks on the supplied text:\n' + tasks.join('\n') + '\n\n' +
    'CRITICAL: never add, remove, or alter Plextrac template placeholders of the form %%...%% ' +
    '(e.g. %%CLIENT_FULLNAME%%, %%CLIENT_SHORTNAME%%, %%REPORT_START_DATE%%, %%Author_01%%) — ' +
    'leave them byte-for-byte unchanged; Plextrac substitutes them at render time.\n' +
    'Return: revised_text (the full text with any client-name and de-jargon edits applied, ' +
    'identical to the input if there are none), changes (one entry per applied edit), and ' +
    'incomplete (flagged sentences; empty if none or not requested). Make no edits beyond the ' +
    'tasks above.'
  );
}

// ── Single combined review of one segment ─────────────────────────────────────
// Runs the enabled checks in one request and returns:
//   { revised_text, changes: [{type,before,after,reason}], incomplete: [{sentence,issue}] }
async function reviewSegment(text, opts = {}) {
  const { clientName, doClientName, doDejargon, doSentences } = opts;
  if (!text || !text.trim() || (!doClientName && !doDejargon && !doSentences)) {
    return { revised_text: text, changes: [], incomplete: [] };
  }

  const system = buildSystem({ clientName, doClientName, doDejargon, doSentences });
  const user = `Text:\n"""\n${text}\n"""`;
  const res = await callJSON({ system, user, schema: REVIEW_SCHEMA });

  return {
    revised_text: typeof res.revised_text === 'string' ? res.revised_text : text,
    changes: Array.isArray(res.changes) ? res.changes : [],
    incomplete: Array.isArray(res.incomplete) ? res.incomplete : [],
  };
}

module.exports = { reviewSegment, MODEL };
