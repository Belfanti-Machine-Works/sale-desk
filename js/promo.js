// promo.js (promo agent): Promo tab. Sale event setup, featured picker, collage,
// per-channel share (clipboard + iOS share sheet), printable signs/flyers, promo checklist.
// Imports only CONTRACT §9 exports from the shell.
import { call } from './api.js';
import { h, BigButton, toast, money, errorMessage } from './ui.js';
import { session } from './state.js';
import {
  renderCollage, canvasToBlob, eventWhen, markdownLine, parseJson, toDate, sameDay,
  priceOf, FORMATS, HEADLINE, FOOTER,
} from './collage.js';

export const tabs = [{
  id: 'promo',
  label: 'Promo',
  icon: '📣',
  roles: ['admin', 'pricer'],
  render,
}];

// ------------------------------------------------------------------ constants
const QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const MAX_FEATURED = 12;
const DEFAULT_NAME = 'Huge Resale Inventory Sale';

const CHANNELS = [
  { key: 'fb', label: 'FB Marketplace', open: 'https://www.facebook.com/marketplace/create/item', openLabel: 'Open Marketplace',
    hint: 'Copy text, then Share image → Facebook. Paste the text into the listing description.', link: false },
  { key: 'fb_group', label: 'FB groups', open: 'https://www.facebook.com/groups/feed/', openLabel: 'Open Groups',
    hint: 'Post in each local buy/sell group. Copy text, Share image → Facebook, pick the group, paste.', link: true },
  { key: 'craigslist', label: 'Craigslist', open: 'https://post.craigslist.org/', openLabel: 'Open Craigslist',
    hint: 'Category: garage & moving sales. Copy text, open Craigslist, paste, then add the image from Photos.', link: true },
  { key: 'nextdoor', label: 'Nextdoor', open: 'https://nextdoor.com/', openLabel: 'Open Nextdoor',
    hint: 'Copy text, Share image → Nextdoor (or post in For Sale & Free), paste.', link: true },
];

const STEPS = [
  { key: 't7', days: 7, when: '1 week before', title: 'Post to FB Marketplace + groups, Craigslist, Nextdoor', go: 'share' },
  { key: 't2', days: 2, when: '2 days before', title: 'Repost + boost best photos', go: 'share' },
  { key: 'd0', days: 0, when: 'Morning of the sale', title: "Repost 'Happening now' + put out signs", go: 'share' },
];

// ------------------------------------------------------------------ module state
const st = {
  root: null,
  view: 'home',
  events: [],
  ev: null,          // selected event (normalized)
  cand: null,        // promo.featured candidates (promo_safe only)
  sel: null,         // featured item ids (ordered, max 12)
  removed: new Set(),
  showOthers: false,
  texts: null,
  textsFor: null,
  channel: 'fb',
  format: 'portrait',
  collage: {},       // format -> {key, blob, url}
  signVariant: 'right',
  flyerAddr: true,
};

// ------------------------------------------------------------------ small utils
function isMock() {
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('mock') === '0') return false;
    if (p.get('mock') === '1') return true;
    return localStorage.getItem('saleDeskMock') === '1';
  } catch { return false; }
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } }

export function previewUrl() {
  const u = new URL('preview.html', location.href.split('#')[0]);
  u.search = isMock() ? '?mock=1' : '';
  u.hash = '';
  return u.href;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function timeStr(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fromLocal(date, time) { const d = new Date(`${date}T${time || '00:00'}`); return isNaN(d) ? null : d; }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayDiff(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
function niceDay(d) { return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }
function niceTime(t) { // '13:30' -> '1:30pm'
  const [hh, mm] = String(t).split(':').map(Number);
  const ap = hh < 12 ? 'am' : 'pm';
  const h12 = hh % 12 || 12;
  return mm ? `${h12}:${pad2(mm)}${ap}` : `${h12}${ap}`;
}

function normEvent(e) {
  if (!e) return null;
  const md = parseJson(e.markdowns, []);
  const cl = parseJson(e.promo_checklist, {});
  return { ...e, markdowns: Array.isArray(md) ? md : [], promo_checklist: cl && typeof cl === 'object' ? cl : {} };
}

// promo_checklist shape isn't fixed by the contract. Accept either
//   object: {t7:{done,at,by}, t2:..., d0:...}   or   array: [{id:'t7', label, done, at?, by?}, ...]
// and write back in the shape the event already uses (object for new events).
const STEP_ALIASES = { t7: ['t7', 't-7', 'week'], t2: ['t2', 't-2'], d0: ['d0', 'dayof', 'day0', 'morning'] };
function stepEntry(cl, key) {
  const ids = STEP_ALIASES[key] || [key];
  if (Array.isArray(cl)) return cl.find((x) => x && ids.includes(String(x.id || x.key || '').toLowerCase())) || null;
  for (const id of ids) if (cl && cl[id] != null) return cl[id];
  return null;
}
function withStep(cl, key, done) {
  const stamp = { at: new Date().toISOString(), by: (session && session.name) || '' };
  if (Array.isArray(cl)) {
    const ids = STEP_ALIASES[key] || [key];
    const out = cl.map((x) => (x && ids.includes(String(x.id || x.key || '').toLowerCase()) ? { ...x, done, ...(done ? stamp : { at: '', by: '' }) } : x));
    if (!out.some((x) => x && ids.includes(String(x.id || x.key || '').toLowerCase()))) {
      const s = STEPS.find((x) => x.key === key);
      out.push({ id: key, label: s ? s.title : key, done, ...(done ? stamp : {}) });
    }
    return out;
  }
  const out = { ...(cl || {}) };
  for (const id of STEP_ALIASES[key] || []) if (id !== key) delete out[id];
  if (done) out[key] = { done: true, ...stamp }; else delete out[key];
  return out;
}
function eventPayload(ev) {
  const out = {
    name: ev.name, start: ev.start, end: ev.end, address: ev.address || '',
    markdowns: ev.markdowns || [], promo_checklist: ev.promo_checklist || {},
  };
  if (ev.event_id) out.event_id = ev.event_id;
  return out;
}
function upsertEvent(saved) {
  const i = st.events.findIndex((e) => e.event_id === saved.event_id);
  if (i >= 0) st.events[i] = saved; else st.events.push(saved);
  st.ev = saved;
}
function isSafe(it) { return it && it.promo_safe !== false && String(it.promo_safe).toLowerCase() !== 'false'; }

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const t = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0;font-size:16px' });
  t.value = text;
  document.body.appendChild(t);
  t.focus();
  t.select();
  t.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

// ------------------------------------------------------------------ QR
let qrLoading = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrLoading) {
    qrLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = QR_SRC;
      s.async = true;
      s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('qr lib missing')));
      s.onerror = () => { qrLoading = null; reject(new Error('qr lib failed')); };
      document.head.appendChild(s);
    });
  }
  return qrLoading;
}
/** SVG element for text, or null if the library is unavailable. */
function qrSvg(text) {
  if (!window.qrcode) return null;
  try {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code to the sale preview page');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', '-2'); bg.setAttribute('y', '-2'); bg.setAttribute('width', n + 4); bg.setAttribute('height', n + 4); bg.setAttribute('fill', '#fff');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', '#000');
    svg.append(bg, p);
    return svg;
  } catch { return null; }
}

