// Was a released report a retest — and when were the initial assessment and the
// retest done? Read for the letter of attestation, whose retest version names both
// testing periods, the kind of test and what was tested
// (jinja2-export-templates/cognisys-letter-of-attestation.j2).
//
// A retest is the same Plextrac report released again with its fixed findings Closed,
// and nothing on the report records the retest itself: the dates are only in the
// Executive Summary narrative, worded differently from report to report ("a follow-up
// retest conducted on 10-05-2026", "Retest Summary (5th October 2026)"). So Claude
// reads that narrative and answers in a fixed JSON shape, which is then checked here —
// a date that isn't a real date is treated as not given.
//
// The outcome, for the letter (readRetest):
//   retested, with a retest date   → the retest letter
//   not a retest                   → the standard letter
//   can't tell (Claude unsure, no retest date, no Executive Summary, the call fails)
//                                  → the standard letter AND a notice, which the
//                                    release posts in its Slack thread for a person
//                                    to check
// Never throws.

const Anthropic = require('@anthropic-ai/sdk');
const log = require('../../lib/logger');

const MODEL = process.env.LOA_RETEST_MODEL || 'claude-opus-5-5';
const EXEC_SUMMARY = 'Executive Summary';
const TZ = process.env.GOOGLE_DRIVE_REPORTS_TZ || 'Europe/London';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return _client;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

// "2026-10-05" → { y, m, d }, or null unless it is a real calendar date.
function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

const isoOf = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const longDate = ({ y, m, d }) => `${d} ${MONTHS[m - 1]} ${y}`;

// A Plextrac timestamp's date in UK time ("2026-08-17T11:34:10Z" → 2026-08-17), or null.
function ukDate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const date = new Date(/^\d+$/.test(String(value).trim()) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return null;
  return parseIsoDate(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date));
}

/**
 * A testing period as the letter words it, after "performed" / "a retest":
 *   one day            "on 5 October 2026"
 *   same month         "between 17 and 26 August 2026"
 *   same year          "between 28 August and 3 September 2026"
 *   across a year end  "between 29 December 2025 and 9 January 2026"
 * `end` may be null (one day). Dates are { y, m, d }.
 */
function formatPeriod(start, end) {
  if (!end || isoOf(end) === isoOf(start)) return `on ${longDate(start)}`;
  if (start.y !== end.y) return `between ${longDate(start)} and ${longDate(end)}`;
  if (start.m !== end.m) return `between ${start.d} ${MONTHS[start.m - 1]} and ${longDate(end)}`;
  return `between ${start.d} and ${longDate(end)}`;
}

// ── The Executive Summary ─────────────────────────────────────────────────────

// The narrative's text, without its HTML: one line per paragraph, list item or row.
function narrativeText(report, label = EXEC_SUMMARY) {
  const es = report?.exec_summary || report?.executive_summary || {};
  const narratives = Array.isArray(es) ? es : (Array.isArray(es.custom_fields) ? es.custom_fields : []);
  const wanted = label.toLowerCase();
  const found = narratives.find((n) => String(n?.label ?? n?.title ?? '').trim().toLowerCase() === wanted);
  const html = String(found?.text ?? found?.value ?? '');
  return html
    .replace(/<\s*(br|\/p|\/li|\/tr|\/h[1-6]|\/div)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .join('\n');
}

// ── Claude ────────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: 'object',
  properties: {
    retested: { type: 'string', enum: ['yes', 'no', 'unclear'] },
    initial_start: { type: 'string' },
    initial_end: { type: 'string' },
    retest_start: { type: 'string' },
    retest_end: { type: 'string' },
    test_type: { type: 'string' },
    target: { type: 'string' },
  },
  required: ['retested', 'initial_start', 'initial_end', 'retest_start', 'retest_end', 'test_type', 'target'],
  additionalProperties: false,
};

const SYSTEM = `You read the Executive Summary of a penetration test report and extract facts for the report's letter of attestation. Answer only from what the Executive Summary says; never guess.

Fields:
- retested: "yes" if the summary says a retest (re-test, follow-up test, remediation verification) was carried out after the initial assessment; "no" if it describes only the initial assessment; "unclear" if you cannot tell.
- initial_start, initial_end: the first and last day of the initial assessment, as YYYY-MM-DD. For a one-day assessment, give the same date twice.
- retest_start, retest_end: the first and last day of the retest, as YYYY-MM-DD. For a one-day retest, give the same date twice. If there were several retests, give the most recent.
- test_type: the kind of test, as it would read in "a ___ security assessment", in lower case, e.g. "grey-box", "black-box", "white-box", "authenticated".
- target: what was tested, as it would read after "a security assessment of", starting with "the", e.g. "the Acme web application and API".

Use "" for any field the summary does not state.

Dates: Plextrac prints dates month first, so 08-17-2026 is 17 August 2026 and 10-05-2026 is 5 October 2026. Written-out dates ("5th October 2026") are unambiguous. The report's own start and end dates are given as a cross-check for the initial assessment; prefer what the summary says.`;

