// Sale Desk in-memory fake backend (CONTRACT §9). Used when ?mock=1.
// handle(action, params) -> Promise<{ok:true,data}|{ok:false,error:{code,message,...}}>
// i.e. exactly the backend's JSON envelope; api.js unwraps it.
//
// PINs: 1111 = admin, 2222 = pricer, 3333 = helper (any other PIN -> AUTH "Wrong PIN").
// State persists in sessionStorage. Dev switches (query string):
//   ?mockreset=1  re-seed the fake data      ?mockfresh=1  empty, un-set-up backend (tests setup.init)
//   localStorage.saleDeskMockFast = '1'      skip the artificial delays
// item.create routes cycle bin -> label -> research; pass hint:'bin'|'label'|'research'
// (and/or 'unreadable' for a label the AI couldn't read) to force one.

const DB_KEY = 'saleDeskMockDb';
const DEFAULT_RULES = {
  used_pct: [0.25, 0.35], nwt_pct: [0.40, 0.50], pick: 'mid',
  round: [{ lt: 10, to: 1 }, { lt: 50, to: 5 }, { lt: 100000, to: 10 }],
  bin_below: 10, tiers: [{ max: 1.99, tier: 'T1' }, { max: 3.99, tier: 'T3' }, { max: 9.99, tier: 'T5' }],
  research_at: 10, premium_at: 75, min_price: 1, stage2_mode: 'search',
};
const ROLES = { helper: 1, pricer: 2, admin: 3 };
const HELPER = ['scan', 'checkout', 'sales.list', 'dashboard', 'tiers.list', 'events.list', 'settings.get'];
const PRICER_EXTRA = ['voidSale', 'item.', 'review.', 'inventory.', 'tiers.count', 'promo.', 'events.save'];
const PUBLIC_SETTINGS = ['venmo_handle', 'zelle_handle', 'venmo_qr_url', 'label_mode', 'users'];
const ADMIN_ONLY = ['settings.save', 'setup.', 'item.delete', 'reports.'];
const OPEN_STATUSES = ['new', 'researching', 'review', 'priced', 'labeled'];

// ------------------------------------------------------------ helpers
const now = () => new Date().toISOString();
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const pad = (n, w) => String(n).padStart(w, '0');
class Fail { constructor(code, message, extra) { this.code = code; this.message = message; Object.assign(this, extra || {}); } }
const fail = (code, message, extra) => { throw new Fail(code, message, extra); };
const pctOf = (p) => (Number(p) || 0) / 100; // §5b: percents are whole numbers everywhere

function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  const step = Math.max(1, Math.floor(str.length / 4000));
  for (let i = 0; i < str.length; i += step) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function svgThumb(text, hue) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>` +
    `<rect width='240' height='240' fill='hsl(${hue},55%,86%)'/>` +
    `<path d='M70 58 L102 42 Q120 60 138 42 L170 58 L198 96 L170 112 L166 196 L74 196 L70 112 L42 96 Z' fill='hsl(${hue},50%,42%)'/>` +
    `<text x='120' y='226' font-size='19' text-anchor='middle' font-family='Arial,sans-serif' fill='%23222'>${text}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/'/g, '%27').replace(/ /g, '%20');
}

// ------------------------------------------------------------ rules (mirror of §6, for realistic numbers)
function roundPrice(x, rules) {
  const band = rules.round.find((r) => x < r.lt) || rules.round[rules.round.length - 1] || { to: 1 };
  const step = Number(band.to) || 1;
  return Math.max(rules.min_price, Math.round(Math.round(x / step + 1e-9) * step * 100) / 100);
}
function pick(range, how) {
  if (how === 'low') return range[0];
  if (how === 'high') return range[1];
  if (typeof how === 'number') return range[0] + (range[1] - range[0]) * Math.min(1, Math.max(0, how));
  return (range[0] + range[1]) / 2;
}
// Mirrors backend/Rules.js applyRules(ai, comps, rules).
function applyRules(ai, comps, rules) {
  const base = comps && comps.comp_mid > 0 ? comps.comp_mid : ai.used_value_est;
  const pct = pick(ai.nwt ? rules.nwt_pct : rules.used_pct, rules.pick);
  const price = roundPrice(base * pct, rules);
  let route = 'label', tier = '';
  const t = price < rules.bin_below ? rules.tiers.slice().sort((a, b) => a.max - b.max).find((x) => price <= x.max + 1e-9) : null;
  if (t) { route = 'bin'; tier = t.tier; }
  else if (!comps && rules.stage2_mode !== 'off' && (price >= rules.research_at || ai.notable_brand)) route = 'research';
  return { ai_price: price, route, tier, premium: price >= rules.premium_at };
}

