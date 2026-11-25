// Sale Desk shared UI components (CONTRACT §9). Other feature modules import these.
// Keep this file stable: names and signatures are part of the contract.

// ---------------------------------------------------------------- h()
// h(tag, attrs, ...children) -> Element
// attrs: class, style (object or string), on* handlers (onClick -> 'click'),
// value/checked/selected set as properties, true -> empty attribute, false/null skipped.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value' || k === 'checked' || k === 'selected') {
        el[k] = v;
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

// ---------------------------------------------------------------- money()
// money(12) -> '$12', money(12.5) -> '$12.50', money(1234) -> '$1,234'
export function money(n) {
  const x = Number(n);
  if (!isFinite(x)) return '$0';
  const neg = x < 0;
  const cents = Math.round(Math.abs(x) * 100);
  const whole = Math.floor(cents / 100);
  const rem = cents % 100;
  let s = '$' + whole.toLocaleString('en-US');
  if (rem) s += '.' + String(rem).padStart(2, '0');
  return (neg ? '-' : '') + s;
}

// ---------------------------------------------------------------- BigButton()
export function BigButton(label, onClick, opts = {}) {
  const variant = opts.variant || 'primary';
  const b = h('button', {
    type: 'button',
    class: 'btn btn-' + variant + (opts.class ? ' ' + opts.class : ''),
    disabled: !!opts.disabled,
  }, label);
  if (onClick) b.addEventListener('click', (e) => { if (!b.disabled) onClick(e); });
  return b;
}

// ---------------------------------------------------------------- toast()
let toastHost = null;
export function toast(msg, kind = 'info') {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toast-host', 'aria-live': 'polite', role: 'status' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: 'toast toast-' + kind }, msg);
  const remove = () => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 250); };
  t.addEventListener('click', remove);
  toastHost.appendChild(t);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  setTimeout(remove, kind === 'error' ? 5000 : 3500);
  return t;
}

// ---------------------------------------------------------------- errorMessage()
const MESSAGES = {
  AUTH: 'Please sign in again.',
  FORBIDDEN: "Your PIN can't do that. Ask the owner.",
  NOT_FOUND: "We couldn't find that item.",
  ALREADY_SOLD: 'That item was already sold.',
  LOCKED: 'Someone else has this one open. Try again in a minute.',
  INVALID: "Something's missing or not right. Check and try again.",
  AI_ERROR: "The pricing helper is having trouble. Try again in a moment.",
  INTERNAL: 'Something went wrong. Please try again.',
  NETWORK: 'No connection. Check Wi-Fi or signal and try again.',
  NO_SERVER: "This app isn't connected to its server yet. Ask the owner.",
};
export function errorMessage(err) {
  if (err && err.code && MESSAGES[err.code]) {
    // A few codes carry a friendly server message worth showing (e.g. "Wrong PIN").
    if (err.code === 'AUTH' && err.message && /pin/i.test(err.message)) return 'Wrong PIN. Try again.';
    if (err.code === 'LOCKED' && err.by) return err.by + ' has this one open. Try another.';
    // Show the server's detail for unexpected errors so problems can be diagnosed from a screenshot.
    if (err.code === 'INTERNAL' && err.message) return err.message;
    return MESSAGES[err.code];
  }
  // A code-less error is a bug in the app itself: include the detail.
  const detail = err && (err.message || String(err));
  return detail ? 'Something went wrong in the app. (' + String(detail).slice(0, 160) + ')' : MESSAGES.INTERNAL;
}
// Convenience (not in §9, but handy): toast an error in plain English.
export function showError(err) {
  if (err && !err.code) console.warn(err);
  return toast(errorMessage(err), 'error');
}

// ---------------------------------------------------------------- overlays
function overlay(cls) {
  const o = h('div', { class: 'overlay ' + (cls || '') });
  document.body.appendChild(o);
  document.body.classList.add('no-scroll');
  return o;
}
function closeOverlay(o) {
  o.remove();
  if (!document.querySelector('.overlay')) document.body.classList.remove('no-scroll');
}

