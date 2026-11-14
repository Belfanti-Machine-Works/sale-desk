// collage.js (promo agent): canvas collage for the Promo tab + shared date helpers.
// Pure browser code, no shell imports, so promo.js and tests can use it on its own.

export const HEADLINE = 'HUGE RESALE INVENTORY SALE';
export const FOOTER = 'Designer brands · $1 racks · 1,000s of items';

export const FORMATS = {
  portrait: { w: 1080, h: 1350, slots: 9, label: 'Post (FB / Instagram)' },
  wide: { w: 1200, h: 630, slots: 6, label: 'Wide (link preview)' },
};

const INK = '#111111';
const YELLOW = '#FFD60A';
const WHITE = '#FFFFFF';
const TILE = '#2B2B2B';
const FONT = 'system-ui, -apple-system, "Helvetica Neue", "Segoe UI", Arial, sans-serif';

// ---------- dates ----------
export function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d;
}
export function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function fmtTime(d) {
  let hr = d.getHours();
  const m = d.getMinutes();
  const ap = hr < 12 ? 'am' : 'pm';
  hr = hr % 12 || 12;
  return m ? `${hr}:${String(m).padStart(2, '0')}${ap}` : `${hr}${ap}`;
}
const dow = (d) => d.toLocaleDateString('en-US', { weekday: 'short' });
const mon = (d) => d.toLocaleDateString('en-US', { month: 'short' });

/** {days:'Sat, Nov 22', hours:'8am–2pm', line:'Sat, Nov 22 · 8am–2pm'} */
export function eventWhen(ev) {
  const s = toDate(ev && ev.start);
  const e = toDate(ev && ev.end);
  if (!s) return { days: 'Date coming soon', hours: '', line: 'Date coming soon' };
  let days;
  let hours;
  if (!e || sameDay(s, e)) {
    days = `${dow(s)}, ${mon(s)} ${s.getDate()}`;
    hours = e ? `${fmtTime(s)}–${fmtTime(e)}` : `from ${fmtTime(s)}`;
  } else {
    days = s.getMonth() === e.getMonth()
      ? `${dow(s)}–${dow(e)}, ${mon(s)} ${s.getDate()}–${e.getDate()}`
      : `${dow(s)} ${mon(s)} ${s.getDate()} – ${dow(e)} ${mon(e)} ${e.getDate()}`;
    hours = `${fmtTime(s)}–${fmtTime(e)} daily`;
  }
  return { days, hours, line: hours ? `${days} · ${hours}` : days };
}

export function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** 'Sun 12pm → 50% off labeled' */
export function markdownLine(md) {
  const d = toDate(md && md.from);
  const when = d ? `${dow(d)} ${fmtTime(d)}` : 'Later';
  const what = md && md.applies === 'all' ? 'everything' : 'labeled items';
  return `${when} → ${Math.round(Number(md && md.pct) || 0)}% off ${what}`;
}

export function priceOf(it) {
  const n = Number(it && (it.final_price || it.ai_price || it.price));
  return isFinite(n) && n > 0 ? n : 0;
}
export function priceText(n) {
  if (!n) return '';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

// ---------- images ----------
const imgCache = new Map();

function isClean(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 1, 1);
    x.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

/** Resolves to a drawable, untainted image or null (CORS failure, taint, 404, timeout). Never rejects. */
export function loadImage(url, timeoutMs = 8000) {
  if (!url) return Promise.resolve(null);
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), timeoutMs);
    img.onload = () => finish(img.naturalWidth || img.width ? (isClean(img) ? img : null) : null);
    img.onerror = () => finish(null);
    img.src = url;
  });
  imgCache.set(url, p);
  p.then((v) => { if (!v) imgCache.delete(url); }); // let a later render retry failures
  return p;
}

// ---------- drawing helpers ----------
function font(px, weight = 900) { return `${weight} ${Math.round(px)}px ${FONT}`; }

/** Shrinks the font until text fits maxW; returns the size used. */
function fitFont(ctx, text, maxW, size, weight = 900, min = 12) {
  let s = size;
  ctx.font = font(s, weight);
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = font(s, weight);
  }
  return s;
}

function wrap(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) { ctx.drawImage(img, x, y, w, h); return; }
  const r = Math.max(w / iw, h / ih);
  const sw = w / r;
  const sh = h / r;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) * 0.35, sw, sh, x, y, w, h);
}

