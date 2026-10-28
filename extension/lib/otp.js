// HOTP (RFC 4226) and TOTP (RFC 6238) on top of WebCrypto HMAC.
import { base32Decode } from './base32.js';

const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export async function hotp(secret, counter, { digits = 6, algorithm = 'SHA1' } = {}) {
  const hash = HASHES[algorithm];
  if (!hash) throw new Error(`Thuật toán không hỗ trợ: ${algorithm}`);
  const keyBytes = typeof secret === 'string' ? base32Decode(secret) : secret;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);

  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export async function totp(secret, { period = 30, digits = 6, algorithm = 'SHA1', now = Date.now() } = {}) {
  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / period);
  return {
    code: await hotp(secret, counter, { digits, algorithm }),
    remaining: period - (seconds % period),
  };
}

export async function generate(account, now = Date.now()) {
  if (account.type === 'hotp') {
    return { code: await hotp(account.secret, account.counter || 0, account), remaining: null };
  }
  return totp(account.secret, { period: account.period, digits: account.digits, algorithm: account.algorithm, now });
}
