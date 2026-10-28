// In-page stand-in for the chrome.* APIs so the popup, options page and content
// script can be exercised in a normal browser tab (npm run dev). The real
// background.js is imported and runs in the same page; storage lives in
// localStorage so every harness page shares one vault.
(() => {
  const params = new URLSearchParams(location.search);

  function area(name) {
    const k = `mock:${name}`;
    const load = () => JSON.parse(localStorage.getItem(k) || '{}');
    const save = (o) => localStorage.setItem(k, JSON.stringify(o));
    return {
      async get(keys) {
        const all = load();
        if (keys == null) return all;
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(list.filter((x) => x in all).map((x) => [x, all[x]]));
      },
      async set(obj) {
        save({ ...load(), ...obj });
      },
      async remove(keys) {
        const all = load();
        for (const x of [].concat(keys)) delete all[x];
        save(all);
      },
      async setAccessLevel() {},
    };
  }

  // background.js is a module (no currentScript); content.js is a classic script.
  const bgListeners = [];
  const pageListeners = [];
  const event = () => ({ addListener() {} });
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const tabUrl = params.get('tab') || location.href;

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  function dispatch(listeners, msg, sender) {
    return new Promise((resolve) => {
      let async = false;
      for (const l of listeners) if (l(clone(msg), sender, (r) => resolve(clone(r))) === true) async = true;
      if (!async) resolve(undefined);
    });
  }

  const chrome = {
    runtime: {
      id: 'mock',
      getURL: (p) => `${location.origin}/${p}`,
      onMessage: { addListener: (fn) => (document.currentScript ? pageListeners : bgListeners).push(fn) },
      onInstalled: event(),
      onStartup: event(),
      async sendMessage(msg) {
        await ready;
        return dispatch(bgListeners, msg, { id: 'mock', url: location.href });
      },
      openOptionsPage: () => window.open('/extension/options/options.html', '_blank'),
    },
    storage: { local: area('local'), session: area('session') },
    alarms: { get: (_n, cb) => cb({}), create() {}, onAlarm: event() },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: tabUrl }],
      sendMessage: async (_id, msg) => dispatch(pageListeners, msg, { id: 'mock' }),
      captureVisibleTab: async () => {
        throw new Error('captureVisibleTab không có trong bản mock');
      },
    },
    action: { openPopup: async () => window.open('/extension/popup/popup.html', '_blank', 'width=380,height=600') },
  };
  Object.defineProperty(window, 'chrome', { value: chrome, configurable: true, writable: true });

  import('/extension/background.js').then(async () => {
    resolveReady();
    if (params.has('seed')) await seed();
  });

  // ?seed — creates a vault (password "test1234") with sample accounts.
  async function seed() {
    const st = await chrome.runtime.sendMessage({ type: 'status' });
    if (st.initialized) return;
    await chrome.runtime.sendMessage({ type: 'setup', password: 'test1234' });
    await chrome.runtime.sendMessage({
      type: 'import',
      text: [
        'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
        'otpauth://totp/Google:me@gmail.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Google',
        'otpauth://totp/Local%20Dev:admin?secret=KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ&issuer=Local%20Dev',
        'otpauth://totp/Binance:trader?secret=MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&issuer=Binance&period=30',
        'otpauth://hotp/Old%20Bank:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=3',
      ].join('\n'),
    });
    const { accounts } = await chrome.runtime.sendMessage({ type: 'listAccounts' });
    const local = accounts.find((a) => a.issuer === 'Local Dev');
    await chrome.runtime.sendMessage({ type: 'linkHost', id: local.id, host: 'localhost' });
    location.reload();
  }
})();
