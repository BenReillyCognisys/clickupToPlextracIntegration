/**
 * One-time setup: registers the SECOND ClickUp webhook — the one scoped to the
 * SecOps space (CLICKUP_SECOPS_SPACE_ID) that feeds the VMaaS pipeline.
 *
 * ClickUp scopes a webhook to a single space and there is no folder-level scope,
 * so this subscribes to the whole SecOps space; the VMaaS folder filter is applied
 * in config/monitored-spaces.js when the task is fetched. Cyber Essentials and
 * Templates events therefore reach the endpoint and are ignored there.
 *
 * Events (the same three the Penetration Test webhook uses):
 *   • taskCreated       — generate the client's VMaaS authorisation form
 *   • taskUpdated       — a rename re-renders the form under the new client name
 *                         (or generates it, if the task was still a placeholder)
 *   • taskStatusUpdated — recorded; no downstream action configured yet
 *
 * This webhook gets its OWN signing secret, separate from the pentest one — the
 * endpoint accepts either (see routes/clickup-webhook.js).
 *
 * Run: node scripts/register-secops-webhook.js
 *   --replace   delete any existing SecOps-scoped webhook for this endpoint first
 *               (use when re-issuing the secret; without it, an existing webhook is
 *               reported and left alone rather than duplicated)
 *
 * Then copy the printed secret into the server .env as CLICKUP_WEBHOOK_SECRET_SECOPS
 * and restart the service.
 */
require('dotenv').config();
const axios = require('axios');

const {
  CLICKUP_API_TOKEN,
  CLICKUP_TEAM_ID,
  CLICKUP_SECOPS_SPACE_ID,
  CLICKUP_VMAAS_FOLDER_ID,
  WEBHOOK_URL,
} = process.env;

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID || !CLICKUP_SECOPS_SPACE_ID || !WEBHOOK_URL) {
  console.error(
    'Required env vars: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CLICKUP_SECOPS_SPACE_ID, WEBHOOK_URL'
  );
  process.exit(1);
}

if (!CLICKUP_VMAAS_FOLDER_ID) {
  console.warn(
    'Warning: CLICKUP_VMAAS_FOLDER_ID is not set — the server will ignore every SecOps\n' +
    '         event until it is. Set it before (or right after) running this.\n'
  );
}

const headers = { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
const endpoint = `${WEBHOOK_URL}/webhook/clickup`;
const events = ['taskCreated', 'taskUpdated', 'taskStatusUpdated'];
const replace = process.argv.includes('--replace');

const isSecopsWebhook = (wh) =>
  wh.endpoint === endpoint && String(wh.space_id) === String(CLICKUP_SECOPS_SPACE_ID);

(async () => {
  // Existing SecOps webhooks for this endpoint. Registering a second one would just
  // deliver every event twice, so stop unless --replace was passed.
  const { data } = await axios.get(
    `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook`,
    { headers }
  );
  const existing = (data.webhooks || []).filter(isSecopsWebhook);

  if (existing.length && !replace) {
    console.log('\nA SecOps webhook is already registered for this endpoint:\n');
    for (const wh of existing) {
      console.log(`  ID     : ${wh.id}`);
      console.log(`  Events : ${wh.events.join(', ')}`);
      console.log(`  Status : ${wh.status}\n`);
    }
    console.log('Nothing to do. Re-run with --replace to delete it and issue a fresh secret.\n');
    return;
  }

  for (const wh of existing) {
    await axios.delete(`https://api.clickup.com/api/v2/webhook/${wh.id}`, { headers });
    console.log(`Deleted existing SecOps webhook ${wh.id}`);
  }

  const { data: created } = await axios.post(
    `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/webhook`,
    { endpoint, events, space_id: Number(CLICKUP_SECOPS_SPACE_ID) },
    { headers }
  );

  const { id, secret } = created.webhook;

  console.log('\nSecOps webhook registered successfully.');
  console.log(`  Webhook ID : ${id}`);
  console.log(`  Endpoint   : ${endpoint}`);
  console.log(`  Space      : ${CLICKUP_SECOPS_SPACE_ID} (SecOps)`);
  console.log(`  Events     : ${events.join(', ')}`);
  console.log('\n──────────────────────────────────────────────────────────────────────');
  console.log('Add these to the server .env, then restart the service:\n');
  console.log(`CLICKUP_WEBHOOK_SECRET_SECOPS=${secret}`);
  console.log(`CLICKUP_SECOPS_SPACE_ID=${CLICKUP_SECOPS_SPACE_ID}`);
  console.log(`CLICKUP_VMAAS_FOLDER_ID=${CLICKUP_VMAAS_FOLDER_ID || '<VMaaS folder id>'}`);
  console.log('──────────────────────────────────────────────────────────────────────\n');
  console.log('The existing CLICKUP_WEBHOOK_SECRET (Penetration Test) stays as it is —');
  console.log('the endpoint accepts a payload signed with either secret.\n');
})().catch((err) => {
  console.error('Failed to register SecOps webhook:', err.response?.data ?? err.message);
  process.exit(1);
});