// ---------------------------------------------------------------- keypad()
// keypad({title, value}) -> Promise<number|null>. Full screen numeric pad; cents optional.
// count: true = a whole number of pieces (no "$", no decimal point, max 999), e.g. how many pieces in a lot.
export function keypad({ title = 'Type a price', value = null, count = false, unit = 'pieces' } = {}) {
  return new Promise((resolve) => {
    let typed = '';
    const o = overlay('keypad');
    const display = h('div', { class: 'kp-display' });
    const okBtn = BigButton('OK', () => done(current()), { variant: 'primary' });
    const current = () => {
      if (typed === '') return value === null || value === undefined ? null : Number(value);
      const n = parseFloat(typed);
      if (count) return isFinite(n) && n > 0 ? Math.floor(n) : null;
      return isFinite(n) ? Math.round(n * 100) / 100 : null;
    };
    const render = () => {
      if (typed === '') {
        display.textContent = count ? (value == null ? '0 ' + unit : value + ' ' + unit) : value === null || value === undefined ? '$0' : money(value);
        display.classList.add('kp-placeholder');
      } else {
        display.textContent = count ? typed + ' ' + (typed === '1' ? unit.replace(/s$/, '') : unit) : '$' + typed;
        display.classList.remove('kp-placeholder');
      }
      okBtn.disabled = current() === null;
    };
    const press = (k) => {
      if (k === 'del') typed = typed.slice(0, -1);
      else if (k === '.') { if (!count && !typed.includes('.')) typed = (typed || '0') + '.'; }
      else if (count) { if (typed.length >= 3) return; typed = typed === '0' ? k : typed + k; }
      else {
        const dot = typed.indexOf('.');
        if (dot >= 0 && typed.length - dot > 2) return; // max 2 decimals
        if (dot < 0 && typed.replace(/^0+/, '').length >= 5) return; // max $99,999
        typed = typed === '0' ? k : typed + k;
      }
      render();
    };
    const done = (v) => {
      document.removeEventListener('keydown', onKey);
      closeOverlay(o);
      resolve(v);
    };
    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === '.') press('.');
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter' && !okBtn.disabled) done(current());
      else if (e.key === 'Escape') done(null);
    };
    document.addEventListener('keydown', onKey);
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', count ? '' : '.', '0', 'del'];
    o.appendChild(h('div', { class: 'kp-panel' },
      h('div', { class: 'kp-title' }, title),
      display,
      h('div', { class: 'kp-grid' }, keys.map((k) =>
        k === '' ? h('span', { class: 'kp-key kp-blank', 'aria-hidden': 'true' }) // count mode: no decimal point
          : h('button', { type: 'button', class: 'kp-key', 'aria-label': k === 'del' ? 'Delete' : k, onClick: () => press(k) },
            k === 'del' ? '⌫' : k))),
      h('div', { class: 'row' }, BigButton('Cancel', () => done(null), { variant: 'secondary' }), okBtn),
    ));
    render();
  });
}

