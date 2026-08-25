// Downloads a file from Google Drive so it can be re-uploaded elsewhere (e.g. the
// finalised auth form → a ClickUp task attachment). Auth uses the shared
// service account key (GOOGLE_SERVICE_ACCOUNT_KEY), which already has Drive
// access to the auth-form files the portal uploads.
//
// If the forms live in a user's My Drive rather than somewhere the service account
// can read directly, set GOOGLE_DRIVE_SUBJECT to a user to impersonate via
// domain-wide delegation (that user must be able to open the file).

const { google } = require('googleapis');
const log = require('./logger');

// Path to the service-account JSON key. Defaults to the production location of
// the Drive integration key.
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  || '/var/app/api/sfe-app-gdrive-integration-1780a21efebe.json';

// Optional user to impersonate (domain-wide delegation). Left unset, the service
// account reads the file with its own identity.
const DRIVE_SUBJECT = process.env.GOOGLE_DRIVE_SUBJECT || undefined;

// Read-only Drive access is enough to fetch metadata + media.
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Drive folder the finalised auth forms live in. When set, a file is only downloaded
// if it sits inside this folder (at any depth) — without it, a caller could name ANY
// file id and have the service account fetch whatever it can read. Left unset the
// check is skipped and a warning is logged on every download; set it in production.
const AUTH_FORM_FOLDER_ID = process.env.GOOGLE_DRIVE_AUTH_FORM_FOLDER_ID || null;

// How many levels of parent folders to walk when checking folder membership, so auth
// forms filed in per-client subfolders still resolve without an unbounded crawl.
const MAX_FOLDER_DEPTH = 5;

// Hosts a Drive share link may legitimately use.
const ALLOWED_DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

/**
 * Strictly parses a Drive share URL and returns just its file id, or null.
 *
 * Deliberately NOT a substring match over the whole string: the id is read only from
 * the parsed pathname or the `id` query parameter of an https URL on a known Drive
 * host. That way a caller can't smuggle extra content (markdown, newlines) alongside a
 * real id — everything outside the id is discarded, and callers rebuild a clean link
 * with driveFileUrl() rather than echoing whatever was passed in.
 *
 * Accepts the common share shapes:
 *   https://drive.google.com/file/d/<ID>/view?...       (/d/<ID>/)
 *   https://docs.google.com/document/d/<ID>/edit        (/d/<ID>/)
 *   https://drive.google.com/open?id=<ID>               (?id=<ID>)
 *   https://drive.google.com/uc?id=<ID>&export=download (?id=<ID>)
 */
function fileIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return null; // not a URL at all
  }
  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_DRIVE_HOSTS.has(parsed.hostname)) return null;

  const fromPath = parsed.pathname.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (fromPath) return fromPath[1];

  const fromQuery = parsed.searchParams.get('id');
  if (fromQuery && /^[A-Za-z0-9_-]+$/.test(fromQuery)) return fromQuery;

  return null;
}

// Canonical, safe-to-render link for a Drive file id. Built from the id alone, so it
// never carries caller-supplied text into a comment/description.
const driveFileUrl = (fileId) => `https://drive.google.com/file/d/${fileId}/view`;

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
 * True when any of `parents` is AUTH_FORM_FOLDER_ID, or descends from it within
 * MAX_FOLDER_DEPTH levels (so per-client subfolders are allowed). Walks upward from
 * the file's immediate parents; an ancestor we can't read is treated as a dead end
 * rather than a pass, so the check only ever grants access it can prove.
 */
async function withinAuthFormFolder(drive, parents) {
  const seen = new Set();
  let frontier = (parents || []).filter(Boolean);

  for (let depth = 0; depth < MAX_FOLDER_DEPTH && frontier.length; depth++) {
    if (frontier.includes(AUTH_FORM_FOLDER_ID)) return true;

    const next = [];
    for (const folderId of frontier) {
      if (seen.has(folderId)) continue;
      seen.add(folderId);
      try {
        const { data } = await drive.files.get({
          fileId: folderId,
          fields: 'parents',
          supportsAllDrives: true,
        });
        next.push(...(data.parents || []));
      } catch {
        // Unreadable ancestor — stop climbing this branch (fail closed for it).
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Downloads the Drive file referenced by a share URL. Returns its raw bytes, the
 * original filename and mime type, the parsed file id, and a canonical link built
 * from that id: { buffer, filename, mimeType, fileId, canonicalUrl }.
 *
 * The URL is parsed strictly (see fileIdFromUrl) and, when
 * GOOGLE_DRIVE_AUTH_FORM_FOLDER_ID is configured, the file must live inside that
 * folder — otherwise a caller could point this at any file the service account can
 * read. Throws on an unparseable URL, a file outside the allowed folder, a
 * Google-native doc (which has no downloadable media), or any Drive API failure.
 */
async function downloadDriveFile(driveUrl) {
  const fileId = fileIdFromUrl(driveUrl);
  if (!fileId) throw new Error('driveUrl is not a valid Google Drive file link');

  const drive = await driveClient();

  // Metadata first — gives us the filename/type, the parents needed for the folder
  // check, and surfaces Google-native docs (which can't be fetched with alt=media).
  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType,parents',
    supportsAllDrives: true,
  });

  if (AUTH_FORM_FOLDER_ID) {
    const allowed = await withinAuthFormFolder(drive, meta.data.parents);
    if (!allowed) {
      throw new Error(`Drive file ${fileId} is not in the authorised auth-form folder`);
    }
  } else {
    log.warn('GOOGLE_DRIVE_AUTH_FORM_FOLDER_ID is not set — downloading without a folder restriction', {
      file_id: fileId,
    });
  }

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
    fileId,
    canonicalUrl: driveFileUrl(fileId),
  };
}

module.exports = { downloadDriveFile, fileIdFromUrl, driveFileUrl, withinAuthFormFolder };
