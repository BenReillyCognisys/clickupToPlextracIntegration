// Claude calls for the client-facing documents (pipeline/client-documents): turns a
// filled-in prompt from prompts/ into the text a document's template prints.
//
// Uses its own key, EXEC_SUMMARY_EDIT_API_KEY, rather than the QA review's
// ANTHROPIC_API_KEY, so the spend and rate limits of client documents are tracked and
// capped separately. Both documents (executive summary, letter of attestation) use it.
//
// Every document gets a structured-output request: the reply MUST be a JSON object
// with exactly the keys the document's `outputs` names (config/client-documents.js),
// so no amount of prompt editing can make Claude return something the pipeline
// can't place.
//
// Configuration (see .env.example → "Client documents"):
//   EXEC_SUMMARY_EDIT_API_KEY    Claude API key — REQUIRED, else the documents are skipped
//   EXEC_SUMMARY_EDIT_MODEL      model (default claude-opus-5)
//   EXEC_SUMMARY_EDIT_EFFORT     low | medium | high | xhigh | max (default high)
//   EXEC_SUMMARY_EDIT_FALLBACKS  "false" turns off the server-side refusal fallback

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.EXEC_SUMMARY_EDIT_MODEL || 'claude-opus-5';
const EFFORT = process.env.EXEC_SUMMARY_EDIT_EFFORT ?? 'high';
// On a safety-classifier refusal the API re-runs the request on the model Anthropic
// recommends for that refusal category, inside the same call, instead of returning
// nothing. Off switch in case a future model does not support it.
const FALLBACKS = process.env.EXEC_SUMMARY_EDIT_FALLBACKS !== 'false';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 16000;

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.EXEC_SUMMARY_EDIT_API_KEY) {
    throw new Error('EXEC_SUMMARY_EDIT_API_KEY is not set — required for client documents');
  }
  _client = new Anthropic({
    apiKey: process.env.EXEC_SUMMARY_EDIT_API_KEY,
    timeout: 5 * 60 * 1000,
    maxRetries: 2,
  });
  return _client;
}

function isConfigured() {
  return Boolean(process.env.EXEC_SUMMARY_EDIT_API_KEY);
}

// { key: description } → a strict JSON schema requiring every key as a string.
function outputSchema(outputs) {
  const keys = Object.keys(outputs);
  return {
    type: 'object',
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string', description: outputs[k] }])),
  };
}

/**
 * Sends one filled-in prompt and returns Claude's values for the document's outputs.
 *
 * @param {object} args
 * @param {string} args.prompt   the prompt text, placeholders already filled
 * @param {Object<string,string>} args.outputs  { key: what that key must contain }
 * @returns {Promise<{values: Object<string,string>, model: string, usage: object}>}
 */
async function generate({ prompt, outputs }) {
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: outputSchema(outputs) } },
    messages: [{ role: 'user', content: prompt }],
  };
  if (EFFORT) params.output_config.effort = EFFORT;

  const response = FALLBACKS
    ? await client().beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
    : await client().messages.create(params);

  return { values: parseResponse(response, outputs), model: response.model, usage: response.usage };
}

// Claude's reply → { key: text } for every key in `outputs`, or a readable error.
function parseResponse(response, outputs) {
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category || 'unspecified';
    throw new Error(`Claude declined the request (refusal, category ${category})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Claude's reply was cut off at ${MAX_TOKENS} tokens`);
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let values;
  try {
    values = JSON.parse(text);
  } catch {
    throw new Error('Claude did not return valid JSON');
  }
  for (const key of Object.keys(outputs)) {
    if (typeof values?.[key] !== 'string' || !values[key].trim()) {
      throw new Error(`Claude returned no text for "${key}"`);
    }
  }
  return values;
}

module.exports = { generate, parseResponse, isConfigured, outputSchema, MODEL };
