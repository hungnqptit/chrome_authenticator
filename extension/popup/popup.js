import { describeImport, detectQrCodes, formatCode, h, send, toast } from '../ui/common.js';

const $ = (s) => document.querySelector(s);
const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

let tab = null;
let currentHost = null;
let codes = [];
let tickTimer = null;

function show(view) {
  for (const v of ['setup', 'locked', 'main']) $(`#view-${v}`).hidden = v !== view;
}

async function route() {
  const st = await send('status');
  if (!st.initialized) {
    show('setup');
    $('#setup-pass').focus();
  } else if (!st.unlocked) {
    show('locked');
    $('#unlock-pass').focus();
  } else {
    show('main');
    await loadCodes();
  }
}

async function loadCodes() {
  try {
    ({ codes } = await send('listCodes', { host: currentHost }));
  } catch (e) {
    if (e.message === 'LOCKED') return route();
    throw e;
  }
  render();
  startTick();
}

function ring(c) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 22 22');
  svg.classList.add('ring');
  for (const cls of ['track', 'fill']) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '11');
    circle.setAttribute('cy', '11');
    circle.setAttribute('r', String(RING_R));
    circle.classList.add(cls);
    if (cls === 'fill') circle.style.strokeDasharray = String(RING_C);
    svg.append(circle);
  }
  return svg;
}

async function copy(c) {
  if (!c.code) return;
  await navigator.clipboard.writeText(c.code);
  toast(`Đã sao chép mã ${c.issuer || ''}`.trim(), 'ok');
}

async function fillOnPage(c) {
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'fill', code: c.code });
    if (res?.filled) {
      window.close();
      return;
    }
  } catch {
    // no content script on this tab (e.g. chrome:// pages)
  }
  await copy(c);
  toast('Không tìm thấy ô nhập mã — đã sao chép thay thế');
}

function itemFor(c) {
  const actions = h('div', { className: 'actions' });
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn().catch((err) => toast(err.message, 'error'));
  };
  if (currentHost && c.code) {
    actions.append(h('button', { title: 'Điền vào trang', onclick: stop(() => fillOnPage(c)) }, 'Điền'));
  }
  if (currentHost && c.match === 'linked') {
    actions.append(
      h('button', {
        title: `Bỏ gắn khỏi ${currentHost}`,
        onclick: stop(async () => {
          await send('unlinkHost', { id: c.id, host: currentHost });
          await loadCodes();
        }),
      }, 'Bỏ gắn'),
    );
  } else if (currentHost && c.match !== 'issuer') {
    actions.append(
      h('button', {
        title: `Luôn hiện tài khoản này trên ${currentHost}`,
        onclick: stop(async () => {
          const { domain } = await send('linkHost', { id: c.id, host: currentHost });
          toast(`Đã gắn với ${domain}`, 'ok');
          await loadCodes();
        }),
      }, 'Gắn trang này'),
    );
  }
  if (c.type === 'hotp') {
    actions.append(
      h('button', {
        title: 'Tạo mã HOTP kế tiếp',
        onclick: stop(async () => {
          await send('hotpNext', { id: c.id });
          await loadCodes();
        }),
      }, 'Mã mới'),
    );
  }

  const codeEl = c.error
    ? h('div', { className: 'code err' }, c.error)
    : h('div', { className: 'code' }, formatCode(c.code));
  const ringEl = c.remaining != null ? ring(c) : null;
  c._els = { codeEl, ringEl };

  return h(
    'li',
    { className: 'item', tabindex: '0', title: 'Bấm để sao chép', onclick: () => copy(c),
      onkeydown: (e) => e.key === 'Enter' && copy(c) },
    h('div', { className: 'meta' },
      h('div', { className: 'issuer' }, c.issuer || 'Không tên',
        c.type === 'hotp' ? h('span', { className: 'badge' }, 'HOTP') : null,
        c.match === 'linked' ? h('span', { className: 'badge' }, 'đã gắn') : null,
        c.match === 'suggest' ? h('span', { className: 'badge' }, 'gợi ý') : null),
      c.label ? h('div', { className: 'label' }, c.label) : null),
    h('div', { className: 'side' }, actions, ringEl),
    codeEl,
  );
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const visible = codes.filter((c) => !q || `${c.issuer} ${c.label}`.toLowerCase().includes(q));
  const site = visible.filter((c) => c.match);
  const rest = visible.filter((c) => !c.match);

  $('#site-section').hidden = !site.length;
  $('#site-host').textContent = currentHost ? `· ${currentHost}` : '';
  $('#site-list').replaceChildren(...site.map(itemFor));
  $('#all-section').hidden = !rest.length;
  $('#all-title').textContent = site.length ? 'Tài khoản khác' : 'Tất cả';
  $('#all-list').replaceChildren(...rest.map(itemFor));
  $('#empty').hidden = codes.length > 0;
  $('#no-results').hidden = !codes.length || visible.length > 0;
  updateTimers();
}

function updateTimers() {
  for (const c of codes) {
    if (!c._els?.ringEl || c.remaining == null) continue;
    const expiring = c.remaining <= 5;
    c._els.ringEl.querySelector('.fill').style.strokeDashoffset = String(RING_C * (1 - c.remaining / c.period));
    c._els.ringEl.classList.toggle('expiring', expiring);
    c._els.codeEl.classList.toggle('expiring', expiring);
  }
}

function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    let expired = false;
    for (const c of codes) {
      if (c.remaining == null) continue;
      c.remaining -= 1;
      if (c.remaining <= 0) expired = true;
    }
    if (expired) loadCodes().catch((e) => toast(e.message, 'error'));
    else updateTimers();
  }, 1000);
}

async function scanTab() {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const values = (await detectQrCodes(bitmap)).filter((v) => /^otpauth/i.test(v));
  if (!values.length) {
    toast('Không thấy mã QR 2FA nào trên màn hình', 'error');
    return;
  }
  const r = await send('import', { text: values.join('\n') });
  toast(describeImport(r), r.added ? 'ok' : 'info');
  await loadCodes();
}

const openManage = () => chrome.runtime.openOptionsPage();

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('#setup-pass').value;
  const p2 = $('#setup-pass2').value;
  $('#setup-error').textContent = '';
  if (p1 !== p2) {
    $('#setup-error').textContent = 'Hai mật khẩu không khớp';
    return;
  }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await send('setup', { password: p1 });
    await route();
  } catch (err) {
    $('#setup-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('#unlock-error').textContent = '';
  try {
    await send('unlock', { password: $('#unlock-pass').value });
    $('#unlock-pass').value = '';
    await route();
  } catch (err) {
    $('#unlock-error').textContent = err.message;
    $('#unlock-pass').select();
  } finally {
    btn.disabled = false;
  }
});

$('#btn-lock').addEventListener('click', async () => {
  clearInterval(tickTimer);
  await send('lock');
  await route();
});
$('#btn-manage').addEventListener('click', openManage);
$('#btn-empty-import').addEventListener('click', openManage);
$('#btn-scan').addEventListener('click', () => scanTab().catch((e) => toast(e.message, 'error')));
$('#search').addEventListener('input', render);

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url);
    if (/^https?:$/.test(u.protocol)) currentHost = u.hostname;
  } catch {
    // tab URL unavailable
  }
  await route();
})().catch((e) => toast(e.message, 'error'));
