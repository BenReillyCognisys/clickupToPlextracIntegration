/**
 * Diagnoses the internal-audit roster that backs GET /availability/internalaudit.
 *
 * The roster is the people pinned in a ClickUp view's sidebar (same mechanism as
 * the pentest CLICKUP_VIEW_ID). The view id is the last segment of the URL
 * app.clickup.com/{team}/v/wl/{viewId}. This reads the view and prints the
 * sidebar assignees (the roster), resolving each id to a workspace member.
 *
 * Run on the server (where the real token lives):
 *   node scripts/probe-internal-audit-view.js
 *   node scripts/probe-internal-audit-view.js 6-901507566408-18   # try a specific view id
 */
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID } = process.env;
const VIEW_ID = process.argv[2]
  || process.env.CLICKUP_INTERNAL_AUDIT_VIEW_ID
  || '6-901507566408-18';

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID) {
  console.error('Required env vars: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID');
  process.exit(1);
}

const headers = { Authorization: CLICKUP_API_TOKEN };
const get = (path) => axios.get(`https://api.clickup.com/api/v2${path}`, { headers }).then(r => r.data);
const errText = (err) => {
  const d = err.response?.data;
  return `${err.response?.status} ${d?.ECODE || ''} ${d?.err || err.message}`;
};

function findAssigneeValues(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.field === 'assignee' && Array.isArray(node.values)) return node.values;
  for (const v of Object.values(node)) {
    const hit = findAssigneeValues(v);
    if (hit && hit.length) return hit;
  }
  return null;
}

(async () => {
  // id -> name for workspace members, to label the roster ids.
  const memberName = {};
  try {
    const data = await get('/team');
    const team = (data.teams || []).find(t => String(t.id) === CLICKUP_TEAM_ID) || (data.teams || [])[0];
    for (const m of (team?.members || [])) {
      const u = m.user || {};
      memberName[String(u.id)] = u.username || u.email || `User ${u.id}`;
    }
  } catch (err) {
    console.error('Could not list workspace members:', errText(err));
  }

  console.log(`\nProbing view id "${VIEW_ID}" (team ${CLICKUP_TEAM_ID}):\n`);
  let view;
  try {
    view = (await get(`/view/${VIEW_ID}`)).view;
  } catch (err) {
    console.log(`  ✗ GET /view/${VIEW_ID}: ${errText(err)}`);
    console.log('\n  This id is not a view this token can read. Confirm the URL is');
    console.log('  app.clickup.com/{team}/v/wl/{viewId} and the token user can open it.\n');
    process.exit(1);
  }

  console.log(`  ✓ view found: "${view.name}" (type: ${view.type})`);

  const sidebar = view.team_sidebar || {};
  let ids = (sidebar.assignees || []).map(String);
  let source = 'team_sidebar.assignees';
  if (!ids.length) { ids = (findAssigneeValues(view) || []).map(String); source = 'assignee filter'; }

  if (!ids.length) {
    console.log('\n  No pinned assignees in the view sidebar or filters — the roster would be');
    console.log('  empty. Pin people to the view\'s sidebar (the way the pentest view does).\n');
    process.exit(1);
  }

  console.log(`\n  Roster (${ids.length}) from ${source}:`);
  for (const id of ids) console.log(`    ${id}  ${memberName[id] || `User ${id} (not a workspace member?)`}`);
  console.log(`\n  Looks good — restart the app and GET /availability/internalaudit?days=N will use these people.\n`);
})();
