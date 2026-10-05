// Usage: node scripts/live-test-client-merge.js [--yes] [--keep] [--slack] [--wait=90]
//        node scripts/live-test-client-merge.js --cleanup
//
// End-to-end LIVE test of the client merge (pipeline/client-merge.js) on the server,
// against the real Plextrac, Google Drive and MongoDB — run it once before the first
// real merge, and after any change to the merge.
//
// It only ever touches two throwaway clients it creates itself:
//   "ZZ Merge Test A"   one report: a finding, an artifact, status PUBLISHED
//   "ZZ Merge Test B"   one report of its own
// and merges A into B through the real pipeline: backup of both to Drive (.ptrac + the
// three PDFs + artifacts), .ptrac import into B, verification, artifact copy, delete of
// the original report and of client A. Then it checks the result independently and
// cleans up (client B and its reports, the alias) unless --keep. The Drive backup
// folder is left for inspection — its link is printed; delete it by hand afterwards.
//
// Webhooks: setting A's report to Published, the import and any status the merge puts
// back would each fire Plextrac's ReportStatusChanged at the running server, which would
// otherwise start QA reviews, release exports and the release announcement. Before any
// of that, every test report is suppressed (lib/webhook-suppression.js, shared with
// the server through MongoDB). After a --wait, the script checks the server did nothing
// with them: no release documents on the reports, no QA-queue rows. The server's PM2 log
// should show "Plextrac webhook ignored — report is being moved by a client merge".
//
//   --yes      don't ask before starting
//   --keep     leave client B and its reports in Plextrac
//   --slack    let the merge post its usual Slack summary (default: printed here only)
//   --wait=N   seconds to wait for webhooks after Published and after the merge (default 90)
//   --cleanup  only remove leftovers of an earlier run (the two ZZ clients, alias, suppressions)
require('dotenv').config();
const readline = require('readline');
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const store = require('../lib/client-merge-store');
const suppression = require('../lib/webhook-suppression');
const { getDb } = require('../lib/mongodb');
const { checkRenderer } = require('../lib/pdf-renderer');
const { resolveTemplateId, resolveLayoutId, templateNameForType } = require('../pipeline/plextrac-report');
const merge = require('../pipeline/client-merge');
const DOCUMENTS = require('../config/client-documents');
const log = require('../lib/logger');

const CLIENT_A = 'ZZ Merge Test A';
const CLIENT_B = 'ZZ Merge Test B';
const REPORT_A = 'ZZ Merge Test | Web Application Black Box | Live test';
const REPORT_B = 'ZZ Merge Test | Kept client report';
const PUBLISHED = process.env.PLEXTRAC_RELEASED_STATUS || 'Published';
const SUPPRESS_MS = 2 * 60 * 60 * 1000;
const ARTIFACT_NAME = 'zz-merge-test-artifact.txt';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const WAIT_S = Number((args.find((a) => a.startsWith('--wait=')) || '').split('=')[1] || 90);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
}
const step = (title) => console.log(`\n── ${title}`);

const clientRows = async () => (await api.listClients()).map((c) => ({ id: Number(c.data[0]), name: String(c.data[1] ?? '') }));
const reportRows = async (clientId) => (await api.listClientReports(clientId))
  .map((r) => ({ id: Number(r.data[0]), name: String(r.data[1] ?? ''), status: r.data[3] ?? null }));
const findingCount = async (c, r) => {
  const f = await api.listReportFindings(c, r);
  return (Array.isArray(f) ? f : Object.values(f || {})).length;
};

// Every report the test makes or the merge creates, by name, on both clients — before
// anything can fire a webhook.
async function suppressAll(extra = []) {
  const pairs = [[CLIENT_A, REPORT_A], [CLIENT_B, REPORT_A], [CLIENT_B, REPORT_B]];
  for (const [clientName, reportName] of pairs) {
    await suppression.suppress({ clientName, reportName, reason: 'client merge live test' }, SUPPRESS_MS);
  }
  for (const cuid of extra.filter(Boolean)) {
    await suppression.suppress({ cuid, reason: 'client merge live test' }, SUPPRESS_MS);
  }
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim().toLowerCase();
}

