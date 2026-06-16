/**
 * Lists all spaces in your ClickUp workspace so you can find
 * the ID for "Penetration Testing" to set as CLICKUP_SPACE_ID.
 *
 * Run: node scripts/list-spaces.js
 */
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID } = process.env;

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID) {
  console.error('Required env vars: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID');
  process.exit(1);
}

(async () => {
  try {
    const { data } = await axios.get(
      `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/space?archived=false`,
      { headers: { Authorization: CLICKUP_API_TOKEN } }
    );

    console.log('\nSpaces in your workspace:\n');
    data.spaces.forEach(s => console.log(`  ${s.id}  ${s.name}`));
    console.log('');
  } catch (err) {
    console.error('Failed to list spaces:', err.response?.data || err.message);
    process.exit(1);
  }
})();
