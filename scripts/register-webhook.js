/**
 * One-time setup: registers a ClickUp webhook for taskCreated events
 * scoped to the space defined by CLICKUP_SPACE_ID.
 *
 * Run once: node scripts/register-webhook.js
 * Then copy the printed secret into your .env as CLICKUP_WEBHOOK_SECRET.
 */
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CLICKUP_SPACE_ID, WEBHOOK_URL } = process.env;

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID || !CLICKUP_SPACE_ID || !WEBHOOK_URL) {
  console.error('Required env vars: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CLICKUP_SPACE_ID, WEBHOOK_URL');
  process.exit(1);
}

(async () => {
  try {
    const { data } = await axios.post(
      `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook`,
      {
        endpoint: `${WEBHOOK_URL}/webhook/clickup`,
        events: ['taskCreated'],
        space_id: Number(CLICKUP_SPACE_ID)
      },
      { headers: { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' } }
    );

    console.log('\nWebhook registered successfully!');
    console.log(`Webhook ID : ${data.webhook.id}`);
    console.log(`\nAdd this to your .env:\nCLICKUP_WEBHOOK_SECRET=${data.webhook.secret}\n`);
  } catch (err) {
    console.error('Failed to register webhook:', err.response?.data || err.message);
    process.exit(1);
  }
})();
