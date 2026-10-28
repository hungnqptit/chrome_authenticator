// Unit tests for the extension's pure logic. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseImportText, parseOtpauthUri, toOtpauthUri } from '../extension/lib/accounts.js';
import { base32Decode, base32Encode } from '../extension/lib/base32.js';
import { matchAccount, registrableDomain, suggestAccount } from '../extension/lib/match.js';
import { hotp, totp } from '../extension/lib/otp.js';
import { createVault, openVault, sealVault } from '../extension/lib/vault.js';

const ascii = (s) => new TextEncoder().encode(s);

test('base32 round-trip', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.equal(base32Encode(ascii('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('jbsw y3dp ehpk 3pxp'), base32Decode('JBSWY3DPEHPK3PXP'));
  assert.throws(() => base32Decode('ABC1'));
});

test('HOTP matches RFC 4226 vectors', async () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(await hotp(ascii('12345678901234567890'), i), expected[i]);
  }
});

test('TOTP matches RFC 6238 vectors', async () => {
  const keys = {
    SHA1: ascii('12345678901234567890'),
    SHA256: ascii('12345678901234567890123456789012'),
    SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, s1, s256, s512] of vectors) {
    const now = t * 1000;
    assert.equal((await totp(keys.SHA1, { digits: 8, algorithm: 'SHA1', now })).code, s1);
    assert.equal((await totp(keys.SHA256, { digits: 8, algorithm: 'SHA256', now })).code, s256);
    assert.equal((await totp(keys.SHA512, { digits: 8, algorithm: 'SHA512', now })).code, s512);
  }
  assert.equal((await totp(keys.SHA1, { now: 59_000 })).remaining, 1);
});

test('parses otpauth:// URIs', () => {
  const a = parseOtpauthUri('otpauth://totp/ACME%20Co:john@example.com?secret=jbswy3dpehpk3pxp&issuer=ACME%20Co&digits=8&period=60&algorithm=SHA256');
  assert.deepEqual(a, {
    issuer: 'ACME Co', label: 'john@example.com', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA256', digits: 8, period: 60, type: 'totp', counter: 0,
  });
  const b = parseOtpauthUri('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP');
  assert.equal(b.issuer, 'GitHub');
  assert.equal(b.label, 'me');
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret='), /secret/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=JBSWY3DP&algorithm=MD5'), /MD5/);
  // round-trip through the export format
  assert.deepEqual(parseOtpauthUri(toOtpauthUri(a)), a);
});

// --- minimal protobuf encoder to build Google Authenticator migration payloads ---
function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const fieldVarint = (f, n) => [...varint(f * 8), ...varint(n)];
const fieldBytes = (f, bytes) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
function otpParams({ secret, name, issuer, algorithm = 1, digits = 1, type = 2, counter = 0 }) {
  return [
    ...fieldBytes(1, secret), ...fieldBytes(2, ascii(name)), ...fieldBytes(3, ascii(issuer)),
    ...fieldVarint(4, algorithm), ...fieldVarint(5, digits), ...fieldVarint(6, type), ...fieldVarint(7, counter),
  ];
}
function migrationUri(params, { batchSize = 1, batchIndex = 0 } = {}) {
  const bytes = Uint8Array.from([
    ...params.flatMap((p) => fieldBytes(1, otpParams(p))),
    ...fieldVarint(2, 1), ...fieldVarint(3, batchSize), ...fieldVarint(4, batchIndex), ...fieldVarint(5, 123456789),
  ]);
  return `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(bytes).toString('base64'))}`;
}

test('parses Google Authenticator migration QR payloads', async () => {
  const secret = ascii('12345678901234567890');
  const uri = migrationUri(
    [
      { secret, name: 'me@gmail.com', issuer: 'Google' },
      { secret: crypto.getRandomValues(new Uint8Array(10)), name: 'GitHub:octocat', issuer: '', digits: 2, algorithm: 2 },
      { secret, name: 'legacy', issuer: 'Bank', type: 1, counter: 5 },
      { secret, name: 'bad', issuer: 'Weird', algorithm: 4 },
    ],
    { batchSize: 2, batchIndex: 1 },
  );
  const { accounts, errors, batches } = parseImportText(`some text\n${uri}\nmore`);
  assert.equal(accounts.length, 3);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /MD5/);
  assert.deepEqual(batches, [{ size: 2, index: 1, id: 123456789 }]);
  assert.deepEqual(
    accounts.map((a) => [a.issuer, a.label, a.type, a.digits, a.algorithm, a.counter]),
    [
      ['Google', 'me@gmail.com', 'totp', 6, 'SHA1', 0],
      ['GitHub', 'octocat', 'totp', 8, 'SHA256', 0],
      ['Bank', 'legacy', 'hotp', 6, 'SHA1', 5],
    ],
  );
  assert.equal(accounts[0].secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(await hotp(accounts[2].secret, accounts[2].counter), '254676');
});