// ------------------------------------------------------------------ CSS (scoped)
const CSS = `
.tab-promo{--pm-ink:#111;--pm-mute:#555;--pm-line:#d6d6d6;--pm-card:#fff;--pm-soft:#f4f4f2;--pm-hi:#FFD60A;--pm-ok:#0a7d2c;--pm-bad:#b00020;--pm-accent:#1450d2;
  color:var(--pm-ink);font-size:var(--fs-body,18px);line-height:1.4;padding:12px 16px 32px;max-width:640px;margin:0 auto;box-sizing:border-box;overflow-x:hidden}
.tab-promo *{box-sizing:border-box}
.tab-promo button{font-family:inherit}
.tab-promo h2{font-size:24px;margin:4px 0 8px;line-height:1.2}
.tab-promo h3{font-size:20px;margin:0 0 6px}
.tab-promo .pm-card{background:var(--pm-card);border:1px solid var(--pm-line);border-radius:14px;padding:16px;margin:12px 0}
.tab-promo .pm-mute{color:var(--pm-mute);font-size:16px}
.tab-promo .pm-stack>*+*{margin-top:10px}
.tab-promo .btn{width:100%;margin:8px 0}
.tab-promo .pm-top{display:flex;align-items:center;gap:8px;margin:0 0 4px}
.tab-promo .pm-top h2{margin:0;flex:1;min-width:0}
.tab-promo .pm-back{min-height:48px;min-width:64px;padding:0 12px;border:0;background:none;color:var(--pm-accent);font-size:18px;font-weight:600;cursor:pointer;text-align:left}
.tab-promo .pm-linkbtn{border:0;background:none;color:var(--pm-accent);font-size:18px;font-weight:600;padding:10px 0;min-height:48px;cursor:pointer;text-decoration:underline}
.tab-promo .pm-ev-when{font-size:20px;font-weight:700}
.tab-promo .pm-field{display:block;margin:14px 0}
.tab-promo .pm-field>span{display:block;font-weight:700;margin-bottom:6px}
.tab-promo input,.tab-promo select,.tab-promo textarea{width:100%;font:inherit;font-size:18px;padding:12px;border:1px solid #aaa;border-radius:10px;background:#fff;color:var(--pm-ink);min-height:52px}
.tab-promo textarea{min-height:220px;line-height:1.4;resize:vertical}
.tab-promo .pm-row{display:flex;gap:10px}
.tab-promo .pm-row>*{flex:1;min-width:0}
.tab-promo .pm-chips{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
.tab-promo .pm-chip{min-height:56px;border:2px solid var(--pm-line);border-radius:12px;background:#fff;font-size:17px;font-weight:700;color:var(--pm-ink);cursor:pointer;padding:6px 8px}
.tab-promo .pm-chip[aria-pressed="true"]{border-color:var(--pm-ink);background:var(--pm-ink);color:#fff}
.tab-promo .pm-md{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--pm-line)}
.tab-promo .pm-md>span{flex:1}
.tab-promo .pm-x{min-width:48px;min-height:48px;border:0;border-radius:10px;background:var(--pm-soft);font-size:20px;cursor:pointer}
.tab-promo .pm-due{border:3px solid var(--pm-ink);background:#fffbe0}
.tab-promo .pm-pill{display:inline-block;font-size:15px;font-weight:800;padding:2px 10px;border-radius:999px;background:var(--pm-soft);vertical-align:middle}
.tab-promo .pm-pill.today{background:var(--pm-hi);color:#000}
.tab-promo .pm-pill.late{background:var(--pm-bad);color:#fff}
.tab-promo .pm-pill.done{background:var(--pm-ok);color:#fff}
.tab-promo .pm-check{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--pm-line);cursor:pointer;min-height:64px}
.tab-promo .pm-check:last-child{border-bottom:0}
.tab-promo .pm-check input{width:34px;height:34px;min-height:0;flex:0 0 34px;margin:2px 0 0;accent-color:var(--pm-ok)}
.tab-promo .pm-check b{display:block;font-size:19px}
.tab-promo .pm-check.is-done b{text-decoration:line-through;color:var(--pm-mute)}
.tab-promo .pm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tab-promo .pm-tile{position:relative;aspect-ratio:3/4;border-radius:10px;overflow:hidden;background:#2b2b2b;border:0;padding:0;cursor:pointer;color:#fff}
.tab-promo .pm-tile img{width:100%;height:100%;object-fit:cover;display:block}
.tab-promo .pm-tile .pm-tt{position:absolute;inset:0;padding:8px;font-size:14px;font-weight:700;text-align:left;display:flex;flex-direction:column;justify-content:center;overflow:hidden}
.tab-promo .pm-tile .pm-tt i{font-style:normal;color:var(--pm-hi);font-size:12px;text-transform:uppercase}
.tab-promo .pm-tile .pm-price{position:absolute;right:4px;top:4px;background:var(--pm-hi);color:#000;font-weight:900;font-size:16px;border-radius:999px;padding:2px 8px}
.tab-promo .pm-tile .pm-tx{position:absolute;left:4px;top:4px;background:rgba(0,0,0,.65);color:#fff;font-size:15px;font-weight:900;width:28px;height:28px;border-radius:50%;line-height:28px;text-align:center}
.tab-promo .pm-tile .pm-tadd{background:var(--pm-ok)}
.tab-promo .pm-tile .pm-num{position:absolute;left:4px;bottom:4px;background:rgba(0,0,0,.65);font-size:13px;font-weight:800;padding:0 6px;border-radius:6px}
.tab-promo .pm-imgbox{background:#222;border-radius:12px;overflow:hidden;display:grid;place-items:center;color:#fff;font-weight:700;margin:8px 0;width:100%}
.tab-promo .pm-imgbox img{width:100%;height:100%;object-fit:contain;display:block;grid-area:1/1}
.tab-promo .pm-steps{margin:6px 0 0;padding-left:22px;font-size:16px;color:var(--pm-mute)}
.tab-promo .pm-url{font-size:15px;word-break:break-all;background:var(--pm-soft);padding:8px 10px;border-radius:8px;margin:6px 0}
.tab-promo .pm-spin{display:flex;align-items:center;gap:12px;padding:24px 4px;color:var(--pm-mute)}
.tab-promo .pm-spin::before{content:"";width:26px;height:26px;border-radius:50%;border:4px solid #ccc;border-top-color:var(--pm-ink);animation:pm-rot .8s linear infinite}
@keyframes pm-rot{to{transform:rotate(360deg)}}
.tab-promo .pm-pagewrap{background:#cfcfcf;border-radius:12px;padding:8px;overflow:hidden;margin:8px 0}
.tab-promo .pm-pagewrap .promo-page{background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.tab-promo .pm-toggle{display:flex;gap:12px;align-items:center;min-height:56px;font-weight:600}
.tab-promo .pm-toggle input{width:30px;height:30px;min-height:0;flex:0 0 30px}

/* printable pages: shared by on-screen preview and print root */
.promo-page{color:#000;background:#fff;font-family:system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;overflow:hidden;position:relative;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.promo-page *{box-sizing:border-box}
.promo-page.land{width:10.4in;height:7.9in;padding:.3in .4in;display:flex;flex-direction:column}
.promo-page.port{width:7.9in;height:10.4in}
.promo-page .ps-top{font-size:.6in;font-weight:900;text-align:center;letter-spacing:.01em;line-height:1;border-bottom:.08in solid #000;padding-bottom:.12in}
.promo-page .ps-mid{flex:1;display:flex;align-items:center;justify-content:center;gap:.35in}
.promo-page .ps-mid.left{flex-direction:row-reverse}
.promo-page .ps-sale{font-size:2.85in;font-weight:900;line-height:.85;letter-spacing:-.02em}
.promo-page .ps-arrow{width:4in;height:2.4in;flex:0 0 auto}
.promo-page .ps-bot{display:flex;align-items:flex-end;justify-content:space-between;gap:.3in;border-top:.08in solid #000;padding-top:.14in}
.promo-page .ps-when{font-size:.56in;font-weight:900;line-height:1.08;text-transform:uppercase}
.promo-page .ps-qr{width:1.45in;text-align:center;font-size:.14in;font-weight:700;flex:0 0 auto}
.promo-page .ps-qr svg{width:1.45in;height:1.45in;display:block}
.promo-page .ps-qr .ps-url{font-size:.12in;word-break:break-all}
.promo-page .pf{height:5.2in;padding:.3in .35in;display:flex;flex-direction:column}
.promo-page .pf+.pf{border-top:.02in dashed #777}
.promo-page .pf-head{background:#000;color:#fff;font-size:.37in;white-space:nowrap;font-weight:900;text-align:center;padding:.1in .1in;line-height:1.05;letter-spacing:.01em}
.promo-page .pf-name{font-size:.2in;font-weight:700;text-align:center;margin-top:.06in}
.promo-page .pf-body{flex:1;display:flex;gap:.3in;margin-top:.14in;min-height:0}
.promo-page .pf-left{flex:1;min-width:0}
.promo-page .pf-when{font-size:.36in;font-weight:900;line-height:1.1}
.promo-page .pf-hours{font-size:.3in;font-weight:800;margin-top:.03in}
.promo-page .pf-addr{font-size:.21in;font-weight:700;margin-top:.12in;line-height:1.2}
.promo-page .pf-pts{font-size:.22in;font-weight:800;margin:.14in 0 0;padding:0;list-style:none}
.promo-page .pf-pts li::before{content:"■ "}
.promo-page .pf-md{font-size:.17in;margin-top:.1in;font-weight:600}
.promo-page .pf-right{width:1.9in;text-align:center;font-size:.15in;font-weight:700;flex:0 0 auto}
.promo-page .pf-right svg{width:1.9in;height:1.9in;display:block}
.promo-page .pf-right .ps-url{font-size:.12in;word-break:break-all}
#promo-print-root{display:none}
@media print{
  html.promo-printing body>*:not(#promo-print-root){display:none!important}
  html.promo-printing,html.promo-printing body{margin:0!important;padding:0!important;background:#fff!important;min-height:0!important;height:auto!important;overflow:visible!important}
  html.promo-printing body>#promo-print-root{display:block!important}
  #promo-print-root .promo-page{break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;box-shadow:none}
  #promo-print-root .promo-page:last-child{break-after:auto;page-break-after:auto}
}
`;
function injectCss() {
  if (document.getElementById('promo-css')) return;
  const s = document.createElement('style');
  s.id = 'promo-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ shell
function loading(text) { return h('div', { class: 'pm-spin', role: 'status' }, text); }
function errBox(err, retry) {
  return h('div', { class: 'pm-card' },
    h('p', null, errorMessage(err)),
    retry ? BigButton('Try again', retry, { variant: 'secondary' }) : null);
}
function show(el) {
  if (!st.root) return;
  st.root.replaceChildren(el);
}
function topBar(title, back = 'home') {
  return h('div', { class: 'pm-top' },
    h('button', { type: 'button', class: 'pm-back', onClick: () => go(back) }, '‹ Back'),
    h('h2', null, title));
}
function go(view) {
  st.view = view;
  const fn = VIEWS[view] || VIEWS.home;
  show(fn());
  try { window.scrollTo(0, 0); } catch { /* ignore */ }
}

async function render(container) {
  injectCss();
  st.root = h('div', { class: 'tab-promo' });
  container.replaceChildren(st.root);
  show(loading('Loading your sales…'));
  try {
    await loadEvents();
  } catch (e) {
    show(errBox(e, () => render(container)));
    return;
  }
  go(st.view && st.view !== 'edit' ? st.view : 'home');
}

async function loadEvents() {
  const d = await call('events.list');
  const list = Array.isArray(d) ? d : (d && d.events) || [];
  st.events = list.map(normEvent).filter(Boolean);
  const keep = st.ev && st.events.find((e) => e.event_id === st.ev.event_id);
  st.ev = keep || pickDefaultEvent(st.events);
}
function pickDefaultEvent(list) {
  if (!list.length) return null;
  const now = Date.now();
  const upcoming = list.filter((e) => { const end = toDate(e.end) || toDate(e.start); return !end || end.getTime() >= now; })
    .sort((a, b) => (toDate(a.start) || 0) - (toDate(b.start) || 0));
  if (upcoming.length) return upcoming[0];
  return list.slice().sort((a, b) => (toDate(b.start) || 0) - (toDate(a.start) || 0))[0];
}
function selectEvent(id) {
  st.ev = st.events.find((e) => e.event_id === id) || st.ev;
  st.sel = null;
  st.removed = new Set();
  st.textsFor = null;
  st.collage = {};
  go('home');
}

// ------------------------------------------------------------------ checklist logic
function isDone(v) { return v === true || (v && typeof v === 'object' && !!v.done) || (typeof v === 'string' && v !== ''); }
export function checklistSteps(ev, now = new Date()) {
  const start = toDate(ev && ev.start);
  const cl = (ev && ev.promo_checklist) || {};
  return STEPS.map((s) => {
    const due = start ? addDays(startOfDay(start), -s.days) : null;
    const done = isDone(stepEntry(cl, s.key));
    const diff = due ? dayDiff(now, due) : null; // days from today until due
    let status = 'upcoming';
    if (done) status = 'done';
    else if (diff === 0) status = 'today';
    else if (diff !== null && diff < 0) status = 'late';
    return { ...s, due, done, diff, status };
  });
}
function saleOver(ev, now = new Date()) {
  const end = toDate(ev && ev.end) || toDate(ev && ev.start);
  return !!end && end.getTime() < now.getTime();
}
/** The step to nag about: due today, else the latest overdue one, else the next upcoming. */
function focusStep(ev) {
  if (!ev || saleOver(ev)) return null;
  const steps = checklistSteps(ev);
  return steps.find((s) => s.status === 'today')
    || steps.filter((s) => s.status === 'late').pop()
    || steps.find((s) => s.status === 'upcoming')
    || null;
}
function statusPill(s) {
  const txt = {
    done: 'Done',
    today: 'Due today',
    late: 'Do it now',
    upcoming: s.due ? (s.diff === 1 ? 'Tomorrow' : niceDay(s.due)) : 'Set a date',
  }[s.status];
  return h('span', { class: `pm-pill ${s.status}` }, txt);
}

async function toggleStep(key, done, rerender) {
  const ev = st.ev;
  if (!ev) return;
  const prev = ev.promo_checklist || {};
  const next = withStep(prev, key, done);
  ev.promo_checklist = next;
  rerender();
  try {
    const d = await call('events.save', { event: eventPayload(ev) });
    const saved = normEvent((d && d.event) || d);
    if (saved && saved.event_id) {
      // keep our checklist if the server echoed an older shape
      if (isDone(stepEntry(saved.promo_checklist, key)) !== done) saved.promo_checklist = next;
      upsertEvent(saved);
    }
    toast(done ? 'Checked off' : 'Unchecked', 'ok');
  } catch (e) {
    ev.promo_checklist = prev;
    toast(errorMessage(e), 'error');
  }
  rerender();
}

// ------------------------------------------------------------------ HOME
function viewHome() {
  const ev = st.ev;
  if (!ev) {
    return h('div', null,
      h('h2', null, 'Promote the sale'),
      h('div', { class: 'pm-card' },
        h('p', null, 'No sale set up yet. Add the date, hours and address once, and the app drafts every post, image and sign for you.'),
        BigButton('Set up your sale', () => openEditor(null))));
  }
  const when = eventWhen(ev);
  const picker = st.events.length > 1
    ? h('label', { class: 'pm-field' }, h('span', null, 'Which sale'),
      h('select', { onChange: (e) => selectEvent(e.target.value) },
        st.events.map((e) => h('option', { value: e.event_id, selected: e.event_id === ev.event_id }, `${e.name || DEFAULT_NAME} · ${eventWhen(e).days}`))))
    : null;

  const focus = focusStep(ev);
  let dueCard;
  if (saleOver(ev)) {
    dueCard = h('div', { class: 'pm-card' }, h('b', null, 'This sale is over.'), h('p', { class: 'pm-mute' }, 'Set up the next one with "New sale" below.'));
  } else if (focus) {
    const cb = h('input', { type: 'checkbox', checked: focus.done, 'aria-label': 'Mark done' });
    cb.addEventListener('change', () => toggleStep(focus.key, cb.checked, () => { if (st.view === 'home') go('home'); }));
    dueCard = h('div', { class: `pm-card ${focus.status === 'upcoming' ? '' : 'pm-due'}` },
      h('div', { class: 'pm-mute' }, focus.status === 'upcoming' ? 'Next promo step' : 'Promo step for today', ' ', statusPill(focus)),
      h('label', { class: 'pm-check' }, cb, h('span', null, h('b', null, focus.title), h('span', { class: 'pm-mute' }, focus.when))),
      focus.status !== 'upcoming' ? BigButton(focus.key === 'd0' ? 'Share "Happening now"' : 'Share posts now', () => go('share')) : null);
  }

  return h('div', null,
    h('h2', null, 'Promote the sale'),
    picker,
    h('div', { class: 'pm-card' },
      h('h3', null, ev.name || DEFAULT_NAME),
      h('div', { class: 'pm-ev-when' }, when.line),
      h('div', { class: 'pm-mute' }, ev.address ? ev.address : 'No address yet'),
      ev.markdowns.length ? h('div', { class: 'pm-mute' }, ev.markdowns.map(markdownLine).join(' · ')) : null,
      h('div', { class: 'pm-row' },
        h('button', { type: 'button', class: 'pm-linkbtn', onClick: () => openEditor(ev) }, 'Edit sale'),
        h('button', { type: 'button', class: 'pm-linkbtn', style: 'text-align:right', onClick: () => openEditor(null) }, '+ New sale'))),
    dueCard,
    BigButton('Share posts', () => go('share')),
    BigButton('Featured photos', () => go('photos'), { variant: 'secondary' }),
    BigButton('Signs & flyers', () => go('signs'), { variant: 'secondary' }),
    BigButton('Promo checklist', () => go('checklist'), { variant: 'secondary' }),
    publicLinkCard());
}

function publicLinkCard() {
  const url = previewUrl();
  return h('div', { class: 'pm-card' },
    h('b', null, 'Public preview page'),
    h('p', { class: 'pm-mute' }, 'Anyone can open this. It shows the date, featured items, and the address starting 2 days before the sale.'),
    h('div', { class: 'pm-url' }, url),
    h('div', { class: 'pm-row' },
      h('button', { type: 'button', class: 'pm-linkbtn', onClick: async () => toast(await copyText(url) ? 'Link copied' : 'Could not copy. Press and hold the link to copy.', 'ok') }, 'Copy link'),
      h('a', { class: 'pm-linkbtn', href: url, target: '_blank', rel: 'noopener', style: 'text-align:right' }, 'Open ↗')));
}

// ------------------------------------------------------------------ EVENT EDITOR
let draft = null;
function nextSaturday() {
  const d = startOfDay(new Date());
  d.setDate(d.getDate() + (((6 - d.getDay()) + 7) % 7 || 7));
  return d;
}
function openEditor(ev) {
  if (ev) {
    const s = toDate(ev.start) || nextSaturday();
    const e = toDate(ev.end) || s;
    draft = {
      base: ev, name: ev.name || DEFAULT_NAME, day1: dateStr(s), day2: dateStr(e), open: timeStr(s),
      close: sameDay(s, e) || toDate(ev.end) ? timeStr(e) : '14:00', address: ev.address || '', markdowns: (ev.markdowns || []).slice(),
    };
  } else {
    const s = nextSaturday();
    draft = { base: null, name: DEFAULT_NAME, day1: dateStr(s), day2: dateStr(s), open: '08:00', close: '14:00', address: '', markdowns: [] };
  }
  go('edit');
}
function draftDays() {
  const a = fromLocal(draft.day1);
  let b = fromLocal(draft.day2 || draft.day1);
  if (!a) return [];
  if (!b || b < a) b = a;
  const out = [];
  for (let d = a; d <= b && out.length < 14; d = addDays(d, 1)) out.push(d);
  return out;
}
function viewEdit() {
  if (!draft) openEditor(st.ev);
  const f = draft;
  const inp = (key, attrs) => {
    const el = h('input', { ...attrs, value: f[key] });
    el.addEventListener('input', () => { f[key] = el.value; });
    el.addEventListener('change', () => { f[key] = el.value; if (key === 'day1' || key === 'day2') { if (key === 'day1' && (!f.day2 || f.day2 < f.day1)) f.day2 = f.day1; go('edit'); } });
    return el;
  };
  const addrEl = h('textarea', { rows: 2, placeholder: 'Street, city', style: 'min-height:80px' });
  addrEl.value = f.address;
  addrEl.addEventListener('input', () => { f.address = addrEl.value; });

  const days = draftDays();
  const mdList = h('div', null, f.markdowns.length
    ? f.markdowns.slice().sort((a, b) => (toDate(a.from) || 0) - (toDate(b.from) || 0)).map((m) => h('div', { class: 'pm-md' },
      h('span', null, markdownLine(m)),
      h('button', { type: 'button', class: 'pm-x', 'aria-label': 'Remove markdown', onClick: () => { f.markdowns = f.markdowns.filter((x) => x !== m); go('edit'); } }, '✕')))
    : h('p', { class: 'pm-mute' }, 'None. Optional: drop prices later in the sale, e.g. "Sunday noon → 50% off".'));

  const mdDay = h('select', { 'aria-label': 'Markdown day' }, days.map((d, i) => h('option', { value: dateStr(d), selected: i === days.length - 1 }, niceDay(d))));
  const mdTime = h('select', { 'aria-label': 'Markdown time' }, timeOptions(f.open, f.close).map((t) => h('option', { value: t, selected: t === '12:00' }, niceTime(t))));
  const mdPct = h('select', { 'aria-label': 'Discount' }, [10, 20, 25, 30, 40, 50, 60, 75].map((p) => h('option', { value: p, selected: p === 50 }, `${p}% off`)));
  const mdApplies = h('select', { 'aria-label': 'Applies to' },
    h('option', { value: 'labeled' }, 'labeled items'), h('option', { value: 'all' }, 'everything'));

  const save = BigButton('Save sale', () => saveDraft(save));
  return h('div', null,
    topBar(f.base ? 'Edit sale' : 'New sale'),
    h('label', { class: 'pm-field' }, h('span', null, 'Sale name'), inp('name', { type: 'text', placeholder: DEFAULT_NAME, autocomplete: 'off' })),
    h('div', { class: 'pm-row' },
      h('label', { class: 'pm-field' }, h('span', null, 'First day'), inp('day1', { type: 'date' })),
      h('label', { class: 'pm-field' }, h('span', null, 'Last day'), inp('day2', { type: 'date', min: f.day1 }))),
    h('div', { class: 'pm-row' },
      h('label', { class: 'pm-field' }, h('span', null, 'Opens at'), inp('open', { type: 'time', step: 900 })),
      h('label', { class: 'pm-field' }, h('span', null, 'Closes at'), inp('close', { type: 'time', step: 900 }))),
    h('p', { class: 'pm-mute' }, 'Same hours every day of the sale.'),
    h('label', { class: 'pm-field' }, h('span', null, 'Address'), addrEl),
    h('p', { class: 'pm-mute' }, 'The public page only shows the address starting 2 days before the sale.'),
    h('div', { class: 'pm-card' },
      h('h3', null, 'Markdown schedule'),
      mdList,
      h('div', { class: 'pm-row', style: 'margin-top:10px' }, mdDay, mdTime),
      h('div', { class: 'pm-row', style: 'margin-top:8px' }, mdPct, mdApplies),
      BigButton('Add markdown', () => {
        const at = fromLocal(mdDay.value, mdTime.value);
        if (!at) { toast('Pick a day and time first', 'error'); return; }
        f.markdowns.push({ from: at.toISOString(), pct: Number(mdPct.value), applies: mdApplies.value });
        go('edit');
      }, { variant: 'secondary' })),
    save,
    BigButton('Cancel', () => { draft = null; go('home'); }, { variant: 'secondary' }));
}
function timeOptions(open, close) {
  const out = [];
  const [oh] = String(open || '08:00').split(':').map(Number);
  const [ch] = String(close || '18:00').split(':').map(Number);
  const a = isFinite(oh) ? oh : 8;
  const b = isFinite(ch) && ch > a ? ch : 18;
  for (let hh = a; hh <= b; hh++) for (const mm of [0, 30]) {
    const t = `${pad2(hh)}:${pad2(mm)}`;
    if (hh === b && mm > 0) break;
    out.push(t);
  }
  if (!out.includes('12:00')) out.push('12:00');
  return out.sort();
}
async function saveDraft(btn) {
  const f = draft;
  const start = fromLocal(f.day1, f.open);
  const lastDay = f.day2 && f.day2 >= f.day1 ? f.day2 : f.day1;
  const end = fromLocal(lastDay, f.close);
  if (!start || !end) { toast('Pick the day and the hours', 'error'); return; }
  if (f.close <= f.open) { toast('Closing time has to be after opening time', 'error'); return; }
  const ev = {
    ...(f.base || {}),
    name: (f.name || '').trim() || DEFAULT_NAME,
    start: start.toISOString(),
    end: end.toISOString(),
    address: (f.address || '').trim(),
    markdowns: f.markdowns,
    promo_checklist: (f.base && f.base.promo_checklist) || {},
  };
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const d = await call('events.save', { event: eventPayload(ev) });
    const saved = normEvent((d && d.event) || d) || ev;
    upsertEvent(saved.event_id ? saved : { ...ev, ...saved });
    st.textsFor = null;
    st.collage = {};
    draft = null;
    toast('Sale saved', 'ok');
    go('home');
  } catch (e) {
    toast(errorMessage(e), 'error');
    btn.disabled = false;
    btn.textContent = 'Save sale';
  }
}

