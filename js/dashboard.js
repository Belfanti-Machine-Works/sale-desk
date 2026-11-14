// dashboard.js — Dashboard tab: live sale numbers, cash drawer count, end-of-event reports, rack signs.
// Owner: labels+checkout agent.

import { call } from './api.js';
import { session, can, on } from './state.js';
import { h, BigButton, toast, keypad, sheet, money, errorMessage } from './ui.js';
import { printReport, printTierSigns } from './labels.js';
import { currentEvent } from './checkout.js';

const FLOAT_KEY = 'sdDrawerFloat';
const REFRESH_MS = 30000;

const el = (tag, attrs, ...kids) => h(tag, attrs || {}, ...kids.flat(Infinity).filter(k => k != null && k !== false && k !== ''));
const num = v => Number(v) || 0;
const priceOf = i => num(i.final_price) || num(i.ai_price);
const soldOf = i => num(i.sold_price) || priceOf(i);
const r2 = n => Math.round(num(n) * 100) / 100;
function role() { return (session && session.role) || ''; }
function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } }
function errMsg(e) { try { return errorMessage(e); } catch (_) { return 'Something went wrong. Try again.'; } }
const METHOD_NAMES = { cash: 'Cash', venmo: 'Venmo', zelle_apple: 'Zelle / Apple Cash' };