// ------------------------------------------------------------ seed data
// [title, brand, category, size, condition, nwt, retail, confident, used_value, notable, promo_safe, status]
const CATALOG = [
  ['Embroidered peasant top', 'Free People', 'Tops', 'M', 'like_new', false, 98, true, 60, true, true, 'labeled'],
  ['Wool blend peacoat', 'J.Crew', 'Coats', 'S', 'good', false, 248, true, 90, false, true, 'labeled'],
  ['High-rise skinny jeans', "Levi's", 'Jeans', '28', 'good', false, 79, true, 40, false, true, 'labeled'],
  ['Pirate captain costume', 'Rubie’s', 'Costumes', 'L', 'like_new', false, 45, false, 38, false, true, 'labeled'],
  ['Sequin flapper dress', 'Leg Avenue', 'Costumes', 'M', 'good', false, 60, false, 40, false, true, 'labeled'],
  ['Leather crossbody bag', 'Coach', 'Bags', 'One size', 'good', false, 295, true, 120, true, true, 'labeled'],
  ['Cashmere crew sweater', 'Vince', 'Sweaters', 'L', 'like_new', false, 285, true, 110, true, true, 'labeled'],
  ['Running shoes', 'Nike', 'Shoes', '9', 'good', false, 120, true, 45, false, true, 'labeled'],
  ['Floral maxi dress', 'Anthropologie', 'Dresses', 'S', 'like_new', false, 168, true, 70, true, true, 'labeled'],
  ['Denim jacket', 'Madewell', 'Coats', 'M', 'good', false, 138, true, 55, false, true, 'labeled'],
  ['Superhero cape set', 'Disguise', 'Costumes', 'Kids M', 'good', false, 30, false, 35, false, true, 'labeled'],
  ['Silk blouse', 'Equipment', 'Tops', 'XS', 'like_new', false, 230, true, 80, true, true, 'labeled'],
  ['Puffer vest', 'Patagonia', 'Coats', 'M', 'good', false, 149, true, 70, true, true, 'labeled'],
  ['Corset costume', 'Dreamgirl', 'Costumes', 'S', 'like_new', false, 70, false, 45, false, false, 'labeled'],
  ['Vintage band tee', 'Hanes', 'Tops', 'L', 'fair', false, 0, false, 40, false, true, 'labeled'],
  ['Ankle boots', 'Sam Edelman', 'Shoes', '8', 'good', false, 150, true, 50, false, true, 'labeled'],
  ['Wrap dress', 'Diane von Furstenberg', 'Dresses', '6', 'like_new', false, 398, true, 140, true, true, 'labeled'],
  ['Yoga leggings', 'Lululemon', 'Activewear', '6', 'good', true, 98, true, 50, true, true, 'priced'],
  ['Witch costume', 'Spirit', 'Costumes', 'M', 'good', false, 40, false, 36, false, true, 'priced'],
  ['Chunky knit cardigan', 'Madewell', 'Sweaters', 'S', 'good', false, 98, true, 45, false, true, 'priced'],
  ['Trench coat', 'Banana Republic', 'Coats', 'M', 'good', false, 198, true, 75, false, true, 'priced'],
  ['Sexy nurse costume', 'Leg Avenue', 'Costumes', 'M', 'like_new', true, 50, false, 40, false, false, 'priced'],
  ['Hiking boots', 'Merrell', 'Shoes', '10', 'good', false, 140, true, 50, false, true, 'review'],
  ['Fleece jacket', 'The North Face', 'Coats', 'L', 'good', false, 99, true, 60, true, true, 'review'],
  ['Mermaid gown costume', 'Rubie’s', 'Costumes', 'S', 'like_new', false, 80, false, 90, false, true, 'review'],
  ['Tote bag', 'Kate Spade', 'Bags', 'One size', 'good', false, 228, true, 90, true, true, 'review'],
  ['Midi skirt', 'Reformation', 'Skirts', '4', 'like_new', true, 148, true, 70, true, true, 'review'],
  ['Ski jacket', 'Columbia', 'Coats', 'XL', 'good', false, 180, true, 80, false, true, 'researching'],
  ['Platform sandals', 'Steve Madden', 'Shoes', '7', 'good', false, 90, false, 60, false, true, 'researching'],
  ['Lace bodysuit', 'Free People', 'Tops', 'S', 'like_new', false, 78, true, 45, true, true, 'sold'],
  ['Cowboy boots', 'Ariat', 'Shoes', '8', 'good', false, 200, true, 90, true, true, 'sold'],
  ['Viking costume', 'Rubie’s', 'Costumes', 'L', 'good', false, 55, false, 40, false, true, 'sold'],
  ['Cropped cardigan', 'Zara', 'Sweaters', 'M', 'good', false, 40, false, 35, false, true, 'sold'],
  ['Mini dress', 'Lulus', 'Dresses', 'S', 'like_new', true, 60, true, 40, false, true, 'sold'],
  ['Gorilla suit', 'Rubie’s', 'Costumes', 'Adult', 'fair', false, 90, false, 50, false, true, 'pulled'],
  ['Stained blazer', 'Ann Taylor', 'Coats', '8', 'fair', false, 140, false, 40, false, true, 'pulled'],
  ['Basic tank top', 'Old Navy', 'Tops', 'M', 'good', false, 10, false, 6, false, true, 'binned'],
  ['Kids t-shirt', 'Carter’s', 'Kids', '4T', 'good', false, 8, false, 4, false, true, 'binned'],
  ['Scarf', 'Target', 'Accessories', 'One size', 'good', false, 15, false, 9, false, true, 'binned'],
  ['Cat ears headband', 'Party City', 'Costumes', 'One size', 'good', false, 6, false, 3, false, true, 'binned'],
];
const PEOPLE = ['Alex', 'Jordan', 'Sam'];
// collab / style_code for a few seed items. 'Running shoes' reproduces the real S-00009 bug (a style code read
// as the brand), so "Edit details" has something to fix.
const EXTRAS = {
  'Running shoes': { brand: 'JR286' },
  'Fleece jacket': { collab: 'Supreme', style_code: 'NF0A5J4Y' },
  'Platform sandals': { collab: 'Disney' },
  'Yoga leggings': { style_code: 'LW5CT3S' },
  'Leather crossbody bag': { style_code: 'F23537' },
};