function starburst(ctx, cx, cy, rOut, rIn, points) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? rIn : rOut;
    const a = (Math.PI * i) / points - Math.PI / 2;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function sticker(ctx, cx, cy, r, text) {
  if (!text) return;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = r * 0.25;
  ctx.shadowOffsetY = r * 0.08;
  starburst(ctx, cx, cy, r, r * 0.86, 18);
  ctx.fillStyle = YELLOW;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.2);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitFont(ctx, text, r * 1.45, r * 0.78);
  ctx.fillText(text, 0, r * 0.04);
  ctx.restore();
}

function textTile(ctx, it, x, y, w, h) {
  ctx.fillStyle = TILE;
  rrect(ctx, x, y, w, h, 18);
  ctx.fill();
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 4;
  rrect(ctx, x + 2, y + 2, w - 4, h - 4, 16);
  ctx.stroke();
  const pad = Math.round(w * 0.08);
  const maxW = w - pad * 2;
  let ty = y + h * 0.42;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (it && it.brand) {
    ctx.fillStyle = YELLOW;
    fitFont(ctx, String(it.brand).toUpperCase(), maxW, Math.min(36, w * 0.13), 900);
    ctx.fillText(String(it.brand).toUpperCase(), x + pad, ty);
    ty += Math.min(42, w * 0.15);
  }
  ctx.fillStyle = WHITE;
  const fs = Math.min(32, w * 0.115);
  ctx.font = font(fs, 700);
  const title = (it && (it.title || it.category)) || 'Great find';
  for (const line of wrap(ctx, title, maxW, 3)) {
    ctx.fillText(line, x + pad, ty);
    ty += fs * 1.2;
  }
}

function fillerTile(ctx, x, y, w, h) {
  ctx.fillStyle = TILE;
  rrect(ctx, x, y, w, h, 18);
  ctx.fill();
  ctx.fillStyle = YELLOW;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const s = Math.min(54, w * 0.17);
  ctx.font = font(s);
  ctx.fillText('1,000s', x + w / 2, y + h / 2 - s * 0.6);
  ctx.fillStyle = WHITE;
  fitFont(ctx, 'MORE INSIDE', w * 0.84, s * 0.62);
  ctx.fillText('MORE INSIDE', x + w / 2, y + h / 2 + s * 0.45);
}

async function drawTile(ctx, it, x, y, w, h, stickerR, useImages) {
  if (!it) { fillerTile(ctx, x, y, w, h); return; }
  const img = useImages ? await loadImage(it.thumb_url) : null;
  if (img) {
    ctx.save();
    rrect(ctx, x, y, w, h, 18);
    ctx.clip();
    ctx.fillStyle = TILE;
    ctx.fillRect(x, y, w, h);
    try { drawCover(ctx, img, x, y, w, h); } catch { textTile(ctx, it, x, y, w, h); }
    ctx.restore();
  } else {
    textTile(ctx, it, x, y, w, h);
  }
  sticker(ctx, x + w - stickerR * 0.78, y + stickerR * 0.82, stickerR, priceText(priceOf(it)));
}

function gridSpec(n, cols) { return { cols, rows: Math.ceil(n / cols) }; }

// ---------- layouts ----------
async function drawPortrait(ctx, W, H, ev, items, useImages) {
  const when = eventWhen(ev);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);

  // header band
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, 0, W, 268);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const s = fitFont(ctx, 'INVENTORY SALE', W - 90, 136);
  ctx.fillText('HUGE RESALE', W / 2, 30 + s * 0.92);
  ctx.fillText('INVENTORY SALE', W / 2, 30 + s * 1.86);

  // date band
  ctx.fillStyle = WHITE;
  fitFont(ctx, when.line.toUpperCase(), W - 80, 62);
  ctx.fillText(when.line.toUpperCase(), W / 2, 346);
  const mds = parseJson(ev && ev.markdowns, []);
  if (Array.isArray(mds) && mds.length) {
    ctx.fillStyle = YELLOW;
    const t = mds.slice(0, 2).map(markdownLine).join('  ·  ');
    fitFont(ctx, t, W - 80, 34, 800);
    ctx.fillText(t, W / 2, 392);
  }

  // grid
  const n = items.length >= 9 ? 9 : 6;
  const { cols, rows } = gridSpec(n, 3);
  const gx = 30;
  const gy = 418;
  const gw = W - 60;
  const gh = 1246 - gy;
  const gap = 18;
  const tw = (gw - gap * (cols - 1)) / cols;
  const th = (gh - gap * (rows - 1)) / rows;
  const r = Math.min(64, tw * 0.2);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const rr = Math.floor(i / cols);
    jobs.push([items[i], gx + c * (tw + gap), gy + rr * (th + gap)]);
  }
  // load in parallel, draw in order (stickers overlap neighbours)
  if (useImages) await Promise.all(jobs.map(([it]) => it && loadImage(it.thumb_url)));
  for (const [it, x, y] of jobs) await drawTile(ctx, it, x, y, tw, th, r, useImages);

  // footer
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'center';
  fitFont(ctx, FOOTER, W - 80, 46, 800);
  ctx.fillText(FOOTER, W / 2, 1316);
}

