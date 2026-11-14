// checkout.js — Checkout tab: scanner → cart → discounts → pay → sale.  (labels+checkout agent)
// Built for zero-training helpers: huge buttons, plain words, one decision per screen.

import { call, ApiError } from './api.js';
import { session, can, emit } from './state.js';
import { h, BigButton, toast, keypad, confirmModal, sheet, money, errorMessage } from './ui.js';
import { createScanner, decodeImageFile, unlockAudio, beep, normalizeCode, ensureLib } from './scanner.js';
import { qrSvg } from './labels.js';

const IS_MOCK = new URLSearchParams(location.search).get('mock') === '1' ||
  (() => { try { return localStorage.saleDeskMock === '1'; } catch (_) { return false; } })();
const CART_KEY = 'sdCart';
const RECENT_KEY = 'sdRecentSales';
const PAY_KEY = 'sdPaySettings';
const SCAN_WANT_KEY = 'sdScanWanted';

// ------------------------------------------------------------------ helpers
const cents = n => Math.round((Number(n) || 0) * 100);
const dollars = c => Math.round(c) / 100;
const $ = c => money(dollars(c));
/** Accept 50, "50", 0.5 → 0.5 */
export function frac(p) { const n = Number(p) || 0; return n > 1 ? n / 100 : n; }
function el(tag, attrs, ...kids) { return h(tag, attrs || {}, ...kids.flat(Infinity).filter(k => k != null && k !== false && k !== '')); }
function role() { try { return (session && (session.role || (session.value && session.value.role))) || ''; } catch (_) { return ''; } }
function isPricerPlus() { const r = role(); return r === 'admin' || r === 'pricer'; }
function load(key, store, dflt) { try { const v = store.getItem(key); return v ? JSON.parse(v) : dflt; } catch (_) { return dflt; } }
function save(key, store, v) { try { store.setItem(key, JSON.stringify(v)); } catch (_) { /* ignore */ } }
let keySeq = 0;
const newKey = () => 'L' + Date.now().toString(36) + (keySeq++);

// ------------------------------------------------------------------ cart model (module-level, survives tab switches)
const cart = Object.assign({ lines: [], discountPct: 0, customTotal: null, bad: [] },
  load(CART_KEY, sessionStorage, {}));
cart.lines = (cart.lines || []).filter(l => !l.pending);
function persist() { save(CART_KEY, sessionStorage, { lines: cart.lines.filter(l => !l.pending), discountPct: cart.discountPct, customTotal: cart.customTotal, bad: cart.bad }); }
function resetCart() { cart.lines = []; cart.discountPct = 0; cart.customTotal = null; cart.bad = []; persist(); }

let events = [];
let tiers = [];

/** Pick the event that is on now, else the next one, else the latest. */
export function currentEvent(list = events, now = Date.now()) {
  if (!list || !list.length) return null;
  const t = e => ({ s: Date.parse(e.start) || 0, e: Date.parse(e.end) || Infinity });
  const live = list.find(e => t(e).s <= now && now <= t(e).e);
  if (live) return live;
  const upcoming = list.filter(e => t(e).s > now).sort((a, b) => t(a).s - t(b).s)[0];
  return upcoming || list.slice().sort((a, b) => t(b).s - t(a).s)[0];
}
function parseMarkdowns(ev) {
  let m = ev && ev.markdowns;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = []; } }
  return Array.isArray(m) ? m : [];
}
/** The scheduled markdown in effect now: the biggest one whose `from` has passed (same rule as the server). */
export function activeMarkdown(ev = currentEvent(), now = Date.now()) {
  const list = parseMarkdowns(ev).filter(m => (Date.parse(m.from) || 0) <= now && frac(m.pct) > 0);
  if (!list.length) return null;
  list.sort((a, b) => frac(b.pct) - frac(a.pct));
  return list[0];
}

/**
 * Cart math, all in integer cents.
 * subtotal = Σ price × qty (price is after line edits)
 * markdown = scheduled markdown % of the applicable lines (labeled = item lines; all = every line)
 * total    = round((subtotal − markdown) × (1 − cart%));   a custom total overrides the computed total.
 */
export function totals(lines = cart.lines, discountPct = cart.discountPct, customTotal = cart.customTotal, md = activeMarkdown()) {
  const real = lines.filter(l => !l.pending);
  const lineC = l => cents(l.price) * (Number(l.qty) || 0);
  const subtotal = real.reduce((s, l) => s + lineC(l), 0);
  let markdown = 0;
  if (md) {
    const pct = frac(md.pct);
    const base = real.filter(l => md.applies === 'all' || l.type === 'item').reduce((s, l) => s + lineC(l), 0);
    markdown = Math.round(base * pct);
  }
  const afterMd = subtotal - markdown;
  const pct = customTotal == null ? frac(discountPct) : 0;
  const discounted = Math.round(afterMd * (1 - pct));
  const discount = afterMd - discounted;
  const total = customTotal != null ? cents(customTotal) : discounted;
  return { subtotal, markdown, md, afterMd, discount, total, count: real.reduce((s, l) => s + (Number(l.qty) || 0), 0) };
}

// ------------------------------------------------------------------ recent sales (this phone)
// §5 has no "list sales" action, so Recent sales shows the sales rung up on this phone.
function recentSales() { return load(RECENT_KEY, localStorage, []); }
function rememberSale(sale) {
  const list = recentSales().filter(s => s.sale_id !== sale.sale_id);
  list.unshift(sale);
  save(RECENT_KEY, localStorage, list.slice(0, 30));
}

