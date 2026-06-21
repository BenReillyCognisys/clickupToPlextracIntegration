const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
// Dedicated QA channel; falls back to the main Slack webhook if not set.
const QA_SLACK_URL = process.env.QA_SLACK_WEBHOOK_URL || SLACK_URL;
// Optional append-only log file. When set, every console line is mirrored here.
const LOG_FILE = process.env.LOG_FILE;

// Ensure the log directory exists once at startup (appendFile won't create it).
if (LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(LOG_FILE)), { recursive: true });
  } catch (err) {
    console.error('[logger] could not create log directory:', err.message);
  }
}

function formatLine(level, message, data = {}) {
  const parts = [`[${level}] ${message}`];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`);
  }
  return parts.join(' | ');
}

// Fire-and-forget append to the log file. Never throws — logging must not
// take down a request handler.
function toFile(level, line) {
  if (!LOG_FILE) return;
  const stamped = `${new Date().toISOString()} ${line}\n`;
  fs.appendFile(path.resolve(LOG_FILE), stamped, err => {
    if (err) console.error('[logger] log file write failed:', err.message);
  });
}

function info(message, data) {
  const line = formatLine('INFO', message, data);
  console.log(line);
  toFile('INFO', line);
}

function warn(message, data) {
  const line = formatLine('WARN', message, data);
  console.warn(line);
  toFile('WARN', line);
}

function error(message, data) {
  const line = formatLine('ERROR', message, data);
  console.error(line);
  toFile('ERROR', line);
}

// Fire-and-forget plain Slack message. Pass { url } to target a specific
// channel (e.g. the QA channel); defaults to the main SLACK_WEBHOOK_URL.
function notify(message, opts = {}) {
  const url = opts.url || SLACK_URL;
  if (!url) return;
  axios.post(url, { text: message }).catch(err => {
    console.error('[logger] Slack post failed:', err.message);
  });
}

// Convenience: post to the QA channel.
function notifyQA(message) {
  notify(message, { url: QA_SLACK_URL });
}

module.exports = { info, warn, error, notify, notifyQA };
