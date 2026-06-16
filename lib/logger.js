const axios = require('axios');

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

const SLACK_EMOJI = {
  INFO:  '🔵',
  WARN:  '🟠',
  ERROR: '🔴',
};

function formatLine(level, message, data = {}) {
  const parts = [`[${level}] ${message}`];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`);
  }
  return parts.join(' | ');
}

// Fire-and-forget — Slack failures must never break the pipeline
function postSlack(level, text) {
  if (!SLACK_URL) return;
  axios.post(SLACK_URL, { text: `${SLACK_EMOJI[level]} ${text}` }).catch(err => {
    console.error('[logger] Slack post failed:', err.message);
  });
}

function info(message, data) {
  const line = formatLine('INFO', message, data);
  console.log(line);
  postSlack('INFO', line);
}

function warn(message, data) {
  const line = formatLine('WARN', message, data);
  console.warn(line);
  postSlack('WARN', line);
}

function error(message, data) {
  const line = formatLine('ERROR', message, data);
  console.error(line);
  postSlack('ERROR', line);
}

module.exports = { info, warn, error };
