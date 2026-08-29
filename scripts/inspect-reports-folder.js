/**
 * Checks that the released-report export can actually reach and write to its Drive
 * destination, and shows where the next PDF would land.
 *
 * Read-only: it lists the destination folder and asks Drive whether the service
 * account may add children to it, so nothing is uploaded and nothing is left behind.
 *
 * Run on the box that holds the service-account key:
 *   node scripts/inspect-reports-folder.js
 *
 * Env (see .env.example): GOOGLE_DRIVE_REPORTS_FOLDER_ID, GOOGLE_SERVICE_ACCOUNT_KEY,
 * GOOGLE_DRIVE_SUBJECT, GOOGLE_DRIVE_REPORTS_TZ, GOOGLE_DRIVE_REPORTS_MONTH_FOLDERS,
 * GOOGLE_DRIVE_REPORTS_EPOCH_MONTH.
 */
require('dotenv').config();

const {
  driveClient, WRITE_SCOPES, listSubfolders, resolveSequencedFolder,
} = require('../lib/google-drive');
const { monthFolder } = require('../pipeline/report-export');

const FOLDER_ID = process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID;
const MONTH_FOLDERS = process.env.GOOGLE_DRIVE_REPORTS_MONTH_FOLDERS !== 'false';

if (!FOLDER_ID) {
  console.error('GOOGLE_DRIVE_REPORTS_FOLDER_ID is not set — the export would be skipped entirely.');
  process.exit(1);
}

(async () => {
  // The same scope the upload path uses, so a scope that is not allow-listed for a
  // delegated key fails here rather than at release time.
  const drive = await driveClient(WRITE_SCOPES);

  const { data: folder } = await drive.files.get({
    fileId: FOLDER_ID,
    fields: 'id,name,mimeType,driveId,capabilities(canAddChildren,canEdit)',
    supportsAllDrives: true,
  });

  console.log('');
  console.log(`Destination : ${folder.name}  (${folder.id})`);
  console.log(`Type        : ${folder.mimeType}${folder.driveId ? '  [shared drive]' : '  [My Drive]'}`);

  const canWrite = Boolean(folder.capabilities?.canAddChildren);
  console.log(`Writable    : ${canWrite ? 'yes' : 'NO — the service account cannot add files here'}`);

  const subfolders = await listSubfolders(drive, FOLDER_ID);
  console.log('');
  console.log(`Subfolders (${subfolders.length}):`);
  // Sorted the way Drive lists them, so the numbering is easy to eyeball.
  subfolders
    .map((f) => f.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .forEach((name) => console.log(`  ${name}`));
  if (!subfolders.length) console.log('  (none yet)');

  console.log('');
  if (MONTH_FOLDERS) {
    const month = monthFolder();
    const target = resolveSequencedFolder(subfolders, month.label, month.sequence);
    console.log(`A report exported now would go to: ${folder.name}/${target.name}/`);
    console.log(target.created
      ? `  ("${target.name}" does not exist yet — it would be created)`
      : `  (reusing the existing folder ${target.folderId})`);
    console.log(`  ${month.label} is number ${month.sequence}, counted from `
      + `${process.env.GOOGLE_DRIVE_REPORTS_EPOCH_MONTH || '2026-07'} = 001. That number comes `
      + 'from the month alone, so deleting old folders never shifts it.');
  } else {
    console.log('Month folders are OFF — PDFs go straight into the destination folder.');
  }
  console.log('');

  if (!canWrite) {
    console.error('Fix: share the folder with the service account as Editor, or set '
      + 'GOOGLE_DRIVE_SUBJECT to a user who can write there.');
    process.exit(1);
  }
})().catch((err) => {
  console.error('');
  console.error('Failed:', err.errors?.[0]?.message || err.message);
  console.error('  - 404 usually means the folder was never shared with the service account.');
  console.error('  - "invalid_grant" / unauthorized_client means the key or the delegated '
    + 'scope is wrong (the full .../auth/drive scope must be allow-listed).');
  process.exit(1);
});
