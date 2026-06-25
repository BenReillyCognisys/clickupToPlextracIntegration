/**
 * Diagnoses the internal-audit View that backs GET /availability/internalaudit.
 *
 * The internal-audit roster is read from a ClickUp List view's sidebar assignees
 * (same mechanism as the pentest CLICKUP_VIEW_ID). The view id is the last
 * segment of the list URL: app.clickup.com/{team}/v/l/{viewId}.
 *
 * This prints the view's sidebar assignees (the roster) and confirms each id
 * resolves to a workspace member.
 *
 * Run on the server (where the real token lives):
 *   node scripts/probe-internal-audit-task.js
 *   node scripts/probe-internal-audit-task.js 8cnj048-61655   # try a specific view id
 */
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID } = process.env;
const VIEW_ID = process.argv[2]
  || process.env.CLICKUP_INTERNAL_AUDIT_VIEW_ID
  || '8cnj048-61655';

if (!CLICKUP_API_TOKEN || !CLICKUP_TEAM_ID) {
  console.error('Required env vars: CLICKUP_API_TOKEN, CLICKUP_TEAM_ID');
  process.exit(1);
}

const headers = { Authorization: CLICKUP_API_TOKEN };

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
  // Build an id -> name map of workspace members.
  const memberName = {};
  try {
    const { data } = await axios.get('https://api.clickup.com/api/v2/team', { headers });
    const team = (data.teams || []).find(t => String(t.id) === CLICKUP_TEAM_ID) || (data.teams || [])[0];
    for (const m of (team?.members || [])) {
      const u = m.user || {};
      memberName[String(u.id)] = u.username || u.email || `User ${u.id}`;
    }
  } catch (err) {
    console.error('Could not list workspace members:', err.response?.data || err.message);
  }

  console.log(`\nProbing view id "${VIEW_ID}" (team ${CLICKUP_TEAM_ID}):\n`);
  let view;
  try {
    const { data } = await axios.get(`https://api.clickup.com/api/v2/view/${VIEW_ID}`, { headers });
    view = data.view;
  } catch (err) {
    const d = err.response?.data;
    console.log(`  ✗ GET /view/${VIEW_ID}: ${err.response?.status} ${d?.ECODE || ''} ${d?.err || err.message}`);
    console.log('\n  This id is not a view this token can read. Confirm the list URL is');
    console.log('  app.clickup.com/{team}/v/l/{viewId} and the token user can open it.\n');
    process.exit(1);
  }

  console.log(`  ✓ view found: "${view.name}" (type: ${view.type})`);

  const sidebar = view.team_sidebar || {};
  let ids = (sidebar.assignees || []).map(String);
  let source = 'team_sidebar.assignees';
  if (!ids.length) { ids = (findAssigneeValues(view) || []).map(String); source = 'assignee filter'; }

  if (!ids.length) {
    console.log('\n  No assignees found in the view sidebar or filters — the roster would be');
    console.log('  empty. Add people to the view\'s sidebar (the way the pentest view lists');
    console.log('  consultants).\n');
    process.exit(1);
  }

  console.log(`\n  Roster (${ids.length}) from ${source}:`);
  for (const id of ids) console.log(`    ${id}  ${memberName[id] || `User ${id} (not a workspace member?)`}`);
  console.log(`\n  Looks good — set CLICKUP_INTERNAL_AUDIT_VIEW_ID="${VIEW_ID}" and restart.\n`);
})();
