const express = require('express');
const {
  cache,
  refreshCache,
  matchServiceType,
  createEngagementTask,
  requireApiKey,
  requireCache,
} = require('../lib/availability-cache');
const log = require('../lib/logger');

const router = express.Router();

// ── POST /schedule/pentest ────────────────────────────────────────────────────
// Creates a ClickUp engagement task from a chosen consultant/date range.
// Requires the X-API-Key header (AVAILABILITY_API_KEY) and a warm cache.
router.post('/pentest', requireApiKey, requireCache, async (req, res) => {
  const { testType, days, email, customerName, startDate, endDate, consultant, clickupCustomFields } = req.body || {};

  if (!testType || !days || !consultant || !startDate || !endDate) {
    return res.status(400).json({
      error: 'testType, days, consultant, startDate, and endDate are required',
    });
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

  try {
    const task = await createEngagementTask({
      consultant,
      startDate,
      endDate,
      serviceType:  lookup.match.service_type,
      days:         daysNum,
      customerName: customerName || null,
      email:        email        || null,
      membersMap:   cache.availability.membersMap,
      clickupCustomFields,
    });
    res.json({ success: true, task });

    // The new hold changes availability, so refresh the cache so subsequent
    // reads reflect it. Fire-and-forget to avoid delaying the response;
    // refreshCache() guards against overlapping runs internally.
    refreshCache().catch((err) =>
      log.error('Post-hold cache refresh failed', { reason: err.message })
    );
  } catch (err) {
    log.error('Engagement task creation failed', { reason: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
