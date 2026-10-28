// Turns otpauth:// and otpauth-migration:// URIs into normalized account records.
import { base32Decode, base32Encode } from './base32.js';
import { parseMigrationUri } from './migration.js';

const MIGRATION_ALGOS = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const MIGRATION_DIGITS = { 0: 6, 1: 6, 2: 8 };
const MIGRATION_TYPES = { 0: 'totp', 1: 'hotp', 2: 'totp' };

function splitLabel(label) {
  const i = label.indexOf(':');
  if (i === -1) return { issuer: '', name: label.trim() };
  return { issuer: label.slice(0, i).trim(), name: label.slice(i + 1).trim() };
}

export function normalizeAccount(raw) {
  const algorithm = String(raw.algorithm || 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) {
    throw new Error(`Thuật toán ${algorithm} chưa được hỗ trợ`);
  }
  const digits = Number(raw.digits || 6);
  if (!(digits >= 6 && digits <= 8)) throw new Error(`Số chữ số không hợp lệ: ${raw.digits}`);
  const period = Number(raw.period || 30);
  if (!(period > 0 && period <= 300)) throw new Error(`Chu kỳ không hợp lệ: ${raw.period}`);
  const type = raw.type === 'hotp' ? 'hotp' : 'totp';
  const secretBytes = typeof raw.secret === 'string' ? base32Decode(raw.secret) : raw.secret;
  if (!secretBytes?.length) throw new Error('Secret trống');
  return {
    issuer: String(raw.issuer || '').trim(),
    label: String(raw.label || '').trim(),
    secret: base32Encode(secretBytes),
    algorithm,
    digits,
    period,
    type,
    counter: type === 'hotp' ? Number(raw.counter || 0) : 0,
  };
}

export function parseOtpauthUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:') throw new Error('Không phải URI otpauth://');
  const type = url.hostname.toLowerCase();
  if (type !== 'totp' && type !== 'hotp') throw new Error(`Loại OTP không hỗ trợ: ${type}`);
  let label = url.pathname.replace(/^\//, '');
  try {
    label = decodeURIComponent(label);
  } catch {
    // keep the raw label
  }
  const { issuer: labelIssuer, name } = splitLabel(label);
  const p = url.searchParams;
  const secret = p.get('secret');
  if (!secret) throw new Error('Thiếu tham số secret');
  return normalizeAccount({
    type,
    issuer: p.get('issuer') || labelIssuer,
    label: name,
    secret,
    algorithm: p.get('algorithm'),
    digits: p.get('digits'),
    period: p.get('period'),
    counter: p.get('counter'),
  });
}

export function parseMigration(uri) {
  const payload = parseMigrationUri(uri);
  const accounts = [];
  const errors = [];
  for (const p of payload.otpParameters) {
    try {
      const { issuer: labelIssuer, name } = splitLabel(p.name);
      accounts.push(
        normalizeAccount({
          type: MIGRATION_TYPES[p.type],
          issuer: p.issuer || labelIssuer,
          label: name,
          secret: p.secret,
          algorithm: MIGRATION_ALGOS[p.algorithm],
          digits: MIGRATION_DIGITS[p.digits],
          counter: p.counter,
        }),
      );
    } catch (e) {
      errors.push(`${p.issuer || p.name || 'Tài khoản không tên'}: ${e.message}`);
    }
  }
  return {
    accounts,
    errors,
    batch: { size: payload.batchSize, index: payload.batchIndex, id: payload.batchId },
  };
}

// Accepts any blob of text (one URI per line, a backup file, QR contents...).
export function parseImportText(text) {
  const uris = String(text).match(/otpauth(?:-migration)?:\/\/[^\s"'<>]+/gi) || [];
  const accounts = [];
  const errors = [];
  const batches = [];
  for (const uri of uris) {
    try {
      if (/^otpauth-migration:/i.test(uri)) {
        const r = parseMigration(uri);
        accounts.push(...r.accounts);
        errors.push(...r.errors);
        batches.push(r.batch);
      } else {
        accounts.push(parseOtpauthUri(uri));
      }
    } catch (e) {
      errors.push(`${uri.slice(0, 40)}…: ${e.message}`);
    }
  }
  if (!uris.length) errors.push('Không tìm thấy URI otpauth:// hoặc otpauth-migration:// nào');
  return { accounts, errors, batches };
}

export function toOtpauthUri(acc) {
  const label = encodeURIComponent(acc.issuer ? `${acc.issuer}:${acc.label}` : acc.label);
  const params = new URLSearchParams({ secret: acc.secret });
  if (acc.issuer) params.set('issuer', acc.issuer);
  params.set('algorithm', acc.algorithm);
  params.set('digits', String(acc.digits));
  if (acc.type === 'hotp') params.set('counter', String(acc.counter || 0));
  else params.set('period', String(acc.period));
  return `otpauth://${acc.type}/${label}?${params}`;
}
