const express = require('express');
const {
  cache,
  matchServiceType,
  resolveNames,
  earliestRun,
  requireApiKey,
  requireCache,
  requireInternalAuditCache,
} = require('../lib/availability-cache');

// Collapses slots covering the same start→end window — the consumer only needs
// each distinct date range once, not one entry per available consultant.
function dedupeSlots(slots) {
  const seen = new Set();
  return slots.filter((s) => {
    const key = `${s.start_date}|${s.end_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Consultants to suppress from the public availability views, regardless of
// what the ClickUp roster / service-type Doc returns. Matched case-insensitively
// on the resolved roster name.
const HIDDEN_CONSULTANTS = new Set(['ben reilly', 'kyle kriedemann']);
const isHidden = (name) => HIDDEN_CONSULTANTS.has(String(name).trim().toLowerCase());

const router = express.Router();

// ── GET /availability/pentest?testType=X&days=N ───────────────────────────────
// Returns the earliest available consultant slots for a service type, read from
// the background-refreshed cache. Requires the X-API-Key header.
router.get('/pentest', requireApiKey, requireCache, (req, res) => {
  const { testType, days } = req.query;
  if (!testType || !days) {
    return res.status(400).json({ error: 'testType and days query params are required' });
  }
  const daysNum = Number(days);
  if (!Number.isFinite(daysNum) || daysNum < 1) {
    return res.status(400).json({ error: 'days must be a positive integer' });
  }

  const lookup = matchServiceType(testType, cache.serviceTypes);
  if (lookup.none) {
    return res.status(404).json({
      error:                   `No service type matched "${testType}"`,
      available_service_types: lookup.all.map((s) => s.service_type),
    });
  }
  if (lookup.ambiguous) {
    return res.status(400).json({ error: `"${testType}" is ambiguous`, matches: lookup.ambiguous });
  }

  const match    = lookup.match;
  const roster   = cache.availability.roster || [];
  const { matched, unmatched, resolved } = resolveNames(match.independent, roster);

  const visibleResolved = resolved.filter((c) => !isHidden(c));

  const slots = [];
  for (const consultant of visibleResolved) {
    const slot = earliestRun(cache.availability.days, consultant, daysNum);
    if (slot) slots.push(slot);
  }
  slots.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.end_date.localeCompare(b.end_date));

  const uniqueSlots = dedupeSlots(slots);

  res.json({
    request: {
      testType,
      service_type: match.service_type,
      days:         daysNum,
    },
    qualified_consultants: visibleResolved,
    name_resolution:       { matched: matched.filter((m) => !isHidden(m.roster_name)), unmatched },
    availability_window:   cache.availability.window || null,
    next_available:        uniqueSlots[0]      || null,
    alternatives:          uniqueSlots.slice(1),
    cache_generated_at:    cache.availability.generated_at,
    cache_refreshed_at:    cache.lastRefresh,
  });
});

// ── GET /availability/freeblackbox ────────────────────────────────────────────
// "Free Black Box Test" — a half-day (0.5) variant of the Black Box Web App
// service. Surfaces Black Box-qualified consultants who have at least half a day
// free. Half-day availability is read from each day's fractional `load` (derived
// from tasks' "Days Balance" effort): a day where a consultant's committed load
// is <= 0.5 still has >= 0.5 day free.
//
//   • Within the next 2 weeks: ANY Black Box-qualified consultant with a half-day
//     GAP is surfaced (soonest first) — these are prioritised.
//   • After the 2-week window: up to 5 distinct dates, restricted to the priority
//     consultants (Chahat Mundra, Akshay Dandekar, Siddharth Johri).
//
// A "half-day gap" means the consultant is ALREADY booked for part of the day but
// has at least half a day still free (0 < load <= 0.5). A completely free day
// (load == 0) does NOT count — the point is to fill existing gaps, not consume a
// whole free day that could take a larger engagement.
//
// Requires the X-API-Key header. Booking still goes through POST /schedule/pentest
// with testType "Black Box Web App" and days 0.5.
const FREE_BLACKBOX_BASE_SERVICE = 'Black Box Web App';
const FREE_BLACKBOX_PRIORITY     = ['Chahat Mundra', 'Akshay Dandekar', 'Siddharth Johri'];
const PRIORITY_WINDOW_DAYS       = 14;
const HALF_DAY                   = 0.5;
const AFTER_OPTION_COUNT         = 5;
const EPS                        = 1e-9;

// True when the consultant is partially booked that day with at least half a day
// still free — i.e. an existing half-day gap the free test can slot into. A fully
// free day (load 0) and a (near-)full day (load > 0.5) both return false.
const hasHalfDayGap = (day, name) => {
  const load = (day.load && day.load[name]) || 0;
  return load > EPS && load <= HALF_DAY + EPS;
};

router.get('/freeblackbox', requireApiKey, requireCache, (req, res) => {
  const lookup = matchServiceType(FREE_BLACKBOX_BASE_SERVICE, cache.serviceTypes);
  if (lookup.none || lookup.ambiguous) {
    return res.status(500).json({
      error:  `Base service type "${FREE_BLACKBOX_BASE_SERVICE}" could not be resolved from the service-types Doc`,
      detail: lookup.ambiguous
        ? { ambiguous: lookup.ambiguous }
        : { available_service_types: lookup.all.map((s) => s.service_type) },
    });
  }

  const match  = lookup.match;
  const roster = cache.availability.roster || [];
  const days   = cache.availability.days   || [];

  // Black Box-qualified consultants (visible) — used for the 2-week priority window.
  const { matched, unmatched, resolved } = resolveNames(match.independent, roster);
  const qualified = resolved.filter((c) => !isHidden(c));

  // The named consultants, resolved to their roster names — used after 2 weeks.
  const priorityResolved = resolveNames(FREE_BLACKBOX_PRIORITY, roster).resolved.filter((c) => !isHidden(c));
  const priorityRank = (name) => {
    const i = priorityResolved.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Named consultants first (in the configured order), then the rest alphabetically.
  const orderConsultants = (names) =>
    [...names].sort((a, b) => priorityRank(a) - priorityRank(b) || a.localeCompare(b));

  const today    = cache.availability.today || null;
  const boundary = today
    ? new Date(Date.parse(`${today}T00:00:00Z`) + PRIORITY_WINDOW_DAYS * 86400000).toISOString().slice(0, 10)
    : null;

  // Within 2 weeks: any qualified consultant with a half-day gap (soonest first;
  // `days` is already chronological).
  const withinTwoWeeks = [];
  for (const day of days) {
    if (boundary && day.date > boundary) continue;
    const free = orderConsultants(qualified.filter((c) => hasHalfDayGap(day, c)));
    if (free.length) withinTwoWeeks.push({ date: day.date, weekday: day.weekday, consultants: free });
  }

  // After 2 weeks: distinct dates where a priority consultant has a half-day gap,
  // capped at 5 options.
  const afterOptions = [];
  for (const day of days) {
    if (boundary && day.date <= boundary) continue;
    const free = orderConsultants(priorityResolved.filter((c) => hasHalfDayGap(day, c)));
    if (free.length) afterOptions.push({ date: day.date, weekday: day.weekday, consultants: free });
    if (afterOptions.length >= AFTER_OPTION_COUNT) break;
  }

  const payload = {
    request:               { testType: 'Free Black Box Test', based_on: match.service_type, days: HALF_DAY },
    qualified_consultants: qualified,
    name_resolution:       { matched: matched.filter((m) => !isHidden(m.roster_name)), unmatched },
    availability_window:   cache.availability.window || null,
    priority_window:       boundary ? { start: today, end: boundary, days: PRIORITY_WINDOW_DAYS } : null,
    within_two_weeks:      withinTwoWeeks,
    after_two_weeks:       { prioritised_consultants: priorityResolved, options: afterOptions },
    next_available:        withinTwoWeeks[0] || afterOptions[0] || null,
    cache_generated_at:    cache.availability.generated_at,
    cache_refreshed_at:    cache.lastRefresh,
  };

  // ?debug=1 — surface how half-day load is actually being computed, so we can see
  // whether the "Days Balance" field is being read off tasks at all. Lists every
  // (consultant, date) with a non-zero load across the whole window for the
  // qualified + priority consultants, plus the distinct load values seen.
  if (req.query.debug) {
    const watch = [...new Set([...qualified, ...priorityResolved])];
    const loadByConsultant = {};
    const distinct = new Set();
    for (const day of days) {
      for (const name of watch) {
        const v = (day.load && day.load[name]) || 0;
        if (v > 0) {
          (loadByConsultant[name] = loadByConsultant[name] || []).push({ date: day.date, load: v });
          distinct.add(Number(v.toFixed(4)));
        }
      }
    }
    payload.debug = {
      load_stats:             cache.availability.loadStats || null,
      distinct_load_values:   [...distinct].sort((a, b) => a - b),
      nonzero_load_by_consultant: loadByConsultant,
      note: 'If distinct_load_values has no entries <= 0.5, no half-day gaps exist — '
          + 'either Days Balance is not set on tasks, or it is not being read (check load_stats).',
    };
  }

  res.json(payload);
});

// ── GET /availability/internalaudit?days=N ────────────────────────────────────
// Earliest available slots for an internal audit. Unlike /pentest there is no
// service-type/skill filtering — the roster is the assignees of the configured
// internal-audit ClickUp task, and the search is purely on day count. Requires
// the X-API-Key header.
router.get('/internalaudit', requireApiKey, requireInternalAuditCache, (req, res) => {
  const { days } = req.query;
  if (!days) {
    return res.status(400).json({ error: 'days query param is required' });
  }
  const daysNum = Number(days);
  if (!Number.isFinite(daysNum) || daysNum < 1) {
    return res.status(400).json({ error: 'days must be a positive integer' });
  }

  const ia     = cache.internalAudit;
  const roster = (ia.roster || []).filter((c) => !isHidden(c));

  // Per consultant, their earliest window that fits the requested day count. Only
  // consultants with such a window can deliver the job.
  const slots = [];
  for (const consultant of roster) {
    const slot = earliestRun(ia.days, consultant, daysNum);
    if (slot) slots.push(slot);
  }
  slots.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.end_date.localeCompare(b.end_date));

  // No date-window de-dupe here (unlike /pentest): every consultant's earliest
  // window is surfaced, even when two consultants share the same start→end range.
  res.json({
    request:               { days: daysNum },
    qualified_consultants: roster,
    // Consultants who can actually deliver the job (have an N-day slot), each with
    // their earliest available window. Subset of qualified_consultants.
    available_consultants: slots.map((s) => ({
      consultant: s.consultant,
      start_date: s.start_date,
      end_date:   s.end_date,
      days:       s.days,
    })),
    availability_window: ia.window || null,
    next_available:      slots[0] || null,
    alternatives:        slots.slice(1),
    cache_generated_at:  ia.generated_at,
    cache_refreshed_at:  cache.lastRefresh,
  });
});

module.exports = router;
