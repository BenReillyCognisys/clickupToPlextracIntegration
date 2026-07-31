// Report-submission lateness math for the /report-kpis @user view.
//
// A report's ClickUp due date is a deadline DAY. Per the spec, the due day itself is
// never counted late — the clock starts at 09:00 on the NEXT WORKING DAY (Mon–Fri).
// So a report due Thursday starts its lateness clock at Friday 09:00; one due Friday
// starts Monday 09:00. Lateness is then the wall-clock hours from that start to the
// moment the report was submitted (moved to "Ready For Review"), clamped at 0 so an
// on-time or early submission reads as 0h late.
//
// All wall-clock times are interpreted in a single timezone (Europe/London by
// default) and converted to epoch ms with DST handled via Intl, so results don't
// depend on the server's timezone.

const TZ = process.env.KPI_LATE_TZ || process.env.REPORTS_DUE_TZ || 'Europe/London';
const START_HOUR = Number(process.env.KPI_LATE_START_HOUR) || 9;

// Offset (tz − UTC) in ms at the given instant — positive when tz is ahead of UTC
// (e.g. +3600000 during British Summer Time).
function tzOffsetMs(ms, tz = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(ms))) map[p.type] = p.value;
  const hour = map.hour === '24' ? '00' : map.hour; // some engines emit 24 at midnight
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +hour, +map.minute, +map.second);
  return asUTC - ms;
}

// The tz calendar date (year/month/day) an instant falls on.
function tzYMD(ms, tz = TZ) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(ms))) map[p.type] = p.value;
  return { y: +map.year, m: +map.month, d: +map.day };
}

// Epoch ms for a wall-clock (y, m, d, hour) in `tz`, DST-correct.
function wallClockToMs(y, m, d, hour, tz = TZ) {
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  return guess - tzOffsetMs(guess, tz);
}

// Epoch ms of START_HOUR on the next working day strictly after the due date's day.
function trackingStartMs(dueDateMs, tz = TZ) {
  const { y, m, d } = tzYMD(dueDateMs, tz);
  // Advance one calendar day at a time (via a UTC anchor — date-only, DST-agnostic),
  // skipping Saturday/Sunday, to land on the next working day.
  const anchor = new Date(Date.UTC(y, m - 1, d));
  do {
    anchor.setUTCDate(anchor.getUTCDate() + 1);
  } while (anchor.getUTCDay() === 0 || anchor.getUTCDay() === 6);
  return wallClockToMs(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate(), START_HOUR, tz);
}

// Hours a submission was late: wall-clock hours from the tracking start to
// `submittedMs`, clamped at 0 (on-time / early → 0). Returns null if the due date
// is missing/invalid.
function hoursLate(dueDateMs, submittedMs, tz = TZ) {
  const due = Number(dueDateMs);
  if (!Number.isFinite(due) || due <= 0) return null;
  const start = trackingStartMs(due, tz);
  const late = (Number(submittedMs) - start) / (60 * 60 * 1000);
  return late > 0 ? late : 0;
}

module.exports = { trackingStartMs, hoursLate, tzOffsetMs, tzYMD, wallClockToMs, TZ, START_HOUR };
