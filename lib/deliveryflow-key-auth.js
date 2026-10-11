// X-API-Key gate for routes DeliveryFlow calls: the DeliveryFlow shared secret
// (lib/deliveryflow-api.js deliveryFlowKey()), compared in constant time.

const crypto = require('crypto');
const { deliveryFlowKey } = require('./deliveryflow-api');

function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireDeliveryFlowKey(req, res, next) {
  const expected = deliveryFlowKey();
  const key = req.headers['x-api-key'];
  if (!expected || !key || !timingSafeMatch(key, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}

module.exports = { requireDeliveryFlowKey };
