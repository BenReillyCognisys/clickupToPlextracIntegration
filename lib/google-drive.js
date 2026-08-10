// Downloads a file from Google Drive so it can be re-uploaded elsewhere (e.g. the
// finalised auth form → a ClickUp task attachment). Auth reuses the same service
// account as the MFA check (GOOGLE_SERVICE_ACCOUNT_KEY), which already has Drive
// access to the auth-form files the portal uploads.
//
// If the forms live in a user's My Drive rather than somewhere the service account
// can read directly, set GOOGLE_DRIVE_SUBJECT to a user to impersonate via
// domain-wide delegation (that user must be able to open the file).

const { google } = require('googleapis');

// Path to the service-account JSON key. Defaults to the same production location
// the MFA check uses (the key file is named for the Drive integration).
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  || '/var/app/api/sfe-app-gdrive-integration-1780a21efebe.json';

// Optional user to impersonate (domain-wide delegation). Left unset, the service
// account reads the file with its own identity.
const DRIVE_SUBJECT = process.env.GOOGLE_DRIVE_SUBJECT || undefined;

// Read-only Drive access is enough to fetch metadata + media.
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Pulls the Drive file id out of the common share/link shapes:
//   https://drive.google.com/file/d/<ID>/view?...      (/d/<ID>/)
//   https://docs.google.com/document/d/<ID>/edit        (/d/<ID>/)
//   https://drive.google.com/open?id=<ID>               (?id=<ID>)
//   https://drive.google.com/uc?id=<ID>&export=download (?id=<ID>)
// Returns null when no id can be found.
function fileIdFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/\/d\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Builds an authorised Drive v3 client, impersonating DRIVE_SUBJECT when set.
async function driveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: SCOPES,
    ...(DRIVE_SUBJECT ? { clientOptions: { subject: DRIVE_SUBJECT } } : {}),
  });
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}

/**
 * Downloads the Drive file referenced by a share URL. Returns its raw bytes plus
 * the original filename and mime type: { buffer, filename, mimeType }. Throws on an
 * unparseable URL, a Google-native doc (which has no downloadable media), or any
 * Drive API failure.
 */
async function downloadDriveFile(driveUrl) {
  const fileId = fileIdFromUrl(driveUrl);
  if (!fileId) throw new Error(`could not parse a Drive file id from URL: ${driveUrl}`);

  const drive = await driveClient();

  // Metadata first — gives us the filename/type and surfaces Google-native docs
  // (which can't be fetched with alt=media, they'd need an export instead).
  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  });
  const mimeType = meta.data.mimeType || 'application/octet-stream';
  if (mimeType.startsWith('application/vnd.google-apps')) {
    throw new Error(`Drive file ${fileId} is a Google-native doc (${mimeType}); export not supported`);
  }

  const media = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );

  return {
    buffer: Buffer.from(media.data),
    filename: meta.data.name || null,
    mimeType,
  };
}

module.exports = { downloadDriveFile, fileIdFromUrl };
