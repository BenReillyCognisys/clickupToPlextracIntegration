// Usage: node scripts/preview-client-documents.js <clientId> <reportId> [options]
//
// Builds the client documents (executive summary, letter of attestation) for a real
// report exactly as a release would — same Plextrac data, same prompt, same Claude
// call, same template — and writes them to disk. Nothing is uploaded: not to Drive,
// not to Plextrac. This is the loop for working on a prompt or a template.
//
// Options:
//   --doc <key>     only this document (exec-summary, letter-of-attestation)
//   --prompt        print the filled-in prompt(s) and stop — no Claude call, no cost
//   --no-ai         skip Claude: render the template with the report's own text (free;
//                   for template work)
//   --html          write the rendered HTML instead of a PDF (no WeasyPrint needed)
//   --out <dir>     where to write (default preview/)
//
// Each run prints Claude's output and token usage, and writes
// <name> <timestamp>.pdf plus a .json of what Claude returned next to it.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const clientDocuments = require('../pipeline/client-documents');
const DOCUMENTS = require('../config/client-documents');
const aiClient = require('../lib/client-doc-ai');
const api = require('../lib/plextrac-api');
const fields = require('../pipeline/qa-review/report-fields');

function parseArgs(argv) {
  const args = { positional: [], doc: null, prompt: false, ai: true, html: false, out: 'preview' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') args.doc = argv[++i];
    else if (a === '--prompt') args.prompt = true;
    else if (a === '--no-ai') args.ai = false;
    else if (a === '--html') args.html = true;
    else if (a === '--out') args.out = argv[++i];
    else args.positional.push(a);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const [clientId, reportId] = args.positional;
  if (!clientId || !reportId) {
    console.error('Usage: node scripts/preview-client-documents.js <clientId> <reportId> [--doc key] [--prompt] [--no-ai] [--html] [--out dir]');
    process.exit(1);
  }

  const documents = args.doc ? DOCUMENTS.filter((d) => d.key === args.doc) : DOCUMENTS;
  if (!documents.length) {
    console.error(`No document "${args.doc}". Known: ${DOCUMENTS.map((d) => d.key).join(', ')}`);
    process.exit(1);
  }

  const clientName = fields.clientNameFromRecord(await api.getClient(clientId), `Client ${clientId}`);
  const exportedAt = new Date();

  if (args.prompt) {
    const facts = { ...(await clientDocuments.loadReportData({ clientId, reportId })), clientName, exportedAt };
    for (const doc of documents) {
      console.log(`\n===== ${doc.key} — prompts/${doc.prompt} =====\n`);
      try {
        console.log(clientDocuments.buildPrompt(doc, facts));
      } catch (err) {
        console.log(`(cannot be filled for this report: ${err.message})`);
      }
    }
    return;
  }

  if (args.ai && !aiClient.isConfigured()) {
    console.error('EXEC_SUMMARY_EDIT_API_KEY is not set — set it in .env, or pass --no-ai.');
    process.exit(1);
  }

  const results = await clientDocuments.generateClientDocuments({
    clientId, reportId, clientName, exportedAt, documents,
    useAi: args.ai, output: args.html ? 'html' : 'pdf',
  });

  if (!results.length) {
    console.log('No documents to build — their templates are missing from jinja2-export-templates/.');
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });
  for (const r of results) {
    console.log(`\n===== ${r.doc.key} =====`);
    if (!r.ok) {
      console.log(`FAILED: ${r.error}`);
      continue;
    }
    if (r.meta) {
      console.log(`model: ${r.meta.model}  tokens in/out: ${r.meta.usage?.input_tokens}/${r.meta.usage?.output_tokens}`);
    }
    for (const [key, value] of Object.entries(r.values || {})) console.log(`\n--- ${key} ---\n${value}`);
    if (r.warnings?.length) console.log(`\nrenderer warnings:\n  ${r.warnings.join('\n  ')}`);

    const file = path.join(args.out, r.filename);
    fs.writeFileSync(file, r.buffer);
    fs.writeFileSync(`${file}.json`, JSON.stringify({ values: r.values, meta: r.meta }, null, 2));
    console.log(`\nwritten: ${file}`);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
