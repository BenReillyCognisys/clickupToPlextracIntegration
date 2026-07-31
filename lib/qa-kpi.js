// Builds the QA KPI leaderboard shown by the /report-kpis Slack command.
//
// Data flow: the Plextrac webhook records one { report_id, actor_cuid } row per
// QA a consultant performs (see lib/qa-kpi-store.js). Here we aggregate those into
// per-consultant totals and resolve each actor_cuid to a name via lib/plextrac-users.
//
// `renderKpis` is a pure function (entries → mrkdwn string) so it can be unit-tested
// without a database or the Plextrac API.

const kpiStore = require('./qa-kpi-store');
const submissionStore = require('./qa-submission-store');
const users = require('./plextrac-users');
const log = require('./logger');

// Escapes the three characters special in Slack mrkdwn.
function slackEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Builds a calendar-quarter window: Q1 = 1 Jan–31 Mar, Q2 = 1 Apr–30 Jun,
// Q3 = 1 Jul–30 Sep, Q4 = 1 Oct–31 Dec. `until` is the exclusive start of the next
// quarter, so the final day is fully included. Boundaries are UTC midnight — near
// enough for a leaderboard (Cognisys is UK-based; BST shifts an edge by ≤1h).
function quarterWindow(q, year) {
  const startMonth = (q - 1) * 3; // Q1→0, Q2→3, Q3→6, Q4→9
  const since = new Date(Date.UTC(year, startMonth, 1));
  const until = new Date(Date.UTC(year, startMonth + 3, 1)); // exclusive
  return { label: `Q${q} ${year} (${MONTHS[startMonth]}–${MONTHS[startMonth + 2]})`, since, until };
}

// Largest rolling window accepted (10 years) — guards against absurd day counts.
const MAX_WINDOW_DAYS = 3650;

// Builds a rolling last-N-days window ending now.
function daysWindow(n, now) {
  return {
    label: `last ${n} day${n === 1 ? '' : 's'}`,
    since: new Date(now.getTime() - n * 24 * 60 * 60 * 1000),
    until: now,
  };
}

// Parses the /report-kpis argument into a time window { label, since, until }.
//   • ""                       → rolling last 31 days (the default)
//   • "90d" / "90" / "90 days" / "month" → rolling last N days (1..3650)
//   • "q1".."q4" (optionally with a year, e.g. "q2 2025") → that calendar quarter
//   • "quarter" / "q"          → the current quarter
// Returns null for anything unrecognised or out of range (caller shows usage help).
function parseWindow(arg, now = new Date()) {
  const raw = String(arg || '').trim().toLowerCase().replace(/\s+/g, ' ');

  if (raw === '' || raw === 'month') return daysWindow(31, now);

  // "<N>", "<N>d", "<N> days" → rolling last N days.
  const dm = raw.match(/^(\d+) ?(?:d|days?)?$/);
  if (dm) {
    const n = Number(dm[1]);
    if (n >= 1 && n <= MAX_WINDOW_DAYS) return daysWindow(n, now);
    return null; // zero or out of range
  }

  if (raw === 'quarter' || raw === 'q' || raw === 'thisquarter' || raw === 'this quarter') {
    const q = Math.floor(now.getUTCMonth() / 3) + 1;
    return quarterWindow(q, now.getUTCFullYear());
  }

  const m = raw.match(/^q([1-4])(?: (\d{4}))?$/);
  if (m) {
    const year = m[2] ? Number(m[2]) : now.getUTCFullYear();
    return quarterWindow(Number(m[1]), year);
  }

  return null;
}

// Aggregates the KPI store and resolves each consultant's cuid to a display name.
// Returns [{ cuid, name, count, email }] sorted by count desc (name asc to break
// ties deterministically). Degrades gracefully if user resolution fails — the
// counts are still shown, keyed by a short cuid. Pass a { since, until } window to
// restrict to credits earned in that period.
async function buildKpiEntries(window = {}) {
  const rows = await kpiStore.aggregateByActor(window);

  let map = new Map();
  try {
    map = await users.cuidMap();
  } catch (err) {
    log.error('QA KPIs: failed to resolve Plextrac users — showing cuids', { reason: err.message });
  }

  const entries = rows.map(r => {
    const user = map.get(r.cuid);
    return {
      cuid:  r.cuid,
      name:  users.displayName(user, r.cuid),
      email: user?.email || null,
      count: r.count,
      totalFindings: r.totalFindings || 0,
      reportsWithFindings: r.reportsWithFindings || 0,
    };
  });

  entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return entries;
}

const RANK = ['🥇', '🥈', '🥉'];

