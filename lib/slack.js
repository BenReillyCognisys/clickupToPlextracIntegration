// Slack Web API helper for threaded messages.
//
// Incoming webhooks (lib/logger.js `notify`) can't thread — they post and return
// nothing. To post a parent message and then reply IN ITS THREAD we use
// chat.postMessage, which returns the message `ts` we thread the reply against.
//
// Requires a bot token (SLACK_BOT_TOKEN, `xoxb-...`) with the `chat:write` scope,
// and the bot must be a member of the target channel.

const axios = require('axios');

const POST_URL = 'https://slack.com/api/chat.postMessage';
const LOOKUP_URL = 'https://slack.com/api/users.lookupByEmail';

function botToken() {
  const t = process.env.SLACK_BOT_TOKEN;
  if (!t) throw new Error('SLACK_BOT_TOKEN is not set — required to post threaded Slack messages');
  return t;
}

async function chatPostMessage(payload) {
  const { data } = await axios.post(POST_URL, payload, {
    headers: {
      Authorization: `Bearer ${botToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  // The Slack Web API returns HTTP 200 with { ok: false, error } on failure.
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

// Posts a top-level message; returns its `ts` (the thread anchor).
async function postMessage(channel, text) {
  const data = await chatPostMessage({ channel, text });
  return data.ts;
}

// Posts a reply in the thread of `threadTs`.
async function postReply(channel, threadTs, text) {
  await chatPostMessage({ channel, text, thread_ts: threadTs });
}

// Resolves a Slack user id from an email address (for @-mentions). Requires the
// `users:read.email` scope. Returns the id, or null if no user matches.
async function lookupUserIdByEmail(email) {
  const { data } = await axios.get(LOOKUP_URL, {
    headers: { Authorization: `Bearer ${botToken()}` },
    params: { email },
  });
  if (!data.ok) {
    if (data.error === 'users_not_found') return null;
    throw new Error(`Slack API error: ${data.error}`);
  }
  return data.user?.id || null;
}

module.exports = { postMessage, postReply, lookupUserIdByEmail };