// ------------------------------------------------------------------ FEATURED
function selKey() { return `saleDeskPromo:featured:${(st.ev && st.ev.event_id) || 'none'}`; }
async function ensureCandidates() {
  if (!st.cand) {
    const d = await call('promo.featured', { n: 36 });
    const list = Array.isArray(d) ? d : (d && d.items) || [];
    st.cand = list.filter(isSafe);
  }
  if (!st.sel) {
    const ids = new Set(st.cand.map((i) => i.id));
    const saved = parseJson(lsGet(selKey()), null);
    if (saved && Array.isArray(saved.sel)) {
      st.sel = saved.sel.filter((id) => ids.has(id)).slice(0, MAX_FEATURED);
      st.removed = new Set((saved.removed || []).filter((id) => ids.has(id)));
    } else {
      st.sel = st.cand.slice(0, MAX_FEATURED).map((i) => i.id);
      st.removed = new Set();
    }
  }
}
function saveSel() {
  lsSet(selKey(), JSON.stringify({ sel: st.sel, removed: [...st.removed] }));
  st.collage = {};
}
function featuredItems() {
  const byId = new Map((st.cand || []).map((i) => [i.id, i]));
  return (st.sel || []).map((id) => byId.get(id)).filter(Boolean);
}
function removeFeatured(id) {
  st.sel = st.sel.filter((x) => x !== id);
  st.removed.add(id);
  const next = st.cand.find((i) => !st.sel.includes(i.id) && !st.removed.has(i.id));
  if (next) st.sel.push(next.id);
  saveSel();
  go('photos');
}
function addFeatured(id) {
  if (st.sel.length >= MAX_FEATURED) { toast('12 is the max. Tap a photo above to take one out first.', 'info'); return; }
  st.sel.push(id);
  st.removed.delete(id);
  saveSel();
  go('photos');
}
function itemTile(it, mark, onTap, idx) {
  const label = [it.brand, it.title].filter(Boolean).join(' · ') || 'Item';
  const price = priceOf(it);
  const fallback = () => h('div', { class: 'pm-tt' }, it.brand ? h('i', null, it.brand) : null, it.title || it.category || 'Item');
  let media;
  if (it.thumb_url) {
    media = h('img', { src: it.thumb_url, alt: label, loading: 'lazy', referrerpolicy: 'no-referrer' });
    media.addEventListener('error', () => media.replaceWith(fallback()), { once: true });
  } else media = fallback();
  return h('button', { type: 'button', class: 'pm-tile', 'aria-label': `${mark === '+' ? 'Add' : 'Remove'} ${label} ${price ? money(price) : ''}`, onClick: onTap },
    media,
    price ? h('span', { class: 'pm-price' }, money(price)) : null,
    h('span', { class: `pm-tx ${mark === '+' ? 'pm-tadd' : ''}` }, mark),
    idx != null ? h('span', { class: 'pm-num' }, `#${idx + 1}`) : null);
}
function viewPhotos() {
  const wrap = h('div', null, topBar('Featured photos'), loading('Finding your best items…'));
  ensureCandidates().then(() => {
    if (st.view !== 'photos') return;
    const items = featuredItems();
    const others = st.cand.filter((i) => !st.sel.includes(i.id));
    wrap.replaceChildren(h('div', null,
      topBar('Featured photos'),
      h('p', { class: 'pm-mute' }, `These go on the share image (first 9) in this order. Tap a photo to take it out; the next best item slides in. Only items marked OK for public posts show up here.`),
      h('div', { class: 'pm-card' },
        h('b', null, `Featured (${items.length}/${MAX_FEATURED})`),
        items.length
          ? h('div', { class: 'pm-grid', style: 'margin-top:10px' }, items.map((it, i) => itemTile(it, '✕', () => removeFeatured(it.id), i)))
          : h('p', { class: 'pm-mute' }, 'No public-safe priced items yet. Price a few nice pieces first.')),
      others.length
        ? BigButton(st.showOthers ? 'Hide other items' : `Show more (${others.length})`, () => { st.showOthers = !st.showOthers; go('photos'); }, { variant: 'secondary' })
        : null,
      st.showOthers && others.length
        ? h('div', { class: 'pm-card' }, h('b', null, 'Tap to add'), h('div', { class: 'pm-grid', style: 'margin-top:10px' }, others.map((it) => itemTile(it, '+', () => addFeatured(it.id)))))
        : null,
      BigButton('Make the share image', () => go('share'))));
  }).catch((e) => { if (st.view === 'photos') wrap.replaceChildren(topBar('Featured photos'), errBox(e, () => go('photos'))); });
  return wrap;
}