// Renders the leaderboard as Slack mrkdwn. Pure — no I/O. `windowLabel` (e.g.
// "last 31 days", "Q2 2026 (Apr–Jun)") is shown in the header for context.
function renderKpis(entries, windowLabel) {
  const suffix = windowLabel ? ` — ${slackEscape(windowLabel)}` : '';
  const header = `*QA KPIs — QAs performed per consultant${suffix}*`;

  if (!entries || entries.length === 0) {
    return `${header}\n\n_No QA activity recorded in this period._`;
  }

  const total = entries.reduce((sum, e) => sum + e.count, 0);
  const totalFindings = entries.reduce((sum, e) => sum + (e.totalFindings || 0), 0);

  const lines = entries.map((e, i) => {
    const rank = RANK[i] || `${i + 1}.`;
    const qa = e.count === 1 ? 'QA' : 'QAs';
    return `${rank} ${slackEscape(e.name)} — *${e.count}* ${qa}${findingsSuffix(e)}`;
  });

  return [
    header,
    '',
    ...lines,
    '',
    `_Total: ${total} QA${total === 1 ? '' : 's'} (${totalFindings} finding${totalFindings === 1 ? '' : 's'}) across ${entries.length} consultant${entries.length === 1 ? '' : 's'}._`,
    '_A consultant is credited once per report; the initial "Ready For Review" submission is not counted._',
    '_Findings = report size at QA time (avg per report), to distinguish large from short reports._',
  ].join('\n');
}

// " · N findings (avg M/report)" for a consultant, or "" when no report of theirs
// had a known findings count (so we never show a misleading "0 findings").
function findingsSuffix(e) {
  const known = e.reportsWithFindings || 0;
  if (known === 0) return '';
  const total = e.totalFindings || 0;
  const avg = total / known;
  // One decimal, but drop a trailing ".0" so whole numbers read cleanly.
  const avgStr = avg.toFixed(1).replace(/\.0$/, '');
  const findings = total === 1 ? 'finding' : 'findings';
  return ` · ${total} ${findings} (avg ${avgStr}/report)`;
}

// ── Per-user lookup (/report-kpis @user) ─────────────────────────────────────

// Extracts a Slack user id from an escaped mention (`<@U012ABC|name>` or
// `<@U012ABC>`; enterprise ids start with W). Returns the id, or null if the text
// has no escaped mention. Requires the slash command's "Escape channels, users, and
// links" option — without it Slack sends the literal "@Name" text, which cannot be
// resolved to an id.
function parseUserMention(text) {
  const m = String(text || '').match(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/);
  return m ? m[1] : null;
}

// The fixed windows shown for an @user lookup.
const USER_PERIODS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

// Gathers a single consultant's stats for each USER_PERIODS window — both QA work
// done and their own report-submission lateness. Returns
// [{ label, stats: {...}, late: {...} }].
async function buildUserPeriods(actorCuid, now = new Date()) {
  const periods = [];
  for (const p of USER_PERIODS) {
    const window = { since: new Date(now.getTime() - p.days * 24 * 60 * 60 * 1000), until: now };
    const stats = await kpiStore.statsForActor(actorCuid, window);
    const late = await submissionStore.lateStatsForActor(actorCuid, window);
    periods.push({ label: p.label, stats, late });
  }
  return periods;
}

// "6.3h" (drops a trailing ".0" so whole numbers read cleanly).
function formatHours(h) {
  return `${h.toFixed(1).replace(/\.0$/, '')}h`;
}

// QA-work line for a period: "QA'd *N* reports · … findings", or idle text.
function qaLine(stats) {
  if (!stats || !stats.count) return "QA'd _no reports_";
  const reports = stats.count === 1 ? 'report' : 'reports';
  return `QA'd *${stats.count}* ${reports}${findingsSuffix(stats)}`;
}

// Submission-lateness line for a period: how many reports the consultant submitted
// and their average hours late (from 09:00 the next working day after the due date).
function submissionLine(late) {
  if (!late || !late.count) return 'Submitted _no reports_';
  const reports = late.count === 1 ? 'report' : 'reports';
  let line = `Submitted *${late.count}* ${reports}`;
  if (late.withDeadline > 0 && late.avgHoursLate != null) {
    line += ` · avg *${formatHours(late.avgHoursLate)}* late (${late.lateCount} late)`;
  }
  return line;
}

// Renders a single consultant's stats across the given periods, grouping QA work and
// submission lateness under each period. Pure — no I/O. Lateness is only shown here
// (never on the leaderboard).
function renderUserStats(displayName, periods) {
  const lines = [`*QA KPIs — ${slackEscape(displayName)}*`];
  for (const p of periods) {
    lines.push('', `*${p.label}:*`, `• ${qaLine(p.stats)}`, `• ${submissionLine(p.late)}`);
  }
  lines.push(
    '',
    '_QA credited once per report; the initial "Ready For Review" submission is not counted. ' +
    'Findings = report size at QA time. Lateness runs from 09:00 the next working day after the ClickUp due date._'
  );
  return lines.join('\n');
}

module.exports = {
  buildKpiEntries, renderKpis, parseWindow, slackEscape,
  parseUserMention, buildUserPeriods, renderUserStats,
};