// ------------------------------------------------------------------ CSS
const CSS = `
.db-root{--db-ink:var(--ink,#111);--db-mute:var(--ink-2,#4a4a4a);--db-line:var(--line,#d4d6da);--db-ok:var(--ok,#0a7d2c);
  --db-bad:var(--bad,#b00020);font-size:var(--fs-body,18px);color:var(--db-ink);max-width:100%;overflow-x:clip}
.db-root *{box-sizing:border-box}
.db-root .db-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0 6px}
.db-root .db-head h2{margin:0;font-size:24px}
.db-root .db-small{min-height:48px;padding:0 14px;border-radius:12px;border:2px solid var(--db-line);background:#fff;font-size:17px;font-weight:700;color:var(--db-ink)}
.db-root select{width:100%;min-height:52px;font-size:18px;border:2px solid var(--db-line);border-radius:12px;padding:0 10px;background:#fff;margin:0 0 8px;color:var(--db-ink)}
.db-root .db-upd{font-size:15px;color:var(--db-mute);margin:0 0 10px}
.db-root .db-card{border:2px solid var(--db-line);border-radius:16px;padding:14px;margin:0 0 12px;background:#fff}
.db-root .db-card h3{margin:0 0 8px;font-size:20px}
.db-root .db-hero{text-align:center;border-color:var(--db-ink);border-width:3px}
.db-root .db-hero .db-k{font-size:18px;font-weight:700;color:var(--db-mute)}
.db-root .db-hero .db-v{font-size:var(--fs-price,56px);font-weight:900;line-height:1.05}
.db-root .db-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 12px}
.db-root .db-tile{border:2px solid var(--db-line);border-radius:14px;padding:10px;background:#fff;min-width:0}
.db-root .db-tile .db-v{font-size:32px;font-weight:900;line-height:1.1;overflow-wrap:anywhere}
.db-root .db-tile .db-k{font-size:15px;color:var(--db-mute);font-weight:600}
.db-root .db-rows{list-style:none;margin:0;padding:0}
.db-root .db-rows li{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--db-line);font-size:19px}
.db-root .db-rows li:last-child{border-bottom:0}
.db-root .db-rows b{white-space:nowrap}
.db-root .db-drawer-res{text-align:center;border-radius:16px;padding:12px;margin-top:8px}
.db-root .db-drawer-res.ok{background:#e7f6ec;border:3px solid var(--db-ok);color:var(--db-ok)}
.db-root .db-drawer-res.bad{background:#fde8eb;border:3px solid var(--db-bad);color:var(--db-bad)}
.db-root .db-drawer-res .db-v{font-size:var(--fs-price,56px);font-weight:900;line-height:1.05}
.db-root .db-drawer-res .db-k{font-size:22px;font-weight:800}
.db-root .db-btns{display:flex;flex-direction:column;gap:8px;margin:4px 0 12px}
.db-root .db-two{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.db-root .db-back{min-height:52px;padding:0 14px;border-radius:12px;border:2px solid var(--db-line);background:#fff;font-size:18px;font-weight:700;margin:0 0 10px;color:var(--db-ink)}
.db-root .db-table{width:100%;border-collapse:collapse;font-size:16px;table-layout:fixed}
.db-root .db-table td{padding:6px 2px;border-bottom:1px solid var(--db-line);vertical-align:top;overflow-wrap:anywhere}
.db-root .db-table td.n{text-align:right;width:80px;white-space:nowrap;font-weight:700}
.db-root .db-thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
.db-root .db-thumbs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--db-line)}
.db-root .db-more{font-size:15px;color:var(--db-mute);margin:6px 0 0}
.db-root .db-err{color:var(--db-bad);font-weight:700}
`;
function injectCss() {
  if (document.getElementById('sd-dashboard-css')) return;
  const s = document.createElement('style');
  s.id = 'sd-dashboard-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ helpers
/** by_cashier / by_pricer may be {name: n} or [{name, total|count}] — normalize to [[name, value]]. */
function pairs(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.map(o => [o.name || o.cashier || o.pricer || '?', o.total ?? o.count ?? o.value ?? 0]);
  if (typeof x === 'object') return Object.entries(x).map(([k, v]) => [k, v && typeof v === 'object' ? (v.total ?? v.count ?? 0) : v]);
  return [];
}
function sumTierQty(x) { return pairs(x).reduce((a, [, v]) => a + num(v), 0); }
function itemLine(i) { return [i.brand, i.title, i.size].filter(Boolean).join(' · ') || i.id; }

async function shareText(title, text) {
  try {
    if (navigator.share) { await navigator.share({ title, text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it into a text or email.', 'ok');
    return;
  } catch (_) { /* fall through */ }
  let s = null;
  const ta = h('textarea', { style: { width: '100%', height: '50vh', fontSize: '15px' }, readonly: true }, text);
  s = sheet(h('div', {}, h('p', {}, 'Select all and copy:'), ta, BigButton('Close', () => s.close(), { variant: 'secondary' })));
}

// ------------------------------------------------------------------ controller
let current = null;

function mount(container) {
  injectCss();
  if (current) current.destroy();
  const ctl = { destroyed: false };
  current = ctl;

  const root = el('div', { class: 'db-root' });
  container.replaceChildren(root);

  let view = 'main';     // main | drawer | report
  let events = [];
  let eventId = null;    // '' = all events
  let data = null, updated = null, loading = false, lastErr = null;
  let counted = null;    // cents
  let report = null, reportErr = null;

  // ---------- data
  async function refresh() {
    if (loading || ctl.destroyed) return;
    loading = true;
    try {
      data = await call('dashboard', eventId ? { event_id: eventId } : {});
      updated = new Date();
      lastErr = null;
    } catch (e) { lastErr = e; }
    loading = false;
    if (!ctl.destroyed && view !== 'report') paint();
  }
  async function loadEvents() {
    try { const r = await call('events.list'); events = (r && (r.events || r)) || []; if (!Array.isArray(events)) events = []; } catch (_) { events = []; }
    if (eventId == null) { const ev = currentEvent(events); eventId = ev ? ev.event_id : ''; }
  }

  // ---------- views
  function paint() {
    if (ctl.destroyed) return;
    if (view === 'drawer') root.replaceChildren(drawerView());
    else if (view === 'report') root.replaceChildren(reportView());
    else root.replaceChildren(mainView());
  }

  function mainView() {
    const d = data;
    const head = el('div', { class: 'db-head' }, el('h2', {}, 'Dashboard'),
      el('button', { type: 'button', class: 'db-small', onclick: () => { refresh(); toast('Updating…'); } }, 'Refresh'));
    const sel = events.length ? el('select', { 'aria-label': 'Which sale', onchange: e => { eventId = e.target.value; data = null; paint(); refresh(); } },
      events.map(ev => el('option', { value: ev.event_id, selected: ev.event_id === eventId }, ev.name || ev.event_id)),
      el('option', { value: '', selected: eventId === '' }, 'All sales (every event)')) : null;
    const upd = el('p', { class: 'db-upd' }, lastErr ? el('span', { class: 'db-err' }, errMsg(lastErr)) :
      updated ? 'Updated ' + updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' · refreshes every 30 s' : 'Loading…');
    if (!d) return el('div', {}, head, sel, upd);

    const by = d.revenue_by_method || {};
    const methods = ['cash', 'venmo', 'zelle_apple'].concat(Object.keys(by).filter(k => !METHOD_NAMES[k]));
    const tierSold = sumTierQty(d.tier_qty_sold);
    const r = role();

    return el('div', {}, head, sel, upd,
      el('div', { class: 'db-card db-hero' }, el('div', { class: 'db-k' }, 'Total sales'), el('div', { class: 'db-v', 'data-k': 'total' }, money(num(d.total)))),
      el('div', { class: 'db-card' }, el('h3', {}, 'By payment'),
        el('ul', { class: 'db-rows' }, methods.map(m => el('li', {}, el('span', {}, METHOD_NAMES[m] || m), el('b', { 'data-k': 'm-' + m }, money(num(by[m] || 0))))))),
      el('div', { class: 'db-grid' },
        tile('Sales', num(d.sales_count), 'sales_count'),
        tile('Labeled items sold', num(d.items_sold), 'items_sold'),
        tile('Rack/bag pieces sold', tierSold, 'tier_qty'),
        tile('Items left', num(d.remaining_count), 'remaining_count'),
        tile('Value left', money(num(d.remaining_value)), 'remaining_value', true)),
      el('div', { class: 'db-btns' },
        BigButton('Count the cash drawer', () => { view = 'drawer'; paint(); }, { variant: 'primary' })),
      listCard('Sales by cashier', pairs(d.by_cashier), v => money(num(v))),
      listCard('Items priced by person', pairs(d.by_pricer), v => String(num(v))),
      el('div', { class: 'db-btns' },
        r === 'admin' || can('reports.endOfEvent') ? BigButton('End-of-sale report', () => { view = 'report'; report = null; reportErr = null; paint(); loadReport(); }, { variant: 'secondary' }) : null,
        r === 'admin' || r === 'pricer' ? BigButton('Print rack signs', rackSigns, { variant: 'secondary' }) : null));
  }

  function tile(k, v, key, wide) {
    return el('div', { class: 'db-tile', style: wide ? { gridColumn: '1 / -1' } : null },
      el('div', { class: 'db-v', 'data-k': key }, String(v)), el('div', { class: 'db-k' }, k));
  }
  function listCard(title, rows, fmt) {
    rows = rows.slice().sort((a, b) => num(b[1]) - num(a[1]));
    return el('div', { class: 'db-card' }, el('h3', {}, title),
      rows.length ? el('ul', { class: 'db-rows' }, rows.map(([n, v]) => el('li', {}, el('span', {}, n), el('b', {}, fmt(v)))))
        : el('p', { class: 'db-more' }, 'Nothing yet.'));
  }

  async function rackSigns() {
    try {
      const r = await call('tiers.list');
      const tiers = (r && (r.tiers || r)) || [];
      await printTierSigns(tiers);
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  // ---------- cash drawer
  function drawerView() {
    const d = data || {};
    const float = Math.round(num(load(FLOAT_KEY, 0)) * 100);
    const expected = float + Math.round(num(d.cash_expected) * 100);
    let res = null;
    if (counted != null) {
      const diff = counted - expected;
      res = el('div', { class: 'db-drawer-res ' + (diff === 0 ? 'ok' : 'bad') },
        el('div', { class: 'db-k' }, diff === 0 ? 'Exactly right' : diff > 0 ? 'OVER by' : 'SHORT by'),
        diff === 0 ? el('div', { class: 'db-v' }, '✓') : el('div', { class: 'db-v', 'data-k': 'diff' }, money(Math.abs(diff) / 100)),
        el('div', {}, 'Counted ' + money(counted / 100) + ' · should be ' + money(expected / 100)));
    }
    return el('div', {},
      el('button', { type: 'button', class: 'db-back', onclick: () => { view = 'main'; paint(); } }, '← Back'),
      el('div', { class: 'db-card' }, el('h3', {}, 'Count the cash drawer'),
        el('ul', { class: 'db-rows' },
          el('li', {}, el('span', {}, 'Starting cash (change float)'), el('b', {}, money(float / 100))),
          el('li', {}, el('span', {}, 'Cash sales'), el('b', { 'data-k': 'cash_expected' }, money(num(d.cash_expected)))),
          el('li', {}, el('span', {}, 'Should be in the drawer'), el('b', { 'data-k': 'expected' }, money(expected / 100)))),
        el('div', { class: 'db-two' },
          BigButton('Set starting cash', async () => {
            const n = await keypad({ title: 'Cash in the drawer at the start', value: float / 100 });
            if (n == null) return;
            save(FLOAT_KEY, n); paint();
          }, { variant: 'secondary' }),
          BigButton('Refresh', () => refresh().then(() => paint()), { variant: 'secondary' }))),
      BigButton(counted == null ? 'Enter cash counted' : 'Count again', async () => {
        const n = await keypad({ title: 'Total cash you counted', value: null });
        if (n == null) return;
        counted = Math.round(n * 100); paint();
      }, { variant: 'primary' }),
      res);
  }

  // ---------- end-of-event report (admin)
  async function loadReport() {
    try {
      report = await call('reports.endOfEvent', eventId ? { event_id: eventId } : {});
    } catch (e) { reportErr = e; }
    if (!ctl.destroyed && view === 'report') paint();
  }

  function reportView() {
    const back = el('button', { type: 'button', class: 'db-back', onclick: () => { view = 'main'; paint(); } }, '← Back');
    const evName = (events.find(e => e.event_id === eventId) || {}).name || 'All sales';
    if (reportErr) return el('div', {}, back, el('p', { class: 'db-err' }, errMsg(reportErr)));
    if (!report) return el('div', {}, back, el('p', {}, 'Building the report…'));
    const R = buildReports(report, evName);
    return el('div', {}, back,
      el('h2', { style: { margin: '0 0 10px', fontSize: '24px' } }, 'End-of-sale report'),
      el('p', { class: 'db-upd' }, evName),
      R.map(sec => el('div', { class: 'db-card' }, el('h3', {}, sec.title), sec.screen(),
        el('div', { class: 'db-two' },
          BigButton('Print', () => printReport(sec.print()), { variant: 'secondary' }),
          BigButton('Share as text', () => shareText(sec.title, sec.text()), { variant: 'secondary' })))));
  }

  // ---------- lifecycle (§9 has no unmount hook)
  const offSale = on('sale:done', () => refresh());
  const onVis = () => { if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', onVis);
  const timer = setInterval(() => {
    if (!root.isConnected) { ctl.destroy(); return; }
    if (!document.hidden && view !== 'report') refresh();
  }, REFRESH_MS);
  const watch = setInterval(() => { if (!root.isConnected) ctl.destroy(); }, 1000);
  ctl.destroy = () => {
    if (ctl.destroyed) return;
    ctl.destroyed = true;
    clearInterval(timer); clearInterval(watch);
    document.removeEventListener('visibilitychange', onVis);
    if (typeof offSale === 'function') offSale();
    if (current === ctl) current = null;
  };

  paint();
  loadEvents().then(() => { paint(); refresh(); });
  return ctl;
}

// ------------------------------------------------------------------ report sections (screen + print + text)
export function buildReports(rep, evName) {
  const sold = Array.isArray(rep.sold) ? rep.sold : [];
  const soldVal = r2(sold.reduce((a, i) => a + soldOf(i), 0));
  const uns = rep.unsold_summary || {};
  const cats = Object.entries(uns.by_category || {}).sort((a, b) => num(b[1].value) - num(a[1].value));
  const don = Array.isArray(rep.donation_manifest) ? rep.donation_manifest : [];
  const donVal = r2(don.reduce((a, i) => a + num(i.value), 0));
  const bulk = rep.bulk_lot || {};
  const top = Array.isArray(bulk.top_items) ? bulk.top_items : [];
  const dateStr = new Date().toLocaleDateString();
  const P = (title, ...kids) => h('div', {}, h('h1', {}, title), h('p', {}, evName + ' · ' + dateStr), ...kids);
  const table = (head, rows, numCols = []) => h('table', {},
    h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: numCols.includes(i) ? 'num' : '' }, t)))),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'num' : '' }, c))))));
  const screenList = (rows, n = 8) => el('div', {},
    el('table', { class: 'db-table' }, el('tbody', {}, rows.slice(0, n).map(([a, b]) => el('tr', {}, el('td', {}, a), el('td', { class: 'n' }, b))))),
    rows.length > n ? el('p', { class: 'db-more' }, 'and ' + (rows.length - n) + ' more (in Print / Share)') : null);

  return [
    {
      title: 'Sold vs. unsold',
      screen: () => el('div', {},
        el('ul', { class: 'db-rows' },
          el('li', {}, el('span', {}, 'Labeled items sold'), el('b', {}, sold.length + ' · ' + money(soldVal))),
          el('li', {}, el('span', {}, 'Items not sold'), el('b', {}, num(uns.count) + ' · ' + money(num(uns.value))))),
        cats.length ? screenList(cats.map(([c, v]) => [c + ' (' + num(v.count) + ')', money(num(v.value))]), 6) : null),
      print: () => P('Sold vs. unsold',
        h('p', {}, `Sold: ${sold.length} labeled items, ${money(soldVal)}. Not sold: ${num(uns.count)} items, ${money(num(uns.value))} at sticker price.`),
        h('h2', {}, 'Unsold by category'),
        table(['Category', 'Items', 'Value'], cats.map(([c, v]) => [c, String(num(v.count)), money(num(v.value))]), [1, 2]),
        h('h2', {}, 'Sold items'),
        table(['ID', 'Item', 'Sold for'], sold.map(i => [i.id, itemLine(i), money(soldOf(i))]), [2])),
      text: () => [`Sold vs. unsold: ${evName} (${dateStr})`,
        `Sold: ${sold.length} labeled items, ${money(soldVal)}`,
        `Not sold: ${num(uns.count)} items, ${money(num(uns.value))} at sticker price`, '',
        'Unsold by category:', ...cats.map(([c, v]) => `- ${c}: ${num(v.count)} items, ${money(num(v.value))}`)].join('\n'),
    },
    {
      title: 'Donation manifest',
      screen: () => el('div', {},
        el('p', { style: { margin: '0 0 6px' } }, el('b', {}, don.length + ' items · ' + money(donVal)), ' (sticker value)'),
        screenList(don.map(i => [i.id + ' ' + itemLine(i), money(num(i.value))]), 6)),
      print: () => P('Donation manifest',
        h('p', {}, `${don.length} items, total sticker value ${money(donVal)}.`),
        table(['ID', 'Item', 'Category', 'Condition', 'Value'],
          don.map(i => [i.id, itemLine(i), i.category || '', String(i.condition || '').replace('_', ' '), money(num(i.value))]), [4]),
        h('p', { style: { marginTop: '18pt' } }, 'Received by: ______________________   Date: __________')),
      text: () => [`Donation manifest: ${evName} (${dateStr})`, `${don.length} items, sticker value ${money(donVal)}`, '',
        ...don.map(i => `${i.id}  ${itemLine(i)}  ${i.condition ? '(' + String(i.condition).replace('_', ' ') + ') ' : ''}${money(num(i.value))}`)].join('\n'),
    },
    {
      title: 'Bulk-lot summary',
      screen: () => el('div', {},
        el('ul', { class: 'db-rows' },
          el('li', {}, el('span', {}, 'Items in the lot'), el('b', {}, String(num(bulk.count)))),
          el('li', {}, el('span', {}, 'Estimated lot value'), el('b', {}, money(num(bulk.est_value))))),
        top.length ? el('div', { class: 'db-thumbs' }, top.slice(0, 8).map(i => i.thumb_url ? el('img', { src: i.thumb_url, alt: itemLine(i), loading: 'lazy' }) : null)) : null,
        screenList(top.map(i => [itemLine(i), money(priceOf(i))]), 5)),
      print: () => P('Bulk-lot summary',
        h('p', {}, `${num(bulk.count)} items. Estimated lot value ${money(num(bulk.est_value))}.`),
        h('h2', {}, 'Top items'),
        table(['', 'ID', 'Item', 'Price'], top.map(i => [i.thumb_url ? h('img', { src: i.thumb_url, alt: '' }) : '', i.id, itemLine(i), money(priceOf(i))]), [3])),
      text: () => [`Bulk lot: ${evName} (${dateStr})`, `${num(bulk.count)} items, estimated lot value ${money(num(bulk.est_value))}`, '',
        'Top items:', ...top.map(i => `- ${itemLine(i)}: ${money(priceOf(i))}`)].join('\n'),
    },
  ];
}

// ------------------------------------------------------------------ tab export (§9)
export const tabs = [{
  id: 'dashboard',
  label: 'Dashboard',
  icon: '📊',
  roles: ['admin', 'pricer', 'helper'],
  render(container /* , ctx */) { mount(container); },
  onHide() { if (current) current.destroy(); },
}];
