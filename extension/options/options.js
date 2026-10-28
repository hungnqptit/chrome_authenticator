import { describeImport, detectQrCodes, h, qrSupported, send, toast } from '../ui/common.js';

const $ = (s) => document.querySelector(s);
let accounts = [];
let gateMode = 'unlock';

// ---------- gate (setup / unlock) ----------

async function route() {
  const st = await send('status');
  const ready = st.initialized && st.unlocked;
  $('#gate').hidden = ready;
  $('#app').hidden = !ready;
  $('#nav').hidden = !ready;
  if (!ready) {
    gateMode = st.initialized ? 'unlock' : 'setup';
    const setup = gateMode === 'setup';
    $('#gate-title').textContent = setup ? 'Tạo mật khẩu chính' : 'Mở khoá';
    $('#gate-desc').textContent = setup
      ? 'Mật khẩu này mã hoá các mã 2FA trên máy bạn. Không thể khôi phục nếu quên.'
      : 'Nhập mật khẩu chính để quản lý tài khoản.';
    $('#gate-pass2-field').hidden = !setup;
    $('#gate-pass2').required = setup;
    $('#gate-submit').textContent = setup ? 'Tạo vault' : 'Mở khoá';
    $('#gate-pass').focus();
    stopCamera();
    return;
  }
  applySettings(st.settings);
  await loadAccounts();
}

$('#gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#gate-pass').value;
  $('#gate-error').textContent = '';
  if (gateMode === 'setup' && pass !== $('#gate-pass2').value) {
    $('#gate-error').textContent = 'Hai mật khẩu không khớp';
    return;
  }
  $('#gate-submit').disabled = true;
  try {
    await send(gateMode, { password: pass });
    $('#gate-pass').value = $('#gate-pass2').value = '';
    await route();
  } catch (err) {
    $('#gate-error').textContent = err.message;
  } finally {
    $('#gate-submit').disabled = false;
  }
});

$('#btn-lock').addEventListener('click', async () => {
  await send('lock');
  await route();
});

// Calls that need the vault unlocked bounce back to the gate if it auto-locked.
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.message === 'LOCKED') {
      await route();
      return null;
    }
    toast(e.message, 'error');
    return null;
  }
}

// ---------- import ----------

function logImport(r, source) {
  const log = $('#import-log');
  log.prepend(h('li', {}, `${source}: ${describeImport(r)}.`));
  for (const err of r.errors || []) log.prepend(h('li', { className: 'err' }, err));
}

async function importText(text, source) {
  const r = await guarded(() => send('import', { text }));
  if (!r) return null;
  logImport(r, source);
  toast(describeImport(r), r.added ? 'ok' : 'info');
  await loadAccounts();
  return r;
}

for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== tab.dataset.tab;
    if (tab.dataset.tab !== 'camera') stopCamera();
  });
}

$('#btn-import-text').addEventListener('click', async () => {
  const text = $('#uris').value;
  if (!text.trim()) return;
  if (await importText(text, 'Dán URI')) $('#uris').value = '';
});

async function importFiles(files) {
  for (const file of files) {
    try {
      if (file.type.startsWith('image/')) {
        const values = (await detectQrCodes(await createImageBitmap(file))).filter((v) => /^otpauth/i.test(v));
        if (!values.length) {
          $('#import-log').prepend(h('li', { className: 'err' }, `${file.name}: không thấy mã QR 2FA trong ảnh`));
          continue;
        }
        await importText(values.join('\n'), file.name);
      } else {
        await importText(await file.text(), file.name);
      }
    } catch (e) {
      $('#import-log').prepend(h('li', { className: 'err' }, `${file.name}: ${e.message}`));
    }
  }
}

$('#file').addEventListener('change', (e) => {
  importFiles([...e.target.files]);
  e.target.value = '';
});
const drop = $('#drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  importFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', (e) => {
  if ($('#app').hidden) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    importFiles(files);
  }
});

// ---------- camera ----------

let stream = null;
let scanLoop = null;
const seen = new Set();

async function startCamera() {
  if (!(await qrSupported())) {
    toast('Trình duyệt này không đọc được QR. Dùng tab Dán URI.', 'error');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
  } catch (e) {
    toast(`Không mở được camera: ${e.message}`, 'error');
    return;
  }
  const video = $('#video');
  video.srcObject = stream;
  await video.play();
  $('.camera').classList.add('on');
  $('#btn-camera-stop').hidden = false;
  $('#camera-status').textContent = 'Đưa mã QR vào khung…';

  let busy = false;
  scanLoop = setInterval(async () => {
    if (busy || video.readyState < 2) return;
    busy = true;
    try {
      for (const value of await detectQrCodes(video)) {
        if (!/^otpauth/i.test(value) || seen.has(value)) continue;
        seen.add(value);
        const r = await importText(value, 'Camera');
        const batch = r?.batches?.find((b) => b.size > 1);
        $('#camera-status').textContent = batch
          ? `Đã quét QR ${batch.index + 1}/${batch.size}. ${batch.index + 1 < batch.size ? 'Chuyển sang mã QR tiếp theo trên điện thoại.' : 'Hoàn tất!'}`
          : 'Đã quét. Có thể quét thêm mã khác.';
      }
    } catch {
      // frame not ready / transient decode error
    } finally {
      busy = false;
    }
  }, 300);
}

