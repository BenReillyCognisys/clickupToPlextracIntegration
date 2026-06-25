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

  const slots = [];
  for (const consultant of resolved) {
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
    qualified_consultants: resolved,
    name_resolution:       { matched, unmatched },
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
  const roster = ia.roster || [];

  const slots = [];
  for (const consultant of roster) {
    const slot = earliestRun(ia.days, consultant, daysNum);
    if (slot) slots.push(slot);
  }
  slots.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.end_date.localeCompare(b.end_date));

  const uniqueSlots = dedupeSlots(slots);

  res.json({
    request:             { days: daysNum },
    qualified_consultants: roster,
    availability_window: ia.window || null,
    next_available:      uniqueSlots[0] || null,
    alternatives:        uniqueSlots.slice(1),
    cache_generated_at:  ia.generated_at,
    cache_refreshed_at:  cache.lastRefresh,
  });
});

module.exports = router;
