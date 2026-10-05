// The client-facing documents made when a report is released (see
// pipeline/client-documents and docs/client-documents.md).
//
// Each one: Plextrac data → the template (jinja2-export-templates/<template>), which
// fills itself from that data → a PDF, filed in the report's Drive folder and uploaded
// to the report's Artifacts in Plextrac.
//
//   key         id used in logs and by `scripts/preview-client-documents.js --doc`
//   name        what the logs, Slack notices and the Plextrac artifact call it
//   filename    filename prefix ("<filename> <timestamp>.pdf"); defaults to `name`
//   template    .j2 file in jinja2-export-templates/. A document whose template is
//               missing is skipped with a warning, so an entry can be added before its
//               template exists.
//   enabledBy   the .env switch for this document. On unless set to false / 0 / off /
//               no; switched off, the document isn't made at all on release.
//   findings    'full' = the template gets every finding's write-up, CVSS score,
//               affected assets and screenshots (pipeline/client-documents/data.js).
//               Anything else gets each finding's title and severity only.
//   pdfOptions  WeasyPrint write_pdf options for this document (renderer/render.py
//               accepts dpi, optimize_images and jpeg_quality).
module.exports = [
  {
    // The whole report as Plextrac holds it, laid out by the Cognisys template: the
    // narratives, then every finding (most severe first) with its CVSS
    // score and affected assets where they are set, and its screenshots.
    key: 'full-report',
    name: 'Full Report',
    filename: 'Full-Pentest-Report-Tech-Details',
    template: 'cognisys-full-report.j2',
    enabledBy: 'CLIENT_DOCS_FULL_REPORT_ENABLED',
    findings: 'full',
    // Screenshots arrive as full-resolution PNGs (2 MB+ each); 150 dpi is sharp on
    // screen and in print, and keeps a report with dozens of them to a sensible size.
    pdfOptions: { dpi: 150, optimize_images: true },
  },
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