function seed({ fresh = false } = {}) {
  const rules = clone(DEFAULT_RULES);
  const start = Date.now() - 6 * 86400000;
  const items = CATALOG.map((c, i) => {
    const [title, brand, category, size, condition, nwt, retail, confident, used, notable, promoSafe, status] = c;
    const ai = { title, brand, category, size, condition, nwt, retail_est: retail, retail_confident: confident, used_value_est: used, notable_brand: notable, promo_safe: promoSafe };
    const researched = status !== 'researching' && (status === 'review' || notable || used * 0.3 >= 25);
    const comps = researched ? { comp_low: Math.round(used * 0.7), comp_high: Math.round(used * 1.4), comp_mid: used } : null;
    const r = applyRules(ai, comps, rules);
    const created = new Date(start + i * 3 * 3600000).toISOString();
    const pricedBy = PEOPLE[i % 3];
    const it = blankItem();
    Object.assign(it, {
      id: 'S-' + pad(i + 1, 5), status, created_at: created, created_by: pricedBy,
      title, brand, category, size, condition, nwt, retail_est: retail, retail_confident: confident,
      comp_low: comps ? comps.comp_low : '', comp_high: comps ? comps.comp_high : '',
      comp_links: comps ? sampleLinks(brand, title) : [],
      ai_price: r.ai_price, route: status === 'binned' ? 'bin' : (r.route === 'bin' ? 'label' : r.route),
      tier: r.tier, premium: r.premium, promo_safe: promoSafe,
      photo_ids: { label: 'mock-l' + (i + 1), item: 'mock-i' + (i + 1) },
      thumb_url: svgThumb(brand.replace(/[^\w ]/g, '').slice(0, 16), (i * 37) % 360),
      ai_cost_usd: researched ? 0.1 : 0.0004,
      used_value_est: used, notable_brand: notable,
      _ai: ai,
    }, EXTRAS[title] || {});
    if (['priced', 'labeled', 'sold', 'binned'].includes(status)) {
      const override = i % 7 === 3;
      it.final_price = override ? it.ai_price + 5 : it.ai_price;
      it.price_source = override ? 'override' : 'ai';
      it.priced_by = pricedBy;
      it.priced_at = new Date(Date.parse(created) + 60000).toISOString();
      if (status === 'binned') it.final_price = tierPriceOf(r.tier || 'T3');
    }
    if (status === 'review' && i === 24) { // one item locked by Jordan, to exercise LOCKED
      it.review_lock_by = 'Jordan';
      it.review_lock_until = new Date(Date.now() + 15 * 60000).toISOString();
    }
    return it;
  });
  const tiers = [
    { tier: 'T1', label: '$1 bin', price: 1, counted_in: 0, sold_qty: 0 },
    { tier: 'T3', label: '$3 bin', price: 3, counted_in: 42, sold_qty: 4 },
    { tier: 'T5', label: '$5 bin', price: 5, counted_in: 17, sold_qty: 2 },
    { tier: 'BAG', label: 'Fill a bag', price: 10, counted_in: 0, sold_qty: 1 },
  ];
  const sat = nextWeekday(6);
  const sun = new Date(sat.getTime() + 86400000);
  const at = (d, hh) => { const x = new Date(d); x.setHours(hh, 0, 0, 0); return x.toISOString(); };
  const events = [{
    event_id: 'E-001', name: 'Huge resale inventory sale', start: at(sat, 8), end: at(sun, 14),
    address: '123 Example St, Springfield',
    markdowns: [{ from: at(sun, 12), pct: 50, applies: 'labeled' }],
    promo_checklist: { t7: { done: false }, t2: { done: false }, d0: { done: false } },
  }];
  const db = {
    v: 4, seq: items.length, saleSeq: 0, createCount: 0,
    pins: fresh ? {} : { admin: '1111', pricer: '2222', helper: '3333' },
    hasKey: !fresh,
    settings: { venmo_handle: '@Sale-Desk-Demo', zelle_handle: 'demo@example.com', venmo_qr_file_id: '', venmo_qr_url: '', rules, label_mode: 'batch', users: fresh ? [] : PEOPLE.slice() },
    items: fresh ? [] : items, tiers, events: fresh ? [] : events, sales: [], log: [],
  };
  if (!fresh) seedSales(db);
  return db;
}
function nextWeekday(dow) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7 || 7));
  return d;
}
function sampleLinks(brand, title) {
  const q = encodeURIComponent((brand + ' ' + title).trim());
  return [
    { title: 'eBay sold listing', url: 'https://www.ebay.com/sch/i.html?LH_Sold=1&_nkw=' + q },
    { title: 'Poshmark sold', url: 'https://poshmark.com/search?availability=sold_out&query=' + q },
  ];
}
function tierPriceOf(t) { return { T1: 1, T3: 3, T5: 5, BAG: 10 }[t] || 3; }
function blankItem() {
  return {
    id: '', status: 'new', created_at: '', created_by: '', title: '', brand: '', category: '', size: '', condition: 'good',
    nwt: false, retail_est: 0, retail_confident: false, comp_low: '', comp_high: '', comp_links: [], ai_price: 0,
    final_price: '', price_source: '', route: 'label', tier: '', premium: false, promo_safe: true, photo_ids: {},
    thumb_url: '', notes: '', sale_event: '', sold_price: '', sold_at: '', sale_id: '', priced_by: '', priced_at: '',
    review_lock_by: '', review_lock_until: '', ai_cost_usd: 0, used_value_est: 0, notable_brand: false,
    collab: '', style_code: '',
  };
}
function seedSales(db) {
  const sold = db.items.filter((i) => i.status === 'sold');
  const groups = [[sold[0], sold[1]], [sold[2]], [sold[3], sold[4]]];
  const methods = ['cash', 'venmo', 'zelle_apple'];
  const cashiers = ['Sam', 'Jordan', 'Sam'];
  groups.forEach((g, n) => {
    const lines = g.filter(Boolean).map((it) => ({ type: 'item', id: it.id, qty: 1, desc: it.brand + ' ' + it.title, list_price: it.final_price, price: it.final_price }));
    if (n === 0) lines.push({ type: 'tier', tier: 'T3', qty: 4, desc: '$3 bin', list_price: 3, price: 3 });
    if (n === 2) lines.push({ type: 'tier', tier: 'T5', qty: 2, desc: '$5 bin', list_price: 5, price: 5 }, { type: 'tier', tier: 'BAG', qty: 1, desc: 'Fill a bag', list_price: 10, price: 10 });
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const sale = {
      sale_id: 'X-' + pad(++db.saleSeq, 6), time: new Date(Date.now() - (3 - n) * 3600000).toISOString(), cashier: cashiers[n],
      event_id: 'E-001', lines, subtotal, cart_discount_pct: 0, custom_total: '', markdown_applied: 0, total: subtotal,
      method: methods[n], tendered: methods[n] === 'cash' ? Math.ceil(subtotal / 20) * 20 : '', change: methods[n] === 'cash' ? Math.ceil(subtotal / 20) * 20 - subtotal : '', voided: false,
    };
    db.sales.push(sale);
    for (const l of lines) if (l.type === 'item') {
      const it = db.items.find((i) => i.id === l.id);
      Object.assign(it, { sold_price: l.price, sold_at: sale.time, sale_id: sale.sale_id, sale_event: 'E-001' });
    }
  });
}

// ------------------------------------------------------------ persistence
let db = null;
function loadDb() {
  const q = new URLSearchParams(location.search);
  if (q.get('mockreset') === '1' || q.get('mockfresh') === '1') {
    if (!sessionStorage.getItem('saleDeskMockResetDone')) {
      db = seed({ fresh: q.get('mockfresh') === '1' });
      sessionStorage.setItem('saleDeskMockResetDone', '1');
      save();
      return db;
    }
  } else sessionStorage.removeItem('saleDeskMockResetDone');
  try { db = JSON.parse(sessionStorage.getItem(DB_KEY) || 'null'); } catch (e) { db = null; }
  if (!db || db.v !== 4) { db = seed(); save(); }
  return db;
}
function save() {
  try { sessionStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn('mock: sessionStorage full', e); }
}