// ── Cleanup — only ever the two ZZ test clients, matched by exact name ────────
async function cleanup({ keepB = false } = {}) {
  step('Cleanup');
  const clients = (await clientRows()).filter((c) => c.name === CLIENT_A || (!keepB && c.name === CLIENT_B));
  for (const c of clients) {
    for (const r of await reportRows(c.id)) {
      try {
        await api.deleteReport(c.id, r.id);
        console.log(`  deleted report ${r.id} "${r.name}" from ${c.name}`);
      } catch (err) {
        console.log(`  COULD NOT delete report ${r.id} from ${c.name}: ${err.message}`);
      }
    }
    try {
      await api.deleteClient(c.id);
      console.log(`  deleted client ${c.id} "${c.name}"`);
    } catch (err) {
      console.log(`  COULD NOT delete client ${c.id} "${c.name}": ${err.message} — delete it in Plextrac`);
    }
  }
  if (!clients.length) console.log('  no ZZ test clients in Plextrac');
  if (!keepB) {
    const db = await getDb();
    const res = await db.collection('plextrac_client_aliases').deleteMany({ alias: store.aliasKey(CLIENT_A) });
    if (res.deletedCount) console.log(`  removed the "${CLIENT_A}" alias`);
    for (const [clientName, reportName] of [[CLIENT_A, REPORT_A], [CLIENT_B, REPORT_A], [CLIENT_B, REPORT_B]]) {
      await suppression.release({ clientName, reportName });
    }
    console.log('  webhook suppressions lifted (cuid ones expire on their own)');
  } else {
    console.log(`  --keep: "${CLIENT_B}" and its reports left in Plextrac; webhook suppressions expire in 2h`);
  }
}

