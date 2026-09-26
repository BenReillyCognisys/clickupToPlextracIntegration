// Usage: node scripts/preview-client-documents.js <clientId> <reportId> [options]
//
// Builds the client documents (executive summary, letter of attestation) for a real
// report exactly as a release would — same Plextrac data, same templates — and writes
// them to disk. Nothing is uploaded: not to Drive, not to Plextrac. This is the loop
// for working on a template. The .env on/off switches are ignored here, so a document
// can be checked before it is switched on.
//
// Options:
//   --doc <key>     only this document (exec-summary, letter-of-attestation)
//   --html          write the rendered HTML instead of a PDF (no WeasyPrint needed)
//   --out <dir>     where to write (default preview/)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const clientDocuments = require('../pipeline/client-documents');
const DOCUMENTS = require('../config/client-documents');

function parseArgs(argv) {
  const args = { positional: [], doc: null, html: false, out: 'preview' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') args.doc = argv[++i];
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
    console.error('Usage: node scripts/preview-client-documents.js <clientId> <reportId> [--doc key] [--html] [--out dir]');
    process.exit(1);
  }

  const documents = args.doc ? DOCUMENTS.filter((d) => d.key === args.doc) : DOCUMENTS;
  if (!documents.length) {
    console.error(`No document "${args.doc}". Known: ${DOCUMENTS.map((d) => d.key).join(', ')}`);
    process.exit(1);
  }

  const results = await clientDocuments.generateClientDocuments({
    clientId, reportId, exportedAt: new Date(), documents, output: args.html ? 'html' : 'pdf',
    respectSwitches: false,
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
    if (r.warnings?.length) console.log(`renderer warnings:\n  ${r.warnings.join('\n  ')}`);
    const file = path.join(args.out, r.filename);
    fs.writeFileSync(file, r.buffer);
    console.log(`written: ${file}`);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
