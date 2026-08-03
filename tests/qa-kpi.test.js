const assert = require('assert');
const {
  renderKpis, parseWindow, slackEscape, parseUserMention, renderUserStats,
} = require('../lib/qa-kpi');
const { normaliseUser, rowsOf, displayName } = require('../lib/plextrac-users');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const ok = (v) => assert.ok(v);

// ── renderKpis ──────────────────────────────────────────────────────────────
console.log('\nrenderKpis:');

test('empty leaderboard shows the no-activity line', () => {
  ok(renderKpis([]).includes('No QA activity recorded in this period'));
  ok(renderKpis(null).includes('No QA activity recorded in this period'));
});

test('numbers consultants and pluralises QA', () => {
  const out = renderKpis([
    { cuid: 'a', name: 'Alice', count: 3 },
    { cuid: 'b', name: 'Bob', count: 1 },
  ]);
  ok(out.includes('1. Alice — *3* QAs'));
  ok(out.includes('2. Bob — *1* QA'));  // singular
});

test('lists every consultant with plain 1..N numbering', () => {
  const entries = ['A', 'B', 'C', 'D'].map((n, i) => ({ cuid: n, name: n, count: 4 - i }));
  const out = renderKpis(entries);
  ok(out.includes('1. A — *4* QAs'));
  ok(out.includes('3. C — *2* QAs'));
  ok(out.includes('4. D — *1* QA'));
});

test('totals across consultants', () => {
  const out = renderKpis([
    { cuid: 'a', name: 'Alice', count: 3 },
    { cuid: 'b', name: 'Bob', count: 2 },
  ]);
  ok(out.includes('Total: 5 QAs (0 findings) across 2 consultants'));
});

test('shows findings total and average per report', () => {
  const out = renderKpis([
    { cuid: 'a', name: 'Alice', count: 5, totalFindings: 42, reportsWithFindings: 5 },
    { cuid: 'b', name: 'Bob', count: 5, totalFindings: 10, reportsWithFindings: 5 },
  ]);
  ok(out.includes('1. Alice — *5* QAs · 42 findings (avg 8.4/report)'));
  ok(out.includes('2. Bob — *5* QAs · 10 findings (avg 2/report)')); // whole avg drops .0
  ok(out.includes('Total: 10 QAs (52 findings) across 2 consultants'));
});

test('singular finding and clean whole-number average', () => {
  const out = renderKpis([{ cuid: 'a', name: 'Alice', count: 1, totalFindings: 1, reportsWithFindings: 1 }]);
  ok(out.includes('*1* QA · 1 finding (avg 1/report)'));
});

test('omits findings suffix when no report had a known count', () => {
  const out = renderKpis([{ cuid: 'a', name: 'Alice', count: 3, totalFindings: 0, reportsWithFindings: 0 }]);
  ok(out.includes('1. Alice — *3* QAs\n'));  // no " · ... findings" appended
  ok(!out.includes('findings (avg'));
});

test('escapes mrkdwn-special characters in names', () => {
  const out = renderKpis([{ cuid: 'a', name: 'A & B <Ltd>', count: 1 }]);
  ok(out.includes('A &amp; B &lt;Ltd&gt;'));
});

test('shows the window label in the header and empty state', () => {
  ok(renderKpis([{ cuid: 'a', name: 'Alice', count: 1 }], 'Q2 2026 (Apr–Jun)')
    .includes('QAs performed per consultant — Q2 2026 (Apr–Jun)'));
  ok(renderKpis([], 'last 31 days').includes('No QA activity recorded in this period'));
});

// ── parseWindow ─────────────────────────────────────────────────────────────
console.log('\nparseWindow:');

const NOW = new Date(Date.UTC(2026, 6, 31, 12, 0, 0)); // 2026-07-31 (in Q3)
const iso = (d) => d.toISOString();

test('empty / no arg → rolling last 31 days', () => {
  const w = parseWindow('', NOW);
  eq(w.label, 'last 31 days');
  eq(iso(w.until), iso(NOW));
  eq(iso(w.since), iso(new Date(Date.UTC(2026, 5, 30, 12, 0, 0)))); // 31 days before
});

test('31 aliases → last 31 days', () => {
  for (const a of ['31d', '31', '31days', '31 days', 'month']) {
    eq(parseWindow(a, NOW).label, 'last 31 days');
  }
});