// ------------------------------------------------------------ auth
function parseToken(token) {
  const m = /^mock\|(admin|pricer|helper)\|(.+)$/.exec(token || '');
  return m ? { role: m[1], name: decodeURIComponent(m[2]) } : null;
}
function allowed(role, action) {
  if (ADMIN_ONLY.some((p) => action === p || (p.endsWith('.') && action.startsWith(p)))) return role === 'admin';
  if (PRICER_EXTRA.some((p) => action === p || (p.endsWith('.') && action.startsWith(p)))) return ROLES[role] >= 2;
  if (HELPER.includes(action)) return true;
  return false;
}

// ------------------------------------------------------------ delays
function delayFor(action) {
  let fast = false;
  try { fast = localStorage.getItem('saleDeskMockFast') === '1'; } catch (e) { /* ignore */ }
  if (fast) return 30;
  if (action === 'item.create' || action === 'item.reprice') return 1500 + Math.random() * 1500;
  if (action === 'item.research') return 3000 + Math.random() * 2000;
  return 400 + Math.random() * 1100;
}

// ------------------------------------------------------------ public entry
export async function handle(action, params = {}) {
  if (!db) loadDb();
  const started = Date.now();
  let out;
  try {
    const fn = ACTIONS[action];
    if (!fn) fail('INVALID', 'Unknown action: ' + action);
    let user = null;
    if (action !== 'login' && action !== 'setup.init') {
      user = parseToken(params.token);
      if (!user) fail('AUTH', 'Not signed in');
      if (!allowed(user.role, action)) fail('FORBIDDEN', 'Your role cannot do ' + action);
    }
    const data = await fn(params, user);
    save();
    out = { ok: true, data: withBrandDisplay(clone(strip(data))) };
  } catch (e) {
    if (e instanceof Fail) out = { ok: false, error: Object.assign({}, e) };
    else { console.error('mock-api internal error', e); out = { ok: false, error: { code: 'INTERNAL', message: String(e && e.message) } }; }
  }
  const wait = delayFor(action) - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return out;
}
// Mirrors the backend's computed brand_display ("Nike × Off-White") on every item in a response.
function brandDisplay(it) {
  const b = String(it.brand || '').trim(), c = String(it.collab || '').trim();
  return c ? (b ? b + ' × ' + c : c) : b;
}
function withBrandDisplay(x) {
  if (Array.isArray(x)) { x.forEach(withBrandDisplay); return x; }
  if (x && typeof x === 'object') {
    if (/^S-\d+$/.test(x.id || '') && 'brand' in x) x.brand_display = brandDisplay(x);
    for (const v of Object.values(x)) if (v && typeof v === 'object') withBrandDisplay(v);
  }
  return x;
}
// drop private keys (prefixed _) from items before returning
function strip(x) {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) if (!k.startsWith('_')) o[k] = (v && typeof v === 'object') ? strip(v) : v;
    return o;
  }
  return x;
}

// ------------------------------------------------------------ actions
function getItem(id) {
  const it = db.items.find((i) => i.id === id);
  if (!it) fail('NOT_FOUND', 'No item ' + id);
  return it;
}
function lockActive(it, name) {
  return it.review_lock_by && it.review_lock_by !== name && Date.parse(it.review_lock_until || 0) > Date.now();
}
function log(user, action, itemId, detail, cost) {
  db.log.push({ time: now(), user: user ? user.name : '', action, item_id: itemId || '', detail: detail || {}, cost_usd: cost || 0 });
  if (db.log.length > 500) db.log.shift();
}
function currentEvent(eventId) {
  if (eventId) return db.events.find((e) => e.event_id === eventId) || null;
  return db.events[0] || null;
}

const TEMPLATES = {
  bin: [
    { title: 'Graphic t-shirt', brand: 'Old Navy', category: 'Tops', size: 'L', condition: 'good', nwt: false, retail_est: 15, retail_confident: false, used_value_est: 9, notable_brand: false, promo_safe: true },
    { title: 'Cotton tank top', brand: 'Gap', category: 'Tops', size: 'S', condition: 'good', nwt: false, retail_est: 20, retail_confident: false, used_value_est: 5, notable_brand: false, promo_safe: true },
    { title: 'Kids leggings', brand: 'Cat & Jack', category: 'Kids', size: '6', condition: 'fair', nwt: false, retail_est: 8, retail_confident: false, used_value_est: 3, notable_brand: false, promo_safe: true },
  ],
  label: [
    { title: 'Wool blend peacoat', brand: 'J.Crew', category: 'Coats', size: 'M', condition: 'good', nwt: false, retail_est: 120, retail_confident: true, used_value_est: 50, notable_brand: false, promo_safe: true },
    { title: 'Cowgirl costume', brand: 'Leg Avenue', category: 'Costumes', size: 'S', condition: 'like_new', nwt: false, retail_est: 55, retail_confident: false, used_value_est: 40, notable_brand: false, promo_safe: true },
    { title: 'Corduroy pants', brand: 'Madewell', category: 'Pants', size: '28', condition: 'good', nwt: false, retail_est: 98, retail_confident: true, used_value_est: 45, notable_brand: false, promo_safe: true },
  ],
  research: [
    { title: 'Embroidered peasant dress', brand: 'Free People', category: 'Dresses', size: 'M', condition: 'like_new', nwt: false, retail_est: 148, retail_confident: true, used_value_est: 90, notable_brand: true, promo_safe: true },
    { title: 'Down parka', brand: 'Canada Goose', category: 'Coats', size: 'L', condition: 'good', nwt: false, retail_est: 1095, retail_confident: true, used_value_est: 400, notable_brand: true, promo_safe: true },
    { title: 'Leather belt bag', brand: 'Coach', category: 'Bags', size: 'One size', condition: 'good', nwt: true, retail_est: 250, retail_confident: true, used_value_est: 100, notable_brand: true, promo_safe: true },
  ],
};

function makeThumb(b64) {
  return new Promise((resolve) => {
    if (!b64 || typeof Image === 'undefined') return resolve('');
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 200 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve('');
    img.src = 'data:image/jpeg;base64,' + b64;
  });
}

