// Client for DeliveryFlow's engagement-events endpoint.
//
// The portal (SFE) reports what happens to a DeliveryFlow engagement's forms —
// dates booked, test files uploaded, the signed form, a merged form, extra URLs on a
// Free Black Box — to break.services (routes/deliveryflow-portal.js), which forwards
// each one here as a single typed event. It is the DeliveryFlow counterpart of the
// ClickUp writes in routes/clickup-actions.js.
//
// One URL takes every event: POST DELIVERYFLOW_EVENTS_URL with
//   { event, engagementId, dealId, occurredAt, data }
// authenticated by the same shared secret DeliveryFlow sends us (DELIVERYFLOW_API_KEY,
// else AVAILABILITY_API_KEY), so there is one key to manage in both directions.

const axios = require('axios');

const TIMEOUT_MS = Number(process.env.DELIVERYFLOW_TIMEOUT_MS) || 15000;

// The shared secret for both directions. Read per call so a rotated key takes effect
// on restart without touching this file.
function deliveryFlowKey() {
  return process.env.DELIVERYFLOW_API_KEY || process.env.AVAILABILITY_API_KEY || null;
}

function isConfigured() {
  return Boolean(process.env.DELIVERYFLOW_EVENTS_URL && deliveryFlowKey());
}

// Compact, loggable error (status + trimmed body) that never includes the key. The
// HTTP status is attached as `.status` (null for a transport failure).
function deliveryFlowError(err, event) {
  const status = err.response?.status ?? null;
  const body = typeof err.response?.data === 'string'
    ? err.response.data
    : JSON.stringify(err.response?.data ?? err.message);
  const wrapped = new Error(`DeliveryFlow ${status || 'ERR'} ${event}: ${String(body).slice(0, 400)}`);
  wrapped.status = status;
  return wrapped;
}

/**
 * Sends one event about one engagement. Resolves with DeliveryFlow's parsed body on
 * any 2xx; throws a deliveryFlowError otherwise.
 */
async function sendEvent(event, { engagementId, dealId }, data) {
  const url = process.env.DELIVERYFLOW_EVENTS_URL;
  if (!url) throw new Error('DELIVERYFLOW_EVENTS_URL is not set');
  const key = deliveryFlowKey();
  if (!key) throw new Error('neither DELIVERYFLOW_API_KEY nor AVAILABILITY_API_KEY is set');

  try {
    const { data: body } = await axios.post(url, {
      event,
      engagementId,
      dealId: dealId ?? null,
      occurredAt: new Date().toISOString(),
      data,
    }, {
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
    });
    return body;
  } catch (err) {
    throw deliveryFlowError(err, event);
  }
}

module.exports = { sendEvent, isConfigured, deliveryFlowKey };
