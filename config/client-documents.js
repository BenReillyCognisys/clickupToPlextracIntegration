// The client-facing documents made when a report is released (see
// pipeline/client-documents and docs/client-documents.md).
//
// Each one: Plextrac data → a prompt (prompts/<prompt>) → Claude → the template
// (jinja2-export-templates/<template>) → a PDF, filed in the report's Drive folder
// next to the full report and uploaded to the report's Artifacts in Plextrac.
//
//   key               id used in logs and by `scripts/preview-client-documents.js --doc`
//   name              filename prefix ("<name> <timestamp>.pdf") and artifact description
//   template          .j2 file in jinja2-export-templates/. A document whose template is
//                     missing is skipped with a warning, so an entry can be added before
//                     its template exists.
//   prompt            .md file in prompts/
//   outputs           what Claude must return: { key: what the value must contain }.
//                     Every value is HTML, cleaned to basic formatting (paragraphs,
//                     lists, bold/italic) before it reaches the template, and is
//                     available there as {{ AI.<key> }}.
//   replaceNarratives { 'Plextrac narrative label': 'output key' } — puts an output in
//                     place of that narrative's text, so a template that prints the
//                     narrative prints Claude's version without being edited.
module.exports = [
  {
    key: 'exec-summary',
    name: 'Executive Summary Report',
    template: 'cognisys-exec-summary.j2',
    prompt: 'exec-summary.md',
    outputs: {
      executive_summary: 'The rewritten Executive Summary section, as HTML: <p> paragraphs, '
        + 'with <ul>/<li> and <strong> only where they help. No headings - the template '
        + 'supplies the section heading.',
    },
    replaceNarratives: { 'Executive Summary': 'executive_summary' },
  },
  {
    key: 'letter-of-attestation',
    name: 'Letter of Attestation',
    template: 'cognisys-letter-of-attestation.j2',
    prompt: 'letter-of-attestation.md',
    outputs: {
      attestation_body: 'The body of the letter of attestation, as HTML <p> paragraphs: that '
        + 'the penetration test was performed, its scope, and the dates of testing. No '
        + 'salutation, sign-off or headings - the template supplies those.',
    },
  },
];
