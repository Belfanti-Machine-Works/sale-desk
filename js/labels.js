// labels.js — price labels (62 x 100 mm flag labels), tier rack signs, print + share helpers.
// Owner: labels+checkout agent. Exports per CONTRACT §9 plus a few extras used by checkout/dashboard.
//
// Label layout ("flag" label that wraps around a tag loop and sticks to itself):
//   top half (0-50 mm): everything — huge price, "Was $X new", brand · title · size (2 lines),
//                       QR (item id, EC level M, 20 mm) bottom-left, id text bottom-right.
//   bottom half (50-100 mm): price + id repeated upside-down, so the back of the folded flag reads right.
// Black only (AirPrint on the Brother QL-820NWB can't do red).

import { ensureLib } from './scanner.js';
import { money, sheet, BigButton, toast, h } from './ui.js';

const MM = 'mm';
const LABEL_W = 62, LABEL_H = 100;
const FONT = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';

// ---------------------------------------------------------------- shared CSS
const CSS = `
.sd-label{position:relative;width:62mm;height:100mm;min-width:62mm;flex:none;overflow:hidden;background:#fff;color:#000;
  font-family:${FONT};box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sd-label *{box-sizing:border-box}
.sd-l-top{position:absolute;left:3mm;right:3mm;top:2mm;height:47mm}
.sd-l-price{font-weight:800;line-height:.95;white-space:nowrap;letter-spacing:-.02em;height:13.5mm;overflow:hidden}
.sd-l-was{font-size:3.6mm;line-height:1.15;margin-top:.6mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-l-desc{font-size:3.4mm;line-height:1.15;margin-top:.6mm;max-height:7.9mm;overflow:hidden;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;word-break:break-word}
.sd-l-row{position:absolute;left:0;right:0;bottom:0;height:20mm;display:flex;justify-content:space-between;align-items:flex-end}
.sd-l-qr{width:20mm;height:20mm}
.sd-l-qr svg{display:block;width:20mm;height:20mm}
.sd-l-id{font-size:4.2mm;font-weight:800;line-height:1;letter-spacing:.02em}
.sd-l-fold{position:absolute;left:3mm;right:3mm;top:50mm;border-top:.25mm dotted #000;opacity:.6}
.sd-l-back{position:absolute;left:3mm;right:3mm;top:51mm;height:47mm;transform:rotate(180deg);
  display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.sd-l-back .sd-l-price{height:auto;line-height:1}
.sd-l-back .sd-l-id{font-size:5mm;margin-top:3mm}

.sd-sign{width:7.5in;height:9.8in;flex:none;background:#fff;color:#000;font-family:${FONT};display:flex;flex-direction:column;
  align-items:center;justify-content:space-between;text-align:center;box-sizing:border-box;padding:.2in 0;overflow:hidden}
.sd-sign-price{font-size:3.6in;font-weight:900;line-height:.9;letter-spacing:-.04em}
.sd-sign-head{font-size:.62in;font-weight:900;line-height:1.05;text-transform:uppercase}
.sd-sign-sub{font-size:.3in;font-weight:600;margin-top:.08in}
.sd-sign-qr svg{display:block;width:3.4in;height:3.4in}
.sd-sign-foot{font-size:.24in;font-weight:700}

.sd-report{font-family:${FONT};color:#000;background:#fff;font-size:11pt;line-height:1.35}
.sd-report h1{font-size:18pt;margin:0 0 4pt}
.sd-report h2{font-size:13pt;margin:12pt 0 4pt}
.sd-report table{width:100%;border-collapse:collapse}
.sd-report th,.sd-report td{border-bottom:.5pt solid #999;padding:3pt 4pt;text-align:left;vertical-align:top}
.sd-report td.num,.sd-report th.num{text-align:right;white-space:nowrap}
.sd-report img{width:36pt;height:36pt;object-fit:cover}

/* 3 x 2 in (76.2 x 50.8 mm) FLAT one-sided label for the Rollo (owner, 2026-11-24 layout; same as pi/sale_desk_printer.py):
   big price top-left, 29 mm photo top-right, 13 mm QR bottom-right with the id above it,
   "Was" / comps / description along the bottom-left. No photo: bigger price and text. */
.sd-label.sd-3x2{width:76.2mm;height:50.8mm;min-width:76.2mm}
.sd-3x2 .sd-l-price{position:absolute;left:3mm;top:2.5mm;height:auto;line-height:.95;letter-spacing:-.03em;white-space:nowrap}
.sd-3x2 .sd-f-thumb{position:absolute;right:3mm;top:2.5mm;width:29mm;height:29mm;object-fit:cover;filter:grayscale(1) contrast(1.25)}
.sd-3x2 .sd-f-info{position:absolute;left:3mm;right:18.5mm;bottom:2.5mm}
.sd-3x2 .sd-l-was{font-size:3.1mm;line-height:1.15;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-3x2 .sd-l-comps{font-weight:700}
.sd-3x2 .sd-l-desc{font-size:3.1mm;line-height:1.15;margin:0}
.sd-3x2.no-thumb .sd-l-was,.sd-3x2.no-thumb .sd-l-desc{font-size:3.6mm}
.sd-3x2 .sd-l-qr{position:absolute;right:3mm;bottom:2.5mm;width:13mm;height:13mm}
.sd-3x2 .sd-l-qr svg{width:13mm;height:13mm}
.sd-3x2 .sd-l-id{position:absolute;right:3mm;bottom:15.7mm;font-size:3.2mm;line-height:1;text-align:right;white-space:nowrap}

/* 2 x 1 in label on Rollo's ROLLO-2X1 roll (owner, 2026-11-24; same as render_2x1 in pi/sale_desk_printer.py):
   QR left; big price, brand, "Was $X new", "Resells $A–$B", item id on the right. No photo. */
.sd-label.sd-2x1{width:50.8mm;height:25.4mm;min-width:50.8mm;display:flex;align-items:center;gap:1.2mm;padding:0 1.5mm}
.sd-2x1 .sd-l-qr{width:16mm;height:16mm;flex:none}
.sd-2x1 .sd-l-qr svg{display:block;width:16mm;height:16mm}
.sd-2x1 .sd-f-txt{min-width:0;flex:1;display:flex;flex-direction:column;gap:.5mm}
.sd-2x1 .sd-l-price{height:auto;line-height:.9;letter-spacing:-.02em;white-space:nowrap}
.sd-2x1 .sd-l-brand{font-size:2.7mm;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-2x1 .sd-l-small{font-size:2.5mm;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-2x1 .sd-l-id{font-size:2.7mm;font-weight:800;line-height:1}

#sd-print-root{display:none}
@media print{
  html.sd-printing body>*:not(#sd-print-root){display:none!important}
  html.sd-printing,html.sd-printing body{margin:0!important;padding:0!important;background:#fff!important;
    height:auto!important;min-height:0!important;overflow:visible!important}
  html.sd-printing #sd-print-root{display:block!important}
  #sd-print-root .sd-page{break-after:page;page-break-after:always}
  #sd-print-root .sd-page-fixed{break-inside:avoid;page-break-inside:avoid;overflow:hidden}
  #sd-print-root .sd-page:last-child{break-after:auto;page-break-after:auto}
  #sd-print-root .sd-page-label{width:62mm;height:100mm}
  #sd-print-root .sd-page-label.sd-page-3x2{width:76.2mm;height:50.8mm}
  #sd-print-root .sd-page-label.sd-page-2x1{width:50.8mm;height:25.4mm}
  #sd-print-root .sd-page-label.sd-page-225{width:57.15mm;height:31.75mm}
}
`;

