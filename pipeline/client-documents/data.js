// Plextrac data for the client-facing documents: what the templates are given.
//
// The templates receive a REDUCED copy of the report. Only the keys in REPORT_KEYS /
// CLIENT_KEYS are passed through, and each finding is cut down to FINDING_KEYS (its
// title and severity — enough for the letter of attestation to count them) — the
// documents are client-facing summaries, so the finding write-ups never reach the
// renderer at all. Removing the data here, rather than relying on the template not to
// print it, means a later template edit (or DEBUG_CONTEXT, which dumps the whole
// context into the PDF) cannot leak it. A template that needs another field has to be
// given it here, deliberately.
//
// Everything else — narratives, custom fields — is read by the templates themselves,
// from the shapes Plextrac supplies (see their _lookup macros).

const REPORT_KEYS = [
  'name', 'start_date', 'end_date', 'tags',
  'custom_field', 'custom_fields', 'fields',
  'exec_summary', 'executive_summary',
];
const CLIENT_KEYS = ['name', 'tags', 'custom_field', 'custom_fields', 'fields'];
const FINDING_KEYS = ['title', 'severity'];

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];

const TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

// "09-26-2026 14:30" — the export_datetime_us shape the templates read the issue date
// from (month first, as Plextrac supplies it): the exec summary's cover date and the
// letter's "(MONTH YEAR)".
function exportDatetimeUs(date, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const v = (type) => parts.find((p) => p.type === type)?.value;
  return `${v('month')}-${v('day')}-${v('year')} ${v('hour')}:${v('minute')}`;
}

// listReportFindings answers with an array or { data: [...] } depending on version,
// and each finding is either an object or — what this instance returns — a list row:
//   { id, doc_id, data: [flaw_id, severity, title, status, ...] }
// (positions confirmed against live reports, Sept 2026). Rows are turned into
// { flaw_id, severity, title, status } so everything downstream reads one shape.
function normaliseFindings(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  return list.map((f) => (Array.isArray(f?.data)
    ? { flaw_id: f.data[0], severity: f.data[1], title: f.data[2], status: f.data[3] }
    : f));
}

const severityOf = (f) => String(f?.severity ?? '').trim().toLowerCase();

// The FINDING_SUMMARY shape the templates read: { critical: { total }, ..., totals: { total_reported } }.
function findingSummary(findings) {
  const summary = Object.fromEntries(SEVERITIES.map((s) => [s, { total: 0 }]));
  for (const f of findings) if (summary[severityOf(f)]) summary[severityOf(f)].total += 1;
  summary.totals = { total_reported: findings.length };
  return summary;
}

const pick = (obj, keys) => Object.fromEntries(
  keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, structuredClone(obj[k])]),
);

/**
 * The variables a client-document template is rendered with — the names Plextrac's
 * own export uses, so the templates run unchanged.
 *
 * @param {object} args
 * @param {object} args.report        the Plextrac report (reduced to REPORT_KEYS here)
 * @param {object} args.clientRecord  the Plextrac client (reduced to CLIENT_KEYS here)
 * @param {Array}  args.findings      normalised findings (reduced to FINDING_KEYS here)
 * @param {Date}   args.exportedAt    the release's export time (issue date)
 */
function templateContext({ report, clientRecord, findings, exportedAt }) {
  const REPORT_INFO = pick(report, REPORT_KEYS);
  REPORT_INFO.export_datetime_us = exportDatetimeUs(exportedAt);

  return {
    REPORT_INFO,
    CLIENT_INFO: pick(clientRecord, CLIENT_KEYS),
    FINDINGS: findings.map((f) => pick(f, FINDING_KEYS)),
    FINDING_SUMMARY: findingSummary(findings),
  };
}

module.exports = {
  REPORT_KEYS,
  CLIENT_KEYS,
  FINDING_KEYS,
  exportDatetimeUs,
  normaliseFindings,
  findingSummary,
  templateContext,
};
