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

  // ClickUp reports delivery health under `health`, not as a top-level `status`:
  //   health.status     — 'active' while deliveries succeed, 'failing' after
  //                       consecutive non-2xx responses (ClickUp stops delivering)
  //   health.fail_count — consecutive failures; resets on the next success
  // Reading wh.status printed `undefined` and hid a failing webhook entirely.
  for (const wh of webhooks) {
    const health = wh.health || {};
    console.log(`\nID         : ${wh.id}`);
    console.log(`Endpoint   : ${wh.endpoint}`);
    console.log(`Events     : ${wh.events.join(', ')}`);
    console.log(`Health     : ${health.status ?? 'unknown'}  (fail_count: ${health.fail_count ?? 'n/a'})`);
    console.log(`Space      : ${wh.space_id || 'all'}`);
    console.log(`Folder     : ${wh.folder_id || '—'}`);
    console.log(`List       : ${wh.list_id || '—'}`);
  }

  // --json dumps the raw objects, for any field this summary doesn't cover.
  if (process.argv.includes('--json')) {
    console.log(`\n${JSON.stringify(webhooks, null, 2)}`);
  }
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
