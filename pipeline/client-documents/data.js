// Plextrac data for the client-facing documents: what the prompts may reference, and
// what the templates are given.
//
// The templates receive a REDUCED copy of the report. Only the keys in REPORT_KEYS /
// CLIENT_KEYS are passed through, and FINDINGS is always empty — the documents are
// client-facing summaries, so the finding write-ups never reach the renderer at all
// (only the per-severity counts do). Removing the data here, rather than relying on
// the template not to print it, means a later template edit (or DEBUG_CONTEXT, which
// dumps the whole context into the PDF) cannot leak it. A template that needs another
// field has to be given it here, deliberately.
//
// Shapes are handled as tolerantly as the template's own _lookup macro handles them:
// narratives live in report.exec_summary.custom_fields as { label, text }, and custom
// fields arrive as a slug key, a `fields` dict, or a { label, value } list.

const sanitizeHtml = require('sanitize-html');

const REPORT_KEYS = [
  'name', 'start_date', 'end_date', 'tags',
  'custom_field', 'custom_fields', 'fields',
  'exec_summary', 'executive_summary',
];
const CLIENT_KEYS = ['name', 'tags', 'custom_field', 'custom_fields', 'fields'];

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];

const TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

// ── Narratives ────────────────────────────────────────────────────────────────

// The narrative list, from whichever key this report carries it under.
function narrativesOf(report) {
  for (const key of ['exec_summary', 'executive_summary']) {
    const val = report?.[key];
    if (Array.isArray(val?.custom_fields)) return val.custom_fields;
    if (Array.isArray(val)) return val;
  }
  return [];
}

const narrativeLabel = (f) => String(f?.label ?? f?.title ?? f?.name ?? '');
const narrativeText = (f) => String(f?.text ?? f?.value ?? f?.content ?? '');

// Same rule as the template's _label_matches: case- and whitespace-insensitive, and a
// trailing "s" is ignored ("Limitation" matches "Limitations").
function labelMatches(a, b) {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return x === y || x === `${y}s` || `${x}s` === y;
}

function findNarrative(report, label) {
  return narrativesOf(report).find((f) => labelMatches(narrativeLabel(f), label)) || null;
}

// ── Custom fields ─────────────────────────────────────────────────────────────

// The template's _key(): "Author 1 Email" → "author_1_email".
const fieldKey = (label) => String(label ?? '').replace(/ /g, '_').replace(/[()/:]/g, '').toLowerCase();

function customFieldValue(obj, label) {
  if (!obj) return '';
  const key = fieldKey(label);
  if (obj[key] && typeof obj[key] !== 'object') return String(obj[key]);
  if (obj.fields && !Array.isArray(obj.fields) && obj.fields[key]?.value) return String(obj.fields[key].value);
  for (const bag of [obj.fields, obj.custom_fields, obj.custom_field]) {
    if (!Array.isArray(bag)) continue;
    const hit = bag.find((f) => fieldKey(f?.label ?? f?.key) === key);
    const value = hit?.value ?? hit?.text;
    if (value) return String(value);
  }
  return '';
}

// ── Dates ─────────────────────────────────────────────────────────────────────