async function drawWide(ctx, W, H, ev, items, useImages) {
  const when = eventWhen(ev);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);

  // left panel
  const pw = 460;
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, 0, pw, H);
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const words = ['HUGE', 'RESALE', 'INVENTORY', 'SALE'];
  const fs = fitFont(ctx, 'INVENTORY', pw - 70, 96);
  ctx.font = font(fs);
  let y = 40 + fs * 0.9;
  for (const w of words) { ctx.fillText(w, 36, y); y += fs * 0.98; }
  y += 14;
  ctx.fillRect(36, y - 6, pw - 72, 6);
  y += 46;
  fitFont(ctx, when.days.toUpperCase(), pw - 72, 40);
  ctx.fillText(when.days.toUpperCase(), 36, y);
  if (when.hours) {
    y += 46;
    fitFont(ctx, when.hours.toUpperCase(), pw - 72, 38, 800);
    ctx.fillText(when.hours.toUpperCase(), 36, y);
  }

  // grid
  const gx = pw + 22;
  const gy = 22;
  const gw = W - gx - 22;
  const gh = 560 - gy;
  const cols = 3;
  const rows = 2;
  const gap = 14;
  const tw = (gw - gap * (cols - 1)) / cols;
  const th = (gh - gap * (rows - 1)) / rows;
  const r = Math.min(46, tw * 0.2);
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push([items[i], gx + (i % cols) * (tw + gap), gy + Math.floor(i / cols) * (th + gap)]);
  if (useImages) await Promise.all(jobs.map(([it]) => it && loadImage(it.thumb_url)));
  for (const [it, x, yy] of jobs) await drawTile(ctx, it, x, yy, tw, th, r, useImages);

  ctx.fillStyle = WHITE;
  ctx.textAlign = 'center';
  fitFont(ctx, FOOTER, gw, 32, 800);
  ctx.fillText(FOOTER, gx + gw / 2, 604);
}

/**
 * Renders the collage. Never throws for image problems: a photo that fails to
 * load or would taint the canvas becomes a text tile (name + price).
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderCollage({ event, items, format = 'portrait' }) {
  const f = FORMATS[format] || FORMATS.portrait;
  const list = (items || []).filter((it) => it && it.promo_safe !== false && String(it.promo_safe).toLowerCase() !== 'false').slice(0, f.slots);
  const draw = async (useImages) => {
    const c = document.createElement('canvas');
    c.width = f.w;
    c.height = f.h;
    const ctx = c.getContext('2d');
    if (format === 'wide') await drawWide(ctx, f.w, f.h, event || {}, list, useImages);
    else await drawPortrait(ctx, f.w, f.h, event || {}, list, useImages);
    return c;
  };
  const c = await draw(true);
  // Belt and braces: if anything still tainted the canvas, redraw text-only.
  try { c.getContext('2d').getImageData(0, 0, 1, 1); return c; } catch { return draw(false); }
}

/** canvas → Blob (JPEG). Falls back to a dataURL conversion if toBlob is missing/fails. */
export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    const viaDataUrl = () => {
      try {
        const url = canvas.toDataURL(type, quality);
        const bin = atob(url.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type }));
      } catch (e) { reject(e); }
    };
    try {
      if (!canvas.toBlob) return viaDataUrl();
      canvas.toBlob((b) => (b ? resolve(b) : viaDataUrl()), type, quality);
    } catch { viaDataUrl(); }
  });
}