// ------------------------------------------------------------------ COLLAGE + SHARE
function collageKey(format) {
  const ev = st.ev || {};
  return JSON.stringify([format, st.sel, ev.start, ev.end, ev.markdowns]);
}
async function ensureCollage(format) {
  await ensureCandidates();
  const key = collageKey(format);
  const have = st.collage[format];
  if (have && have.key === key) return have;
  const canvas = await renderCollage({ event: st.ev, items: featuredItems(), format });
  const blob = await canvasToBlob(canvas);
  if (have && have.url) URL.revokeObjectURL(have.url);
  const entry = { key, blob, url: URL.createObjectURL(blob), w: canvas.width, h: canvas.height };
  st.collage[format] = entry;
  return entry;
}

function textKey(ch) { return `saleDeskPromo:text:${(st.ev && st.ev.event_id) || 'none'}:${ch}`; }
function baseText(ch) {
  const c = CHANNELS.find((x) => x.key === ch);
  let t = (st.texts && st.texts[ch]) || '';
  const url = previewUrl();
  if (c && c.link && t && !t.includes(url)) t = `${t.trim()}\n\nSee featured items: ${url}`;
  return t;
}
function currentText(ch) { return lsGet(textKey(ch)) ?? baseText(ch); }
async function ensureTexts() {
  if (st.textsFor === st.ev.event_id && st.texts) return;
  const d = await call('promo.texts', { event_id: st.ev.event_id });
  st.texts = d || {};
  st.textsFor = st.ev.event_id;
}
function isSaleDay(ev) {
  const s = toDate(ev.start);
  const e = toDate(ev.end) || s;
  if (!s) return false;
  const t = startOfDay(new Date());
  return t >= startOfDay(s) && t <= startOfDay(e);
}

