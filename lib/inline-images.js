// Embeds the images of an HTML fragment (a PM's Gmail signature) in the email itself, as
// inline attachments referenced by cid:, instead of links to wherever they're hosted.
//
// Gmail stores signature images as links: to Google's copy of an uploaded image, to a
// Google Drive file, or to any web address. A draft made through the API carries only
// the link, and a link that needs a sign-in (a Drive file that isn't shared publicly) or
// is blocked shows as a broken image — for the PM and for the client. Downloading each
// image when the draft is made, and attaching it, makes it show wherever the email is read.
//
// Only https:// images (and data: URIs) are taken; anything that can't be fetched, isn't
// an image, or is too big is left as a link and reported, so the PM can check it.

const axios = require('axios');
const crypto = require('crypto');

const MAX_IMAGES = 10;
const MAX_BYTES = 1024 * 1024; // per image
const TIMEOUT_MS = 10 * 1000;

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

const decodeAttr = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// The image type from its first bytes, when the server didn't say (or said something vague).
function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Downloads one https image: { data, contentType }. Throws with a short reason. */
async function fetchImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    maxRedirects: 5,
    // Stay on https all the way, even through redirects.
    beforeRedirect: (options) => {
      if (options.protocol !== 'https:') throw new Error('redirected off https');
    },
    validateStatus: () => true,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = Buffer.from(res.data);
  const declared = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const contentType = EXT[declared] ? declared : sniff(data);
  if (!contentType) throw new Error(`not an image (${declared || 'no content type'})`);
  return { data, contentType };
}

function fromDataUri(uri) {
  const m = /^data:(image\/[a-z+.-]+);base64,([a-z0-9+/=\s]+)$/i.exec(uri);
  if (!m) throw new Error('unsupported data: image');
  const data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (data.length > MAX_BYTES) throw new Error('too big');
  const contentType = EXT[m[1].toLowerCase()] ? m[1].toLowerCase() : sniff(data);
  if (!contentType) throw new Error('not an image');
  return { data, contentType };
}

/**
 * Rewrites every <img src> in `html` to a cid: reference, downloading the image.
 * Returns { html, images: [{ cid, contentType, filename, data }], failed: [{ src, reason }] }.
 * `fetch` is for tests. Never throws.
 */
async function inlineImages(html, { fetch = fetchImage } = {}) {
  const source = String(html || '');
  const srcs = [...new Set([...source.matchAll(IMG_SRC)].map((m) => decodeAttr(m[3]).trim()))];
  const byUrl = new Map();
  const images = [];
  const failed = [];
  const tag = crypto.randomBytes(4).toString('hex');

  for (const src of srcs) {
    if (images.length >= MAX_IMAGES) { failed.push({ src, reason: `more than ${MAX_IMAGES} images` }); continue; }
    try {
      let got;
      if (/^data:/i.test(src)) got = fromDataUri(src);
      else if (/^https:\/\//i.test(src)) got = await fetch(src);
      else throw new Error('not an https:// image');
      const n = images.length + 1;
      const cid = `sig${n}.${tag}@break.services`;
      images.push({ cid, contentType: got.contentType, filename: `signature-${n}.${EXT[got.contentType]}`, data: got.data });
      byUrl.set(src, cid);
    } catch (err) {
      failed.push({ src: src.startsWith('data:') ? 'data: image' : src, reason: err.message });
    }
  }

  const out = source.replace(IMG_SRC, (whole, before, quote, raw) => {
    const cid = byUrl.get(decodeAttr(raw).trim());
    return cid ? `${before}${quote}cid:${cid}${quote}` : whole;
  });
  return { html: out, images, failed };
}

module.exports = { inlineImages, fetchImage, sniff };