// One structured-output request; the parsed answer. Throws on any failure.
async function askClaude({ text, clientName, reportName, start, end }) {
  const user = [
    `Client: ${clientName || 'unknown'}`,
    `Report: ${reportName || 'unknown'}`,
    `Report start date in Plextrac: ${start ? isoOf(start) : 'not set'}`,
    `Report end date in Plextrac: ${end ? isoOf(end) : 'not set'}`,
    '',
    '<executive_summary>',
    text,
    '</executive_summary>',
  ].join('\n');

  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read the Executive Summary');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of tokens before answering');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude gave no answer');
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error('Claude did not answer in JSON');
  }
}

// ── The letter's answer ───────────────────────────────────────────────────────

/**
 * Checks Claude's answer and turns it into the letter's retest details.
 * `start` / `end` are the report's Plextrac dates, used for the initial assessment
 * when the summary doesn't give it. Pure, for tests.
 *
 * @returns {{ retest: null | { initialStart, initialEnd, retestStart, retestEnd, testType, target },
 *             unsure: string | null }}
 *   unsure — why it couldn't be told whether, or when, the report was retested
 */
function interpret(answer, { start = null, end = null } = {}) {
  const retested = String(answer?.retested ?? '').trim().toLowerCase();
  if (retested === 'no') return { retest: null, unsure: null };
  if (retested !== 'yes') return { retest: null, unsure: 'the Executive Summary does not make clear whether it was retested' };

  const retestStart = parseIsoDate(answer.retest_start);
  if (!retestStart) return { retest: null, unsure: 'the Executive Summary says it was retested, but no retest date could be read from it' };
  let retestEnd = parseIsoDate(answer.retest_end);
  if (retestEnd && isoOf(retestEnd) < isoOf(retestStart)) retestEnd = null;

  // The initial assessment: the summary's dates, else Plextrac's.
  let initialStart = parseIsoDate(answer.initial_start);
  let initialEnd = parseIsoDate(answer.initial_end);
  if (initialStart && initialEnd && isoOf(initialEnd) < isoOf(initialStart)) initialEnd = null;
  if (!initialStart) [initialStart, initialEnd] = [start, end];
  if (initialStart && initialEnd && isoOf(initialEnd) < isoOf(initialStart)) initialEnd = null;

  const words = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return {
    retest: {
      initialStart: initialStart || null,
      initialEnd: initialEnd || null,
      retestStart,
      retestEnd: retestEnd || null,
      testType: words(answer.test_type).toLowerCase() || null,
      target: words(answer.target) || null,
    },
    unsure: null,
  };
}

/**
 * The retest details the letter needs, as the template reads them (REPORT_INFO.retest):
 *   initial_period  "between 17 and 26 August 2026" — null when no date is known
 *   retest_period   "on 5 October 2026"
 *   assessment      "a grey-box security assessment of the Userled web application and
 *                   API" — null when the summary doesn't say, and the letter keeps its
 *                   standard wording
 */
function templateRetest(retest) {
  if (!retest) return null;
  const { testType, target } = retest;
  return {
    initial_period: retest.initialStart ? formatPeriod(retest.initialStart, retest.initialEnd) : null,
    retest_period: formatPeriod(retest.retestStart, retest.retestEnd),
    assessment: testType && target
      ? `${/^[aeiou]/i.test(testType) ? 'an' : 'a'} ${testType} security assessment of ${target}`
      : null,
  };
}

/**
 * Reads whether, and when, a report was retested, for its letter of attestation.
 * Never throws. `ask` is the Claude call, replaceable in tests.
 *
 * @returns {Promise<{ retest: object | null, notice: string | null }>}
 *   retest — templateRetest()'s shape, or null for the standard letter
 *   notice — for the release's Slack thread, when it couldn't be told
 */
async function readRetest({ report, clientName, reportId, ask = askClaude }) {
  const start = ukDate(report?.start_date);
  const end = ukDate(report?.end_date);
  const standard = (why) => {
    log.warn('Letter of Attestation: could not tell whether the report was retested — standard letter made', { report_id: reportId, reason: why });
    return {
      retest: null,
      notice: `could not tell whether this report was retested (${why}), so the standard letter was made. If it was a retest, the letter needs redoing by hand.`,
    };
  };

  const text = narrativeText(report);
  if (!text) return standard('it has no Executive Summary');

  let answer;
  try {
    answer = await ask({ text, clientName, reportName: report?.name, start, end });
  } catch (err) {
    return standard(`reading the Executive Summary with Claude failed: ${err.message}`);
  }

  const { retest, unsure } = interpret(answer, { start, end });
  if (unsure) return standard(unsure);
  if (!retest) {
    log.info('Letter of Attestation: not a retest', { report_id: reportId });
    return { retest: null, notice: null };
  }
  const details = templateRetest(retest);
  log.info('Letter of Attestation: retest letter', {
    report_id: reportId, initial: details.initial_period, retest: details.retest_period, assessment: details.assessment,
  });
  return { retest: details, notice: null };
}

module.exports = {
  readRetest,
  interpret,
  templateRetest,
  formatPeriod,
  parseIsoDate,
  ukDate,
  narrativeText,
  SCHEMA,
};
