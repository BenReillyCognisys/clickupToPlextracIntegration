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