// ---------------------------------------------------------------- Countdown()
// Countdown({seconds, onExpire, onInterrupt}) -> Element & {stop(), interrupt()}
// Shows a ring + number. Tapping it interrupts (stop + onInterrupt). Pauses while the
// page is hidden and stops itself when removed from the DOM.
export function Countdown({ seconds = 5, onExpire, onInterrupt } = {}) {
  const R = 26, C = 2 * Math.PI * R;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'cd-ring');
  const bg = document.createElementNS(ns, 'circle');
  const fg = document.createElementNS(ns, 'circle');
  for (const c of [bg, fg]) { c.setAttribute('cx', 32); c.setAttribute('cy', 32); c.setAttribute('r', R); }
  bg.setAttribute('class', 'cd-bg');
  fg.setAttribute('class', 'cd-fg');
  fg.setAttribute('stroke-dasharray', C);
  svg.append(bg, fg);
  const num = h('span', { class: 'cd-num' }, String(seconds));
  const el = h('button', { type: 'button', class: 'countdown', 'aria-label': 'Auto-accept timer. Tap to stop.' },
    h('span', { class: 'cd-wrap' }, svg, num),
    h('span', { class: 'cd-text' }, 'Auto-OK'));
  let elapsed = 0, last = performance.now(), stopped = false, seenInDom = false;
  const total = seconds * 1000;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    if (el.isConnected) seenInDom = true;
    else if (seenInDom) { stop(); return; }
    if (!document.hidden && el.isConnected) elapsed += Math.min(now - last, 250);
    last = now;
    const left = Math.max(0, total - elapsed);
    num.textContent = String(Math.ceil(left / 1000));
    fg.setAttribute('stroke-dashoffset', String(C * (1 - left / total)));
    if (left <= 0) {
      stop();
      el.classList.add('cd-done');
      if (onExpire) onExpire();
    }
  };
  const timer = setInterval(tick, 50);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    el.classList.add('cd-stopped');
  }
  function interrupt() {
    if (stopped) return;
    stop();
    if (onInterrupt) onInterrupt();
  }
  el.addEventListener('click', interrupt);
  el.stop = stop;
  el.interrupt = interrupt;
  Object.defineProperty(el, 'running', { get: () => !stopped });
  tick();
  return el;
}

// ---------------------------------------------------------------- confirmModal()
export function confirmModal(text, okLabel = 'Yes') {
  return new Promise((resolve) => {
    const o = overlay('modal');
    const done = (v) => { closeOverlay(o); resolve(v); };
    o.appendChild(h('div', { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true' },
      h('p', { class: 'modal-text' }, text),
      BigButton(okLabel, () => done(true), { variant: /delete|pull|remove|void/i.test(okLabel) ? 'danger' : 'primary' }),
      BigButton('Cancel', () => done(false), { variant: 'secondary' }),
    ));
    o.addEventListener('click', (e) => { if (e.target === o) done(false); });
  });
}

// ---------------------------------------------------------------- sheet()
// sheet(contentEl, {onClose}?) -> {close(), el}. Bottom sheet modal.
export function sheet(contentEl, opts = {}) {
  const o = overlay('sheet');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    panel.classList.add('sheet-out');
    setTimeout(() => { closeOverlay(o); if (opts.onClose) opts.onClose(); }, 180);
  };
  const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet-top' },
      h('span', { class: 'sheet-grip' }),
      h('button', { type: 'button', class: 'sheet-x', 'aria-label': 'Close', onClick: close }, '✕')),
    h('div', { class: 'sheet-body' }, contentEl));
  o.appendChild(panel);
  o.addEventListener('click', (e) => { if (e.target === o) close(); });
  return { close, el: panel };
}

// ---------------------------------------------------------------- extras (not in §9)
// spinner(text) -> Element: big friendly spinner block.
export function spinner(text = 'Working…') {
  return h('div', { class: 'spin-block' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'spin-text' }, text));
}
// empty(text) -> Element: centered muted message.
export function empty(text) {
  return h('p', { class: 'empty' }, text);
}
// imageToJpeg(fileOrBlob, max=1280, quality=0.8) -> Promise<{b64, dataUrl, width, height}>
// Shrinks a photo so its long side is <= max px (the camera-spike resize).
export async function imageToJpeg(file, max = 1280, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that photo'));
      i.src = url;
    });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', quality);
    return { b64: dataUrl.split(',')[1], dataUrl, width: c.width, height: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
// Plain-English status names for items.
export const STATUS_LABEL = {
  new: 'New', researching: 'Looking up', review: 'To review', priced: 'Priced',
  labeled: 'Labeled', sold: 'Sold', pulled: 'Pulled', binned: 'In a bin',
};
