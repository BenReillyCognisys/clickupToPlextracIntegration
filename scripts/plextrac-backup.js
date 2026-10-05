// Usage: node scripts/plextrac-backup.js --clients=39283,99371   test run of a few clients
//        node scripts/plextrac-backup.js --full                   a full numbered run, now
//        node scripts/plextrac-backup.js --status                 last run / next run
//        add --yes to skip the confirmation
//
// Runs the weekly Plextrac backup (pipeline/plextrac-backup.js) by hand, on the server.
// It only READS from Plextrac.
//
// --clients=…  a TEST run: just those clients, into "TEST <timestamp>" under the backup
//              folder. Takes no number, isn't shown as the last backup in the portal,
//              and is never what the next weekly run compares itself with. Its
//              changes.md compares those clients with the last real run. Delete the
//              TEST folder in Drive when done.
// --full       the whole tenant, exactly as the Friday run does, as the next numbered
//              run (it is the "previous week" for the next scheduled run). Takes hours.
//              Leave it running (e.g. in tmux/screen): if this script stops, the run is
//              left part-done and the server picks it up again only if its record goes
//              stale for 20 minutes — or re-run with --full to start a new one.
//
// Preflight checks MongoDB, the PDF renderer and write access to the Drive folder
// before anything starts.
require('dotenv').config();
const readline = require('readline');
const drive = require('../lib/google-drive');
const { getDb } = require('../lib/mongodb');
const { checkRenderer } = require('../lib/pdf-renderer');
const backup = require('../pipeline/plextrac-backup');
const { formatSize } = require('../pipeline/report-export');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim().toLowerCase();
}

function printRun(label, run) {
  if (!run) { console.log(`${label}: none`); return; }
  const t = run.totals || {};
  console.log(`${label}: ${run.folder?.name} — ${run.status}`);
  console.log(`  started ${new Date(run.started_at).toLocaleString('en-GB')}${run.duration_ms ? `, took ${backup.formatDuration(run.duration_ms)}` : ''}`);
  if (run.totals) {
    console.log(`  ${t.clients} clients, ${t.reports} reports (${t.reports_failed} failed), ${t.pdfs} PDFs, ${t.ptrac} .ptrac, ${t.artifacts} artifacts, ${formatSize(t.bytes)}`);
  }
  if (run.progress && run.status === 'running') {
    console.log(`  ${run.progress.stage}: ${run.progress.reports_done}/${run.progress.reports_total} reports (${run.progress.reports_failed} failed)`);
  }
  if (run.changes && !run.changes.first) {
    const c = run.changes;
    console.log(`  changes: ${c.reports_new} new, ${c.reports_changed} changed, ${c.reports_removed} removed reports; ${c.clients_new} new, ${c.clients_removed} removed clients`);
  }
  if (run.folder?.url) console.log(`  ${run.folder.url}`);
  if (run.changes_file?.url) console.log(`  changes.md: ${run.changes_file.url}`);
}

async function preflight() {
  let ok = true;
  const report = (name, pass, detail = '') => { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); ok = ok && pass; };
  try {
    await (await getDb()).command({ ping: 1 });
    report('MongoDB reachable', true);
  } catch (err) {
    report('MongoDB reachable', false, err.message);
  }
  const renderer = await checkRenderer();
  report('PDF renderer ready', renderer.ok, renderer.ok ? `weasyprint ${renderer.weasyprint}` : renderer.error);
  const root = process.env.PLEXTRAC_BACKUP_DRIVE_FOLDER_ID || '1B9zPyVhLH7AvFdnHFIK-37v8M06COy5V';
  try {
    const d = await drive.driveClient(drive.WRITE_SCOPES);
    const { data } = await d.files.get({ fileId: root, fields: 'name,capabilities(canAddChildren)', supportsAllDrives: true });
    report('Drive backup folder writable', Boolean(data.capabilities?.canAddChildren), `"${data.name}" ${drive.driveFolderUrl(root)}`);
  } catch (err) {
    report('Drive backup folder writable', false, `${root}: ${err.message}`);
  }
  return ok;
}

(async () => {
  if (flag('status')) {
    const s = await backup.getStatus();
    printRun('Running', s.running);
    printRun('Last backup', s.last);
    console.log(`Schedule: ${s.schedule.description} (the server process holds the timer)`);
    process.exit(0);
  }

  const clientIds = value('clients') ? value('clients').split(',').map((v) => Number(v.trim())).filter(Boolean) : null;
  if (!clientIds && !flag('full')) {
    console.log('Pass --clients=<id,id> for a test run, --full for a full run, or --status.');
    process.exit(1);
  }

  console.log('Preflight');
  if (!await preflight()) {
    console.log('\nPreflight failed — nothing was started.');
    process.exit(1);
  }
  const what = clientIds ? `a TEST backup of client(s) ${clientIds.join(', ')}` : 'a FULL numbered backup of every client (takes hours)';
  if (!flag('yes') && await ask(`\nStart ${what}? Type "yes": `) !== 'yes') {
    console.log('Not started.');
    process.exit(0);
  }

  const run = await backup.runBackup({
    kind: clientIds ? 'test' : 'manual', clientIds, role: 'script',
    requestedBy: 'scripts/plextrac-backup.js',
  });
  console.log('');
  if (run?.skipped) {
    console.log(`Not started: ${run.skipped}`);
    process.exit(1);
  }
  printRun('Result', run);
  process.exit(run?.status === 'completed' ? 0 : 1);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
