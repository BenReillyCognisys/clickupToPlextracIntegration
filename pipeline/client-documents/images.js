// Screenshots in finding write-ups, made printable.
//
// Plextrac stores an image pasted into a rich-text field as a link to its own file
// store — <img src="/api/v2/uploads/<uuid>.png"> — which only answers with the API
// account's token. The renderer fetches nothing but data: URIs (renderer/render.py),
// so every such image is fetched here, through the authenticated Plextrac client, and
// written back into the HTML as a data: URI before the template sees it.
//
// Only Plextrac's upload store is fetched, and only from this Plextrac instance: a
// relative /api/vN/uploads/... path, or the same path on PLEXTRAC_INSTANCE. Anything
// else — another host, file://, a path elsewhere on the API — is never requested.
//
// An image that can't be printed (not a Plextrac upload, a failed fetch, not an image,
// too large) is replaced by a red "[Screenshot missing ...]" note, so the report never
// goes out silently lacking evidence, and is counted in `missing` so the release can
// say which findings need checking.

const api = require('../../lib/plextrac-api');
const { limiter } = require('../../lib/concurrency');

const INSTANCE = process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com';
const MAX_BYTES = Number(process.env.CLIENT_DOCS_MAX_IMAGE_BYTES) || 20 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;

const UPLOAD_PATH = /^\/api\/v\d+\/uploads\/[A-Za-z0-9._-]+$/;
const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;

// The path to fetch for an <img src>, or null when it isn't one of this Plextrac
// instance's uploads.
function uploadPath(src) {
  const value = String(src ?? '').trim().replace(/&amp;/g, '&');
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== INSTANCE.toLowerCase()) return null;
    path = url.pathname;
  }
  return UPLOAD_PATH.test(path) ? path : null;
}

// The image type from the file's first bytes. The content-type header isn't trusted:
// what matters is what the renderer will be decoding.
function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const MISSING = '<span class="tpl-note">[Screenshot missing: it could not be loaded from Plextrac]</span>';

// Every string anywhere in `value`, for finding the images to fetch.
function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v);
}

// `value` with fn applied to every string in it.
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

const srcOf = (tag) => { const m = SRC_ATTR.exec(tag); return m ? (m[2] ?? m[3] ?? m[4]) : null; };

// Plextrac's editor stamps style="aspect-ratio:W/H" on every pasted image. WeasyPrint
// doesn't support the property and logs a warning per image; the images keep their
// own proportions without it, so it is dropped.
const ASPECT_RATIO = /\baspect-ratio\s*:[^;"']*;?\s*/gi;
const withoutAspectRatio = (tag) => tag.replace(ASPECT_RATIO, '');

/**
 * Returns copies of `findings` with every Plextrac screenshot inlined as a data: URI.
 *
 * @param {Array<object>} findings  full finding records
 * @param {object} [opts]
 * @param {(path: string) => Promise<{buffer: Buffer}>} [opts.fetchUpload]  defaults to
 *   the authenticated Plextrac client
 * @returns {Promise<{findings: Array<object>, inlined: number,
 *   missing: Array<{title: string, reason: string}>}>}  one `missing` entry per image
 *   that could not be printed, naming its finding
 */
async function inlineScreenshots(findings, { fetchUpload = (path) => api.rawBinary('get', path) } = {}) {
  // Each distinct upload is fetched once, however many times it's used.
  const paths = new Set();
  for (const f of findings) {
    for (const s of strings(f)) {
      for (const tag of s.match(IMG_TAG) || []) {
        const path = uploadPath(srcOf(tag));
        if (path) paths.add(path);
      }
    }
  }

  const slots = limiter(FETCH_CONCURRENCY);
  const fetched = new Map(); // path -> { uri } | { reason }
  await Promise.all([...paths].map((path) => slots(async () => {
    try {
      const { buffer } = await fetchUpload(path);
      const type = imageType(buffer);
      if (!type) fetched.set(path, { reason: 'Plextrac did not return an image' });
      else if (buffer.length > MAX_BYTES) fetched.set(path, { reason: `image is over ${Math.round(MAX_BYTES / 1024 / 1024)} MB` });
      else fetched.set(path, { uri: `data:${type};base64,${buffer.toString('base64')}` });
    } catch (err) {
      fetched.set(path, { reason: err.message });
    }
  })));

  let inlined = 0;
  const missing = [];
  const out = findings.map((f) => mapStrings(f, (s) => s.replace(IMG_TAG, (found) => {
    const tag = withoutAspectRatio(found);
    const src = srcOf(tag);
    if (src && /^data:image\//i.test(src.trim())) return tag;
    const path = uploadPath(src);
    const got = path ? fetched.get(path) : { reason: `not a Plextrac upload (${String(src ?? '').slice(0, 80) || 'no src'})` };
    if (got?.uri) {
      inlined++;
      return tag.replace(SRC_ATTR, `src="${got.uri}"`);
    }
    missing.push({ title: String(f.title ?? 'untitled finding'), reason: got?.reason ?? 'not fetched' });
    return MISSING;
  })));

  return { findings: out, inlined, missing };
}

module.exports = { inlineScreenshots, uploadPath, imageType };