// ------------------------------------------------------------------ CSS
const CSS = `
.ck-root{--ck-ink:var(--ink,#111);--ck-mute:var(--ink-2,#4a4a4a);--ck-line:var(--line,#d4d6da);
  --ck-ok:var(--ok,#0a7d2c);--ck-bad:var(--bad,#b00020);--ck-accent:var(--accent,#1450d2);--ck-bg2:var(--bg-2,#f2f3f5);
  font-size:var(--fs-body,18px);color:var(--ck-ink);max-width:100%;overflow-x:clip}
.ck-root *{box-sizing:border-box}
.ck-root .ck-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0 10px}
.ck-root .ck-head h2{margin:0;font-size:24px}
.ck-root .ck-link{min-height:48px;padding:0 14px;border-radius:12px;border:2px solid var(--ck-line);background:#fff;
  font-size:17px;font-weight:600;color:var(--ck-ink)}
.ck-root .ck-scan{border:2px solid var(--ck-line);border-radius:16px;padding:10px;margin-bottom:12px;background:#fff}
.ck-root .ck-reader{width:100%;border-radius:12px;overflow:hidden;background:#000;display:none}
.ck-root .ck-reader.on{display:block}
.ck-root .ck-reader video{width:100%!important;display:block}
.ck-root .ck-scan-msg{font-size:16px;color:var(--ck-mute);margin:6px 2px 0}
.ck-root .ck-row{display:flex;gap:8px;align-items:stretch}
.ck-root .ck-row>*{flex:1;min-width:0}
.ck-root .ck-photo-btn{display:flex;align-items:center;justify-content:center;min-height:var(--btn-h,64px);border-radius:12px;
  background:var(--ck-bg2);border:2px solid var(--ck-line);font-size:19px;font-weight:700;cursor:pointer;margin:8px 0 0;text-align:center}
.ck-root input[type=file]{display:none}
.ck-root .ck-dev{display:flex;gap:8px;margin-top:8px}
.ck-root .ck-dev input{flex:1;min-width:0;font-size:18px;padding:12px;border:2px dashed #999;border-radius:10px}
.ck-root .ck-dev button{min-height:52px;padding:0 14px;font-size:17px;border-radius:10px;border:0;background:#444;color:#fff}
.ck-root .ck-tiers{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 8px}
.ck-root .ck-tier{min-height:72px;border-radius:14px;border:3px solid var(--ck-ink);background:#fff;color:var(--ck-ink);
  font-size:30px;font-weight:800;line-height:1.05;padding:4px}
.ck-root .ck-tier small{display:block;font-size:15px;font-weight:600}
.ck-root .ck-tier:active,.ck-root .ck-disc button:active{transform:scale(.97)}
.ck-root .ck-misc{width:100%;min-height:var(--btn-h,64px);border-radius:14px;border:3px dashed var(--ck-ink);background:#fff;
  font-size:22px;font-weight:800;color:var(--ck-ink);margin-bottom:12px}
.ck-root .ck-banner{background:#fde8eb;border:3px solid var(--ck-bad);color:var(--ck-bad);border-radius:14px;padding:12px;
  font-weight:700;margin:0 0 10px}
.ck-root .ck-banner button{margin-top:8px}
.ck-root .ck-empty{color:var(--ck-mute);text-align:center;padding:18px 8px;border:2px dashed var(--ck-line);border-radius:14px}
.ck-root .ck-lines{list-style:none;margin:0;padding:0}
.ck-root .ck-line{border:2px solid var(--ck-line);border-radius:14px;margin:0 0 8px;background:#fff;overflow:hidden}
.ck-root .ck-line.bad{border-color:var(--ck-bad);background:#fde8eb}
.ck-root .ck-line.pending{opacity:.6;border-style:dashed}
.ck-root .ck-line-main{display:flex;gap:10px;align-items:center;padding:10px 12px;min-height:64px;width:100%;
  background:none;border:0;text-align:left;font:inherit;color:inherit;cursor:pointer}
.ck-root .ck-line-desc{flex:1;min-width:0}
.ck-root .ck-line-desc b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px}
.ck-root .ck-line-desc span{display:block;font-size:15px;color:var(--ck-mute)}
.ck-root .ck-line.bad .ck-line-desc span{color:var(--ck-bad);font-weight:700}
.ck-root .ck-line-price{font-size:24px;font-weight:800;white-space:nowrap;text-align:right}
.ck-root .ck-line-price s{display:block;font-size:14px;font-weight:400;color:var(--ck-mute)}
.ck-root .ck-qty{display:flex;align-items:center;gap:8px;padding:0 12px 10px}
.ck-root .ck-qty button{width:64px;height:56px;border-radius:12px;border:2px solid var(--ck-ink);background:#fff;font-size:30px;font-weight:800;color:var(--ck-ink)}
.ck-root .ck-qty output{min-width:48px;text-align:center;font-size:24px;font-weight:800}
.ck-root .ck-sum{border-top:3px solid var(--ck-ink);margin-top:10px;padding-top:8px}
.ck-root .ck-sum-row{display:flex;justify-content:space-between;gap:8px;font-size:19px;padding:3px 0}
.ck-root .ck-sum-row.md{color:var(--ck-ok);font-weight:700}
.ck-root .ck-disc{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0 4px}
.ck-root .ck-disc button{min-height:var(--btn-h,64px);border-radius:12px;border:2px solid var(--ck-ink);background:#fff;
  font-size:19px;font-weight:800;color:var(--ck-ink);padding:2px}
.ck-root .ck-disc button.on{background:var(--ck-ink);color:#fff}
.ck-root .ck-paybar{position:sticky;bottom:calc(var(--tab-h,68px) + var(--safe-bottom,0px));z-index:5;background:#fff;border-top:3px solid var(--ck-ink);
  margin:12px -2px 0;padding:8px 2px}
.ck-root .ck-total{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.ck-root .ck-total span{font-size:22px;font-weight:800}
.ck-root .ck-total b{font-size:var(--fs-price,56px);line-height:1.05;font-weight:900}
.ck-root .ck-clear{display:block;margin:10px auto 0;background:none;border:0;color:var(--ck-mute);font-size:17px;
  text-decoration:underline;min-height:48px}
.ck-root .ck-screen{display:flex;flex-direction:column;gap:10px;text-align:center;padding-top:4px}
.ck-root .ck-back{align-self:flex-start;min-height:52px;padding:0 14px;border-radius:12px;border:2px solid var(--ck-line);
  background:#fff;font-size:18px;font-weight:700;color:var(--ck-ink)}
.ck-root .ck-label{font-size:20px;font-weight:700;color:var(--ck-mute);margin:6px 0 0}
.ck-root .ck-giant{font-size:min(22vw,96px);font-weight:900;line-height:1;margin:0;word-break:break-all}
.ck-root .ck-big{font-size:var(--fs-price,56px);font-weight:900;line-height:1.05;margin:0}
.ck-root .ck-method{min-height:96px!important;font-size:28px!important}
.ck-root .ck-bills{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ck-root .ck-bills button{min-height:80px;border-radius:14px;border:3px solid var(--ck-ink);background:#fff;font-size:30px;font-weight:900;color:var(--ck-ink)}
.ck-root .ck-change{background:#e7f6ec;border:4px solid var(--ck-ok);border-radius:18px;padding:14px 8px}
.ck-root .ck-change .ck-giant{color:var(--ck-ok)}
.ck-root .ck-qrimg{width:min(78vw,300px);height:auto;aspect-ratio:1;object-fit:contain;margin:0 auto;display:block;
  border:2px solid var(--ck-line);border-radius:14px;background:#fff}
.ck-root .ck-handle{font-size:30px;font-weight:900;word-break:break-all;margin:0}
.ck-root .ck-note{font-size:17px;color:var(--ck-mute);margin:0}
.ck-root .ck-done{padding-top:24px}
.ck-root .ck-check{width:120px;height:120px;border-radius:50%;background:var(--ck-ok);color:#fff;font-size:76px;
  line-height:120px;margin:0 auto;font-weight:900}
.ck-root .ck-recent{list-style:none;margin:0;padding:0;max-height:60vh;overflow:auto}
.ck-root .ck-recent li,.ck-recent-sheet li{border-bottom:1px solid #ddd;padding:10px 2px;display:flex;gap:8px;align-items:center}
.ck-recent-sheet{font-size:18px}
.ck-recent-sheet ul{list-style:none;margin:0;padding:0;max-height:58vh;overflow:auto}
.ck-recent-sheet li{border-bottom:1px solid #ddd;padding:10px 2px;display:flex;gap:8px;align-items:center}
.ck-recent-sheet .ck-r-main{flex:1;min-width:0}
.ck-recent-sheet .ck-r-main b{font-size:22px}
.ck-recent-sheet .ck-r-main span{display:block;font-size:15px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ck-recent-sheet .ck-void{min-height:52px;padding:0 14px;border-radius:12px;border:2px solid #b00020;background:#fff;color:#b00020;font-size:17px;font-weight:800}
.ck-recent-sheet .ck-voided{color:#b00020;font-weight:800}
.ck-line-sheet{display:flex;flex-direction:column;gap:8px;font-size:18px}
.ck-line-sheet h3{margin:0 0 4px;font-size:22px}
`;
function injectCss() {
  if (document.getElementById('sd-checkout-css')) return;
  const s = document.createElement('style');
  s.id = 'sd-checkout-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ controller (one per render)
let current = null;

function mount(container) {
  injectCss();
  if (current) current.destroy();
  const ctl = { destroyed: false };
  current = ctl;

  const root = el('div', { class: 'ck-root' });
  container.replaceChildren(root);

  let view = 'cart';           // cart | pay | cash | change | venmo | zelle | done
  let tendered = null;         // cents
  let paying = false;
  let showBanner = false;   // scroll the 'already sold' banner into view on the next cart paint
  let lastSale = null;
  let doneTimer = 0;
  let pay = load(PAY_KEY, localStorage, null);

  // ---------- persistent scanner panel (kept across cart repaints)
  const reader = el('div', { class: 'ck-reader' });
  const scanMsg = el('p', { class: 'ck-scan-msg' }, 'Point the camera at the QR code on the label.');
  const scanBtnHolder = el('div');
  const photoInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'ck-photo-' + Date.now() });
  photoInput.addEventListener('change', onPhoto);
  const photoBtn = el('label', { class: 'ck-photo-btn', for: photoInput.id }, 'Scan with photo');
  const devBox = IS_MOCK ? devField() : null;
  const scanPanel = el('section', { class: 'ck-scan' }, reader, scanBtnHolder, scanMsg, photoBtn, photoInput, devBox);

  const scanner = createScanner(reader, code => handleCode(code));

  function paintScanButton() {
    scanBtnHolder.replaceChildren(scanner.running
      ? BigButton('Stop camera', () => stopScanner(true), { variant: 'secondary' })
      : BigButton('Start scanning', () => startScanner(), { variant: 'primary' }));
  }
  async function startScanner() {
    unlockAudio();
    scanMsg.textContent = 'Starting camera…';
    reader.classList.add('on');
    try {
      await scanner.start();
      save(SCAN_WANT_KEY, sessionStorage, true);
      scanMsg.textContent = 'Point the camera at the QR code on the label.';
    } catch (e) {
      reader.classList.remove('on');
      scanMsg.textContent = 'Camera not available. Use "Scan with photo" or the price buttons.';
      toast('Camera blocked. Use "Scan with photo".', 'error');
    }
    paintScanButton();
  }
  async function stopScanner(byUser) {
    if (byUser) save(SCAN_WANT_KEY, sessionStorage, false);
    await scanner.stop();
    reader.classList.remove('on');
    if (!ctl.destroyed) paintScanButton();
  }

  function devField() {
    const input = el('input', { type: 'text', placeholder: 'Type a code (test only)', autocapitalize: 'characters', autocomplete: 'off' });
    const go = () => { const v = input.value.trim(); if (v) { handleCode(normalizeCode(v)); input.value = ''; } };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return el('div', { class: 'ck-dev' }, input, el('button', { type: 'button', onclick: go }, 'Add'));
  }

  async function onPhoto(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    unlockAudio();
    try {
      const code = await decodeImageFile(f);
      if (code) handleCode(code);
      else { beep(false); toast('No QR code found in that photo. Try again closer.', 'error'); }
    } catch (_) { beep(false); toast('Could not read that photo.', 'error'); }
  }

  // ---------- scanning → cart
  async function handleCode(code) {
    code = normalizeCode(code);
    if (!code) return;
    const existing = cart.lines.find(l => l.type === 'item' && l.id === code);
    if (existing) { beep(false); toast(code + ' is already in the cart.', 'info'); return; }
    const ph = { key: newKey(), type: 'item', id: code, qty: 1, desc: 'Looking up ' + code + '…', price: 0, list_price: 0, pending: true };
    cart.lines.push(ph);
    paint();
    try {
      const res = await call('scan', { code });
      const i = cart.lines.indexOf(ph);
      if (i < 0) return; // cart was cleared meanwhile
      if (res.kind === 'tier' && res.tier) {
        cart.lines.splice(i, 1);
        addTier(res.tier, 1, true);
      } else {
        const it = res.item || {};
        if (cart.lines.some(l => l !== ph && l.type === 'item' && l.id === it.id)) {
          cart.lines.splice(i, 1);
          toast(it.id + ' is already in the cart.', 'info');
        } else {
          const p = Number(it.final_price) || Number(it.ai_price) || 0;
          cart.lines[i] = { key: ph.key, type: 'item', id: it.id || code, qty: 1,
            desc: [it.brand, it.title, it.size].filter(Boolean).join(' · ') || it.id || code, list_price: p, price: p };
          beep(true);
        }
      }
    } catch (err) {
      const i = cart.lines.indexOf(ph);
      if (i >= 0) cart.lines.splice(i, 1);
      beep(false);
      const c = err && err.code;
      if (c === 'ALREADY_SOLD') toast(code + ' was already sold. Set it aside.', 'error');
      else if (c === 'NOT_FOUND') toast('Code ' + code + ' not found. Use Misc $ instead.', 'error');
      else toast(errMsg(err), 'error');
    }
    persist();
    paint();
  }

  function addTier(t, delta = 1, fromScan = false) {
    const line = cart.lines.find(l => l.type === 'tier' && l.tier === t.tier && !l.edited);
    const price = Number(t.price) || 0;
    if (line) line.qty = Math.max(0, (Number(line.qty) || 0) + delta);
    else if (delta > 0) cart.lines.push({ key: newKey(), type: 'tier', tier: t.tier, qty: delta, desc: tierName(t), list_price: price, price });
    cart.lines = cart.lines.filter(l => !(l.type === 'tier' && l.qty <= 0));
    if (fromScan || delta > 0) beep(true);
    persist();
  }

  async function addMisc() {
    const n = await keypad({ title: 'Misc item: price?', value: null });
    if (n == null || !(n > 0)) return;
    cart.lines.push({ key: newKey(), type: 'misc', qty: 1, desc: 'Misc item', list_price: n, price: n });
    beep(true);
    persist(); paint();
  }

  function editLine(line) {
    if (line.pending) return;
    let s = null;
    const close = () => s && s.close();
    const body = el('div', { class: 'ck-line-sheet' },
      el('h3', {}, line.desc),
      el('p', { style: { margin: '0 0 6px', color: '#555' } },
        'Price ' + money(line.price) + (line.qty > 1 ? ' each × ' + line.qty : '') +
        (cents(line.price) !== cents(line.list_price) ? ' (was ' + money(line.list_price) + ')' : '')),
      BigButton('Change price', async () => {
        close();
        const n = await keypad({ title: 'New price' + (line.qty > 1 ? ' (each)' : ''), value: line.price });
        if (n == null || n < 0) return;
        line.price = n;
        if (line.type === 'tier') line.edited = true;
        persist(); paint();
      }, { variant: 'primary' }),
      cents(line.price) !== cents(line.list_price) ? BigButton('Back to ' + money(line.list_price), () => {
        line.price = line.list_price; delete line.edited; close(); persist(); paint();
      }, { variant: 'secondary' }) : null,
      BigButton('Remove from cart', () => {
        cart.lines = cart.lines.filter(l => l !== line);
        cart.bad = cart.bad.filter(id => id !== line.id);
        close(); persist(); paint();
      }, { variant: 'danger' }),
      BigButton('Cancel', close, { variant: 'secondary' }));
    s = sheet(body);
  }

  // ---------- cart view
  const cartArea = el('div');

  function paint() {
    if (ctl.destroyed) return;
    clearTimeout(doneTimer);
    if (view === 'cart') {
      if (!root.contains(scanPanel)) root.replaceChildren(header(), scanPanel, cartArea);
      paintScanButton();
      paintCart();
      if (showBanner) {
        showBanner = false;
        const b = root.querySelector('.ck-banner');
        if (b) requestAnimationFrame(() => b.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      }
      if (load(SCAN_WANT_KEY, sessionStorage, false) && !scanner.running) startScanner();
      return;
    }
    if (scanner.running) stopScanner(false);
    const screens = { pay: payScreen, cash: cashScreen, change: changeScreen, venmo: venmoScreen, zelle: zelleScreen, done: doneScreen };
    root.replaceChildren((screens[view] || payScreen)());
    window.scrollTo(0, 0);
  }

  function header() {
    return el('div', { class: 'ck-head' },
      el('h2', {}, 'Checkout'),
      el('button', { type: 'button', class: 'ck-link', onclick: openRecent }, 'Recent sales'));
  }

  function paintCart() {
    const t = totals();
    const tierBtns = tiers.slice().sort((a, b) => tierOrder(a) - tierOrder(b)).map(tr =>
      el('button', { type: 'button', class: 'ck-tier', onclick: () => { unlockAudio(); addTier(tr, 1); paint(); } },
        money(Number(tr.price) || 0), el('small', {}, tierBtnSub(tr))));
    const badCount = cart.lines.filter(l => isBad(l)).length;

    const lines = cart.lines.length
      ? el('ul', { class: 'ck-lines' }, cart.lines.map(lineRow))
      : el('p', { class: 'ck-empty' }, 'Cart is empty. Scan a label or tap a price button.');

    const discBtn = (pct) => el('button', { type: 'button', class: cart.customTotal == null && frac(cart.discountPct) === pct / 100 ? 'on' : '',
      onclick: () => { cart.customTotal = null; cart.discountPct = frac(cart.discountPct) === pct / 100 ? 0 : pct; persist(); paint(); } }, pct + '%');
    const customBtn = el('button', { type: 'button', class: cart.customTotal != null ? 'on' : '', onclick: async () => {
      if (cart.customTotal != null) { cart.customTotal = null; persist(); paint(); return; }
      const n = await keypad({ title: 'Custom total for the whole cart', value: null });
      if (n == null || n < 0) return;
      cart.customTotal = n; cart.discountPct = 0; persist(); paint();
    } }, cart.customTotal != null ? 'Custom ✓' : 'Custom');

    const sumRows = [
      row('Subtotal (' + t.count + ' item' + (t.count === 1 ? '' : 's') + ')', $(t.subtotal)),
      t.markdown ? row('Sale markdown ' + Math.round(frac(t.md.pct) * 100) + '% off' + (t.md.applies === 'all' ? '' : ' labeled'), '−' + $(t.markdown), 'md') : null,
      t.discount ? row('Discount ' + Math.round(frac(cart.discountPct) * 100) + '%', '−' + $(t.discount)) : null,
      cart.customTotal != null ? row('Custom total (was ' + $(t.afterMd) + ')', $(t.total)) : null,
    ];

    const canPay = cart.lines.length > 0 && !cart.lines.some(l => l.pending) && !badCount;
    cartArea.replaceChildren(...[
      el('div', { class: 'ck-tiers' }, tierBtns),
      el('button', { type: 'button', class: 'ck-misc', onclick: addMisc }, 'Misc $__'),
      badCount ? el('div', { class: 'ck-banner' },
        badCount === 1 ? '1 item in red was already sold. Take it back and remove it.' : badCount + ' items in red were already sold. Take them back and remove them.',
        BigButton('Remove sold items', () => {
          cart.lines = cart.lines.filter(l => !isBad(l)); cart.bad = []; persist(); paint();
        }, { variant: 'danger' })) : null,
      lines,
      cart.lines.length ? el('div', { class: 'ck-sum' },
        sumRows,
        el('div', { class: 'ck-disc' }, discBtn(10), discBtn(20), discBtn(50), customBtn)) : null,
      el('div', { class: 'ck-paybar' },
        el('div', { class: 'ck-total' }, el('span', {}, 'TOTAL'), el('b', { 'data-total': dollars(t.total) }, $(t.total))),
        BigButton(canPay ? 'Pay ' + $(t.total) : (cart.lines.some(l => l.pending) ? 'Looking up…' : 'Pay'), () => { view = 'pay'; paint(); },
          { variant: 'primary', disabled: !canPay })),
      cart.lines.length ? el('button', { type: 'button', class: 'ck-clear', onclick: async () => {
        if (await confirmModal('Clear the whole cart?', 'Clear cart')) { resetCart(); paint(); }
      } }, 'Clear cart') : null].flat(Infinity).filter(Boolean));
  }

  function isBad(l) { return l.type === 'item' && cart.bad.includes(l.id); }

  function lineRow(l) {
    const edited = cents(l.price) !== cents(l.list_price);
    const sub = l.pending ? 'Checking…' : isBad(l) ? 'ALREADY SOLD: remove this' :
      l.type === 'item' ? l.id : l.type === 'tier' ? (l.qty > 1 ? money(l.price) + ' each' : 'Price rack') : 'No label';
    const li = el('li', { class: 'ck-line' + (isBad(l) ? ' bad' : '') + (l.pending ? ' pending' : ''), 'data-key': l.key },
      el('button', { type: 'button', class: 'ck-line-main', onclick: () => editLine(l) },
        el('span', { class: 'ck-line-desc' }, el('b', {}, l.desc), el('span', {}, sub)),
        el('span', { class: 'ck-line-price' }, l.pending ? '…' : $(cents(l.price) * l.qty),
          edited && !l.pending ? el('s', {}, $(cents(l.list_price) * l.qty)) : null)));
    if (l.type === 'tier') {
      li.appendChild(el('div', { class: 'ck-qty' },
        el('button', { type: 'button', 'aria-label': 'One less', onclick: () => { l.qty = Math.max(0, l.qty - 1); if (!l.qty) cart.lines = cart.lines.filter(x => x !== l); persist(); paint(); } }, '−'),
        el('output', {}, String(l.qty)),
        el('button', { type: 'button', 'aria-label': 'One more', onclick: () => { l.qty += 1; beep(true); persist(); paint(); } }, '+')));
    }
    return li;
  }

  function row(label, val, cls) {
    return el('div', { class: 'ck-sum-row' + (cls ? ' ' + cls : '') }, el('span', {}, label), el('b', {}, val));
  }

  // ---------- pay screens
  function back(to = 'cart', label = 'Back to cart') {
    return el('button', { type: 'button', class: 'ck-back', onclick: () => { view = to; paint(); } }, '← ' + label);
  }
  function totalBlock(label = 'TOTAL') {
    return [el('p', { class: 'ck-label' }, label), el('p', { class: 'ck-giant', 'data-total': dollars(totals().total) }, $(totals().total))];
  }

  function payScreen() {
    refreshPay();
    return el('div', { class: 'ck-screen' }, back(),
      totalBlock(),
      el('p', { class: 'ck-label' }, 'How are they paying?'),
      methodBtn('Cash', () => { tendered = null; view = 'cash'; paint(); }),
      methodBtn('Venmo', () => { view = 'venmo'; paint(); }),
      methodBtn('Zelle / Apple Cash', () => { view = 'zelle'; paint(); }));
  }
  function methodBtn(label, fn) { const b = BigButton(label, fn, { variant: 'primary' }); b.classList.add('ck-method'); return b; }

  function cashScreen() {
    const total = totals().total;
    // likely bills: next $5, next $10, next $20, then $50 / $100 (only amounts above the total)
    const up = step => Math.floor(total / step) * step + step;
    const bills = [...new Set([up(500), up(1000), up(2000), 5000, 10000])].filter(b => b > total).sort((x, y) => x - y).slice(0, 4);
    const choose = c => { tendered = c; view = 'change'; paint(); };
    return el('div', { class: 'ck-screen' }, back('pay', 'Back'),
      totalBlock('Cash · TOTAL'),
      el('p', { class: 'ck-label' }, 'How much cash did they hand you?'),
      el('div', { class: 'ck-bills' },
        el('button', { type: 'button', onclick: () => choose(total) }, 'Exact'),
        bills.map(b => el('button', { type: 'button', onclick: () => choose(b) }, $(b)))),
      BigButton('Other amount', async () => {
        const n = await keypad({ title: 'Cash they handed you', value: null });
        if (n == null) return;
        if (cents(n) < total) { toast('That is less than the total (' + $(total) + ').', 'error'); return; }
        choose(cents(n));
      }, { variant: 'secondary' }));
  }

  function changeScreen() {
    const total = totals().total;
    const change = Math.max(0, (tendered || 0) - total);
    return el('div', { class: 'ck-screen' }, back('cash', 'Back'),
      el('div', { class: 'ck-change' },
        el('p', { class: 'ck-label' }, change ? 'GIVE CHANGE' : 'NO CHANGE'),
        el('p', { class: 'ck-giant', 'data-change': dollars(change) }, $(change))),
      el('p', { class: 'ck-note' }, 'They gave ' + $(tendered || 0) + ' for a ' + $(total) + ' total.'),
      paidButton('cash'));
  }

  function venmoScreen() {
    const p = pay || {};
    const handle = cleanHandle(p.venmo_handle);
    const imgSrc = p.venmo_qr_url || p.venmo_qr_thumb || (p.venmo_qr_file_id ? 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(p.venmo_qr_file_id) + '&sz=w800' : '');
    let qr = null;
    if (imgSrc) {
      qr = el('img', { class: 'ck-qrimg', alt: 'Venmo QR code', src: imgSrc });
      qr.addEventListener('error', () => { const g = generatedVenmoQr(handle); if (g) qr.replaceWith(g); else qr.remove(); });
    } else qr = generatedVenmoQr(handle);
    return el('div', { class: 'ck-screen' }, back('pay', 'Back'),
      el('p', { class: 'ck-label' }, 'Venmo: have them scan this'),
      qr,
      handle ? el('p', { class: 'ck-handle' }, '@' + handle) : el('p', { class: 'ck-note' }, 'No Venmo name saved yet. Ask the owner.'),
      ...totalBlock('Amount to send'),
      el('p', { class: 'ck-note' }, 'Wait until you see the payment on their screen.'),
      paidButton('venmo'));
  }

  function zelleScreen() {
    const p = pay || {};
    const z = String(p.zelle_handle || '').trim();
    return el('div', { class: 'ck-screen' }, back('pay', 'Back'),
      el('p', { class: 'ck-label' }, 'Zelle or Apple Cash: send to'),
      z ? el('p', { class: 'ck-handle' }, z) : el('p', { class: 'ck-note' }, 'No Zelle / Apple Cash handle saved yet. Ask the owner.'),
      ...totalBlock('Amount to send'),
      el('p', { class: 'ck-note' }, 'Wait until you see the payment on their screen.'),
      paidButton('zelle_apple'));
  }

  function paidButton(method) {
    const b = BigButton('Paid ✓', () => doCheckout(method, b), { variant: 'primary' });
    b.classList.add('ck-method');
    return b;
  }

  async function doCheckout(method, btn) {
    if (paying) return;
    paying = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const t = totals();
    const ev = currentEvent();
    const params = {
      lines: cart.lines.filter(l => !l.pending).map(cleanLine),
      method,
    };
    if (ev && ev.event_id) params.event_id = ev.event_id;
    if (cart.customTotal != null) params.custom_total = dollars(cents(cart.customTotal));
    else if (cart.discountPct) params.cart_discount_pct = Math.round(frac(cart.discountPct) * 100); // whole percent, like event markdowns (pct: 50)
    if (method === 'cash' && tendered != null) params.tendered = dollars(tendered);
    try {
      const sale = await call('checkout', params);
      lastSale = Object.assign({ total: dollars(t.total), method, time: new Date().toISOString(),
        lines: params.lines, tendered: params.tendered, change: method === 'cash' ? dollars(Math.max(0, (tendered || 0) - t.total)) : 0 }, sale || {});
      rememberSale(lastSale);
      resetCart();
      try { emit('sale:done', lastSale); } catch (_) { /* ignore */ }
      view = 'done';
      beep(true);
    } catch (err) {
      if (err && err.code === 'ALREADY_SOLD') {
        const ids = soldIdsFrom(err);
        if (ids.length) cart.bad = ids;
        else await recheckItems();
        persist();
        view = 'cart';
        showBanner = true;
        beep(false);
        toast(cart.bad.length ? 'Some items were already sold. They are marked in red.' : errMsg(err), 'error');
      } else {
        toast(errMsg(err) + ' Nothing was charged. Tap Paid again.', 'error');
      }
    } finally {
      paying = false;
    }
    paint();
  }

  async function recheckItems() {
    const bad = [];
    for (const l of cart.lines.filter(x => x.type === 'item')) {
      try { await call('scan', { code: l.id }); } catch (e) { if (e && e.code === 'ALREADY_SOLD') bad.push(l.id); }
    }
    cart.bad = bad;
  }

  function doneScreen() {
    const s = lastSale || {};
    doneTimer = setTimeout(() => { if (view === 'done' && !ctl.destroyed) { view = 'cart'; paint(); } }, 20000);
    return el('div', { class: 'ck-screen ck-done' },
      el('div', { class: 'ck-check' }, '✓'),
      el('p', { class: 'ck-big' }, 'Sale complete: ' + money(Number(s.total) || 0)),
      s.method === 'cash' && Number(s.change) > 0 ? el('p', { class: 'ck-label' }, 'Change given: ' + money(Number(s.change))) : null,
      s.sale_id ? el('p', { class: 'ck-note' }, 'Sale ' + s.sale_id) : null,
      BigButton('Next customer', () => { view = 'cart'; paint(); }, { variant: 'primary' }));
  }

  async function refreshPay() {
    try {
      const s = await call('settings.get');
      pay = { venmo_handle: s.venmo_handle, zelle_handle: s.zelle_handle, venmo_qr_file_id: s.venmo_qr_file_id,
        venmo_qr_url: s.venmo_qr_url, venmo_qr_thumb: s.venmo_qr_thumb };
      save(PAY_KEY, localStorage, pay);
    } catch (_) { /* helpers can't read settings (§3); use the copy cached from the last admin on this phone */ }
  }

  // ---------- recent sales
  // §5 has no "list sales" action. Show this phone's sales right away, then merge in `dashboard.sales`
  // (the mock returns the last 20 there; the real backend may not, which is fine).
  function openRecent() {
    let s = null;
    const pricer = isPricerPlus();
    const listBox = el('div', {}, el('p', {}, 'Loading…'));
    const body = el('div', { class: 'ck-recent-sheet' },
      el('h3', { style: { margin: '0 0 6px', fontSize: '22px' } }, 'Recent sales'),
      listBox,
      !pricer ? el('p', { style: { fontSize: '16px', color: '#555' } }, 'To undo a sale, ask the owner or a pricer.') : null,
      BigButton('Close', () => s && s.close(), { variant: 'secondary' }));
    s = sheet(body);
    let list = recentSales();
    draw();
    const ev = currentEvent();
    call('dashboard', ev && ev.event_id ? { event_id: ev.event_id } : {}).then(d => {
      const server = Array.isArray(d && d.sales) ? d.sales : [];
      if (!server.length) return;
      const seen = new Set(server.map(x => x.sale_id));
      const local = recentSales();
      list = server.concat(local.filter(x => !seen.has(x.sale_id)))
        .sort((x, y) => (Date.parse(y.time) || 0) - (Date.parse(x.time) || 0)).slice(0, 30);
      draw();
    }).catch(() => {});

    function draw() {
      listBox.replaceChildren(list.length ? el('ul', {}, list.map(sale => {
        const desc = (sale.lines || []).map(l => (l.qty > 1 ? l.qty + '× ' : '') + l.desc).join(', ');
        return el('li', {},
          el('div', { class: 'ck-r-main' },
            el('b', {}, money(Number(sale.total) || 0)), ' ',
            el('span', {}, [timeStr(sale.time), methodName(sale.method), sale.cashier, sale.sale_id].filter(Boolean).join(' · ')),
            el('span', {}, desc)),
          truthy(sale.voided) ? el('span', { class: 'ck-voided' }, 'VOIDED')
            : pricer && sale.sale_id ? el('button', { type: 'button', class: 'ck-void', onclick: () => voidSale(sale) }, 'Void') : null);
      })) : el('p', {}, 'No sales yet.'));
    }

    async function voidSale(sale) {
      const ok = await confirmModal('Void sale ' + sale.sale_id + ' for ' + money(Number(sale.total) || 0) + '? Its items go back on sale. Give back the money first.', 'Void sale');
      if (!ok) return;
      try {
        await call('voidSale', { sale_id: sale.sale_id });
        rememberSale(Object.assign({}, sale, { voided: true }));
        list = list.map(x => (x.sale_id === sale.sale_id ? Object.assign({}, x, { voided: true }) : x));
        draw();
        toast('Sale ' + sale.sale_id + ' voided.', 'ok');
        try { emit('sale:done', Object.assign({}, sale, { voided: true })); } catch (_) { /* ignore */ }
      } catch (err) { toast(errMsg(err), 'error'); }
    }
  }

  // ---------- data
  async function loadData() {
    try { const r = await call('tiers.list'); tiers = (r && (r.tiers || r)) || []; if (!Array.isArray(tiers)) tiers = []; } catch (e) { toast(errMsg(e), 'error'); }
    try { const r = await call('events.list'); events = (r && (r.events || r)) || []; if (!Array.isArray(events)) events = []; } catch (_) { /* no markdowns */ }
    if (view === 'cart' && !ctl.destroyed) paintCart();
  }

  // ---------- lifecycle (§9 has no unmount hook: watch for our root leaving the page)
  const onVis = () => {
    if (document.hidden) { if (scanner.running) scanner.stop().then(() => reader.classList.remove('on')).then(() => !ctl.destroyed && paintScanButton()); }
    else if (view === 'cart' && load(SCAN_WANT_KEY, sessionStorage, false) && !scanner.running) startScanner();
  };
  document.addEventListener('visibilitychange', onVis);
  const watch = setInterval(() => { if (!root.isConnected) ctl.destroy(); }, 1000);
  ctl.destroy = () => {
    if (ctl.destroyed) return;
    ctl.destroyed = true;
    clearInterval(watch);
    clearTimeout(doneTimer);
    document.removeEventListener('visibilitychange', onVis);
    scanner.stop();
    if (current === ctl) current = null;
  };

  if (IS_MOCK) window.__sdCheckout = { scan: handleCode, cart, totals, view: () => view, setView: v => { view = v; paint(); } };

  paint();
  loadData();
  ensureLib('qrcode').catch(() => {});
  return ctl;
}