function viewShare() {
  const ev = st.ev;
  if (!ev || !ev.event_id) {
    return h('div', null, topBar('Share posts'),
      h('div', { class: 'pm-card' }, h('p', null, 'Set up the sale first (date, hours, address).'), BigButton('Set up your sale', () => openEditor(null))));
  }
  const ch = CHANNELS.find((c) => c.key === st.channel) || CHANNELS[0];

  // image
  const imgBox = h('div', { class: 'pm-imgbox', style: `aspect-ratio:${FORMATS[st.format].w}/${FORMATS[st.format].h}` }, 'Building image…');
  const shareBtn = BigButton('Share image', () => shareImage(), { variant: 'secondary', disabled: true });
  const saveImgBtn = h('button', { type: 'button', class: 'pm-linkbtn', disabled: true, onClick: () => { const c = st.collage[st.format]; if (c) downloadBlob(c.blob, `sale-${st.format}.jpg`); } }, 'Save image');
  const fmtChips = h('div', { class: 'pm-chips' }, Object.entries(FORMATS).map(([k, f]) =>
    h('button', { type: 'button', class: 'pm-chip', 'aria-pressed': String(st.format === k), onClick: () => { st.format = k; go('share'); } }, f.label)));
  const fmt = st.format;
  ensureCollage(fmt).then((c) => {
    if (st.view !== 'share' || st.format !== fmt) return;
    imgBox.replaceChildren(h('img', { src: c.url, alt: 'Sale collage preview', class: 'pm-collage', 'data-format': fmt, width: c.w, height: c.h }));
    shareBtn.disabled = false;
    saveImgBtn.disabled = false;
  }).catch((e) => {
    console.warn('collage failed', e);
    imgBox.replaceChildren(h('div', { style: 'padding:24px;text-align:center' }, "Couldn't build the image. You can still copy the text."));
  });

  // text
  const ta = h('textarea', { 'aria-label': `${ch.label} post text`, spellcheck: 'true' });
  ta.value = 'Loading draft…';
  ta.disabled = true;
  ta.addEventListener('input', () => lsSet(textKey(ch.key), ta.value));
  ensureTexts().then(() => {
    if (st.view !== 'share') return;
    ta.value = currentText(ch.key);
    ta.disabled = false;
  }).catch((e) => { ta.value = ''; ta.disabled = false; toast(errorMessage(e), 'error'); });

  const copyBtn = BigButton('Copy text', async () => {
    const ok = await copyText(ta.value);
    toast(ok ? 'Text copied. Paste it into your post.' : 'Could not copy. Press and hold in the box → Select All → Copy.', ok ? 'ok' : 'error');
  });

  async function shareImage() {
    const c = st.collage[st.format];
    if (!c) return;
    const text = ta.value;
    copyText(text); // so paste works even if the target app drops the caption
    let file = null;
    try { file = new File([c.blob], 'sale.jpg', { type: 'image/jpeg' }); } catch { file = null; }
    const payload = file ? { files: [file], text } : null;
    if (payload && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share(payload); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    downloadBlob(c.blob, 'sale.jpg');
    toast('Image saved. Add it from Photos or Downloads, then paste the text.', 'info');
  }

  return h('div', null,
    topBar('Share posts'),
    h('div', { class: 'pm-chips', role: 'tablist' }, CHANNELS.map((c) =>
      h('button', { type: 'button', class: 'pm-chip', role: 'tab', 'aria-pressed': String(c.key === ch.key), onClick: () => { st.channel = c.key; go('share'); } }, c.label))),
    h('p', { class: 'pm-mute' }, ch.hint),
    h('div', { class: 'pm-card' },
      h('b', null, `${ch.label} text`),
      isSaleDay(ev) ? h('button', { type: 'button', class: 'pm-linkbtn', onClick: () => { if (!/^HAPPENING NOW/i.test(ta.value)) { ta.value = `HAPPENING NOW! Come on by.\n\n${ta.value}`; lsSet(textKey(ch.key), ta.value); } } }, 'Add "Happening now"') : null,
      ta,
      copyBtn,
      h('div', { class: 'pm-row' },
        h('button', { type: 'button', class: 'pm-linkbtn', onClick: () => { lsSet(textKey(ch.key), null); ta.value = baseText(ch.key); toast('Back to the original draft', 'info'); } }, 'Reset text'),
        h('a', { class: 'pm-linkbtn', href: ch.open, target: '_blank', rel: 'noopener', style: 'text-align:right' }, `${ch.openLabel} ↗`))),
    h('div', { class: 'pm-card' },
      h('b', null, 'Image'),
      fmtChips,
      imgBox,
      shareBtn,
      h('div', { class: 'pm-row' },
        saveImgBtn,
        h('button', { type: 'button', class: 'pm-linkbtn', style: 'text-align:right', onClick: () => go('photos') }, 'Change photos')),
      h('ol', { class: 'pm-steps' }, h('li', null, 'Copy text'), h('li', null, 'Share image → pick the app'), h('li', null, 'Paste the text into the post'))),
    publicLinkCard());
}

// ------------------------------------------------------------------ SIGNS & FLYERS
function arrowSvg(dir) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 60');
  svg.setAttribute('class', 'ps-arrow');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'polygon');
  p.setAttribute('points', '0,17 58,17 58,0 100,30 58,60 58,43 0,43');
  p.setAttribute('fill', '#000');
  if (dir === 'left') p.setAttribute('transform', 'translate(100,0) scale(-1,1)');
  svg.appendChild(p);
  return svg;
}
function qrBlock(url, caption) {
  const svg = qrSvg(url);
  return [svg || h('div', { class: 'ps-url' }, url), h('div', null, caption)];
}
export function signPage(ev, dir) {
  const when = eventWhen(ev);
  return h('div', { class: 'promo-page land', 'data-sign': dir },
    h('div', { class: 'ps-top' }, HEADLINE),
    h('div', { class: `ps-mid ${dir}` }, h('div', { class: 'ps-sale' }, 'SALE'), arrowSvg(dir)),
    h('div', { class: 'ps-bot' },
      h('div', { class: 'ps-when' }, h('div', null, when.days), when.hours ? h('div', null, when.hours) : null),
      h('div', { class: 'ps-qr' }, qrBlock(previewUrl(), 'Scan for photos'))));
}
function flyerHalf(ev, withAddr) {
  const when = eventWhen(ev);
  const name = (ev.name || '').trim();
  const showName = name && name.toLowerCase() !== HEADLINE.toLowerCase();
  return h('div', { class: 'pf' },
    h('div', { class: 'pf-head' }, HEADLINE),
    showName ? h('div', { class: 'pf-name' }, name) : null,
    h('div', { class: 'pf-body' },
      h('div', { class: 'pf-left' },
        h('div', { class: 'pf-when' }, when.days),
        when.hours ? h('div', { class: 'pf-hours' }, when.hours) : null,
        h('div', { class: 'pf-addr' }, withAddr && ev.address ? ev.address : 'Address posted 2 days before the sale. Scan the code.'),
        h('ul', { class: 'pf-pts' }, FOOTER.split(' · ').map((t) => h('li', null, t))),
        (ev.markdowns || []).slice(0, 3).map((m) => h('div', { class: 'pf-md' }, markdownLine(m)))),
      h('div', { class: 'pf-right' }, qrBlock(previewUrl(), 'Scan to see featured items'))));
}
export function flyerPage(ev, withAddr) {
  return h('div', { class: 'promo-page port', 'data-sign': 'flyer' }, flyerHalf(ev, withAddr), flyerHalf(ev, withAddr));
}
function fitPreview(wrapEl) {
  const page = wrapEl.firstElementChild;
  if (!page) return;
  page.style.zoom = '';
  const avail = wrapEl.clientWidth - 16;
  const natural = page.offsetWidth;
  if (avail > 0 && natural > 0) page.style.zoom = String(avail / natural);
}
export function printPages(pages, orientation) {
  const old = document.getElementById('promo-print-root');
  if (old) old.remove();
  const oldCss = document.getElementById('promo-print-page');
  if (oldCss) oldCss.remove();
  injectCss();
  const css = h('style', { id: 'promo-print-page' }, `@page{size:letter ${orientation};margin:.25in}`);
  const root = h('div', { id: 'promo-print-root' }, pages);
  document.head.appendChild(css);
  document.body.appendChild(root);
  document.documentElement.classList.add('promo-printing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.documentElement.classList.remove('promo-printing');
    root.remove();
    css.remove();
    window.removeEventListener('afterprint', finish);
  };
  window.addEventListener('afterprint', finish);
  setTimeout(finish, 5 * 60 * 1000);
  try { window.print(); } catch { finish(); }
}
function viewSigns() {
  const ev = st.ev;
  if (!ev) return h('div', null, topBar('Signs & flyers'), h('div', { class: 'pm-card' }, BigButton('Set up your sale', () => openEditor(null))));
  const wrap = h('div', { class: 'pm-pagewrap' });
  const v = st.signVariant;
  const build = () => (v === 'flyer' ? flyerPage(ev, st.flyerAddr) : signPage(ev, v));
  const paint = () => {
    wrap.replaceChildren(build());
    requestAnimationFrame(() => fitPreview(wrap));
  };
  paint();
  loadQr().then(() => { if (st.view === 'signs') paint(); }).catch(() => toast('QR code library did not load. Signs show the link instead.', 'info'));

  const chips = h('div', { class: 'pm-chips', style: 'grid-template-columns:1fr 1fr 1fr' },
    [['right', 'SALE →'], ['left', '← SALE'], ['flyer', 'Flyer']].map(([k, label]) =>
      h('button', { type: 'button', class: 'pm-chip', 'aria-pressed': String(v === k), onClick: () => { st.signVariant = k; go('signs'); } }, label)));

  let addrToggle = null;
  if (v === 'flyer' && ev.address) {
    const cb = h('input', { type: 'checkbox', checked: st.flyerAddr });
    cb.addEventListener('change', () => { st.flyerAddr = cb.checked; paint(); });
    addrToggle = h('label', { class: 'pm-toggle' }, cb, 'Print the address on the flyer');
  }
  const doPrint = (pages, orient) => loadQr().catch(() => null).then(() => printPages(pages(), orient));
  return h('div', null,
    topBar('Signs & flyers'),
    h('p', { class: 'pm-mute' }, 'Letter paper, any home printer. Arrow signs print sideways (landscape); the flyer prints 2 per page, cut on the dashed line.'),
    chips,
    addrToggle,
    wrap,
    v === 'flyer'
      ? BigButton('Print flyers', () => doPrint(() => [flyerPage(ev, st.flyerAddr)], 'portrait'))
      : BigButton(`Print this sign (${v === 'right' ? 'SALE →' : '← SALE'})`, () => doPrint(() => [signPage(ev, v)], 'landscape')),
    v !== 'flyer' ? BigButton('Print both arrows (2 pages)', () => doPrint(() => [signPage(ev, 'right'), signPage(ev, 'left')], 'landscape'), { variant: 'secondary' }) : null);
}

