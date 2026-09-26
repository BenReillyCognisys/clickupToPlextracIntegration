// Usage: node scripts/inspect-artifacts.js <clientId> <reportId> [--test-upload [--keep]]
//
// Confirms the service account can use a report's Artifacts tab, which the client
// documents are uploaded to on release (pipeline/client-documents).
//
// Plain run: lists the report's artifacts. Read-only.
//
// --test-upload: uploads a small text file as an artifact, checks it lists on the
// report, then deletes it again. The upload needs a permission the read-only API role
// may not have (the report export did), so run this once after granting it. Add --keep
// to leave the file there and check it appears on the Artifacts tab in the web UI.
require('dotenv').config();
const api = require('../lib/plextrac-api');

(async () => {
  const [clientId, reportId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const testUpload = process.argv.includes('--test-upload');
  const keep = process.argv.includes('--keep');
  if (!clientId || !reportId) {
    console.error('Usage: node scripts/inspect-artifacts.js <clientId> <reportId> [--test-upload [--keep]]');
    process.exit(1);
  }

  const show = (list) => {
    if (!list.length) console.log('  (none)');
    for (const a of list) console.log(`  ${a.id}  ${a.filename}  ${a.content_type}  ${a.size} bytes  "${a.description || ''}"`);
  };

  console.log(`Artifacts on client ${clientId} / report ${reportId}:`);
  show(await api.listReportArtifacts(clientId, reportId));
  if (!testUpload) return;

  const filename = `artifact-permission-check-${Date.now()}.txt`;
  console.log(`\nUploading ${filename} ...`);
  const id = await api.uploadReportArtifact(clientId, reportId, {
    buffer: Buffer.from('Upload check from scripts/inspect-artifacts.js - safe to delete.\n'),
    filename,
    contentType: 'text/plain',
    description: 'Upload permission check - safe to delete',
  });
  console.log(`  uploaded as ${id}`);

  const listed = (await api.listReportArtifacts(clientId, reportId)).some((a) => String(a.id) === String(id));
  console.log(listed ? '  lists on the report: yes' : '  lists on the report: NO — uploaded, but not related to this report');

  if (keep) {
    console.log('\n--keep: left in place. Check the report\'s Artifacts tab, then delete it there.');
  } else {
    await api.deleteArtifact(id);
    console.log('  deleted again');
  }
  if (!listed) process.exit(2);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
