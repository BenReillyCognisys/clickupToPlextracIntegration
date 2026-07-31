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
const UPDATE_URL = 'https://slack.com/api/chat.update';
const DELETE_URL = 'https://slack.com/api/chat.delete';
const LOOKUP_URL = 'https://slack.com/api/users.lookupByEmail';
const INFO_URL = 'https://slack.com/api/users.info';

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

// Edits the text of a message the bot previously posted (chat.update works on the
// bot's own messages with the `chat:write` scope). Treats an already-gone message
// (message_not_found) as a no-op rather than an error; returns true on success.
async function updateMessage(channel, ts, text) {
  const { data } = await axios.post(UPDATE_URL, { channel, ts, text }, {
    headers: {
      Authorization: `Bearer ${botToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  if (!data.ok) {
    if (data.error === 'message_not_found') return false;
    throw new Error(`Slack API error: ${data.error}`);
  }
  return true;
}

// Deletes a message the bot previously posted (chat.delete works on the bot's own
// messages with the `chat:write` scope). Returns true on success; treats an
// already-gone message (message_not_found) as a no-op rather than an error.
async function deleteMessage(channel, ts) {
  const { data } = await axios.post(DELETE_URL, { channel, ts }, {
    headers: {
      Authorization: `Bearer ${botToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  if (!data.ok) {
    if (data.error === 'message_not_found') return false;
    throw new Error(`Slack API error: ${data.error}`);
  }
  return true;
}

// Posts to a slash-command `response_url` (the delayed-response channel Slack gives
// each slash command for up to 30 min / 5 posts). Needs no auth token — the URL is
// the capability. Used when a command's work is too slow for the 3-second inline
// ack; pass { replace_original: true } to overwrite the "working…" ack message.
async function postToResponseUrl(responseUrl, payload) {
  const { data } = await axios.post(responseUrl, payload, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  return data;
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

// Looks a Slack user up by their id (as sent in an escaped `<@U…>` mention),
// returning { id, email, name } — the email is what we cross-reference to Plextrac.
// Requires the `users:read` scope (and `users:read.email` for the email). Returns
// null if the user doesn't exist; email may be null if not visible to the bot.
async function lookupUserById(userId) {
  const { data } = await axios.get(INFO_URL, {
    headers: { Authorization: `Bearer ${botToken()}` },
    params: { user: userId },
  });
  if (!data.ok) {
    if (data.error === 'user_not_found') return null;
    throw new Error(`Slack API error: ${data.error}`);
  }
  const u = data.user || {};
  return {
    id: u.id || userId,
    email: u.profile?.email || null,
    name: u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || null,
  };
}

module.exports = {
  postMessage, postReply, updateMessage, deleteMessage, postToResponseUrl,
  lookupUserIdByEmail, lookupUserById,
};