// ------------------------------------------------------------------ CHECKLIST
function viewChecklist() {
  const ev = st.ev;
  if (!ev) return h('div', null, topBar('Promo checklist'), h('div', { class: 'pm-card' }, BigButton('Set up your sale', () => openEditor(null))));
  const box = h('div', { class: 'pm-card' });
  const paint = () => {
    const steps = checklistSteps(ev);
    const focus = focusStep(ev);
    box.replaceChildren(...steps.map((s) => {
      const cb = h('input', { type: 'checkbox', checked: s.done, 'aria-label': s.title });
      cb.addEventListener('change', () => toggleStep(s.key, cb.checked, () => { if (st.view === 'checklist') paint(); }));
      return h('label', { class: `pm-check ${s.done ? 'is-done' : ''} ${focus && focus.key === s.key ? 'pm-focus' : ''}`, 'data-step': s.key },
        cb,
        h('span', null,
          h('b', null, s.title),
          h('span', { class: 'pm-mute' }, `${s.when}${s.due ? ` · ${niceDay(s.due)}` : ''} `),
          statusPill(s)));
    }));
  };
  paint();
  const focus = focusStep(ev);
  return h('div', null,
    topBar('Promo checklist'),
    h('p', { class: 'pm-mute' }, `${ev.name || DEFAULT_NAME} · ${eventWhen(ev).line}`),
    focus && focus.status !== 'upcoming'
      ? h('div', { class: 'pm-card pm-due' }, h('b', null, focus.status === 'today' ? 'Due today: ' : 'Catch up: '), focus.title)
      : saleOver(ev) ? h('div', { class: 'pm-card' }, 'This sale is over.') : null,
    box,
    h('p', { class: 'pm-mute' }, 'Check-offs are saved to the sale, so everyone sees the same list.'),
    BigButton('Share posts', () => go('share')),
    BigButton('Signs & flyers', () => go('signs'), { variant: 'secondary' }));
}

const VIEWS = {
  home: viewHome,
  edit: viewEdit,
  photos: viewPhotos,
  share: viewShare,
  signs: viewSigns,
  checklist: viewChecklist,
};

// Debug/test hook (no side effects): lets QA open a view directly.
export const _promoDebug = { st, go };