// ------------------------------------------------------------------ small helpers
function cleanLine(l) {
  const o = { type: l.type, qty: Number(l.qty) || 1, desc: l.desc, list_price: Number(l.list_price) || 0, price: Number(l.price) || 0 };
  if (l.type === 'item') o.id = l.id;
  if (l.type === 'tier') o.tier = l.tier;
  return o;
}
function soldIdsFrom(err) {
  const cand = err.ids || (err.data && err.data.ids) || (err.details && err.details.ids) || (err.error && err.error.ids);
  if (Array.isArray(cand) && cand.length) return cand.map(String);
  const m = String(err.message || '').match(/S-\d+/gi);
  return m ? m.map(s => s.toUpperCase()) : [];
}
function errMsg(err) {
  try { if (err instanceof ApiError || (err && err.code)) return errorMessage(err); } catch (_) { /* ignore */ }
  return 'Something went wrong. Try again.';
}
function tierOrder(t) { return /BAG/i.test(t.tier) ? 1e6 : Number(t.price) || 0; }
function tierName(t) { return /BAG/i.test(t.tier) ? 'Fill a bag' : (t.label || money(Number(t.price) || 0) + ' rack'); }
function tierBtnSub(t) { return /BAG/i.test(t.tier) ? 'fill a bag' : 'rack item'; }
function cleanHandle(hd) { return String(hd || '').trim().replace(/^@/, ''); }
function generatedVenmoQr(handle) {
  if (!handle || !window.qrcode) return null;
  const box = document.createElement('div');
  box.innerHTML = qrSvg('https://venmo.com/u/' + handle, 4);
  const svg = box.firstElementChild;
  if (svg) { svg.setAttribute('class', 'ck-qrimg'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Venmo QR code'); }
  return svg || null;
}
function truthy(v) { return v === true || v === 'true' || v === 'TRUE' || v === 1; }
function methodName(m) { return m === 'cash' ? 'Cash' : m === 'venmo' ? 'Venmo' : m === 'zelle_apple' ? 'Zelle/Apple' : (m || ''); }
function timeStr(t) { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

// ------------------------------------------------------------------ tab export (§9)
export const tabs = [{
  id: 'checkout',
  label: 'Checkout',
  icon: '🛒',
  roles: ['admin', 'pricer', 'helper'],
  render(container /* , ctx */) { mount(container); },
  onHide() { if (current) current.destroy(); }, // shell extra: stop the camera as soon as we leave
}];