const ACTIONS = {
  // ---- auth / setup
  login({ pin, name }) {
    const n = String(name || '').trim();
    if (!n) fail('INVALID', 'Name required');
    if (!db.pins.admin) fail('AUTH', 'Setup needed: no PINs yet');
    const role = Object.keys(db.pins).find((r) => db.pins[r] === String(pin));
    if (!role) fail('AUTH', 'Wrong PIN');
    if (!db.settings.users.some((u) => u.toLowerCase() === n.toLowerCase())) db.settings.users.push(n);
    log({ name: n }, 'login', '', { role });
    return { token: 'mock|' + role + '|' + encodeURIComponent(n), role, name: n };
  },
  // Celebration config. Off unless localStorage.saleDeskMockEgg === '1' (dev testing); placeholder heart sprite.
  'fun.egg'() {
    let on = false, odds = 0.01;
    try { on = localStorage.getItem('saleDeskMockEgg') === '1'; odds = Number(localStorage.getItem('saleDeskMockEggOdds') || 0.01); } catch (e) { /* ignore */ }
    if (!on) return { enabled: false };
    return { enabled: true, odds, palette: { r: '#e0245e', w: '#fff' },
      sprite: ['.rr.rr.', 'rwrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'] };
  },
  'setup.init'({ adminPin }) {
    if (db.pins.admin) fail('FORBIDDEN', 'Already set up');
    if (!/^\d{4}$/.test(String(adminPin || ''))) fail('INVALID', 'PIN must be 4 digits');
    db.pins.admin = String(adminPin);
    if (!db.events.length) db.events = seed().events;
    return { ok: true };
  },
  'setup.setKey'({ apiKey }) {
    if (!apiKey || String(apiKey).length < 10) fail('INVALID', 'That key looks too short');
    db.hasKey = true;
    return { saved: true };
  },
  'setup.status'() {
    return { hasKey: !!db.hasKey, hasPins: !!db.pins.admin, sheetUrl: 'https://docs.google.com/spreadsheets/d/MOCK-SHEET/edit' };
  },

  // ---- items
  async 'item.create'({ photos, hint }, user) {
    photos = photos || {};
    const roles = ['label', 'tag', 'item'].filter((r) => photos[r]);
    if (!roles.length) fail('INVALID', 'At least one photo is required');
    const hintStr = String(hint || '').toLowerCase();
    const route = ['bin', 'label', 'research'].find((r) => hintStr.includes(r)) || ['bin', 'label', 'research'][db.createCount % 3];
    db.createCount++;
    const h = hashStr(photos.item || photos.label || photos.tag);
    const ai = clone(TEMPLATES[route][h % 3]);
    if (!photos.label && !photos.tag) { ai.retail_confident = false; ai.notes = 'No label photo; brand guessed from item.'; }
    // ~1 in 8 creates (the 5th, 13th, ...) or hint:'unreadable' -> the AI couldn't read the label (CONTRACT §8 retake prompt)
    if (photos.label && (hintStr.includes('unreadable') || db.createCount % 8 === 5)) { ai.brand = ''; ai.notes = 'LABEL UNREADABLE: text on the label is blurry.'; ai.retail_confident = false; }
    ai.confidence = photos.label ? 0.85 : 0.5;
    const r = applyRules(ai, null, db.settings.rules);
    const it = blankItem();
    const id = 'S-' + pad(++db.seq, 5);
    Object.assign(it, {
      id, status: r.route === 'research' ? 'researching' : 'new', created_at: now(), created_by: user.name,
      title: ai.title, brand: ai.brand, collab: ai.collab || '', style_code: ai.style_code || '', category: ai.category, size: ai.size, condition: ai.condition, nwt: ai.nwt,
      retail_est: ai.retail_est, retail_confident: ai.retail_confident, promo_safe: ai.promo_safe,
      ai_price: r.ai_price, route: r.route, tier: r.tier, premium: r.premium, notes: ai.notes || '',
      used_value_est: ai.used_value_est, notable_brand: !!ai.notable_brand,
      photo_ids: Object.fromEntries(roles.map((x) => [x, 'mock-' + x + '-' + id])),
      thumb_url: await makeThumb(photos.item || photos.label || photos.tag), ai_cost_usd: 0.0004, _ai: ai,
    });
    db.items.push(it);
    log(user, 'item.create', id, { route: r.route, ai_price: r.ai_price }, 0.0004);
    return it;
  },
  'item.research'({ id }, user) {
    const it = getItem(id);
    if (!['researching', 'review', 'new'].includes(it.status)) fail('INVALID', 'Item is ' + it.status);
    const ai = it._ai || { used_value_est: it.used_value_est || (it.ai_price || 10) / 0.3, nwt: it.nwt };
    const mid = Math.round(ai.used_value_est * (0.8 + (hashStr(id) % 40) / 100));
    const comps = { comp_low: Math.round(mid * 0.7), comp_high: Math.round(mid * 1.3), comp_mid: mid };
    const r = applyRules(ai, comps, db.settings.rules);
    Object.assign(it, {
      comp_low: comps.comp_low, comp_high: comps.comp_high, comp_links: sampleLinks(it.brand, it.title),
      ai_price: r.ai_price, route: r.route, tier: r.tier, premium: r.premium,
      retail_confident: it.retail_confident || !!ai.retail_confident, status: 'review', ai_cost_usd: r2((it.ai_cost_usd || 0) + 0.1),
    });
    log(user, 'item.research', id, comps, 0.1);
    return it;
  },
  'item.accept'({ id, final_price, source }, user) {
    const it = getItem(id);
    if (it.status === 'sold') fail('ALREADY_SOLD', 'Already sold', { ids: [id] });
    if (lockActive(it, user.name)) fail('LOCKED', 'Locked by ' + it.review_lock_by, { by: it.review_lock_by });
    const rules = db.settings.rules;
    const override = source === 'override' && final_price !== undefined && final_price !== null && final_price !== '';
    let price = override ? Number(final_price) : (final_price !== undefined && final_price !== null && final_price !== '' ? Number(final_price) : it.ai_price);
    if (!isFinite(price) || price < 0) fail('INVALID', 'Bad price');
    price = r2(price);
    if (price < rules.bin_below && it.route === 'bin') {
      const t = (rules.tiers.find((x) => price <= x.max) || rules.tiers[rules.tiers.length - 1]).tier;
      const tierRow = db.tiers.find((x) => x.tier === t);
      // Bin items get labels now (status 'priced'); AI price -> the rack's price, a typed price is kept exactly.
      Object.assign(it, { status: 'priced', route: 'bin', tier: t, final_price: override ? price : (tierRow ? tierRow.price : price) });
    } else {
      Object.assign(it, { status: 'priced', final_price: price, route: it.route === 'bin' ? 'label' : it.route, tier: it.route === 'bin' ? '' : it.tier });
    }
    Object.assign(it, { price_source: override ? 'override' : 'ai', premium: it.final_price >= rules.premium_at, priced_by: user.name, priced_at: now(), review_lock_by: '', review_lock_until: '' });
    if (override) log(user, 'override', id, { ai_price: it.ai_price, final_price: it.final_price });
    return it;
  },
  'item.markLabeled'({ ids }) {
    let count = 0;
    for (const id of ids || []) {
      const it = db.items.find((i) => i.id === id);
      if (it && (it.status === 'priced' || it.status === 'labeled')) { it.status = 'labeled'; count++; }
    }
    return { count };
  },
  'item.reprice'({ id }, user) {
    const it = getItem(id);
    if (it.status === 'sold') fail('ALREADY_SOLD', 'Already sold', { ids: [id] });
    const ai = clone(it._ai || { used_value_est: it.used_value_est || (it.ai_price || 10) / 0.3, nwt: it.nwt });
    ai.used_value_est = Math.round(ai.used_value_est * (0.85 + (Date.now() % 30) / 100));
    const r = applyRules(ai, null, db.settings.rules);
    Object.assign(it, { ai_price: r.ai_price, premium: r.premium, ai_cost_usd: r2((it.ai_cost_usd || 0) + 0.0004) });
    if (it.status !== 'binned') it.tier = r.route === 'bin' ? r.tier : it.tier;
    log(user, 'item.reprice', id, { ai_price: r.ai_price }, 0.0004);
    return it;
  },
  'item.edit'(p, user) {
    const it = getItem(p.id);
    if (it.status === 'sold') fail('ALREADY_SOLD', 'That item was already sold.', { ids: [it.id] });
    if (it.status === 'pulled') fail('INVALID', 'That item was pulled from the sale. Put it back on sale first.');
    if (lockActive(it, user.name)) fail('LOCKED', it.review_lock_by + ' has this item open right now.', { by: it.review_lock_by });
    const caps = { brand: 60, collab: 60, title: 80, size: 30, category: 40, style_code: 40, notes: 500 };
    const patch = {};
    for (const [k, max] of Object.entries(caps)) {
      if (p[k] === undefined) continue;
      patch[k] = String(p[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    }
    if (patch.title !== undefined && !patch.title) fail('INVALID', 'Give the item a name.');
    if (p.condition !== undefined && p.condition !== null && p.condition !== '') {
      const c = String(p.condition).trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (!['new', 'like_new', 'good', 'fair'].includes(c)) fail('INVALID', 'Condition must be new, like new, good or fair.');
      patch.condition = c;
    }
    const changed = {};
    for (const k of Object.keys(patch)) { if (String(it[k] ?? '') === patch[k]) delete patch[k]; else changed[k] = [it[k], patch[k]]; }
    const research = (p.recheck === true || p.recheck === 'true') && db.settings.rules.stage2_mode !== 'off';
    Object.assign(it, patch);
    if (it._ai) Object.assign(it._ai, patch);
    if (research) Object.assign(it, { status: 'researching', route: 'research', comp_low: '', comp_high: '', comp_links: [], review_lock_by: '', review_lock_until: '' });
    log(user, 'item.edit', it.id, { changed, recheck: research });
    return it;
  },
  'item.pull'({ id }, user) {
    const it = getItem(id);
    if (it.status === 'sold') fail('ALREADY_SOLD', 'Already sold', { ids: [id] });
    it.status = 'pulled';
    it.review_lock_by = ''; it.review_lock_until = '';
    log(user, 'item.pull', id);
    return it;
  },
  'item.delete'({ id }, user) {
    getItem(id);
    db.items = db.items.filter((i) => i.id !== id);
    log(user, 'item.delete', id);
    return { ok: true };
  },

  // ---- review
  'review.list'() {
    const items = db.items.filter((i) => i.status === 'review' || i.status === 'researching')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { items };
  },
  'review.open'({ id }, user) {
    const it = getItem(id);
    if (it.status !== 'review' && it.status !== 'researching') fail('INVALID', 'Not in review');
    if (lockActive(it, user.name)) fail('LOCKED', 'Locked by ' + it.review_lock_by, { by: it.review_lock_by });
    it.review_lock_by = user.name;
    it.review_lock_until = new Date(Date.now() + 60000).toISOString();
    return it;
  },

  // ---- inventory
  'inventory.list'({ q, status, offset = 0, limit = 30 }) {
    let list = db.items.slice();
    if (status) {
      const set = String(status).split(',');
      list = list.filter((i) => set.includes(i.status));
    }
    if (q) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((i) => {
        const hay = [i.id, i.title, i.brand, i.category, i.size, i.notes].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const o = Math.max(0, Number(offset) || 0), l = Math.min(200, Math.max(1, Number(limit) || 30));
    return { items: list.slice(o, o + l), total: list.length };
  },
  'inventory.stats'() {
    const counts = {};
    for (const s of ['new', 'researching', 'review', 'priced', 'labeled', 'sold', 'pulled', 'binned']) counts[s] = 0;
    let value = 0;
    const binned = {};
    for (const i of db.items) {
      counts[i.status] = (counts[i.status] || 0) + 1;
      if (OPEN_STATUSES.includes(i.status)) value += Number(i.final_price || i.ai_price || 0);
      if (i.status === 'binned') binned[i.tier] = (binned[i.tier] || 0) + 1;
    }
    for (const t of db.tiers) binned[t.tier] = Math.max(binned[t.tier] || 0, t.counted_in);
    return { counts, value_remaining: r2(value), binned_by_tier: binned, uncounted_tiers: db.tiers.filter((t) => !t.counted_in).map((t) => t.tier) };
  },

  // ---- tiers
  'tiers.list'() { return { tiers: db.tiers }; },
  'tiers.count'({ tier, delta = 1 }, user) {
    const t = db.tiers.find((x) => x.tier === tier);
    if (!t) fail('NOT_FOUND', 'No tier ' + tier);
    t.counted_in = Math.max(0, (t.counted_in || 0) + (Number(delta) || 0));
    log(user, 'tiers.count', '', { tier, delta });
    return t;
  },

  // ---- checkout
  scan({ code }) {
    const c = String(code || '').trim();
    const tm = /^(?:tier[:\-]?)?(T1|T3|T5|BAG)$/i.exec(c);
    if (tm) {
      const t = db.tiers.find((x) => x.tier === tm[1].toUpperCase());
      if (t) return { kind: 'tier', tier: t };
    }
    const im = /S-\d{5}/i.exec(c);
    if (!im) fail('NOT_FOUND', 'Unknown code');
    const it = db.items.find((i) => i.id === im[0].toUpperCase());
    if (!it) fail('NOT_FOUND', 'No item ' + im[0]);
    if (it.status === 'sold') fail('ALREADY_SOLD', 'Already sold', { ids: [it.id], sold_at: it.sold_at });
    if (it.status === 'pulled') fail('NOT_FOUND', 'Pulled from sale');
    return { kind: 'item', item: it };
  },
  checkout({ event_id, lines, cart_discount_pct, custom_total, method, tendered }, user) {
    if (!Array.isArray(lines) || !lines.length) fail('INVALID', 'Cart is empty');
    if (!['cash', 'venmo', 'zelle_apple'].includes(method)) fail('INVALID', 'Bad payment method');
    const ev = currentEvent(event_id);
    const itemIds = lines.filter((l) => l.type === 'item').map((l) => l.id);
    if (new Set(itemIds).size !== itemIds.length) fail('INVALID', 'Same item twice');
    const soldIds = itemIds.filter((id) => { const it = db.items.find((i) => i.id === id); return !it || it.status === 'sold'; });
    if (soldIds.length) fail('ALREADY_SOLD', 'Already sold: ' + soldIds.join(', '), { ids: soldIds });
    // markdown: biggest active scheduled markdown on this event
    let md = { pct: 0, applies: 'labeled' };
    if (ev) for (const m of ev.markdowns || []) if (Date.parse(m.from) <= Date.now() && pctOf(m.pct) > md.pct) md = { pct: pctOf(m.pct), applies: m.applies };
    let subtotal = 0, mdAmount = 0;
    const lineTotals = lines.map((l) => {
      const t = Number(l.price) * (Number(l.qty) || 1);
      subtotal += t;
      const hit = md.pct && (md.applies === 'all' || l.type === 'item') ? t * md.pct : 0;
      mdAmount += hit;
      return t - hit;
    });
    subtotal = r2(subtotal); mdAmount = r2(mdAmount);
    const pct = pctOf(cart_discount_pct);
    let total = r2((subtotal - mdAmount) * (1 - pct));
    if (custom_total !== undefined && custom_total !== null && custom_total !== '') total = r2(custom_total);
    let change = '';
    if (method === 'cash') {
      const tnd = tendered === undefined || tendered === null || tendered === '' ? total : Number(tendered);
      if (tnd < total) fail('INVALID', 'Not enough cash');
      change = r2(tnd - total);
      tendered = tnd;
    }
    const sale = {
      sale_id: 'X-' + pad(++db.saleSeq, 6), time: now(), cashier: user.name, event_id: ev ? ev.event_id : '',
      lines: clone(lines), subtotal, cart_discount_pct: Number(cart_discount_pct) || 0, custom_total: custom_total ?? '',
      markdown_applied: mdAmount, total, method, tendered: method === 'cash' ? tendered : '', change, voided: false,
    };
    const preTotal = lineTotals.reduce((a, b) => a + b, 0) || 1;
    lines.forEach((l, i) => {
      if (l.type === 'item') {
        const it = db.items.find((x) => x.id === l.id);
        Object.assign(it, { status: 'sold', sold_price: r2(lineTotals[i] * total / preTotal), sold_at: sale.time, sale_id: sale.sale_id, sale_event: sale.event_id });
      } else if (l.type === 'tier') {
        const t = db.tiers.find((x) => x.tier === l.tier);
        if (t) t.sold_qty += Number(l.qty) || 1;
      }
    });
    db.sales.push(sale);
    log(user, 'checkout', '', { sale_id: sale.sale_id, total });
    return sale;
  },
  voidSale({ sale_id }, user) {
    const s = db.sales.find((x) => x.sale_id === sale_id);
    if (!s) fail('NOT_FOUND', 'No sale ' + sale_id);
    if (s.voided) fail('INVALID', 'Already voided');
    s.voided = true;
    for (const l of s.lines) {
      if (l.type === 'item') {
        const it = db.items.find((x) => x.id === l.id);
        if (it) Object.assign(it, { status: 'labeled', sold_price: '', sold_at: '', sale_id: '', sale_event: '' });
      } else if (l.type === 'tier') {
        const t = db.tiers.find((x) => x.tier === l.tier);
        if (t) t.sold_qty = Math.max(0, t.sold_qty - (Number(l.qty) || 1));
      }
    }
    log(user, 'voidSale', '', { sale_id });
    return s;
  },
  'sales.list'({ event_id, limit = 20 }) {
    const sales = db.sales.filter((s) => !event_id || s.event_id === event_id).slice().reverse();
    return { sales: sales.slice(0, Math.max(1, Number(limit) || 20)) };
  },
  dashboard({ event_id, date }) {
    const ymd = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2); };
    const sales = db.sales.filter((s) => !s.voided && (!event_id || s.event_id === event_id) && (!date || ymd(s.time) === date));
    const by = { cash: 0, venmo: 0, zelle_apple: 0 };
    const byCashier = {}, tierQty = {};
    let total = 0, itemsSold = 0;
    for (const s of sales) {
      by[s.method] = r2((by[s.method] || 0) + s.total);
      total += s.total;
      byCashier[s.cashier] = r2((byCashier[s.cashier] || 0) + s.total);
      for (const l of s.lines) {
        if (l.type === 'item') itemsSold++;
        if (l.type === 'tier') tierQty[l.tier] = (tierQty[l.tier] || 0) + (Number(l.qty) || 1);
      }
    }
    const byPricer = {};
    for (const i of db.items) if (i.priced_by) byPricer[i.priced_by] = (byPricer[i.priced_by] || 0) + 1;
    const open = db.items.filter((i) => OPEN_STATUSES.includes(i.status));
    return {
      revenue_by_method: by, total: r2(total), sales_count: sales.length, items_sold: itemsSold, tier_qty_sold: tierQty,
      by_cashier: byCashier, by_pricer: byPricer, remaining_count: open.length,
      remaining_value: r2(open.reduce((a, i) => a + Number(i.final_price || i.ai_price || 0), 0)), cash_expected: by.cash,
      sales: sales.slice(-20).reverse(),
    };
  },

  // ---- events
  'events.list'() { return { events: db.events }; },
  'events.save'({ event }) {
    if (!event || typeof event !== 'object') fail('INVALID', 'Missing event');
    event = clone(event);
    for (const k of ['markdowns', 'promo_checklist']) {
      if (typeof event[k] === 'string') { try { event[k] = JSON.parse(event[k]); } catch (e) { fail('INVALID', k + ' must be JSON'); } }
    }
    if (event.markdowns !== undefined && !Array.isArray(event.markdowns)) fail('INVALID', 'markdowns must be an array');
    if (Array.isArray(event.promo_checklist)) { // legacy [{id,label,done}] -> {id:{done}}
      event.promo_checklist = Object.fromEntries(event.promo_checklist.map((c) => [c.id, { done: !!c.done, at: c.at || '', by: c.by || '' }]));
    }
    let ev = event.event_id && db.events.find((e) => e.event_id === event.event_id);
    if (ev) Object.assign(ev, event);
    else {
      ev = Object.assign({ name: 'Sale', start: '', end: '', address: '', markdowns: [], promo_checklist: { t7: { done: false }, t2: { done: false }, d0: { done: false } } }, event, { event_id: 'E-' + pad(db.events.length + 1, 3) });
      db.events.push(ev);
    }
    return ev;
  },

  // ---- promo
  'promo.featured'({ n = 12 }) {
    const items = db.items.filter((i) => i.promo_safe && ['priced', 'labeled'].includes(i.status) && i.thumb_url)
      .sort((a, b) => (Number(b.final_price || b.ai_price) - Number(a.final_price || a.ai_price)) || (b.brand ? 1 : 0) - (a.brand ? 1 : 0))
      .slice(0, Math.min(36, Math.max(1, Number(n) || 12)));
    return { items };
  },
  'promo.texts'({ event_id }) {
    const ev = currentEvent(event_id) || { name: 'Huge resale inventory sale', start: '', end: '', address: '' };
    const open = db.items.filter((i) => ['priced', 'labeled'].includes(i.status));
    const brands = [...new Set(open.filter((i) => i.premium || i.final_price >= 40).map((i) => i.brand))].slice(0, 5).join(', ');
    const when = ev.start ? new Date(ev.start).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric' }) : 'this weekend';
    const count = open.length + db.tiers.reduce((a, t) => a + (t.counted_in || 0), 0);
    const base = `Huge resale inventory sale: ${when}. ${count}+ items: clothing, costumes, shoes and bags. Brands like ${brands}. $1 / $3 / $5 racks and fill-a-bag. Cash, Venmo, Zelle.`;
    return {
      fb: base + ' Address posted 48 hours before.',
      fb_group: 'Neighbors! ' + base,
      craigslist: base + '\n\nEverything priced and tagged. Early birds welcome at start time.',
      nextdoor: base + ' Come say hi!',
    };
  },

  // ---- reports
  'reports.endOfEvent'({ event_id }) {
    const sold = db.items.filter((i) => i.status === 'sold' && (!event_id || i.sale_event === event_id));
    const unsold = db.items.filter((i) => ['priced', 'labeled', 'review', 'researching', 'new'].includes(i.status));
    const byCat = {};
    for (const i of unsold) {
      const c = byCat[i.category] = byCat[i.category] || { count: 0, value: 0 };
      c.count++; c.value = r2(c.value + Number(i.final_price || i.ai_price || 0));
    }
    const value = r2(unsold.reduce((a, i) => a + Number(i.final_price || i.ai_price || 0), 0));
    const top = unsold.slice().sort((a, b) => Number(b.final_price || b.ai_price) - Number(a.final_price || a.ai_price)).slice(0, 10);
    return {
      sold,
      unsold_summary: { count: unsold.length, value, by_category: byCat },
      donation_manifest: unsold.map((i) => ({ id: i.id, title: i.title, brand: i.brand, category: i.category, size: i.size, condition: i.condition, value: Number(i.final_price || i.ai_price || 0) })),
      bulk_lot: { count: unsold.length, est_value: r2(value * 0.2), top_items: top },
    };
  },

  // ---- settings
  'settings.get'(p, user) {
    if (user.role === 'admin') return Object.assign({}, db.settings);
    return Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, db.settings[k]]));
  },
  'settings.save'(partial, user) {
    const p = Object.assign({}, partial);
    delete p.token; delete p.action;
    for (const role of ['admin', 'pricer', 'helper']) {
      const k = 'pin_' + role;
      if (p[k] !== undefined && p[k] !== '') {
        if (!/^\d{4}$/.test(String(p[k]))) fail('INVALID', 'PINs are 4 digits');
        const other = Object.keys(db.pins).find((r) => r !== role && db.pins[r] === String(p[k]));
        if (other) fail('INVALID', 'Each role needs a different PIN');
        db.pins[role] = String(p[k]);
      }
      delete p[k];
    }
    if (p.venmo_qr_image !== undefined) { p.venmo_qr = p.venmo_qr_image; delete p.venmo_qr_image; } // §5b name
    if (p.venmo_qr !== undefined) {
      const v = String(p.venmo_qr || '');
      db.settings.venmo_qr_url = v ? (v.startsWith('data:') ? v : 'data:image/jpeg;base64,' + v) : '';
      db.settings.venmo_qr_file_id = v ? 'mock-venmo-qr' : '';
      delete p.venmo_qr;
    }
    if (p.rules) { db.settings.rules = Object.assign({}, db.settings.rules, p.rules); delete p.rules; }
    if (p.label_mode !== undefined && !['each', 'batch'].includes(p.label_mode)) fail('INVALID', 'label_mode must be each or batch');
    for (const k of ['venmo_handle', 'zelle_handle', 'label_mode', 'users']) if (p[k] !== undefined) db.settings[k] = p[k];
    log(user, 'settings.save', '', { keys: Object.keys(partial || {}).filter((k) => k !== 'token') });
    return Object.assign({}, db.settings);
  },
};
