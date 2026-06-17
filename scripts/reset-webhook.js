// Deletes all existing webhooks pointing to this server, then registers a fresh one.
// Run: node scripts/reset-webhook.js
// Then copy the printed secret into the server's .env as CLICKUP_WEBHOOK_SECRET.
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CLICKUP_SPACE_ID, WEBHOOK_URL } = process.env;

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID || !CLICKUP_SPACE_ID || !WEBHOOK_URL) {
  console.error('Required: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CLICKUP_SPACE_ID, WEBHOOK_URL');
  process.exit(1);
}

const headers = { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
const target  = `${WEBHOOK_URL}/webhook/clickup`;

(async () => {
  // 1. List existing webhooks
  const { data } = await axios.get(
    `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook`,
    { headers }
  );

  // 2. Delete any that point to our endpoint
  const existing = (data.webhooks || []).filter(wh => wh.endpoint === target);
  if (existing.length) {
    console.log(`Deleting ${existing.length} existing webhook(s)...`);
    for (const wh of existing) {
      await axios.delete(`https://api.clickup.com/api/v2/webhook/${wh.id}`, { headers });
      console.log(`  Deleted ${wh.id}`);
    }
  } else {
    console.log('No existing webhooks found for this endpoint.');
  }

  // 3. Register a fresh webhook
  console.log('\nRegistering new webhook...');
  const { data: created } = await axios.post(
    `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook`,
    {
      endpoint: target,
      events: ['taskCreated'],
      space_id: Number(CLICKUP_SPACE_ID),
    },
    { headers }
  );

  console.log(`\nWebhook ID : ${created.webhook.id}`);
  console.log(`\nUpdate CLICKUP_WEBHOOK_SECRET in the server .env:\nCLICKUP_WEBHOOK_SECRET=${created.webhook.secret}\n`);
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
