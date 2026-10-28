// Service worker: the only place secrets are decrypted and codes generated.
// Content scripts get codes for the matching site only — never secrets.
import { parseImportText, toOtpauthUri } from './lib/accounts.js';
import { matchAccount, normalizeDomain, suggestAccount } from './lib/match.js';
import { generate } from './lib/otp.js';
import * as vault from './lib/vault.js';

const DEFAULT_SETTINGS = { autoLockMinutes: 30, showOverlay: true, autoFill: false };
// Messages a content script (i.e. a web page's context) may send.
const PAGE_MESSAGES = new Set(['codesForPage', 'openPopup', 'linkSuggested']);
const MIN_PASSWORD = 8;

let cache = null; // { key: CryptoKey, accounts: Account[] }
let loading = null;
let writeChain = Promise.resolve();

chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

function ensureAlarm() {
  chrome.alarms.get('autolock', (a) => {
    if (!a) chrome.alarms.create('autolock', { periodInMinutes: 1 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'autolock') return;
  const { autoLockMinutes } = await getSettings();
  if (!autoLockMinutes) return;
  const { lastActive } = await chrome.storage.session.get('lastActive');
  if (lastActive && Date.now() - lastActive > autoLockMinutes * 60_000) await lock();
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getStoredVault() {
  const { vault: stored } = await chrome.storage.local.get('vault');
  return stored || null;
}

async function unlockedState() {
  if (cache) return cache;
  loading ??= (async () => {
    const { sessionKey } = await chrome.storage.session.get('sessionKey');
    const stored = await getStoredVault();
    if (!sessionKey || !stored) return null;
    const key = await vault.importKey(sessionKey);
    cache = { key, accounts: await vault.decryptJSON(key, stored) };
    return cache;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

async function requireUnlocked() {
  const state = await unlockedState();
  if (!state) throw new Error('LOCKED');
  return state;
}

async function startSession(key, accounts) {
  cache = { key, accounts };
  await chrome.storage.session.set({ sessionKey: await vault.exportKey(key), lastActive: Date.now() });
}

async function lock() {
  cache = null;
  await chrome.storage.session.remove(['sessionKey', 'lastActive']);
  broadcast();
}

const touch = () => chrome.storage.session.set({ lastActive: Date.now() });

// Serialize writes so concurrent edits never overwrite each other.
function mutate(fn) {
  const run = writeChain.then(async () => {
    const state = await requireUnlocked();
    const result = await fn(state.accounts);
    const sealed = await vault.sealVault(state.key, await getStoredVault(), state.accounts);
    await chrome.storage.local.set({ vault: sealed });
    await touch();
    return result;
  });
  writeChain = run.catch(() => {
    cache = null; // re-read from storage after a failed write
  });
  return run;
}

// Tell content scripts to re-query (after unlock, lock, import, link...).
async function broadcast() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'refresh' }).catch(() => {});
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

async function codeList(accounts, host) {
  const now = Date.now();
  return Promise.all(
    accounts.map(async (a) => {
      let code = null;
      let remaining = null;
      let error = null;
      try {
        ({ code, remaining } = await generate(a, now));
      } catch (e) {
        error = e.message;
      }
      return {
        id: a.id,
        issuer: a.issuer,
        label: a.label,
        type: a.type,
        period: a.period,
        digits: a.digits,
        code,
        remaining,
        error,
        domains: a.domains || [],
        match: host ? matchAccount(a, host) || (suggestAccount(a, host) ? 'suggest' : null) : null,
      };
    }),
  );
}

function findAccount(accounts, id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Không tìm thấy tài khoản');
  return acc;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Mật khẩu cần tối thiểu ${MIN_PASSWORD} ký tự`);
  }
}

const handlers = {
  async status() {
    const stored = await getStoredVault();
    const state = stored ? await unlockedState().catch(() => null) : null;
    return { initialized: !!stored, unlocked: !!state, settings: await getSettings() };
  },

  async setup({ password }) {
    if (await getStoredVault()) throw new Error('Vault đã được tạo');
    checkPassword(password);
    const { vault: created, key } = await vault.createVault(password, []);
    await chrome.storage.local.set({ vault: created });
    await startSession(key, []);
    return {};
  },

  async unlock({ password }) {
    const stored = await getStoredVault();
    if (!stored) throw new Error('Chưa tạo vault');
    const { key, data } = await vault.openVault(String(password || ''), stored);
    await startSession(key, data);
    broadcast();
    return {};
  },

  async lock() {
    await lock();
    return {};
  },

  async listCodes({ host }) {
    const state = await requireUnlocked();
    await touch();
    return { codes: await codeList(state.accounts, host) };
  },

  async codesForPage(_msg, sender) {
    const settings = await getSettings();
    if (!settings.showOverlay) return { disabled: true };
    // Trust the browser-reported frame URL, not anything the page could forge.
    const host = hostOf(sender.url);
    if (!host) return { disabled: true };
    if (!(await getStoredVault())) return { uninitialized: true };
    const state = await unlockedState();
    if (!state) return { locked: true, host };
    const matched = state.accounts.filter((a) => matchAccount(a, host));
    const codes = (await codeList(matched, host)).map(({ domains, ...c }) => c);
    // Names only — no codes until the user confirms the link.
    const suggestions = state.accounts
      .filter((a) => suggestAccount(a, host))
      .map(({ id, issuer, label }) => ({ id, issuer, label }));
    return { host, autoFill: settings.autoFill, codes, suggestions };
  },

  // From the page overlay after a trusted click: link a suggested account to
  // the frame's own host (taken from Chrome, not from the message).
  async linkSuggested({ id }, sender) {
    const host = hostOf(sender.url);
    if (!host) throw new Error('Forbidden');
    const result = await mutate((list) => {
      const acc = findAccount(list, id);
      if (!suggestAccount(acc, host)) throw new Error('Tài khoản này không được gợi ý cho trang này');
      acc.domains = [...new Set([...(acc.domains || []), host])];
      return { domain: host };
    });
    broadcast();
    return result;
  },

  async openPopup() {
    try {
      await chrome.action.openPopup();
      return { opened: true };
    } catch {
      return { opened: false };
    }
  },

  async import({ text }) {
    await requireUnlocked();
    const { accounts, errors, batches } = parseImportText(text);
    if (!accounts.length) return { added: 0, skipped: 0, errors, batches };
    const result = await mutate((list) => {
      let added = 0;
      let skipped = 0;
      for (const a of accounts) {
        if (list.some((x) => x.secret === a.secret && x.label === a.label && x.issuer === a.issuer)) {
          skipped++;
          continue;
        }
        list.push({ ...a, id: crypto.randomUUID(), domains: [], createdAt: Date.now() });
        added++;
      }
      return { added, skipped };
    });
    broadcast();
    return { ...result, errors, batches };
  },

  async listAccounts() {
    const state = await requireUnlocked();
    await touch();
    return {
      accounts: state.accounts.map(({ secret, ...meta }) => meta),
    };
  },

  async updateAccount({ id, issuer, label, domains }) {
    await mutate((list) => {
      const acc = findAccount(list, id);
      if (typeof issuer === 'string') acc.issuer = issuer.trim();
      if (typeof label === 'string') acc.label = label.trim();
      if (Array.isArray(domains)) acc.domains = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
    });
    broadcast();
    return {};
  },

  async deleteAccount({ id }) {
    await mutate((list) => {
      const i = list.findIndex((a) => a.id === id);
      if (i === -1) throw new Error('Không tìm thấy tài khoản');
      list.splice(i, 1);
    });
    broadcast();
    return {};
  },

  async linkHost({ id, host }) {
    // Exact host: linking on gitlab.example.com must not cover jira.example.com.
    const domain = normalizeDomain(host);
    if (!domain) throw new Error('Tên miền không hợp lệ');
    await mutate((list) => {
      const acc = findAccount(list, id);
      acc.domains = [...new Set([...(acc.domains || []), domain])];
    });
    broadcast();
    return { domain };
  },

  async unlinkHost({ id, host }) {
    const h = normalizeDomain(host);
    await mutate((list) => {
      const acc = findAccount(list, id);
      acc.domains = (acc.domains || []).filter((d) => !(h === d || h.endsWith(`.${d}`)));
    });
    broadcast();
    return {};
  },

  async hotpNext({ id }) {
    await mutate((list) => {
      const acc = findAccount(list, id);
      if (acc.type !== 'hotp') throw new Error('Chỉ áp dụng cho HOTP');
      acc.counter = (acc.counter || 0) + 1;
    });
    return {};
  },

  async getSettings() {
    return { settings: await getSettings() };
  },

  async setSettings({ settings }) {
    const current = await getSettings();
    const next = {
      autoLockMinutes: Math.max(0, Math.min(1440, Number(settings.autoLockMinutes ?? current.autoLockMinutes) || 0)),
      showOverlay: Boolean(settings.showOverlay ?? current.showOverlay),
      autoFill: Boolean(settings.autoFill ?? current.autoFill),
    };
    await chrome.storage.local.set({ settings: next });
    broadcast();
    return { settings: next };
  },

  async exportUris({ password }) {
    const { data } = await vault.openVault(String(password || ''), await getStoredVault());
    return { text: data.map(toOtpauthUri).join('\n') };
  },

  async changePassword({ oldPassword, newPassword }) {
    checkPassword(newPassword);
    const stored = await getStoredVault();
    const { data } = await vault.openVault(String(oldPassword || ''), stored);
    const { vault: created, key } = await vault.createVault(newPassword, data);
    await chrome.storage.local.set({ vault: created });
    await startSession(key, data);
    return {};
  },
};

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!Object.hasOwn(handlers, type)) return false;
  if (!PAGE_MESSAGES.has(type) && !isExtensionPage(sender)) {
    sendResponse({ ok: false, error: 'Forbidden' });
    return false;
  }
  handlers[type](msg, sender).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});
