// Encrypts a secret for storage — AES-256-GCM, so a stored value can't be read or
// quietly altered without the key. Used for the PMs' Gmail refresh tokens
// (lib/gmail-connections.js): the database alone never holds a usable token.
//
// The key is REPORT_EMAIL_TOKEN_KEY, 64 hex characters (32 bytes). Generate one with
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Changing it makes every stored token unreadable: everyone has to reconnect.

const crypto = require('crypto');

function key() {
  const hex = String(process.env.REPORT_EMAIL_TOKEN_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('REPORT_EMAIL_TOKEN_KEY is not set (64 hex characters)');
  }
  return Buffer.from(hex, 'hex');
}

const isConfigured = () => {
  try { key(); return true; } catch { return false; }
};

/** "v1.<iv>.<tag>.<ciphertext>", all base64url. */
function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
}

/** The plaintext back; throws if the value was tampered with or the key is wrong. */
function open(sealed) {
  const [version, iv, tag, data] = String(sealed || '').split('.');
  if (version !== 'v1' || !iv || !tag || data == null) throw new Error('not a sealed value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { seal, open, isConfigured };
