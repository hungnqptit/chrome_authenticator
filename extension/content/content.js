// Detects 2FA prompts and shows the matching code next to the input.
// Runs in Chrome's isolated world; the card lives in a closed shadow root.
(() => {
  'use strict';
  if (window.__myAuthenticatorLoaded) return;
  window.__myAuthenticatorLoaded = true;

  const PAGE_HINTS =
    /two[-\s]?factor|\b2fa\b|two[-\s]?step|\b2[-\s]?step|multi[-\s]?factor|\bmfa\b|authenticator|authentication code|verification code|security code|one[-\s]?time (?:password|code|passcode)|\botp\b|xác (?:thực|minh) (?:hai|2)|mã xác (?:thực|minh)|mã bảo mật|mã otp/i;
  const INPUT_HINTS =
    /(?:^|[^a-z])(?:otp|totp|2fa|mfa|tfa|2sv|one[-_ ]?time|verification[-_ ]?code|verify[-_ ]?code|auth(?:entication|enticator)?[-_ ]?code|security[-_ ]?code|two[-_ ]?factor|passcode|approvals[-_ ]?code|mã xác)/i;
  const TEXT_TYPES = new Set(['text', 'tel', 'number', 'password']);

  const state = {
    target: null, // { input, group }
    data: null,
    dismissed: new WeakSet(),
    autoFilled: new WeakSet(),
    tick: null,
  };
  let overlay = null; // { host, root, card }
  let scanTimer = null;

  // ---------- detection ----------

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
  }

  function hintsOf(el) {
    const parts = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute('aria-label'),
      el.getAttribute('data-testid'),
      el.getAttribute('autocomplete'),
    ];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) parts.push(document.getElementById(id)?.textContent);
    // Split camelCase so "inputOtp" reads as "input Otp".
    return parts.filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  function pageMentions2fa() {
    return PAGE_HINTS.test(`${document.title} ${document.body?.textContent || ''}`);
  }

  function candidateInputs() {
    return [...document.querySelectorAll('input')].filter(
      (i) => TEXT_TYPES.has(i.type) && !i.disabled && !i.readOnly && isVisible(i),
    );
  }

  function segmentGroup(el) {
    let anc = el.parentElement;
    for (let d = 0; anc && d < 4; d++, anc = anc.parentElement) {
      const boxes = [...anc.querySelectorAll('input')].filter(
        (i) => i.maxLength === 1 && TEXT_TYPES.has(i.type) && isVisible(i),
      );
      if (boxes.length > 8) return null;
      if (boxes.length >= 4) return boxes;
    }
    return null;
  }

  function withGroup(input) {
    if (input.maxLength === 1) {
      const group = segmentGroup(input);
      if (group) return { input: group[0], group };
    }
    return { input, group: null };
  }

  function findTarget() {
    const inputs = candidateInputs();
    if (!inputs.length) return null;

    const strong = inputs.find((i) => INPUT_HINTS.test(hintsOf(i)));
    if (strong) return withGroup(strong);

    if (!pageMentions2fa()) return null;

    for (const i of inputs) {
      if (i.maxLength !== 1) continue;
      const group = segmentGroup(i);
      if (group) return { input: group[0], group };
    }
    const weak = inputs.find(
      (i) =>
        (i.type !== 'password' || (i.maxLength >= 6 && i.maxLength <= 8)) &&
        ((i.maxLength >= 4 && i.maxLength <= 10) ||
          i.inputMode === 'numeric' ||
          i.type === 'tel' ||
          i.type === 'number' ||
          /\bcode\b|\bpin\b|\bmã\b/i.test(hintsOf(i))),
    );
    return weak ? { input: weak, group: null } : null;
  }

  // ---------- filling ----------

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function setValue(el, value) {
    el.focus();
    nativeValueSetter.call(el, value); // bypasses React's value tracking
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
  }

  function fillCode(code, target = state.target || findTarget()) {
    if (!target || !code) return false;
    if (target.group) {
      [...code].forEach((ch, i) => target.group[i] && setValue(target.group[i], ch));
      target.group[Math.min(code.length, target.group.length) - 1]?.focus();
    } else {
      setValue(target.input, code);
    }
    return true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  // ---------- overlay ----------

  const CSS = `
    :host { all: initial; }
    .card {
      position: fixed; z-index: 2147483647; width: 296px; box-sizing: border-box;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1b1d22; background: #fff; border: 1px solid rgba(15, 23, 42, .12);
      border-radius: 12px; box-shadow: 0 10px 30px rgba(15, 23, 42, .18); overflow: hidden;
      animation: pop .14s ease-out;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
    .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px; border-bottom: 1px solid #eef0f3; }
    .logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, #4f46e5, #7c3aed);
      display: grid; place-items: center; color: #fff; font-size: 11px; font-weight: 700; flex: none; }
    .title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .host { color: #6b7280; font-weight: 400; }
    .x { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center;
      border-radius: 6px; color: #6b7280; font-size: 16px; }
    .x:hover { background: #f3f4f6; color: #111827; }
    .list { max-height: 260px; overflow: auto; }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 10px 12px; align-items: center; }
    .row + .row { border-top: 1px solid #f1f2f4; }
    .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #4b5563; font-size: 12px; }
    .name b { color: #111827; font-weight: 600; }
    .code { all: unset; cursor: pointer; font: 600 22px/1.15 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: .04em; color: #312e81; }
    .code:hover { color: #4f46e5; }
    .code.expiring { color: #dc2626; }
    .btns { grid-row: 1 / span 2; grid-column: 2; display: flex; gap: 6px; }
    .btn { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; font-weight: 600; font-size: 12px;
      background: #f3f4f6; color: #111827; }
    .btn:hover { background: #e5e7eb; }
    .btn.primary { background: #4f46e5; color: #fff; }
    .btn.primary:hover { background: #4338ca; }
    .bar { grid-column: 1 / -1; height: 3px; border-radius: 2px; background: #eef0f3; overflow: hidden; margin-top: 4px; }
    .bar i { display: block; height: 100%; background: #6366f1; transition: width 1s linear; }
    .bar i.expiring { background: #dc2626; }
    .msg { padding: 12px; color: #374151; }
    .msg p { margin: 0 0 10px; }
    .note { padding: 6px 12px 9px; color: #6b7280; font-size: 11px; }
    @media (prefers-color-scheme: dark) {
      .card { color: #e5e7eb; background: #1f2128; border-color: rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
      .head { border-color: #2c2f38; }
      .row + .row { border-color: #2a2d35; }
      .name { color: #9ca3af; } .name b { color: #f3f4f6; }
      .code { color: #c7d2fe; } .code:hover { color: #a5b4fc; }
      .btn { background: #2c2f38; color: #f3f4f6; } .btn:hover { background: #373a45; }
      .bar { background: #2c2f38; }
      .x:hover { background: #2c2f38; color: #fff; }
      .msg { color: #d1d5db; }
    }
  `;

  function ensureOverlay() {
    if (overlay?.host.isConnected) return overlay;
    const host = document.createElement('my-authenticator-overlay');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Mã xác thực hai bước');
    root.append(style, card);
    document.documentElement.appendChild(host);
    overlay = { host, root, card };
    return overlay;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'onclick') {
        node.addEventListener('click', (e) => {
          if (!e.isTrusted) return; // ignore clicks synthesized by the page
          e.preventDefault();
          e.stopPropagation();
          v(e);
        });
      } else if (k === 'className') node.className = v;
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  function formatCode(code) {
    if (!code) return '——';
    const mid = Math.floor(code.length / 2);
    return `${code.slice(0, mid)} ${code.slice(mid)}`;
  }

  function header(host) {
    return el(
      'div',
      { className: 'head' },
      el('div', { className: 'logo' }, '2'),
      el('div', { className: 'title' }, 'Authenticator ', el('span', { className: 'host' }, host ? `· ${host}` : '')),
      el('button', { className: 'x', title: 'Đóng', 'aria-label': 'Đóng', onclick: dismiss }, '×'),
    );
  }

  async function openPopupOrHint(msgNode) {
    const res = await send({ type: 'openPopup' });
    if (!res?.opened) msgNode.textContent = 'Bấm vào biểu tượng My Authenticator trên thanh công cụ (hoặc Alt+Shift+A).';
  }

  function render() {
    const { card } = ensureOverlay();
    const data = state.data;
    card.replaceChildren(header(data.host));

    if (data.locked) {
      const p = el('p', {}, 'Authenticator đang khoá. Mở khoá để xem mã cho trang này.');
      card.append(
        el('div', { className: 'msg' }, p, el('button', { className: 'btn primary', onclick: () => openPopupOrHint(p) }, 'Mở khoá')),
      );
    } else if (!data.codes.length && data.suggestions?.length) {
      const list = el('div', { className: 'list' });
      for (const s of data.suggestions) {
        const btn = el('button', { className: 'btn primary', onclick: async () => {
          btn.textContent = '…';
          const res = await send({ type: 'linkSuggested', id: s.id });
          if (res?.ok) refresh();
          else btn.textContent = 'Lỗi';
        } }, 'Dùng');
        list.append(
          el(
            'div',
            { className: 'row' },
            el('div', { className: 'name' }, el('b', {}, s.issuer || 'Không tên'), s.label ? ` · ${s.label}` : ''),
            el('div', { className: 'btns' }, btn),
          ),
        );
      }
      card.append(
        el('div', { className: 'note' }, `Có vẻ khớp với ${data.host}. Bấm "Dùng" để luôn hiện mã ở trang này:`),
        list,
      );
    } else if (!data.codes.length) {
      const p = el('p', {}, `Chưa có tài khoản nào gắn với ${data.host}.`);
      card.append(
        el(
          'div',
          { className: 'msg' },
          p,
          el('button', { className: 'btn', onclick: () => openPopupOrHint(p) }, 'Chọn tài khoản…'),
        ),
      );
    } else {
      const list = el('div', { className: 'list' });
      for (const c of data.codes) {
        const fill = () => {
          if (fillCode(c.code)) dismiss();
        };
        const codeBtn = el('button', { className: 'code', title: 'Điền mã', onclick: fill }, formatCode(c.code));
        const bar = el('i');
        const row = el(
          'div',
          { className: 'row' },
          el('div', { className: 'name' }, el('b', {}, c.issuer || 'Không tên'), c.label ? ` · ${c.label}` : ''),
          el(
            'div',
            { className: 'btns' },
            el('button', { className: 'btn', title: 'Sao chép', onclick: async (e) => {
              const ok = await copyText(c.code);
              e.target.textContent = ok ? 'Đã chép' : 'Lỗi';
              setTimeout(() => (e.target.textContent = 'Chép'), 1200);
            } }, 'Chép'),
            el('button', { className: 'btn primary', onclick: fill }, 'Điền'),
          ),
          codeBtn,
        );
        if (c.type !== 'hotp') row.append(el('div', { className: 'bar' }, bar));
        c._els = { codeBtn, bar };
        list.append(row);
      }
      card.append(list);
      card.append(el('div', { className: 'note' }, 'Esc để đóng · mã chỉ hiển thị cho tài khoản khớp trang này'));
    }
    updateTimers();
    position();
    startTick();
  }

  function updateTimers() {
    for (const c of state.data?.codes || []) {
      if (!c._els || c.remaining == null) continue;
      const expiring = c.remaining <= 5;
      c._els.bar.style.width = `${(c.remaining / c.period) * 100}%`;
      c._els.bar.classList.toggle('expiring', expiring);
      c._els.codeBtn.classList.toggle('expiring', expiring);
    }
  }

  function startTick() {
    clearInterval(state.tick);
    if (!state.data?.codes?.some((c) => c.remaining != null)) return;
    state.tick = setInterval(() => {
      let expired = false;
      for (const c of state.data.codes) {
        if (c.remaining == null) continue;
        c.remaining -= 1;
        if (c.remaining <= 0) expired = true;
      }
      if (expired) refresh();
      else updateTimers();
    }, 1000);
  }

  function position() {
    if (!overlay || !state.target) return;
    const r = state.target.input.getBoundingClientRect();
    const last = state.target.group?.at(-1)?.getBoundingClientRect() || r;
    const { card } = overlay;
    const w = card.offsetWidth || 296;
    const h = card.offsetHeight || 140;
    let top = r.bottom + 8;
    if (top + h > innerHeight - 8 && r.top - h - 8 > 8) top = r.top - h - 8;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8, Math.max(r.left, last.right - w)));
    card.style.top = `${Math.max(8, top)}px`;
    card.style.left = `${left}px`;
  }

  function hide(resetTarget = true) {
    clearInterval(state.tick);
    overlay?.host.remove();
    overlay = null;
    state.data = null;
    if (resetTarget) state.target = null;
  }

  function dismiss() {
    if (state.target) state.dismissed.add(state.target.input);
    hide();
  }

  // ---------- flow ----------

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return null; // extension was reloaded; this script is orphaned
    }
  }

  async function refresh() {
    const target = state.target;
    if (!target) return;
    const res = await send({ type: 'codesForPage' });
    if (state.target !== target) return;
    if (!res?.ok || res.disabled || res.uninitialized) {
      hide(false);
      return;
    }
    state.data = res;
    if (
      res.autoFill &&
      res.codes?.length === 1 &&
      res.codes[0].code &&
      !target.input.value &&
      !state.autoFilled.has(target.input)
    ) {
      state.autoFilled.add(target.input);
      fillCode(res.codes[0].code, target);
    }
    render();
  }

  function scan() {
    if (!chrome.runtime?.id) {
      observer.disconnect();
      hide();
      return;
    }
    const cur = state.target;
    if (cur && cur.input.isConnected && isVisible(cur.input)) {
      position();
      return;
    }
    const next = findTarget();
    if (!next) {
      if (cur) hide();
      return;
    }
    if (state.dismissed.has(next.input)) return;
    hide();
    state.target = next;
    refresh();
  }

  function scheduleScan(delay = 400) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  const observer = new MutationObserver((records) => {
    if (records.every((r) => r.target === overlay?.host)) return;
    scheduleScan();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'type'],
  });

  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement) scheduleScan(50);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay) dismiss();
  }, true);

  let rafPending = false;
  const onMove = () => {
    if (rafPending || !overlay) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      position();
    });
  };
  addEventListener('scroll', onMove, true);
  addEventListener('resize', onMove);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'refresh') {
      if (state.target) refresh();
      else scheduleScan(0);
    } else if (msg?.type === 'fill') {
      // Sent by the popup when the user clicks "Điền" there.
      const target = state.target || findTarget();
      if (!target) return;
      sendResponse({ filled: fillCode(msg.code, target) });
      if (state.target) dismiss();
    }
  });

  scheduleScan(0);
})();
