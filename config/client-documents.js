// The client-facing documents made when a report is released (see
// pipeline/client-documents and docs/client-documents.md).
//
// Each one: Plextrac data → the template (jinja2-export-templates/<template>), which
// fills itself from that data → a PDF, filed in the report's Drive folder next to the
// full report and uploaded to the report's Artifacts in Plextrac.
//
//   key        id used in logs and by `scripts/preview-client-documents.js --doc`
//   name       filename prefix ("<name> <timestamp>.pdf") and artifact description
//   template   .j2 file in jinja2-export-templates/. A document whose template is
//              missing is skipped with a warning, so an entry can be added before its
//              template exists.
//   enabledBy  the .env switch for this document. On unless set to false / 0 / off /
//              no; switched off, the document isn't made at all on release.
module.exports = [
  {
    // The report's own Executive Summary narrative, printed in full, plus the
    // introduction narratives.
    key: 'exec-summary',
    name: 'Executive Summary Report',
    template: 'cognisys-exec-summary.j2',
    enabledBy: 'CLIENT_DOCS_EXEC_SUMMARY_ENABLED',
  },
  {
    // Client name, the month issued, the hosts in the Scope narrative and the finding
    // counts, all filled by the template.
    key: 'letter-of-attestation',
    name: 'Letter of Attestation',
    template: 'cognisys-letter-of-attestation.j2',
    enabledBy: 'CLIENT_DOCS_LETTER_OF_ATTESTATION_ENABLED',
  },
];