// ── Preflight ─────────────────────────────────────────────────────────────────
async function preflight() {
  step('Preflight');
  let ok = true;
  const clients = await clientRows().catch((err) => { ok = check('Plextrac reachable', false, err.message); return null; });
  if (clients) check('Plextrac reachable', true, `${clients.length} clients`);
  const leftovers = (clients || []).filter((c) => c.name === CLIENT_A || c.name === CLIENT_B);
  ok = check('no ZZ test clients left from an earlier run', !leftovers.length,
    leftovers.length ? `found ${leftovers.map((c) => `${c.name} (${c.id})`).join(', ')} — run with --cleanup first` : '') && ok;

  try {
    await (await getDb()).command({ ping: 1 });
    check('MongoDB reachable', true);
  } catch (err) {
    ok = check('MongoDB reachable', false, err.message) && false;
  }

  const renderer = await checkRenderer();
  ok = check('PDF renderer ready', renderer.ok, renderer.ok ? `weasyprint ${renderer.weasyprint}` : renderer.error) && ok;

  const rootId = process.env.CLIENT_MERGE_DRIVE_FOLDER_ID || '1YxrZz42lKpbnrohi04je_RV60ESIZoWn';
  try {
    const d = await drive.driveClient(drive.WRITE_SCOPES);
    const { data } = await d.files.get({ fileId: rootId, fields: 'name,capabilities(canAddChildren)', supportsAllDrives: true });
    ok = check('Drive backup folder writable', data.capabilities?.canAddChildren, `"${data.name}" ${drive.driveFolderUrl(rootId)}`) && ok;
  } catch (err) {
    ok = check('Drive backup folder writable', false, `${rootId}: ${err.message}`) && false;
  }
  return ok;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup() {
  step('Setup (suppressing webhooks for every test report first)');
  await suppressAll();

  const a = await api.createClient(CLIENT_A);
  const b = await api.createClient(CLIENT_B);
  const aId = Number(a.client_id);
  const bId = Number(b.client_id);
  console.log(`  created clients ${CLIENT_A} (${aId}) and ${CLIENT_B} (${bId})`);

  const template = await resolveTemplateId(templateNameForType('Web Application Black Box'));
  const layout = await resolveLayoutId(process.env.PLEXTRAC_FINDINGS_LAYOUT || 'Pentest Cognisys');
  // No operators or reviewers: nobody gets assigned or notified about a test report.
  const make = async (clientId, name) => {
    const res = await api.createReport(clientId, { name, status: 'Draft', template, fields_template: layout, tags: ['zz-merge-test'] });
    const full = await api.getReport(clientId, res.report_id);
    return { id: Number(res.report_id), cuid: full?.cuid || null };
  };
  const ra = await make(aId, REPORT_A);
  const rb = await make(bId, REPORT_B);
  await suppressAll([ra.cuid, rb.cuid]);
  console.log(`  created report ${ra.id} on A and ${rb.id} on B (cuids suppressed too)`);

  // A finding, so the copy's finding count means something. Best-effort: the merge is
  // still tested without one, and the result says so.
  try {
    await api.raw('post', `/api/v1/client/${aId}/report/${ra.id}/flaw/create`, {
      title: 'ZZ Merge Test Finding', severity: 'Medium', status: 'Open',
      description: '<p>Live test of the client merge. Safe to delete.</p>',
      recommendations: '<p>None.</p>', references: '',
    });
  } catch (err) {
    console.log(`  (could not add a finding: ${err.message})`);
  }
  const findings = await findingCount(aId, ra.id);
  check('test report has a finding', findings >= 1, `${findings} finding(s)`);

  await api.uploadReportArtifact(aId, ra.id, {
    buffer: Buffer.from(`Client merge live test artifact, ${new Date().toISOString()}. Safe to delete.\n`),
    filename: ARTIFACT_NAME, contentType: 'text/plain', description: 'Client merge live test',
  });
  check('test artifact on the report', (await api.listReportArtifacts(aId, ra.id)).length === 1);

  await api.updateReport(aId, ra.id, { status: PUBLISHED });
  const status = (await api.getReport(aId, ra.id))?.status;
  check(`report set to ${PUBLISHED} (webhook suppressed)`, status === PUBLISHED, `status is "${status}"`);

  return { aId, bId, ra, rb, findings };
}

// Did the server act on a webhook for these reports? Release exports would have put
// their documents on the Artifacts tab; any handled status change adds a QA-queue row.
async function serverLeftAlone(label, clientId, reportIds, expectedArtifacts) {
  const db = await getDb();
  const queued = await db.collection('qa_queue').countDocuments({ report_id: { $in: reportIds.map(Number) } });
  const artifacts = (await api.listReportArtifacts(clientId, reportIds[reportIds.length - 1])).length;
  check(`${label}: server ignored the webhooks`, queued === 0 && artifacts === expectedArtifacts,
    `qa_queue rows ${queued}, artifacts ${artifacts} (expected ${expectedArtifacts})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!flag('slack')) log.notify = (text) => console.log(`  [Slack, not sent] ${text}`);

  if (flag('cleanup')) {
    await cleanup();
    process.exit(0);
  }

  console.log('Client merge LIVE test — creates two throwaway clients in the real Plextrac,');
  console.log(`merges "${CLIENT_A}" into "${CLIENT_B}" (backup to Drive included), checks it, cleans up.`);

  if (!await preflight()) {
    console.log('\nPreflight failed — nothing was created.');
    process.exit(1);
  }
  if (!flag('yes') && await ask('\nType "yes" to start: ') !== 'yes') {
    console.log('Not started.');
    process.exit(0);
  }

  let ctx;
  let job = null;
  try {
    ctx = await setup();
    console.log(`\n  waiting ${WAIT_S}s for any webhook from setting Published…`);
    await sleep(WAIT_S * 1000);
    await serverLeftAlone('after Published', ctx.aId, [ctx.ra.id], 1);

    step('Merge (the real pipeline)');
    const started = await merge.startMerge({
      keepClientId: ctx.bId, mergeClientId: ctx.aId, confirmClientName: CLIENT_A,
      requestedBy: 'scripts/live-test-client-merge.js',
    });
    const deadline = Date.now() + 30 * 60 * 1000;
    do {
      await sleep(3000);
      job = await store.getMerge(started.merge_id);
    } while (job && ['queued', 'running'].includes(job.status) && Date.now() < deadline);

    step('Checks');
    check('merge completed', job?.status === 'completed', job ? `${job.status}${job.error ? `: ${job.error}` : ''}` : 'no record');
    if (job?.drive_folder) console.log(`  backup folder: ${job.drive_folder.url}`);

    for (const r of job?.reports || []) {
      const kinds = (r.backup?.files || []).map((f) => f.document || f.kind);
      const want = ['ptrac', ...DOCUMENTS.map((d) => d.key), ...(r.report_id === ctx.ra.id ? ['artifact'] : [])];
      check(`backup of "${r.name}" (${r.client_name})`, r.backup?.ok && want.every((k) => kinds.includes(k)),
        r.backup?.ok ? `${kinds.length} files, all MD5-verified` : r.backup?.error);
    }

    const clientsNow = await clientRows();
    check(`client "${CLIENT_A}" deleted`, !clientsNow.some((c) => c.id === ctx.aId));
    const bReports = await reportRows(ctx.bId);
    const copy = bReports.find((r) => r.name === REPORT_A);
    check('report now on the kept client', Boolean(copy), copy ? `report ${copy.id}` : bReports.map((r) => r.name).join(', '));
    check(`kept client's own report untouched`, bReports.some((r) => r.id === ctx.rb.id));
    check('original report deleted', !(await reportRows(ctx.aId).catch(() => [])).some((r) => r.id === ctx.ra.id));
    if (copy) {
      const full = await api.getReport(ctx.bId, copy.id);
      check(`copy is still ${PUBLISHED}`, full?.status === PUBLISHED, `"${full?.status}"`);
      const n = await findingCount(ctx.bId, copy.id);
      check('copy has every finding', n === ctx.findings, `${n} of ${ctx.findings}`);
      const arts = await api.listReportArtifacts(ctx.bId, copy.id);
      check('artifact copied to the copy', arts.some((a) => a.filename === ARTIFACT_NAME), arts.map((a) => a.filename).join(', '));
      const moved = job.reports.find((r) => r.report_id === ctx.ra.id)?.move;
      check('merge record names the copy', Number(moved?.new_report_id) === copy.id, `${moved?.state}`);
      const alias = await store.findAlias(CLIENT_A);
      check(`"${CLIENT_A}" recorded as an alias of "${CLIENT_B}"`, Number(alias?.client_id) === ctx.bId);

      console.log(`\n  waiting ${WAIT_S}s for any webhook from the import…`);
      await sleep(WAIT_S * 1000);
      await serverLeftAlone('after import', ctx.bId, [ctx.ra.id, copy.id], 1);
    }
    if (job?.status !== 'completed') {
      console.log('\n  Merge step log:');
      for (const e of job?.events || []) console.log(`    ${e.level.toUpperCase().padEnd(5)} ${e.message}`);
    }
  } catch (err) {
    check('live test ran to the end', false, err.stack || err.message);
  }

  try {
    await cleanup({ keepB: flag('keep') });
  } catch (err) {
    console.log(`  cleanup failed: ${err.message} — re-run with --cleanup`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (job?.drive_folder) console.log(`Backup folder (delete by hand when done): ${job.drive_folder.url}`);
  console.log('Server PM2 log should show: "Plextrac webhook ignored — report is being moved by a client merge"');
  process.exit(failed.length ? 1 : 0);
})();
