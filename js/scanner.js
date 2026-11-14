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
let audioCtx = null;
/** Call from a user gesture (iOS only lets audio start after a tap). */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { /* no audio, fine */ }
}
export function beep(ok = true) {
  try {
    if (audioCtx && audioCtx.state === 'running') {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = ok ? 'sine' : 'square';
      o.frequency.value = ok ? 1320 : 220;
      const t = audioCtx.currentTime, dur = ok ? 0.09 : 0.28;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    }
  } catch (_) { /* ignore */ }
  try {
    const ua = navigator.userActivation;
    if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate(ok ? 60 : [80, 60, 80]);
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