test('migration payload tolerates raw "+" in data', () => {
  // Try secrets until the base64 contains a "+" (it encodes as a space in query strings).
  let raw = '';
  for (let i = 0; !raw.includes('+'); i++) {
    const secret = Uint8Array.from([0xfb, 0xef, 0xbe, 0xfb, i, i, i]);
    raw = decodeURIComponent(migrationUri([{ secret, name: 'x', issuer: 'Y' }]).split('data=')[1]);
  }
  const { accounts } = parseImportText(`otpauth-migration://offline?data=${raw}`);
  assert.equal(accounts.length, 1);
});

test('registrable domain', () => {
  assert.equal(registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(registrableDomain('www.vietcombank.com.vn'), 'vietcombank.com.vn');
  assert.equal(registrableDomain('login.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('google.com.evil.io'), 'evil.io');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('site matching is strict', () => {
  const google = { issuer: 'Google', domains: [] };
  assert.equal(matchAccount(google, 'accounts.google.com'), 'issuer');
  assert.equal(matchAccount(google, 'google-login.com'), null);
  assert.equal(matchAccount(google, 'google.com.evil.io'), null);
  assert.equal(matchAccount(google, 'notgoogle.com'), null);
  assert.equal(matchAccount({ issuer: 'GitHub' }, 'github.com'), 'issuer');
  assert.equal(matchAccount({ issuer: 'Amazon Web Services' }, 'signin.aws.amazon.com'), 'issuer');
  assert.equal(matchAccount({ issuer: 'binance.com' }, 'accounts.binance.com'), 'issuer');
  const linked = { issuer: 'My VPN', domains: ['corp.example'] };
  assert.equal(matchAccount(linked, 'vpn.corp.example'), 'linked');
  assert.equal(matchAccount(linked, 'evilcorp.example'), null);
});

test('company subdomains do not share accounts', () => {
  // Self-hosted GitLab puts its host in the issuer.
  const gitlab = { issuer: 'gitlab.mbbank.com.vn', domains: [] };
  assert.equal(matchAccount(gitlab, 'gitlab.mbbank.com.vn'), 'issuer');
  assert.equal(matchAccount(gitlab, 'jira.mbbank.com.vn'), null);
  assert.equal(matchAccount(gitlab, 'confluence.mbbank.com.vn'), null);
  assert.equal(matchAccount(gitlab, 'mbbank.com.vn'), null);

  // Issuer is the company name: only its own sign-in hosts, not every internal app.
  const company = { issuer: 'MB Bank', domains: [] };
  assert.equal(matchAccount(company, 'mbbank.com.vn'), 'issuer');
  assert.equal(matchAccount(company, 'login.mbbank.com.vn'), 'issuer');
  assert.equal(matchAccount(company, 'jira.mbbank.com.vn'), null);

  // A link made on one host covers that host only.
  const jira = { issuer: 'Atlassian', domains: ['jira.mbbank.com.vn'] };
  assert.equal(matchAccount(jira, 'jira.mbbank.com.vn'), 'linked');
  assert.equal(matchAccount(jira, 'confluence.mbbank.com.vn'), null);
});

test('vault encrypts, rejects wrong password, re-seals', async () => {
  const data = [{ id: '1', secret: 'JBSWY3DPEHPK3PXP' }];
  const { vault, key } = await createVault('correct horse', data);
  assert.ok(!JSON.stringify(vault).includes('JBSWY3DP'));
  assert.deepEqual((await openVault('correct horse', vault)).data, data);
  await assert.rejects(openVault('wrong password', vault), /Sai mật khẩu/);
  const resealed = await sealVault(key, vault, [...data, { id: '2' }]);
  assert.notEqual(resealed.iv, vault.iv);
  assert.equal((await openVault('correct horse', resealed)).data.length, 2);
});

test('suggests app-named accounts on their subdomain, without auto-matching', () => {
  const jira = { issuer: 'Jira', label: 'hungnq10', domains: [] };
  const confluence = { issuer: 'Confluence', label: 'hungnq10', domains: [] };
  const gitlab = { issuer: 'gitlab.mbbank.com.vn', domains: [] };
  const host = 'jira.mbbank.com.vn';
  assert.equal(matchAccount(jira, host), null);
  assert.equal(suggestAccount(jira, host), true);
  assert.equal(suggestAccount(confluence, host), false);
  assert.equal(suggestAccount(gitlab, host), false);
  assert.equal(suggestAccount(confluence, 'confluence.mbbank.com.vn'), true);
  assert.equal(suggestAccount({ issuer: 'MB Bank' }, host), true);
  // once linked it is a real match, no longer a suggestion
  const linked = { ...jira, domains: [host] };
  assert.equal(matchAccount(linked, host), 'linked');
  assert.equal(suggestAccount(linked, host), false);
  assert.equal(suggestAccount({ issuer: 'X' }, 'x.example.com'), false);
});
