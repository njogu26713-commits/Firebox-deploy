const crypto = require('crypto');

const ALGORITHM  = 'aes-256-cbc';
const KEY_LENGTH = 32; // 256 bits
const SALT       = 'firebox-token-salt-v1';

function getKey() {
  // Derive a stable 32-byte key from the session secret.
  const secret = process.env.SESSION_SECRET || 'firebox_fallback_key_change_me';
  return crypto.scryptSync(secret, SALT, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string. Returns "iv_hex:cipher_hex", or '' for empty input.
 */
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a value produced by encrypt(). Returns '' for empty / invalid input.
 */
function decrypt(stored) {
  if (!stored || !stored.includes(':')) return '';
  try {
    const [ivHex, dataHex] = stored.split(':');
    const iv   = Buffer.from(ivHex,   'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { encrypt, decrypt };
