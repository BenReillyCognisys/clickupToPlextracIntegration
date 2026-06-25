/**
 * Diagnoses the internal-audit roster that backs GET /availability/internalaudit.
 *
 * The roster is the MEMBERS of the internal-audit list. The list is identified by
 * its List view id (the last segment of app.clickup.com/{team}/v/l/{viewId}); the
 * list id is derived from that view's parent. This resolves the list and prints
 * its members (the roster).
 *
 * Run on the server (where the real token lives):
 *   node scripts/probe-internal-audit-view.js
 *   node scripts/probe-internal-audit-view.js 8cnj048-61655   # try a specific view id
 */
require('dotenv').config();
const axios = require('axios');

const { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID } = process.env;
const VIEW_ID = process.argv[2]
  || process.env.CLICKUP_INTERNAL_AUDIT_VIEW_ID
  || '8cnj048-61655';
const LIST_ID_OVERRIDE = process.env.CLICKUP_INTERNAL_AUDIT_LIST_ID || '';

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

(async () => {
  let listId = LIST_ID_OVERRIDE;

  if (listId) {
    console.log(`\nUsing CLICKUP_INTERNAL_AUDIT_LIST_ID="${listId}" (view lookup skipped).\n`);
  } else {
    console.log(`\nResolving list id from view "${VIEW_ID}" (team ${CLICKUP_TEAM_ID}):\n`);
    let view;
    try {
      view = (await get(`/view/${VIEW_ID}`)).view;
    } catch (err) {
      console.log(`  ✗ GET /view/${VIEW_ID}: ${errText(err)}`);
      process.exit(1);
    }
    const parent = view.parent || {};
    console.log(`  ✓ view "${view.name}" (type ${view.type}) -> parent ${JSON.stringify(parent)}`);
    if (!parent.id) {
      console.log('\n  View has no parent list. Set CLICKUP_INTERNAL_AUDIT_LIST_ID directly.\n');
      process.exit(1);
    }
    listId = String(parent.id);
  }

  let members;
  try {
    members = (await get(`/list/${listId}/member`)).members || [];
  } catch (err) {
    console.log(`\n  ✗ GET /list/${listId}/member: ${errText(err)}`);
    console.log('  If the parent isn\'t actually a list, set CLICKUP_INTERNAL_AUDIT_LIST_ID.\n');
    process.exit(1);
  }

  if (!members.length) {
    console.log(`\n  List ${listId} has no members — the roster would be empty.\n`);
    process.exit(1);
  }

  console.log(`\n  Roster = ${members.length} member(s) of list ${listId}:`);
  for (const m of members) console.log(`    ${m.id}  ${m.username || m.email || `User ${m.id}`}`);
  console.log(`\n  Looks good — restart the app and GET /availability/internalaudit?days=N will use these people.\n`);
})();
