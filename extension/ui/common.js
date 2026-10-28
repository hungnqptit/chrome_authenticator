// Helpers shared by the popup and the options page.

export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'Lỗi không xác định');
  return res;
}

export function formatCode(code) {
  if (!code) return '——';
  const mid = Math.floor(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'className') node.className = v;
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

let toastTimer;
export function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

let detector;
export async function qrSupported() {
  if (!('BarcodeDetector' in globalThis)) return false;
  try {
    return (await BarcodeDetector.getSupportedFormats()).includes('qr_code');
  } catch {
    return false;
  }
}

export async function detectQrCodes(source) {
  if (!('BarcodeDetector' in globalThis)) {
    throw new Error('Trình duyệt này không đọc được QR (BarcodeDetector). Hãy dán URI otpauth:// thay thế.');
  }
  detector ??= new BarcodeDetector({ formats: ['qr_code'] });
  const found = await detector.detect(source);
  return found.map((b) => b.rawValue);
}

export function describeImport(r) {
  const parts = [`Đã thêm ${r.added} tài khoản`];
  if (r.skipped) parts.push(`bỏ qua ${r.skipped} trùng`);
  const batch = r.batches?.find((b) => b.size > 1);
  if (batch) parts.push(`QR ${batch.index + 1}/${batch.size} của lần xuất`);
  return parts.join(', ');
}