function injectCss() {
  if (document.getElementById('sd-labels-css')) return;
  const s = document.createElement('style');
  s.id = 'sd-labels-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------- data helpers
export function labelPrice(item) {
  // Sheets give '' for empty cells, so take the first real number rather than using ??
  for (const v of [item.final_price, item.ai_price, item.price]) {
    const n = Number(v);
    if (v !== '' && v != null && isFinite(n) && n > 0) return n;
  }
  return 0;
}
function priceText(item) { return money(labelPrice(item)); }
function wasText(item) {
  const r = Number(item.retail_est);
  if (!truthy(item.retail_confident) || !(r > 0) || r <= labelPrice(item)) return '';
  return 'Was ' + money(Math.round(r)) + ' new';
}
/** "Resells $34–$53 online" from the item's comps (comp_low/high are market values; asking counted at 75%). */
function compsText(item) {
  const lo = Number(item.comp_low) || 0, hi = Number(item.comp_high) || 0;
  if (!(lo > 0) && !(hi > 0)) return '';
  const a = Math.round(lo || hi), b = Math.round(hi || lo);
  if (b <= labelPrice(item)) return ''; // only useful as an anchor when it's above our price
  return 'Resells ' + (a === b ? money(a) : money(a) + '–' + money(b)) + ' online';
}
function descText(item) {
  return [item.brand_display || item.brand, item.title, item.size].map(s => String(s ?? '').trim()).filter(Boolean).join(' · ');
}
function truthy(v) { return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1'; }
/** Price font size (mm) for the front: shrink for long prices so it stays on one line. */
/** Back-of-flag price: bigger, but still one line inside 56 mm (bold digits ≈ 0.7 em wide). */
function backPriceFontMm(text) { return Math.min(20, +(54 / (0.7 * text.length)).toFixed(1)); }
function priceFontMm(text) {
  const n = text.length;
  return n <= 4 ? 14 : n <= 5 ? 12.5 : n <= 6 ? 10.5 : 9;
}

// ---------------------------------------------------------------- QR
function makeQr(text) {
  const q = window.qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  return q;
}
/** Crisp vector QR. quiet = quiet-zone modules on each side. */
export function qrSvg(text, quiet = 2) {
  const q = makeQr(text);
  const n = q.getModuleCount(), size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (q.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function fillQr(el, text) {
  if (window.qrcode) { el.innerHTML = qrSvg(text); return; }
  ensureLib('qrcode').then(() => { el.innerHTML = qrSvg(text); }).catch(() => { el.textContent = ''; });
}

// ---------------------------------------------------------------- label sizes
// Settings `label_size`: '2x1' (2 x 1 in, Rollo ROLLO-2X1 roll; the default since 2026-11-24), '3x2' (3 x 2 in;
// no Rollo-brand roll exists) or '62x100' (62 x 100 mm, Brother QL). printLabels() remembers the size it was last given.
export const LABEL_SIZES = {
  '2.25x1.25': { page: '@page{size:2.25in 1.25in;margin:0}', cls: 'sd-page-225', name: '2¼ × 1¼ in' },
  '2x1': { page: '@page{size:2in 1in;margin:0}', cls: 'sd-page-2x1', name: '2 × 1 in (Rollo)' },
  '3x2': { page: '@page{size:3in 2in;margin:0}', cls: 'sd-page-3x2', name: '3 × 2 in (Rollo)' },
  '62x100': { page: '@page{size:62mm 100mm;margin:0}', cls: '', name: '62 × 100 mm (Brother)' },
};
let currentSize = '2.25x1.25';
export function setLabelSize(size) { if (LABEL_SIZES[size]) currentSize = size; return currentSize; }

/** Small sticker (2.25 x 1.25 or 2 x 1 in; mirrors render_small in pi/sale_desk_printer.py): 16 mm QR left;
 *  price, brand, was/resells, id on the right, each as big as the sticker allows ("maximize the text"). */
function renderLabelSmall(item, wMm, hMm) {
  const price = priceText(item), id = String(item.id || '');
  const el = div('sd-label sd-2x1');
  el.style.width = el.style.minWidth = wMm + MM; el.style.height = hMm + MM;
  el.dataset.id = id;
  const qr = div('sd-l-qr'); fillQr(qr, id);
  const txt = div('sd-f-txt');
  const tw = wMm - 1.2 - 16 - 1.5 - 1.2, avail = hMm - 2.4;              // text column width / height (mm)
  const brand = String(item.brand_display || item.brand || item.title || '').trim();
  const small = [wasText(item), compsText(item).replace(' online', '')].filter(Boolean);
  const nRows = 1 + (brand ? 1 : 0) + small.length;
  // On screen the price box is 0.9 em tall (line-height .9) and bold digits run ~0.68 em wide; other rows 1.1 em.
  const ps = Math.min(tw / (0.68 * price.length), (avail * (nRows > 3 ? 0.5 : 0.58)) / 0.9);
  const left = avail - ps * 0.9 - 0.5 * nRows;
  const longest = Math.max(id.length, ...small.map((t) => t.length));
  const s = Math.max(1.8, Math.min(6, left / (nRows * 1.1), tw / (0.56 * longest)));
  const p = div('sd-l-price', price); p.style.fontSize = ps.toFixed(2) + MM; txt.appendChild(p);
  if (brand) { const b = div('sd-l-brand', brand); b.style.fontSize = s.toFixed(2) + MM; txt.appendChild(b); }
  for (const t of small) { const r = div('sd-l-small', t); r.style.fontSize = s.toFixed(2) + MM; txt.appendChild(r); }
  const idEl = div('sd-l-id', id); idEl.style.fontSize = s.toFixed(2) + MM; txt.appendChild(idEl);
  el.append(qr, txt);
  return el;
}

/** 3 x 2 in flat one-sided label (see CSS above; mirrors render_3x2 in pi/sale_desk_printer.py). */
function renderLabel3x2(item) {
  const price = priceText(item), was = wasText(item), id = String(item.id || '');
  const el = div('sd-label sd-3x2' + (item.thumb_url ? '' : ' no-thumb'));
  el.dataset.id = id;
  const p = div('sd-l-price', price);
  // beside the photo (~41 mm) or, without one, beside the QR row (~52 mm) and bigger
  p.style.fontSize = (item.thumb_url ? Math.min(18, +(40 / (0.66 * price.length)).toFixed(1))
    : Math.min(24, +(52 / (0.66 * price.length)).toFixed(1))) + MM;
  el.appendChild(p);
  if (item.thumb_url) {
    const img = document.createElement('img');
    img.className = 'sd-f-thumb'; img.alt = ''; img.src = item.thumb_url;
    img.onerror = () => { img.remove(); el.classList.add('no-thumb'); };
    el.appendChild(img);
  }
  const info = div('sd-f-info');
  if (was) info.appendChild(div('sd-l-was', was));
  const comps = compsText(item);
  if (comps) info.appendChild(div('sd-l-was sd-l-comps', comps));
  const desc = descText(item);
  if (desc) {
    const d = div('sd-l-desc', desc);
    const lines = 4 - (was ? 1 : 0) - (comps ? 1 : 0);
    d.style.display = '-webkit-box'; d.style.webkitBoxOrient = 'vertical'; d.style.overflow = 'hidden';
    d.style.webkitLineClamp = String(lines);
    info.appendChild(d);
  }
  el.appendChild(info);
  const qr = div('sd-l-qr'); fillQr(qr, id);
  el.append(qr, div('sd-l-id', id));
  return el;
}

// ---------------------------------------------------------------- label (DOM)
/** Label element in the chosen size (default: the last size printLabels used). Screen preview + print. */
export function renderLabel(item, size = currentSize) {
  injectCss();
  if (size === '2.25x1.25') return renderLabelSmall(item, 57.15, 31.75);
  if (size === '2x1') return renderLabelSmall(item, 50.8, 25.4);
  if (size === '3x2') return renderLabel3x2(item);
  const price = priceText(item), was = wasText(item), id = String(item.id || '');
  const el = document.createElement('div');
  el.className = 'sd-label';
  el.dataset.id = id;

  const top = div('sd-l-top');
  const p = div('sd-l-price', price); p.style.fontSize = priceFontMm(price) + MM;
  top.appendChild(p);
  if (was) top.appendChild(div('sd-l-was', was));
  const desc = descText(item);
  if (desc) top.appendChild(div('sd-l-desc', desc));
  const row = div('sd-l-row');
  const qr = div('sd-l-qr'); fillQr(qr, id);
  row.appendChild(qr);
  row.appendChild(div('sd-l-id', id));
  top.appendChild(row);
  el.appendChild(top);

  el.appendChild(div('sd-l-fold'));

  const back = div('sd-l-back');
  const p2 = div('sd-l-price', price); p2.style.fontSize = backPriceFontMm(price) + MM;
  back.appendChild(p2);
  back.appendChild(div('sd-l-id', id));
  el.appendChild(back);
  return el;
}
function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

// ---------------------------------------------------------------- printing
let pendingPrint = null;
function printRoot() {
  let r = document.getElementById('sd-print-root');
  if (!r) { r = document.createElement('div'); r.id = 'sd-print-root'; document.body.appendChild(r); }
  else if (r.parentNode !== document.body) document.body.appendChild(r); // must be a direct child of body
  return r;
}
function setPageCss(css) {
  let s = document.getElementById('sd-page-css');
  if (!s) { s = document.createElement('style'); s.id = 'sd-page-css'; document.head.appendChild(s); }
  s.textContent = css;
}
function cleanupPrint() {
  document.documentElement.classList.remove('sd-printing');
  const s = document.getElementById('sd-page-css'); if (s) s.remove();
  const r = document.getElementById('sd-print-root'); if (r) r.replaceChildren();
}

/**
 * Print each node on its own page. pageCss is the @page rule (only active during this print,
 * so label size never leaks into letter-size reports). Resolves after `afterprint`.
 */
export function printPages(nodes, { pageCss = '@page{size:letter;margin:12mm}', pageClass = '' } = {}) {
  injectCss();
  if (pendingPrint) pendingPrint(); // finish any earlier print that never reported back
  const root = printRoot();
  root.replaceChildren(...nodes.map(n => {
    const pg = document.createElement('div');
    pg.className = 'sd-page' + (pageClass ? ' ' + pageClass : '');
    pg.appendChild(n);
    return pg;
  }));
  setPageCss(pageCss);
  document.documentElement.classList.add('sd-printing');

  return new Promise(resolve => {
    let done = false, timer = 0;
    const finish = () => {
      if (done) return;
      done = true;
      pendingPrint = null;
      clearTimeout(timer);
      window.removeEventListener('afterprint', finish);
      cleanupPrint();
      resolve();
    };
    pendingPrint = finish;
    window.addEventListener('afterprint', finish);
    timer = setTimeout(finish, 5 * 60 * 1000); // safety net if a browser never fires afterprint
    // Let the SVG lay out and label photos download (max 3 s) before the print snapshot
    // (setTimeout, not rAF: rAF stalls in background tabs).
    const imgs = [...root.querySelectorAll('img')].filter((im) => !im.complete);
    const loaded = Promise.all(imgs.map((im) => new Promise((ok) => { im.addEventListener('load', ok, { once: true }); im.addEventListener('error', ok, { once: true }); })));
    Promise.race([loaded, new Promise((ok) => setTimeout(ok, 3000))]).then(() => setTimeout(() => {
      if (done) return;
      try { window.print(); } catch (_) { finish(); }
    }, 80));
  });
}

/** One label per page in the chosen size (opts.size, else the last size used). Resolves after the dialog closes. */
export async function printLabels(items, opts = {}) {
  const list = [].concat(items || []).filter(Boolean);
  if (!list.length) return;
  const size = setLabelSize(opts.size || currentSize);
  const spec = LABEL_SIZES[size];
  await ensureLib('qrcode');
  return printPages(list.map((it) => renderLabel(it, size)), {
    pageCss: spec.page,
    pageClass: 'sd-page-fixed sd-page-label' + (spec.cls ? ' ' + spec.cls : ''),
  });
}

// ---------------------------------------------------------------- PNG (iPrint&Label fallback)
const DPI = 300, PX = DPI / 25.4; // px per mm

/** Render the label to a 300 dpi canvas (732 x 1181 px). */
export async function labelToCanvas(item) {
  await ensureLib('qrcode');
  const W = Math.round(LABEL_W * PX), H = Math.round(LABEL_H * PX);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#000';
  g.textBaseline = 'top';
  const mm = v => v * PX;
  const font = (wt, sizeMm) => `${wt} ${mm(sizeMm)}px ${FONT}`;
  const left = mm(3), width = mm(LABEL_W - 6);

  const price = priceText(item), was = wasText(item), id = String(item.id || '');
  // ---- front (top half)
  let y = mm(2);
  const pf = fitFont(g, price, 800, priceFontMm(price), width, font);
  g.font = font(800, pf);
  g.fillText(price, left, y + mm(pf * 0.02));
  y += mm(13.5);
  if (was) {
    y += mm(0.6);
    g.font = font(400, 3.6);
    g.fillText(clip(g, was, width), left, y);
    y += mm(3.6 * 1.15);
  }
  const desc = descText(item);
  if (desc) {
    y += mm(0.6);
    g.font = font(400, 3.4);
    wrapLines(g, desc, width, 2).forEach((ln, i) => g.fillText(ln, left, y + i * mm(3.4 * 1.15)));
  }
  drawQr(g, id, left, mm(2 + 47 - 20), mm(20));
  g.font = font(800, 4.2);
  g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillText(id, left + width, mm(2 + 47));
  // fold hint
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.globalAlpha = 0.6;
  for (let x = left; x < left + width; x += mm(1)) g.fillRect(x, mm(50), mm(0.3), mm(0.25));
  g.globalAlpha = 1;

  // ---- back (bottom half, upside-down): rotate 180° about the canvas centre,
  // then the bottom-half box [51,98] maps to [2,49] in rotated coordinates.
  g.save();
  g.translate(W, H);
  g.rotate(Math.PI);
  const bf = fitFont(g, price, 800, backPriceFontMm(price), width, font);
  const blockH = bf + 3 + 5; // price + gap + id
  const by = 2 + (47 - blockH) / 2;
  g.textAlign = 'center'; g.textBaseline = 'top';
  g.font = font(800, bf);
  g.fillText(price, W / 2, mm(by));
  g.font = font(800, 5);
  g.fillText(id, W / 2, mm(by + bf + 3));
  g.restore();
  return c;
}

/** PNG blob of the label (for sharing to Brother iPrint&Label). */
export async function labelToPng(item) {
  const c = await labelToCanvas(item);
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('png failed'))), 'image/png'));
}

