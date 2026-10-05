// Plextrac data for the client-facing documents: what the templates are given.
//
// The templates receive a REDUCED copy of the report. Only the keys in REPORT_KEYS /
// CLIENT_KEYS are passed through, and what each finding carries depends on the
// document (its `findings` setting in config/client-documents.js):
//
//   summary (default)  FINDING_KEYS - title and severity, enough for the letter of
//                      attestation to count them. The executive summary and the letter
//                      are client-facing summaries, so the finding write-ups never
//                      reach their renderer at all.
//   full               FULL_FINDING_KEYS - the write-up as well (description, technical
//                      details, recommendations, references, CVSS score, affected
//                      assets), for the full report. Nothing else: no comments,
//                      assignees, ticket links or exhibits, and each affected asset
//                      is cut down to its name and ports (ASSET_KEYS).
//
// Removing the data here, rather than relying on the template not to print it, means
// a later template edit (or DEBUG_CONTEXT, which dumps the whole context into the PDF)
// cannot leak it. A template that needs another field has to be given it here,
// deliberately.
//
// Everything else - narratives, custom fields - is read by the templates themselves,
// from the shapes Plextrac supplies (see their _lookup macros).

const REPORT_KEYS = [
  'name', 'start_date', 'end_date', 'tags',
  'custom_field', 'custom_fields', 'fields',
  'exec_summary', 'executive_summary',
];
const CLIENT_KEYS = ['name', 'tags', 'custom_field', 'custom_fields', 'fields'];
const FINDING_KEYS = ['title', 'severity'];
const FULL_FINDING_KEYS = [
  'flaw_id', 'title', 'severity', 'status', 'description', 'recommendations', 'references',
  'fields', 'risk_score', 'affected_assets', 'tags',
];
const ASSET_KEYS = ['asset', 'name', 'ports'];
const PORT_KEYS = ['number', 'protocol', 'service'];

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
//
// Every finding is kept, whatever its draft/published visibility: the release runs
// when the report is Published, which is what publishes its findings, and filtering
// on visibility would risk an empty report if the two ever arrived out of order.
function normaliseFindings(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  return list.map((f) => (Array.isArray(f?.data)
    ? { flaw_id: f.data[0], severity: f.data[1], title: f.data[2], status: f.data[3] }
    : f));
}

const severityOf = (f) => String(f?.severity ?? '').trim().toLowerCase();

// Most severe first, as the report reads; Plextrac's own order is kept within a
// severity. Unknown severities go last.
function bySeverity(findings) {
  const rank = (f) => { const i = SEVERITIES.indexOf(severityOf(f)); return i === -1 ? SEVERITIES.length : i; };
  return findings.map((f, i) => [f, i]).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([f]) => f);
}

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

// Plextrac's affected assets are a map of asset id -> asset record, and each record
// also carries every OTHER finding on that asset. Only the asset's name and its ports
// go to the template.
function reduceAssets(assets) {
  if (!assets || typeof assets !== 'object') return undefined;
  const reduceAsset = (a) => {
    if (!a || typeof a !== 'object') return a;
    const out = pick(a, ASSET_KEYS);
    if (out.ports && typeof out.ports === 'object' && !Array.isArray(out.ports)) {
      out.ports = Object.fromEntries(Object.entries(out.ports).map(([id, port]) => [id,
        port && typeof port === 'object' ? pick(port, PORT_KEYS) : port]));
    }
    return out;
  };
  return Array.isArray(assets)
    ? assets.map(reduceAsset)
    : Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, reduceAsset(a)]));
}

// A full finding cut down to what the full report prints.
function reduceFullFinding(f) {
  const out = pick(f, FULL_FINDING_KEYS);
  if (out.affected_assets !== undefined) out.affected_assets = reduceAssets(out.affected_assets);
  return out;
}

/**
 * The variables a client-document template is rendered with — the names Plextrac's
 * own export uses, so the templates run unchanged.
 *
 * @param {object} args
 * @param {object} args.report        the Plextrac report (reduced to REPORT_KEYS here)
 * @param {object} args.clientRecord  the Plextrac client (reduced to CLIENT_KEYS here)
 * @param {Array}  args.findings      normalised list rows ('summary') or full finding
 *                                    records ('full')
 * @param {Date}   args.exportedAt    the release's export time (issue date)
 * @param {'summary'|'full'} [args.detail='summary']  how much of each finding to pass:
 *                                    FINDING_KEYS or FULL_FINDING_KEYS
 */
function templateContext({ report, clientRecord, findings, exportedAt, detail = 'summary' }) {
  const REPORT_INFO = pick(report, REPORT_KEYS);
  REPORT_INFO.export_datetime_us = exportDatetimeUs(exportedAt);
  const included = bySeverity(findings);

  return {
    REPORT_INFO,
    CLIENT_INFO: pick(clientRecord, CLIENT_KEYS),
    FINDINGS: included.map((f) => (detail === 'full' ? reduceFullFinding(f) : pick(f, FINDING_KEYS))),
    FINDING_SUMMARY: findingSummary(included),
  };
}

module.exports = {
  REPORT_KEYS,
  CLIENT_KEYS,
  FINDING_KEYS,
  FULL_FINDING_KEYS,
  exportDatetimeUs,
  normaliseFindings,
  bySeverity,
  findingSummary,
  reduceFullFinding,
  templateContext,
};
