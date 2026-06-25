/**
 * Diagnoses the internal-audit task lookup that backs GET /availability/internalaudit.
 *
 * ClickUp returns OAUTH_027 ("Team not authorized") both for real auth problems
 * AND for task identifiers it can't resolve, so this probes the id as BOTH a
 * native task id and a custom task id and reports exactly what each returns,
 * plus the resolved assignees when one succeeds.
 *
 * Run on the server (where the real token lives):
 *   node scripts/probe-internal-audit-task.js
 *   node scripts/probe-internal-audit-task.js 8cnj048      # try a different id
 */
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID } = process.env;
const TASK_ID = process.argv[2]
  || process.env.CLICKUP_INTERNAL_AUDIT_TASK_ID
  || '8cnj048-61655';

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID) {
  console.error('Required env vars: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID');
  process.exit(1);
}

const headers = { Authorization: CLICKUP_API_TOKEN };

async function tryGet(label, params) {
  const url = `https://api.clickup.com/api/v2/task/${TASK_ID}`;
  try {
    const { data } = await axios.get(url, { headers, params });
    const assignees = (data.assignees || []).map(a => `${a.username || a.email || a.id} (${a.id})`);
    console.log(`  ✓ ${label}: FOUND "${data.name}"`);
    console.log(`      assignees: ${assignees.length ? assignees.join(', ') : '(none)'}`);
    return true;
  } catch (err) {
    const d = err.response?.data;
    console.log(`  ✗ ${label}: ${err.response?.status} ${d?.ECODE || ''} ${d?.err || err.message}`);
    return false;
  }
}

(async () => {
  console.log(`\nProbing task id "${TASK_ID}" (team ${CLICKUP_TEAM_ID}):\n`);
  const native = await tryGet('native id', undefined);
  const custom = await tryGet('custom task id', { custom_task_ids: 'true', team_id: CLICKUP_TEAM_ID });

  console.log('');
  if (native || custom) {
    console.log(`Use this id. ${custom && !native ? 'It is a CUSTOM id — the route handles that automatically.' : 'It is a native id.'}`);
  } else {
    console.log('Neither lookup found the task. Open the task in ClickUp, use the');
    console.log('"…" menu → Copy ID (native) and set CLICKUP_INTERNAL_AUDIT_TASK_ID to it.');
  }
  console.log('');
})();