function fitFont(g, text, wt, sizeMm, maxW, font) {
  let s = sizeMm;
  g.font = font(wt, s);
  while (s > 4 && g.measureText(text).width > maxW) { s -= 0.5; g.font = font(wt, s); }
  return s;
}
function clip(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}
function wrapLines(g, text, maxW, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const test = cur ? cur + ' ' + words[i] : words[i];
    if (g.measureText(test).width <= maxW) { cur = test; continue; }
    if (cur) lines.push(cur); else { lines.push(clip(g, words[i], maxW)); cur = ''; continue; }
    cur = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join(' ').split(/\s+/).length;
  if (lines.length === maxLines && used < words.length) {
    lines[maxLines - 1] = clip(g, lines[maxLines - 1] + ' ' + words.slice(used).join(' '), maxW);
  }
  return lines.slice(0, maxLines).map(l => clip(g, l, maxW));
}
function drawQr(g, text, x, y, size) {
  const q = makeQr(text);
  const quiet = 2, n = q.getModuleCount(), cell = size / (n + quiet * 2);
  g.fillStyle = '#fff'; g.fillRect(x, y, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (q.isDark(r, c)) {
      // integer-snapped cells so modules butt together without hairline gaps
      const x0 = Math.round(x + (c + quiet) * cell), y0 = Math.round(y + (r + quiet) * cell);
      const x1 = Math.round(x + (c + quiet + 1) * cell), y1 = Math.round(y + (r + quiet + 1) * cell);
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

/**
 * Share label PNGs (iOS share sheet → Brother iPrint&Label). Falls back to downloads.
 * Returns 'shared' | 'downloaded' | 'cancelled'.
 */
export async function shareLabels(items) {
  const list = [].concat(items || []).filter(Boolean);
  if (!list.length) return 'cancelled';
  const files = await Promise.all(list.map(async it =>
    new File([await labelToPng(it)], `label-${it.id || 'item'}.png`, { type: 'image/png' })));
  const canShare = navigator.canShare && navigator.canShare({ files });
  if (canShare) {
    try {
      await navigator.share({ files, title: list.length === 1 ? 'Label ' + list[0].id : list.length + ' labels' });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // iOS drops the tap "permission" if building the images took too long: ask for one more tap.
      if (e && e.name === 'NotAllowedError') return shareViaTap(files);
      throw e;
    }
  }
  files.forEach(f => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  return 'downloaded';
}
function shareViaTap(files) {
  return new Promise(resolve => {
    let s = null;
    const body = h('div', { class: 'sd-share-sheet', style: { padding: '8px 4px' } },
      h('p', { style: { fontSize: '20px', margin: '0 0 12px' } }, `${files.length} label${files.length > 1 ? 's are' : ' is'} ready.`),
      BigButton('Share labels', async () => {
        try { await navigator.share({ files }); s && s.close(); resolve('shared'); }
        catch (_) { s && s.close(); resolve('cancelled'); }
      }, { variant: 'primary' }));
    s = sheet(body);
  });
}

// ---------------------------------------------------------------- tier signs (letter paper)
export function tierPrice(tier) { return Number(tier && tier.price) || 0; }
function isBag(tier) { return /BAG/i.test(String(tier.tier || '')) || /bag/i.test(String(tier.label || '')); }

/** Letter-size rack sign: huge price, "EVERYTHING ON THIS RACK", big tier QR (code = tier id). */
export function renderTierSign(tier) {
  injectCss();
  const el = document.createElement('div');
  el.className = 'sd-sign';
  el.dataset.tier = tier.tier;
  const bag = isBag(tier);
  const top = document.createElement('div');
  top.appendChild(div('sd-sign-price', money(tierPrice(tier))));
  top.appendChild(div('sd-sign-head', bag ? 'Fill a bag' : 'Everything on this rack'));
  top.appendChild(div('sd-sign-sub', bag ? 'Everything that fits in one bag' : 'Any item, any size'));
  el.appendChild(top);
  const qr = div('sd-sign-qr'); fillQr(qr, tier.tier);
  el.appendChild(qr);
  el.appendChild(div('sd-sign-foot', 'Checkout: scan this code for items without a label'));
  return el;
}

/** Print one letter-size sign per tier. */
export async function printTierSigns(tiers) {
  const list = [].concat(tiers || []).filter(Boolean);
  if (!list.length) { toast('No tiers to print', 'error'); return; }
  await ensureLib('qrcode');
  return printPages(list.map(renderTierSign), { pageCss: '@page{size:letter;margin:.5in}', pageClass: 'sd-page-fixed' });
}

/** Print an arbitrary letter-size report element (dashboard end-of-event reports). */
export function printReport(el) {
  injectCss();
  el.classList.add('sd-report');
  return printPages([el], { pageCss: '@page{size:letter;margin:12mm}' });
}