function stopCamera() {
  clearInterval(scanLoop);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('.camera').classList.remove('on');
  $('#btn-camera-stop').hidden = true;
  $('#camera-status').textContent = '';
}

$('#btn-camera').addEventListener('click', startCamera);
$('#btn-camera-stop').addEventListener('click', stopCamera);
addEventListener('pagehide', stopCamera);

// ---------- accounts ----------

async function loadAccounts() {
  const r = await guarded(() => send('listAccounts'));
  if (!r) return;
  accounts = r.accounts;
  renderAccounts();
}

function renderAccounts() {
  const q = $('#account-filter').value.trim().toLowerCase();
  const rows = accounts
    .filter((a) => !q || `${a.issuer} ${a.label} ${(a.domains || []).join(' ')}`.toLowerCase().includes(q))
    .map(accountRow);
  $('#account-rows').replaceChildren(...rows);
  $('#account-count').textContent = accounts.length ? `(${accounts.length})` : '';
  $('#no-accounts').hidden = accounts.length > 0;
}

function accountRow(a) {
  const save = (field, parse = (v) => v) => async (e) => {
    const value = parse(e.target.value);
    if (await guarded(() => send('updateAccount', { id: a.id, [field]: value })) !== null) {
      toast('Đã lưu', 'ok');
      await loadAccounts();
    }
  };
  const splitDomains = (v) => v.split(/[,\s]+/).filter(Boolean);
  return h(
    'tr',
    {},
    h('td', {}, h('input', { type: 'text', value: a.issuer, placeholder: 'Nhà phát hành', 'aria-label': 'Nhà phát hành', onchange: save('issuer') })),
    h('td', {}, h('input', { type: 'text', value: a.label, placeholder: 'Tên tài khoản', 'aria-label': 'Tên tài khoản', onchange: save('label') })),
    h('td', {}, h('input', {
      type: 'text', value: (a.domains || []).join(', '), placeholder: 'vd. example.com', 'aria-label': 'Trang web',
      onchange: save('domains', splitDomains),
    })),
    h('td', { className: 'type' }, `${a.type.toUpperCase()} · ${a.digits} số${a.type === 'totp' ? ` · ${a.period}s` : ''}${a.algorithm !== 'SHA1' ? ` · ${a.algorithm}` : ''}`),
    h('td', { className: 'act' }, h('button', {
      className: 'danger small',
      onclick: async () => {
        if (!confirm(`Xoá "${a.issuer || a.label}"? Hãy chắc rằng bạn vẫn còn mã này trên điện thoại hoặc đã tắt 2FA.`)) return;
        if (await guarded(() => send('deleteAccount', { id: a.id })) !== null) {
          toast('Đã xoá');
          await loadAccounts();
        }
      },
    }, 'Xoá')),
  );
}

$('#account-filter').addEventListener('input', renderAccounts);

// ---------- settings ----------

function applySettings(s) {
  $('#set-autolock').value = String(s.autoLockMinutes);
  $('#set-overlay').checked = s.showOverlay;
  $('#set-autofill').checked = s.autoFill;
}

async function saveSettings() {
  const r = await guarded(() =>
    send('setSettings', {
      settings: {
        autoLockMinutes: Number($('#set-autolock').value),
        showOverlay: $('#set-overlay').checked,
        autoFill: $('#set-autofill').checked,
      },
    }),
  );
  if (r) {
    applySettings(r.settings);
    toast('Đã lưu cài đặt', 'ok');
  }
}
for (const id of ['#set-autolock', '#set-overlay', '#set-autofill']) $(id).addEventListener('change', saveSettings);

// ---------- security ----------

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pw-error').textContent = '';
  if ($('#pw-new').value !== $('#pw-new2').value) {
    $('#pw-error').textContent = 'Hai mật khẩu mới không khớp';
    return;
  }
  try {
    await send('changePassword', { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value });
    e.target.reset();
    toast('Đã đổi mật khẩu', 'ok');
  } catch (err) {
    $('#pw-error').textContent = err.message;
  }
});

$('#export-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#export-error').textContent = '';
  try {
    const { text } = await send('exportUris', { password: $('#export-pass').value });
    e.target.reset();
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = h('a', { href: url, download: `authenticator-backup-${new Date().toISOString().slice(0, 10)}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    $('#export-error').textContent = err.message;
  }
});

route().catch((e) => toast(e.message, 'error'));
