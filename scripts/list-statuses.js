// Lists all statuses defined in the monitored ClickUp space.
// Run: node scripts/list-statuses.js
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_SPACE_ID } = process.env;

if (!CLICKUP_API_TOKEN || !CLICKUP_SPACE_ID) {
  console.error('Required: CLICKUP_API_TOKEN, CLICKUP_SPACE_ID');
  process.exit(1);
}

(async () => {
  const { data } = await axios.get(
    `https://api.clickup.com/api/v2/space/${CLICKUP_SPACE_ID}`,
    { headers: { Authorization: CLICKUP_API_TOKEN } }
  );

  console.log(`\nStatuses for space "${data.name}":\n`);
  for (const s of data.statuses || []) {
    console.log(`  "${s.status}"`);
  }
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
