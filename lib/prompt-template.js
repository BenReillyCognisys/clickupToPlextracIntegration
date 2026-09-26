// Loads a prompt from prompts/ and fills in its {{placeholders}}.
//
// Prompts are plain Markdown files so they can be edited without touching code. The
// file is re-read on every use: save a change and the next release uses it, no
// restart needed.
//
//   {{name}}           a value, e.g. {{client_name}}
//   {{name:argument}}  a value that takes an argument, e.g. {{narrative:Scope}}
//   <!-- ... -->       a comment for whoever edits the prompt — removed before sending
//
// An unknown placeholder, or one whose data is missing from the report, is an ERROR
// rather than an empty string: a client document written from a half-empty prompt is
// worse than one that is flagged and made by hand.

const fs = require('fs');
const path = require('path');

const PROMPT_DIR = path.join(__dirname, '..', 'prompts');

const PLACEHOLDER = /\{\{\s*([a-z_]+)(?:\s*:\s*([^}]*?))?\s*\}\}/gi;
const COMMENT = /<!--[\s\S]*?-->/g;

function loadPrompt(name) {
  if (!name || path.basename(name) !== name) throw new Error(`Invalid prompt name "${name}"`);
  return fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
}

/**
 * Fills every placeholder in `text` via `resolvers[name](argument)`.
 *
 * @param {string} text
 * @param {Object<string, function(string=): string>} resolvers
 * @returns {string}
 * @throws naming every problem at once, so one edit round fixes them all
 */
function fillPrompt(text, resolvers) {
  const problems = [];
  const filled = String(text).replace(COMMENT, '').replace(PLACEHOLDER, (match, name, arg) => {
    const resolver = resolvers[name.toLowerCase()];
    if (!resolver) {
      problems.push(`unknown placeholder ${match}`);
      return match;
    }
    try {
      return String(resolver(arg?.trim()));
    } catch (err) {
      problems.push(`${match}: ${err.message}`);
      return match;
    }
  });

  if (problems.length) {
    throw new Error(`Prompt could not be filled — ${problems.join('; ')} `
      + `(available: ${Object.keys(resolvers).map((n) => `{{${n}}}`).join(', ')})`);
  }
  return filled.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { loadPrompt, fillPrompt, PROMPT_DIR };