test('arbitrary day counts → rolling last N days', () => {
  for (const [arg, n] of [['90d', 90], ['180d', 180], ['364', 364], ['7 days', 7]]) {
    const w = parseWindow(arg, NOW);
    eq(w.label, `last ${n} days`);
    eq(iso(w.until), iso(NOW));
    eq(iso(w.since), iso(new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)));
  }
});

test('1 day is singular', () => {
  eq(parseWindow('1d', NOW).label, 'last 1 day');
});

test('zero / out-of-range day counts → null', () => {
  eq(parseWindow('0d', NOW), null);
  eq(parseWindow('0', NOW), null);
  eq(parseWindow('99999d', NOW), null); // beyond the 3650-day cap
});

test('q1 → 1 Jan–1 Apr (exclusive) of current year', () => {
  const w = parseWindow('q1', NOW);
  eq(w.label, 'Q1 2026 (Jan–Mar)');
  eq(iso(w.since), iso(new Date(Date.UTC(2026, 0, 1))));
  eq(iso(w.until), iso(new Date(Date.UTC(2026, 3, 1))));
});

test('q2 → 1 Apr–1 Jul (exclusive), fully including 30 Jun', () => {
  const w = parseWindow('Q2', NOW);
  eq(iso(w.since), iso(new Date(Date.UTC(2026, 3, 1))));
  eq(iso(w.until), iso(new Date(Date.UTC(2026, 6, 1))));
});

test('q4 → 1 Oct–1 Jan next year (exclusive)', () => {
  const w = parseWindow('q4', NOW);
  eq(iso(w.since), iso(new Date(Date.UTC(2026, 9, 1))));
  eq(iso(w.until), iso(new Date(Date.UTC(2027, 0, 1))));
});

test('quarter with explicit year', () => {
  const w = parseWindow('q2 2025', NOW);
  eq(w.label, 'Q2 2025 (Apr–Jun)');
  eq(iso(w.since), iso(new Date(Date.UTC(2025, 3, 1))));
});

test('"quarter" / "q" → current quarter (Q3 for July)', () => {
  eq(parseWindow('quarter', NOW).label, 'Q3 2026 (Jul–Sep)');
  eq(parseWindow('q', NOW).label, 'Q3 2026 (Jul–Sep)');
});

test('unrecognised argument → null (caller shows usage)', () => {
  eq(parseWindow('q5', NOW), null);
  eq(parseWindow('lastyear', NOW), null);
  eq(parseWindow('q2 25', NOW), null); // 2-digit year not accepted
});

test('slackEscape handles nullish', () => {
  eq(slackEscape(null), '');
  eq(slackEscape('a & b'), 'a &amp; b');
});

// ── parseUserMention ─────────────────────────────────────────────────────────
console.log('\nparseUserMention:');

test('extracts id from an escaped mention with label', () => {
  eq(parseUserMention('<@U012ABC|ben.reilly>'), 'U012ABC');
});

test('extracts id from a bare escaped mention', () => {
  eq(parseUserMention('<@U012ABC>'), 'U012ABC');
});

test('supports enterprise (W) ids and surrounding text', () => {
  eq(parseUserMention('stats for <@W9Z8Y7X6> please'), 'W9Z8Y7X6');
});

test('returns null for non-mentions', () => {
  eq(parseUserMention('90d'), null);
  eq(parseUserMention('@Ben Reilly'), null); // unescaped — not resolvable
  eq(parseUserMention(''), null);
});

// ── renderUserStats ──────────────────────────────────────────────────────────
console.log('\nrenderUserStats:');

test('renders per-period QA work and submission lateness', () => {
  const out = renderUserStats('Ben Reilly', [
    {
      label: 'Last 30 days',
      stats: { count: 4, totalFindings: 30, reportsWithFindings: 4 },
      late: { count: 5, withDeadline: 5, lateCount: 2, avgHoursLate: 6.25 },
    },
    {
      label: 'Last 90 days',
      stats: { count: 11, totalFindings: 88, reportsWithFindings: 11 },
      late: { count: 12, withDeadline: 12, lateCount: 4, avgHoursLate: 5 },
    },
  ]);
  ok(out.includes('*QA KPIs — Ben Reilly*'));
  ok(out.includes('*Last 30 days:*'));
  ok(out.includes("• QA'd *4* reports · 30 findings (avg 7.5/report)"));
  ok(out.includes('• Submitted *5* reports · avg *6.3h* late (2 late)'));
  ok(out.includes("• QA'd *11* reports · 88 findings (avg 8/report)"));
  ok(out.includes('• Submitted *12* reports · avg *5h* late (4 late)'));
});

