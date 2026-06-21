const axios = require('axios');

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

function formatLine(level, message, data = {}) {
  const parts = [`[${level}] ${message}`];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`);
  }
  return parts.join(' | ');
}

function info(message, data) {
  console.log(formatLine('INFO', message, data));
}

function warn(message, data) {
  console.warn(formatLine('WARN', message, data));
}

function error(message, data) {
  console.error(formatLine('ERROR', message, data));
}

// Fire-and-forget plain Slack message — only call this for the two report
// creation notifications; everything else goes to console only.
function notify(message) {
  if (!SLACK_URL) return;
  axios.post(SLACK_URL, { text: message }).catch(err => {
    console.error('[logger] Slack post failed:', err.message);
  });
}

module.exports = { info, warn, error, notify };
