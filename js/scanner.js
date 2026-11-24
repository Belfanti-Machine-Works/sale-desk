// scanner.js — shared camera/photo QR scanning + CDN lib loader (labels+checkout agent)
// Libraries are normally added by index.html as <script> tags; ensureLib() loads them on demand
// if the page hasn't (so these modules also work in isolation).

const LIBS = {
  qrcode:      { global: 'qrcode',      url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js' },
  jsQR:        { global: 'jsQR',        url: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js' },
  Html5Qrcode: { global: 'Html5Qrcode', url: 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js' },
};
const loading = {};

/** Resolve with the library global (window.qrcode / jsQR / Html5Qrcode), loading it if needed. */
export function ensureLib(name) {
  const lib = LIBS[name];
  if (!lib) return Promise.reject(new Error('unknown lib ' + name));
  if (window[lib.global]) return Promise.resolve(window[lib.global]);
  if (loading[name]) return loading[name];
  loading[name] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = lib.url;
    s.async = true;
    s.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error(name + ' missing after load')));
    s.onerror = () => { delete loading[name]; reject(new Error('could not load ' + name)); };
    document.head.appendChild(s);
  });
  return loading[name];
}

// ---------- feedback: beep + vibrate ----------
// iPhone notes (2026-11-24, scans were silent at checkout):
//  - Web Audio is muted by the ringer/silent switch unless the audio session is "playback" (Safari 17+).
//  - Audio only starts inside a tap, and iOS suspends it again after calls / app switches. The camera can
//    restart without a tap, so keepAudioUnlocked() re-unlocks on ANY tap on the page.
//  - iPhones don't vibrate for web pages, so every sound also gets a screen flash.
let audioCtx = null;
/** Call from a user gesture (iOS only lets audio start after a tap). */
export function unlockAudio() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
  } catch (_) { /* older Safari */ }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    // A silent sample played inside the tap fully unlocks iOS audio.
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (_) { /* no audio, fine */ }
}
let unlockHooked = false;
/** Re-unlock audio on every tap/key anywhere (call once when the checkout screen opens). */
export function keepAudioUnlocked() {
  if (unlockHooked) return;
  unlockHooked = true;
  for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {}); });
}
function tone(freq, at, dur, vol, type) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.setValueAtTime(vol, at + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(at); o.stop(at + dur + 0.02);
}
// kind: true / 'ok' = in the cart (bright two-note "ding-DING"), false / 'error' = problem (low double buzz),
// 'tick' = code read, looking it up (short quiet click).
function playSound(kind) {
  const t = audioCtx.currentTime + 0.01;
  if (kind === 'tick') tone(2200, t, 0.03, 0.25, 'square');
  else if (kind === 'error') { tone(185, t, 0.18, 0.7, 'square'); tone(185, t + 0.24, 0.22, 0.7, 'square'); }
  else { tone(1175, t, 0.08, 0.9, 'triangle'); tone(1760, t + 0.09, 0.16, 0.9, 'triangle'); }
}
let flashEl = null;
function flash(kind) {
  if (kind === 'tick') return;
  try {
    if (!flashEl) {
      flashEl = document.createElement('div');
      flashEl.setAttribute('aria-hidden', 'true');
      Object.assign(flashEl.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '9999', opacity: '0', transition: 'opacity .35s ease-out' });
      document.body.appendChild(flashEl);
    }
    flashEl.style.boxShadow = 'inset 0 0 0 14px ' + (kind === 'error' ? '#d22' : '#1a9e3a');
    flashEl.style.transition = 'none'; flashEl.style.opacity = '1';
    void flashEl.offsetWidth; // restart the fade
    flashEl.style.transition = 'opacity .45s ease-out'; flashEl.style.opacity = '0';
  } catch (_) { /* ignore */ }
}
export function beep(ok = true) {
  const kind = ok === 'tick' ? 'tick' : (ok === false || ok === 'error') ? 'error' : 'ok';
  try {
    if (audioCtx) {
      if (audioCtx.state === 'running') playSound(kind);
      else audioCtx.resume().then(() => playSound(kind)).catch(() => {});
    }
  } catch (_) { /* ignore */ }
  flash(kind);
  try {
    const ua = navigator.userActivation;
    if (kind !== 'tick' && navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate(kind === 'ok' ? 60 : [80, 60, 80]);
  } catch (_) { /* ignore */ }
}

/** Normalize what a QR/typed code says into an id like S-00012 or T3. */
export function normalizeCode(text) {
  let c = String(text || '').trim();
  // tolerate a URL-ish payload that ends in the id
  const m = c.match(/([A-Za-z]+-\d+|T\d+|BAG)\s*$/i);
  if (m) c = m[1];
  return c.toUpperCase();
}

/**
 * Live camera scanner (html5-qrcode, rear camera).
 * Dedupe: the same code is ignored until it has been out of view for `dedupeMs` (sliding window),
 * so holding a tag in front of the camera never double-adds it.
 */
export function createScanner(el, onCode, { dedupeMs = 1500 } = {}) {
  if (!el.id) el.id = 'sd-reader-' + Math.random().toString(36).slice(2, 8);
  let inst = null, running = false, starting = null;
  let lastCode = '', lastSeen = 0;

  function onDecode(text) {
    const code = normalizeCode(text);
    const now = Date.now();
    if (code === lastCode && now - lastSeen < dedupeMs) { lastSeen = now; return; }
    lastCode = code; lastSeen = now;
    onCode(code);
  }

  async function start() {
    if (running) return;
    if (starting) return starting;
    starting = (async () => {
      const H = await ensureLib('Html5Qrcode');
      if (!inst) {
        const fmts = window.Html5QrcodeSupportedFormats;
        inst = new H(el.id, fmts ? { formatsToSupport: [fmts.QR_CODE], verbose: false } : false);
      }
      await inst.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (w, h) => { const s = Math.max(120, Math.floor(Math.min(w, h) * 0.7)); return { width: s, height: s }; },
        },
        onDecode,
        () => {}
      );
      running = true;
    })();
    try { await starting; } finally { starting = null; }
  }

  async function stop() {
    if (starting) { try { await starting; } catch (_) { /* ignore */ } }
    if (inst && running) {
      running = false;
      try { await inst.stop(); } catch (_) { /* ignore */ }
      try { inst.clear(); } catch (_) { /* ignore */ }
    }
  }

  return { start, stop, get running() { return running; }, feed: onDecode };
}

/** Decode a QR from a still photo (jsQR). Returns the normalized code or null. */
export async function decodeImageFile(file) {
  const jsQR = await ensureLib('jsQR');
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('could not read photo'));
    i.src = URL.createObjectURL(file);
  });
  try {
    for (const max of [1600, 900, 2400]) {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const r = jsQR(d.data, d.width, d.height);
      if (r && r.data) return normalizeCode(r.data);
    }
    return null;
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

/** Decode a QR straight from a canvas (used by tests / self-checks). */
export async function decodeCanvas(canvas) {
  const jsQR = await ensureLib('jsQR');
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const r = jsQR(d.data, d.width, d.height);
  return r ? r.data : null;
}