// Plextrac dates arrive as ISO strings or epoch milliseconds. Returns a Date, or null
// when the value isn't a date at all.
function toDate(value) {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' || /^\d+$/.test(String(value))
    ? new Date(Number(value))
    : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

// "26 September 2026". A value that isn't a date is returned as given.
function formatDate(value, tz = TZ) {
  const d = toDate(value);
  if (!d) return String(value ?? '');
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

// "09-26-2026 14:30" — the export_datetime_us shape the template parses its cover date
// from (month first, as Plextrac supplies it).
function exportDatetimeUs(date, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const v = (type) => parts.find((p) => p.type === type)?.value;
  return `${v('month')}-${v('day')}-${v('year')} ${v('hour')}:${v('minute')}`;
}

// ── Findings ──────────────────────────────────────────────────────────────────

// listReportFindings answers with an array or { data: [...] } depending on version.
function normaliseFindings(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

const severityOf = (f) => String(f?.severity ?? '').trim().toLowerCase();

// The FINDING_SUMMARY shape the template reads: { critical: { total }, ..., totals: { total_reported } }.
function findingSummary(findings) {
  const summary = Object.fromEntries(SEVERITIES.map((s) => [s, { total: 0 }]));
  for (const f of findings) if (summary[severityOf(f)]) summary[severityOf(f)].total += 1;
  summary.totals = { total_reported: findings.length };
  return summary;
}

// ── Claude's output ───────────────────────────────────────────────────────────

// Claude's text goes into the PDF through the template's |safe, so it is cut down to
// basic formatting first: no links, images, styles, scripts or attributes of any kind.
const ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li'];

function cleanHtml(text) {
  let html = String(text ?? '').trim();
  // Plain text (no tags at all) becomes paragraphs, so every value reaches the
  // template in one shape.
  if (!/<[a-z][^>]*>/i.test(html)) {
    html = html.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .map((p) => `<p>${escapeText(p)}</p>`).join('');
  }
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttributes: {} }).trim();
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Prompt placeholders ───────────────────────────────────────────────────────

/**
 * The {{placeholders}} a prompt may use, for one report. Only what a prompt actually
 * references is sent to Claude.
 */
function promptResolvers({ report, clientName, findings, exportedAt }) {
  const required = (value, what) => {
    if (!String(value ?? '').trim()) throw new Error(`${what} is empty on this report`);
    return value;
  };
  const sorted = [...findings].sort((a, b) => SEVERITIES.indexOf(severityOf(a)) - SEVERITIES.indexOf(severityOf(b)));

  return {
    client_name: () => required(clientName, 'client name'),
    report_name: () => required(report?.name, 'report name'),
    start_date: () => formatDate(required(report?.start_date, 'start date')),
    end_date: () => formatDate(required(report?.end_date, 'end date')),
    export_date: () => formatDate(exportedAt),
    narrative: (label) => {
      if (!label) throw new Error('needs a narrative label, e.g. {{narrative:Scope}}');
      const field = findNarrative(report, label);
      if (!field) throw new Error(`no "${label}" narrative on this report`);
      return required(narrativeText(field), `the "${label}" narrative`);
    },
    field: (label) => {
      if (!label) throw new Error('needs a field label, e.g. {{field:Author 1}}');
      return required(customFieldValue(report, label), `the "${label}" field`);
    },
    finding_counts: () => {
      const s = findingSummary(findings);
      return SEVERITIES.map((sev) => `${sev[0].toUpperCase()}${sev.slice(1)}: ${s[sev].total}`)
        .concat(`Total: ${findings.length}`).join('\n');
    },
    // Titles and severities only — never the write-ups.
    findings: () => (sorted.length
      ? sorted.map((f) => `- [${f.severity || 'Unrated'}] ${f.title || 'Untitled finding'}`).join('\n')
      : 'No findings were reported.'),
  };
}

// ── Template context ──────────────────────────────────────────────────────────

const pick = (obj, keys) => Object.fromEntries(
  keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, structuredClone(obj[k])]),
);

/**
 * The variables a client-document template is rendered with.
 *
 * @param {object} args
 * @param {object} args.report          the Plextrac report (reduced to REPORT_KEYS here)
 * @param {object} args.clientRecord    the Plextrac client (reduced to CLIENT_KEYS here)
 * @param {Array}  args.findings        used for counts only
 * @param {Date}   args.exportedAt      the release's export time (cover date)
 * @param {object} args.ai              Claude's values, already cleaned
 * @param {object} [args.replaceNarratives]  { narrative label: ai key }
 */
function templateContext({ report, clientRecord, findings, exportedAt, ai, replaceNarratives = {} }) {
  const REPORT_INFO = pick(report, REPORT_KEYS);
  REPORT_INFO.export_datetime_us = exportDatetimeUs(exportedAt);

  for (const [label, key] of Object.entries(replaceNarratives)) {
    if (ai[key] === undefined) continue;
    const list = narrativesOf(REPORT_INFO);
    const field = list.find((f) => labelMatches(narrativeLabel(f), label));
    if (field) {
      field.text = ai[key];
    } else {
      // No such narrative to replace: add one, so the template still finds it.
      REPORT_INFO.exec_summary = REPORT_INFO.exec_summary || {};
      REPORT_INFO.exec_summary.custom_fields = [...list, { label, text: ai[key] }];
    }
  }

  return {
    REPORT_INFO,
    CLIENT_INFO: pick(clientRecord, CLIENT_KEYS),
    FINDINGS: [],
    FINDING_SUMMARY: findingSummary(findings),
    AI: ai,
  };
}

module.exports = {
  REPORT_KEYS,
  CLIENT_KEYS,
  narrativesOf,
  findNarrative,
  narrativeText,
  labelMatches,
  customFieldValue,
  formatDate,
  exportDatetimeUs,
  normaliseFindings,
  findingSummary,
  cleanHtml,
  promptResolvers,
  templateContext,
};