test('idle period shows no QAs and no submissions', () => {
  const out = renderUserStats('Jane', [
    {
      label: 'Last 30 days',
      stats: { count: 0, totalFindings: 0, reportsWithFindings: 0 },
      late: { count: 0, withDeadline: 0, lateCount: 0, avgHoursLate: null },
    },
  ]);
  ok(out.includes("• QA'd _no reports_"));
  ok(out.includes('• Submitted _no reports_'));
});

test('submissions without a due date show a count but no average', () => {
  const out = renderUserStats('Amy', [
    {
      label: 'Last 30 days',
      stats: { count: 0, totalFindings: 0, reportsWithFindings: 0 },
      late: { count: 3, withDeadline: 0, lateCount: 0, avgHoursLate: null },
    },
  ]);
  ok(out.includes('• Submitted *3* reports'));
  ok(!out.includes('avg'));
});

test('escapes special characters in the display name', () => {
  const out = renderUserStats('A & B <Ltd>', [
    {
      label: 'Last 30 days',
      stats: { count: 1, totalFindings: 0, reportsWithFindings: 0 },
      late: { count: 0, withDeadline: 0, lateCount: 0, avgHoursLate: null },
    },
  ]);
  ok(out.includes('A &amp; B &lt;Ltd&gt;'));
});

// ── plextrac-users normalisation ────────────────────────────────────────────
console.log('\nnormaliseUser:');

test('flat object with cuid + name', () => {
  eq(normaliseUser({ cuid: 'c1', id: 7, name: 'Jane Doe', email: 'j@x.com' }),
    { cuid: 'c1', id: 7, name: 'Jane Doe', email: 'j@x.com' });
});

test('builds name from first/last when name is absent', () => {
  const u = normaliseUser({ cuid: 'c2', first_name: 'John', last_name: 'Smith' });
  eq(u.name, 'John Smith');
});

test('handles camelCase field variants', () => {
  const u = normaliseUser({ userCuid: 'c3', userId: 9, firstName: 'Amy', lastName: 'Lee', userEmail: 'a@x.com' });
  eq(u.cuid, 'c3');
  eq(u.id, 9);
  eq(u.name, 'Amy Lee');
  eq(u.email, 'a@x.com');
});

test('unwraps a data-wrapped object', () => {
  const u = normaliseUser({ data: { cuid: 'c4', name: 'Wrapped User' } });
  eq(u.cuid, 'c4');
  eq(u.name, 'Wrapped User');
});

// The live v1 `user/list` shape: user nested under `data`, `name` an object with
// stray/doubled spaces. Must build "Adam Dickinson", not "[object Object]".
test('builds name from an object name {first,last} in the v1 user/list row', () => {
  const u = normaliseUser({
    id: 'a.dickinson@x.ac.uk',
    doc_id: [0],
    data: {
      cuid: 'cmlqgfun703e40gp31ff486pn',
      email: 'a.dickinson@x.ac.uk',
      name: { first: 'Adam ', last: 'Dickinson' },
      first: 'Adam ', last: 'Dickinson', fullName: 'Adam  Dickinson',
      user_id: 669852625,
    },
  });
  eq(u.cuid, 'cmlqgfun703e40gp31ff486pn');
  eq(u.id, 669852625);
  eq(u.name, 'Adam Dickinson');
  eq(u.email, 'a.dickinson@x.ac.uk');
});

test('rows without a cuid are dropped', () => {
  eq(normaliseUser({ id: 1, name: 'No Cuid' }), null);
  eq(normaliseUser(null), null);
  eq(normaliseUser({ data: [12, 'List Row Name'] }), null); // array-row shape has no cuid
});

console.log('\nrowsOf:');

test('accepts array, {data}, {users}, {results}', () => {
  eq(rowsOf([{ cuid: 'a' }]).length, 1);
  eq(rowsOf({ data: [{ cuid: 'a' }] }).length, 1);
  eq(rowsOf({ users: [{ cuid: 'a' }, { cuid: 'b' }] }).length, 2);
  eq(rowsOf({ results: [{ cuid: 'a' }] }).length, 1);
  eq(rowsOf(null).length, 0);
});

console.log('\ndisplayName:');

test('prefers name, then email, then a short cuid fallback', () => {
  eq(displayName({ name: 'Jane', email: 'j@x.com' }, 'cuid123'), 'Jane');
  eq(displayName({ email: 'j@x.com' }, 'cuid123'), 'j@x.com');
  ok(displayName(null, 'abcdefghijklmnop').includes('abcdefgh'));
  ok(displayName(undefined, undefined).includes('unknown'));
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
