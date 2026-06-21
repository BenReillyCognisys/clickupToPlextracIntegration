require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID } = process.env;

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID) {
  console.error('Required: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID');
  process.exit(1);
}

(async () => {
  const { data } = await axios.get(
    `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook`,
    { headers: { Authorization: CLICKUP_API_TOKEN } }
  );

  const webhooks = data.webhooks || [];
  if (!webhooks.length) {
    console.log('No webhooks registered for this team.');
    return;
  }

  for (const wh of webhooks) {
    console.log(`\nID       : ${wh.id}`);
    console.log(`Endpoint : ${wh.endpoint}`);
    console.log(`Events   : ${wh.events.join(', ')}`);
    console.log(`Status   : ${wh.status}`);
    console.log(`Space    : ${wh.space_id || 'all'}`);
  }
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
