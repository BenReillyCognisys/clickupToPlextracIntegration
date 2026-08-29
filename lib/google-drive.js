// Google Drive access: downloads a file so it can be re-uploaded elsewhere (e.g. the
// finalised auth form → a ClickUp task attachment), and uploads files into a Drive
// folder (e.g. the released report PDF). Auth uses the shared service account key
// (GOOGLE_SERVICE_ACCOUNT_KEY), which already has Drive access to the auth-form files
// the portal uploads.
//
// If the forms live in a user's My Drive rather than somewhere the service account
// can read directly, set GOOGLE_DRIVE_SUBJECT to a user to impersonate via
// domain-wide delegation (that user must be able to open the file).

const { google } = require('googleapis');
const { Readable } = require('stream');
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

// Uploading needs write access. `drive.file` would only cover files this app created,
// which can't file a report into a folder someone else made, so writes use the full
// `drive` scope. Only the upload path asks for it — downloads stay read-only.
const WRITE_SCOPES = ['https://www.googleapis.com/auth/drive'];

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
// Defaults to read-only scope; pass WRITE_SCOPES to upload.
async function driveClient(scopes = SCOPES) {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes,
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

// ── Uploads ───────────────────────────────────────────────────────────────────

// Escapes a name for use inside a Drive query string literal ('...' in a q=).
function escapeQueryValue(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// The id of the single non-trashed file called `name` directly inside `folderId`, or
// null. Used to replace a file in place on a re-run rather than pile up duplicates.
async function findFileInFolder(drive, folderId, name) {
  const { data } = await drive.files.list({
    q: `'${escapeQueryValue(folderId)}' in parents and name = '${escapeQueryValue(name)}' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 2,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return data.files?.[0]?.id || null;
}

/**
 * Returns the id of the subfolder called `name` under `parentId`, creating it if it
 * doesn't exist yet. Used to file reports per client.
 */
async function ensureFolder(drive, parentId, name) {
  const { data } = await drive.files.list({
    q: `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(name)}' `
      + `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 2,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existing = data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  log.info('Drive folder created', { name, parent_id: parentId, folder_id: created.data.id });
  return created.data.id;
}

/**
 * Picks the sequenced subfolder for `label` out of `folders` ([{ id, name }] — the
 * folders directly inside the parent).
 *
 * Sequenced folders are named "<NNN>. <label>", e.g. "002. August 2026", so Drive
 * sorts them chronologically instead of alphabetically.
 *
 * `sequence` is supplied by the caller and must be a pure function of the period, NOT
 * a count of the folders present — see monthFolder() in pipeline/report-export.js.
 * That is what lets old folders be deleted (a retention sweep at 18 months, say)
 * without the numbering shifting: "294. December 2050" is 294 because of when
 * December 2050 is, not because 293 folders happen to sit above it.
 *
 * Returns { folderId, name, created }: an existing folder's id when `label` already
 * has one — matched on the LABEL ALONE, so a folder someone renumbered or created
 * unnumbered as "August 2026" is reused rather than given a twin — otherwise folderId
 * null and the name to create.
 *
 * Pure, so the numbering can be tested without touching Drive.
 */
function resolveSequencedFolder(folders, label, sequence) {
  const target = String(label ?? '').trim().toLowerCase();

  for (const folder of folders || []) {
    const existing = String(folder?.name ?? '').trim();
    const numbered = /^(\d+)\s*\.\s*(.+)$/.exec(existing);
    const folderLabel = (numbered ? numbered[2] : existing).trim().toLowerCase();

    if (target && folderLabel === target) {
      return { folderId: folder.id, name: folder.name, created: false };
    }
  }

  // padStart only pads — 1000+ keeps counting rather than being truncated to 3 digits.
  return { folderId: null, name: `${String(sequence).padStart(3, '0')}. ${label}`, created: true };
}

// Every non-trashed folder directly inside `parentId`, following pagination so the
// numbering still sees folder 1001 in a parent that has outgrown one page.
async function listSubfolders(drive, parentId) {
  const folders = [];
  let pageToken;

  do {
    const { data } = await drive.files.list({
      q: `'${escapeQueryValue(parentId)}' in parents `
        + `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken,files(id,name)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    folders.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return folders;
}

/**
 * Returns the id of the sequenced subfolder for `{ label, sequence }` under
 * `parentId`, creating "<NNN>. <label>" if this is the first file of that period. See
 * resolveSequencedFolder for how the name is chosen.
 *
 * Like ensureFolder, two callers racing on the very first upload of a new period can
 * each create a folder — releases are minutes apart in practice, and a stray
 * duplicate is a rename in Drive, not lost data.
 */
async function ensureSequencedFolder(drive, parentId, { label, sequence }) {
  const existing = await listSubfolders(drive, parentId);
  const resolved = resolveSequencedFolder(existing, label, sequence);
  if (resolved.folderId) return resolved.folderId;

  const created = await drive.files.create({
    requestBody: { name: resolved.name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  log.info('Drive sequenced folder created', {
    name: resolved.name, parent_id: parentId, folder_id: created.data.id,
  });
  return created.data.id;
}

/**
 * Uploads `buffer` into a Drive folder as `filename`.
 *
 * If a file of that name is already in the folder its contents are REPLACED (Drive
 * keeps its own version history), so re-running for the same report updates the PDF
 * instead of leaving two copies.
 *
 * Two optional levels of foldering under `folderId`, applied in this order:
 *   `sequencedSubfolder` — { label, sequence }, e.g. { label: 'August 2026',
 *                          sequence: 2 }, filed as "002. August 2026" so Drive sorts
 *                          the periods in order (see ensureSequencedFolder).
 *   `subfolder`          — a plain named subfolder, e.g. the client.
 * Both are created on first use; passing neither uploads straight into `folderId`.
 *
 * Returns { fileId, url, name, folderId, replaced }, where folderId is the folder the
 * file actually landed in. Throws on any Drive failure — callers decide whether that
 * is fatal.
 */
async function uploadFile({
  buffer, filename, mimeType = 'application/pdf', folderId, subfolder, sequencedSubfolder,
}) {
  if (!folderId) throw new Error('uploadFile requires a destination folderId');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('uploadFile requires a non-empty buffer');

  const drive = await driveClient(WRITE_SCOPES);

  let parentId = folderId;
  if (sequencedSubfolder) parentId = await ensureSequencedFolder(drive, parentId, sequencedSubfolder);
  if (subfolder) parentId = await ensureFolder(drive, parentId, subfolder);

  const existingId = await findFileInFolder(drive, parentId, filename);
  // A fresh stream per call — a consumed stream can't be retried.
  const media = { mimeType, body: Readable.from(buffer) };

  const res = existingId
    ? await drive.files.update({ fileId: existingId, media, fields: 'id,name', supportsAllDrives: true })
    : await drive.files.create({
      requestBody: { name: filename, parents: [parentId] },
      media,
      fields: 'id,name',
      supportsAllDrives: true,
    });

  const fileId = res.data.id;
  return {
    fileId,
    url: driveFileUrl(fileId),
    name: res.data.name || filename,
    folderId: parentId,
    replaced: Boolean(existingId),
  };
}

module.exports = {
  downloadDriveFile,
  fileIdFromUrl,
  driveFileUrl,
  withinAuthFormFolder,
  uploadFile,
  ensureFolder,
  ensureSequencedFolder,
  resolveSequencedFolder,
  listSubfolders,
  driveClient,
  WRITE_SCOPES,
  findFileInFolder,
  escapeQueryValue,
};
