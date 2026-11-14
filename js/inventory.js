// Inventory tab (search, filters, item detail) and Settings tab (admin, incl. Admin → Setup).
import { call } from './api.js';
import { session, can, emit } from './state.js';
import { h, BigButton, toast, keypad, confirmModal, sheet, money, showError, spinner, empty, imageToJpeg, STATUS_LABEL } from './ui.js';
import { printNow, addToQueue } from './price.js';

const PAGE = 30;
const FILTERS = [
  { label: 'All', status: '' },
  { label: 'Labeled', status: 'labeled' },
  { label: 'Needs label', status: 'priced' },
  { label: 'To review', status: 'review' },
  { label: 'Looking up', status: 'researching' },
  { label: 'Sold', status: 'sold' },
  { label: 'In bins', status: 'binned' },
  { label: 'Pulled', status: 'pulled' },
];

function pill(status) {
  return h('span', { class: 'pill pill-' + status }, STATUS_LABEL[status] || status);
}
function priceOf(it) {
  if (it.status === 'sold' && it.sold_price !== '' && it.sold_price != null) return Number(it.sold_price);
  const f = it.final_price;
  return f !== '' && f != null ? Number(f) : Number(it.ai_price) || 0;
}
function descOf(it) { return [it.brand, it.title].filter(Boolean).join(' · ') || it.id; }
let tierCache = null; // [{tier, label, price}] from tiers.list, for "$3 bin" labels
async function loadTiers() {
  if (tierCache) return;
  try { tierCache = (await call('tiers.list')).tiers || []; } catch (e) { /* fall back to parsing T3 -> $3 */ }
}

// ================================================================ Inventory
function renderInventory(container, ctx) {
  container.classList.add('tab-inventory');
  loadTiers();
  const state ={ q: '', status: '', offset: 0, items: [], total: 0, loading: false, seq: 0 };
  const statsEl = h('div', { class: 'inv-stats' });
  const search = h('input', { type: 'search', placeholder: 'Search brand, item, or S-00012', 'aria-label': 'Search inventory', autocomplete: 'off', autocorrect: 'off', enterkeyhint: 'search' });
  const chips = h('div', { class: 'chips', role: 'tablist' });
  const listEl = h('div', { class: 'list' });
  const moreEl = h('div');
  container.append(h('div', { class: 'topbar' }, h('h1', null, 'Inventory')), statsEl, h('label', { class: 'field' }, search), chips, listEl, moreEl);

  function drawChips() {
    chips.innerHTML = '';
    for (const f of FILTERS) {
      chips.appendChild(h('button', { type: 'button', class: 'chip' + (state.status === f.status ? ' on' : ''), role: 'tab', 'aria-selected': String(state.status === f.status),
        onClick: () => { state.status = f.status; drawChips(); load(true); } }, f.label));
    }
  }
  async function loadStats() {
    try {
      const s = await call('inventory.stats');
      const c = s.counts || {};
      const forSale = (c.priced || 0) + (c.labeled || 0) + (c.binned || 0);
      statsEl.innerHTML = '';
      statsEl.append(
        stat(forSale, 'for sale'), stat(money(s.value_remaining || 0), 'tagged value'),
        stat((c.review || 0) + (c.researching || 0), 'to review'), stat(c.sold || 0, 'sold'));
      if (c.binned) statsEl.appendChild(h('p', { class: 'inv-note' }, c.binned + ' item' + (c.binned === 1 ? ' is' : 's are') + ' in price bins (no label needed).'));
      if (c.priced) statsEl.appendChild(h('p', { class: 'inv-note' }, c.priced + ' priced item' + (c.priced === 1 ? '' : 's') + ' still need a label.'));
    } catch (e) { /* stats are a nice-to-have */ }
  }
  function stat(v, label) { return h('div', { class: 'inv-stat' }, h('b', null, String(v)), h('span', null, label)); }

  async function load(fresh) {
    const my = ++state.seq;
    if (fresh) { state.offset = 0; state.items = []; listEl.innerHTML = ''; listEl.appendChild(spinner('Loading…')); moreEl.innerHTML = ''; }
    state.loading = true;
    try {
      const params = { offset: state.offset, limit: PAGE };
      if (state.q) params.q = state.q;
      if (state.status) params.status = state.status;
      const res = await call('inventory.list', params);
      if (my !== state.seq) return;
      state.items = state.items.concat(res.items || []);
      state.total = res.total || 0;
      state.offset = state.items.length;
      draw();
    } catch (e) {
      if (my !== state.seq) return;
      listEl.innerHTML = '';
      listEl.appendChild(empty("Couldn't load inventory."));
      showError(e);
    } finally {
      if (my === state.seq) state.loading = false;
    }
  }
  function draw() {
    listEl.innerHTML = '';
    moreEl.innerHTML = '';
    if (!state.items.length) {
      listEl.appendChild(empty(state.q ? 'Nothing matches "' + state.q + '".' : 'No items here yet.'));
      return;
    }
    for (const it of state.items) listEl.appendChild(row(it));
    moreEl.appendChild(h('p', { class: 'mute center' }, 'Showing ' + state.items.length + ' of ' + state.total));
    if (state.items.length < state.total) moreEl.appendChild(BigButton('Show more', () => load(false), { variant: 'secondary' }));
  }
  function row(it) {
    return h('button', { type: 'button', class: 'li', onClick: () => openDetail(it) },
      h('img', { class: 'thumb', src: it.thumb_url || 'icon.svg', alt: '', loading: 'lazy' }),
      h('div', { class: 'main' },
        h('div', { class: 't1' }, descOf(it)),
        h('div', { class: 't2' }, pill(it.status), ' ', it.size ? 'Size ' + it.size + ' · ' : '', it.id)),
      h('div', { class: 'price' }, it.status === 'binned' ? binLabel(it.tier) : money(priceOf(it))));
  }
  // 'T3' -> '$3 bin', 'BAG' -> 'Bag sale' (uses the real tier list once loaded).
  function binLabel(tier) {
    const t = tierCache && tierCache.find((x) => x.tier === tier);
    if (t && t.price) return money(t.price) + ' bin';
    const m = /^T(\d+)$/.exec(String(tier || ''));
    if (m) return '$' + m[1] + ' bin';
    return tier === 'BAG' ? 'Bag sale' : 'Bin';
  }
  function replaceItem(updated, removed) {
    const i = state.items.findIndex((x) => x.id === (updated ? updated.id : removed));
    if (i < 0) return;
    if (removed) { state.items.splice(i, 1); state.total--; }
    else state.items[i] = updated;
    draw();
    loadStats();
  }

  function openDetail(it) {
    const body = h('div', { class: 'inv-detail' });
    const sh = sheet(body);
    paint(it);

    function paint(item) {
      body.innerHTML = '';
      const retail = Number(item.retail_est) || 0;
      body.append(...[ // native append() would print null as the text "null", so drop empties
        item.thumb_url ? h('img', { class: 'inv-photo', src: item.thumb_url, alt: '' }) : null,
        h('div', { class: 'inv-head' },
          h('div', { class: 'price-big' }, item.status === 'binned' ? binLabel(item.tier) : money(priceOf(item))),
          pill(item.status)),
        item.retail_confident && retail > 0 ? h('p', { class: 'inv-was' }, 'Was ' + money(retail) + ' new') : null,
        h('h2', null, descOf(item)),
        h('dl', { class: 'inv-facts' },
          fact('Item #', item.id),
          fact('Size', item.size), fact('Condition', ({ new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair' })[item.condition] || item.condition),
          fact('Category', item.category),
          item.status !== 'binned' && item.final_price !== '' && Number(item.final_price) !== Number(item.ai_price) ? fact('AI said', money(item.ai_price)) : null,
          item.comp_low || item.comp_high ? fact('Sold elsewhere', money(item.comp_low) + ' – ' + money(item.comp_high)) : null,
          fact('Priced by', item.priced_by || item.created_by),
          item.status === 'sold' ? fact('Sold', money(item.sold_price) + (item.sold_at ? ' on ' + new Date(item.sold_at).toLocaleDateString() : '')) : null,
          item.premium ? fact('Table', '★ Premium') : null,
          item.notes ? fact('Notes', item.notes) : null)].filter(Boolean));
      body.appendChild(actions(item));
    }
    function fact(k, v) { return v || v === 0 ? [h('dt', null, k), h('dd', null, String(v))] : null; }

    async function run(btn, fn) {
      btn.disabled = true;
      try { await fn(); } catch (e) { showError(e); } finally { if (btn.isConnected) btn.disabled = false; }
    }
    async function relabel(item) {
      try {
        if (await printNow([item])) { toast('Label sent to the printer', 'ok'); return { ...item, status: 'labeled' }; }
      } catch (e) { showError(e); }
      const n = addToQueue(item);
      toast('Added to the print list (' + n + ' waiting on the Price tab)', 'ok');
      return item;
    }
    function actions(item) {
      const box = h('div', { class: 'inv-actions' });
      const st = item.status;
      if (st === 'priced' || st === 'labeled') {
        const b1 = BigButton('🖨  ' + (st === 'labeled' ? 'Reprint label' : 'Print label'), () => run(b1, async () => {
          const u = await relabel(item); replaceItem(u); paint(u);
        }));
        const b2 = BigButton('Change price', () => run(b2, async () => {
          const v = await keypad({ title: 'New price', value: priceOf(item) });
          if (v === null) return;
          if (v <= 0) { toast('The price has to be more than $0.', 'error'); return; }
          let u = await call('item.accept', { id: item.id, final_price: v, source: 'override' });
          emit('item:priced', u);
          toast('Price changed to ' + money(u.final_price) + '. It needs a new label.', 'ok');
          u = await relabel(u); replaceItem(u); paint(u);
        }), { variant: 'secondary' });
        const b3 = BigButton('Ask the AI again', () => run(b3, async () => {
          b3.textContent = 'Asking…';
          const r = await call('item.reprice', { id: item.id });
          b3.textContent = 'Ask the AI again';
          replaceItem(r);
          const use = await confirmModal('The AI now says ' + money(r.ai_price) + ' (now ' + money(priceOf(item)) + '). Use the new price?', 'Use ' + money(r.ai_price));
          if (!use) { paint(r); return; }
          let u = await call('item.accept', { id: item.id, final_price: r.ai_price, source: 'ai' });
          emit('item:priced', u);
          u = await relabel(u); replaceItem(u); paint(u);
        }), { variant: 'secondary' });
        box.append(b1, b2, b3);
      }
      if (st === 'review' || st === 'researching') {
        box.appendChild(BigButton('Open in Review', () => { sh.close(); ctx.go('review'); }));
      }
      if (st === 'new') {
        const b = BigButton('Set the price', () => run(b, async () => {
          const v = await keypad({ title: 'Price', value: item.ai_price });
          if (v === null) return;
          let u = await call('item.accept', { id: item.id, final_price: v, source: v === Number(item.ai_price) ? 'ai' : 'override' });
          emit('item:priced', u);
          if (u.status !== 'binned') u = await relabel(u);
          replaceItem(u); paint(u);
        }));
        box.appendChild(b);
      }
      if (st === 'pulled') {
        const b = BigButton('Put back on sale', () => run(b, async () => {
          let u = await call('item.accept', { id: item.id, final_price: priceOf(item), source: 'ai' });
          emit('item:priced', u);
          if (u.status !== 'binned') u = await relabel(u);
          toast('Back on sale', 'ok'); replaceItem(u); paint(u);
        }));
        box.appendChild(b);
      }
      if (!['sold', 'pulled', 'binned'].includes(st)) {
        const b = BigButton('Pull from sale', () => run(b, async () => {
          if (!(await confirmModal('Pull ' + item.id + ' from the sale? It stays in the list as Pulled.', 'Pull it'))) return;
          const u = await call('item.pull', { id: item.id });
          toast('Pulled ' + item.id, 'ok'); replaceItem(u); paint(u);
        }), { variant: 'danger' });
        box.appendChild(b);
      }
      if (can('item.delete') && st !== 'sold') {
        box.appendChild(h('div', { class: 'center' }, h('button', { type: 'button', class: 'linkbtn', style: { color: 'var(--bad)' }, onClick: async () => {
          if (!(await confirmModal('Delete ' + item.id + ' forever? This cannot be undone.', 'Delete forever'))) return;
          try { await call('item.delete', { id: item.id }); toast('Deleted ' + item.id, 'ok'); sh.close(); replaceItem(null, item.id); } catch (e) { showError(e); }
        } }, 'Delete forever (admin)')));
      }
      return box;
    }
  }

  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = search.value.trim(); load(true); }, 350);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); state.q = search.value.trim(); search.blur(); load(true); } });
  drawChips();
  loadStats();
  load(true);
}

// ================================================================ Settings (admin)
function renderSettings(container) {
  container.classList.add('tab-settings');
  container.appendChild(h('div', { class: 'topbar' }, h('h1', null, 'Settings')));
  const body = h('div');
  container.appendChild(body);
  body.appendChild(spinner('Loading settings…'));

  (async () => {
    let s, status;
    try {
      [s, status] = await Promise.all([call('settings.get'), call('setup.status').catch((e) => { showError(e); return null; })]);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(empty("Couldn't load settings."));
      showError(e);
      return;
    }
    if (!container.isConnected) return;
    body.innerHTML = '';
    body.append(setupCard(status), paymentsCard(s), labelsCard(s), pinsCard(), rulesCard(s), peopleCard(s));
  })();

  async function save(partial, btn, okMsg) {
    if (btn) btn.disabled = true;
    try {
      const out = await call('settings.save', partial);
      emit('settings:saved', out);
      toast(okMsg || 'Saved', 'ok');
      return out;
    } catch (e) {
      showError(e);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  function card(title, ...kids) { return h('section', { class: 'card' }, h('h2', null, title), ...kids); }
  function field(label, input, hint) { return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null); }

  // ---- Admin → Setup
  function setupCard(st) {
    const box = card('Setup');
    const line = (ok, text) => h('p', { class: 'set-line' }, h('b', { class: ok ? 'set-ok' : 'set-bad' }, ok ? '✓' : '✗'), ' ', text);
    const statusEl = h('div');
    const paint = (x) => {
      statusEl.innerHTML = '';
      if (!x) { statusEl.appendChild(h('p', { class: 'mute' }, "Couldn't check setup status.")); return; }
      statusEl.append(
        line(x.hasKey, x.hasKey ? 'Claude key is saved' : 'No Claude key yet: pricing will not work'),
        line(x.hasPins, x.hasPins ? 'PINs are set' : 'PINs not set'),
        x.sheetUrl ? h('p', null, h('a', { href: x.sheetUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the inventory spreadsheet ↗')) : null);
    };
    paint(st);
    const key = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'sk-ant-…', 'aria-label': 'Claude API key' });
    const saveKey = BigButton('Save key', async () => {
      const v = key.value.trim();
      if (!v) { toast('Paste the key first.', 'error'); return; }
      saveKey.disabled = true;
      try {
        await call('setup.setKey', { apiKey: v });
        key.value = '';
        toast('Key saved. It stays on the server and is never shown again.', 'ok');
        try { paint(await call('setup.status')); } catch (e) { /* ignore */ }
      } catch (e) { showError(e); } finally { saveKey.disabled = false; key.value = ''; }
    });
    box.append(statusEl, field('Claude API key', key, 'Paste it from console.anthropic.com. It goes straight to the server and is never shown again.'), saveKey);
    if (st && !st.hasPins) {
      const pin = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 4, autocomplete: 'new-password', 'aria-label': 'Admin PIN' });
      const init = BigButton('Set admin PIN', async () => {
        if (!/^\d{4}$/.test(pin.value)) { toast('The PIN must be 4 digits.', 'error'); return; }
        init.disabled = true;
        try { await call('setup.init', { adminPin: pin.value }); pin.value = ''; toast('Admin PIN saved', 'ok'); paint(await call('setup.status')); } catch (e) { showError(e); } finally { init.disabled = false; }
      }, { variant: 'secondary' });
      box.append(field('First-time admin PIN', pin), init);
    }
    return box;
  }

  // ---- payments
  function paymentsCard(s) {
    const venmo = h('input', { type: 'text', value: s.venmo_handle || '', placeholder: '@your-venmo', autocapitalize: 'off', autocorrect: 'off' });
    const zelle = h('input', { type: 'text', value: s.zelle_handle || '', placeholder: 'phone or email', autocapitalize: 'off', autocorrect: 'off' });
    const qrImg = h('img', { class: 'set-qr', alt: 'Venmo QR code', hidden: !s.venmo_qr_url, src: s.venmo_qr_url || null });
    const qrNone = h('p', { class: 'mute', hidden: !!s.venmo_qr_url }, 'No Venmo QR picture yet.');
    const qrInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', id: 'set-qr-file' });
    const removeBtn = h('button', { type: 'button', class: 'linkbtn', hidden: !s.venmo_qr_url, onClick: async () => {
      if (!(await confirmModal('Remove the Venmo QR picture?', 'Remove'))) return;
      const out = await save({ venmo_qr_image: '' }, null, 'QR removed');
      if (out) { qrImg.hidden = true; qrNone.hidden = false; removeBtn.hidden = true; }
    } }, 'Remove picture');
    qrInput.addEventListener('change', async () => {
      const f = qrInput.files && qrInput.files[0];
      qrInput.value = '';
      if (!f) return;
      try {
        const img = await imageToJpeg(f, 600, 0.9);
        const out = await save({ venmo_qr_image: img.b64 }, null, 'Venmo QR saved');
        if (out) { qrImg.src = out.venmo_qr_url || img.dataUrl; qrImg.hidden = false; qrNone.hidden = true; removeBtn.hidden = false; }
      } catch (e) { showError(e); }
    });
    const saveBtn = BigButton('Save payment info', () => save({ venmo_handle: venmo.value.trim(), zelle_handle: zelle.value.trim() }, saveBtn, 'Payment info saved'));
    return card('Payments',
      field('Venmo username', venmo), field('Zelle / Apple Cash', zelle, 'Shown to buyers at checkout.'),
      saveBtn,
      h('h3', { style: { marginTop: '18px' } }, 'Venmo QR picture'),
      h('p', { class: 'mute' }, 'In Venmo: Me → the QR icon → screenshot it. Then upload the screenshot here.'),
      qrImg, qrNone, qrInput,
      h('label', { class: 'btn btn-secondary', for: 'set-qr-file', role: 'button', style: { cursor: 'pointer' } }, 'Upload QR picture'),
      h('div', { class: 'center' }, removeBtn));
  }

  // ---- labels
  function labelsCard(s) {
    let mode = s.label_mode === 'each' ? 'each' : 'batch';
    const seg = h('div', { class: 'seg', role: 'radiogroup' });
    const hint = h('p', { class: 'mute', style: { marginTop: '10px' } });
    const paint = () => {
      seg.innerHTML = '';
      for (const [v, label] of [['each', 'One at a time'], ['batch', 'In batches']]) {
        seg.appendChild(h('button', { type: 'button', class: mode === v ? 'on' : '', role: 'radio', 'aria-checked': String(mode === v), onClick: async () => {
          if (mode === v) return;
          const prev = mode; mode = v; paint();
          if (!(await save({ label_mode: v }, null, 'Label printing: ' + label.toLowerCase()))) { mode = prev; paint(); }
        } }, label));
      }
      hint.textContent = mode === 'each'
        ? 'Each label prints right after its price is OK’d.'
        : 'Labels wait in a list on the Price tab. Tap “Print N labels” to print them all at once (fewer print screens).';
    };
    paint();
    return card('Label printing', seg, hint);
  }

  // ---- PINs
  function pinsCard() {
    const mk = (label) => h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 4, autocomplete: 'new-password', placeholder: 'Leave blank to keep', 'aria-label': label });
    const a = mk('New admin PIN'), p = mk('New pricer PIN'), hl = mk('New helper PIN');
    const btn = BigButton('Save PINs', async () => {
      const partial = {};
      const pairs = [['pin_admin', a], ['pin_pricer', p], ['pin_helper', hl]];
      for (const [k, el] of pairs) {
        if (!el.value) continue;
        if (!/^\d{4}$/.test(el.value)) { toast('PINs are exactly 4 digits.', 'error'); return; }
        partial[k] = el.value;
      }
      const vals = Object.values(partial);
      if (!vals.length) { toast('Type a new PIN first.', 'error'); return; }
      if (new Set(vals).size !== vals.length) { toast('Each role needs a different PIN.', 'error'); return; }
      if (await save(partial, btn, 'PINs changed. Tell your team!')) pairs.forEach(([, el]) => { el.value = ''; });
    });
    return card('PINs',
      h('p', { class: 'mute' }, 'Change a PIN any time, for example after a pricing party.'),
      field('Admin (you)', a), field('Pricer (Price, Review, Inventory, Checkout)', p), field('Helper (Checkout + Dashboard)', hl), btn);
  }

  // ---- pricing rules
  function rulesCard(s) {
    const r = Object.assign({}, s.rules || {});
    const tiers = Array.isArray(r.tiers) ? r.tiers : [];
    const tierMax = (t) => { const x = tiers.find((y) => y.tier === t); return x ? x.max : ''; };
    const num = (v, step) => h('input', { type: 'number', inputmode: 'decimal', step: step || 'any', min: '0', value: v === undefined || v === null ? '' : String(v) });
    const pct = (v) => num(v === undefined || v === '' ? '' : Math.round(Number(v) * 1000) / 10, '1');
    const f = {
      used_lo: pct((r.used_pct || [])[0]), used_hi: pct((r.used_pct || [])[1]),
      nwt_lo: pct((r.nwt_pct || [])[0]), nwt_hi: pct((r.nwt_pct || [])[1]),
      bin_below: num(r.bin_below), t1: num(tierMax('T1')), t3: num(tierMax('T3')), t5: num(tierMax('T5')),
      research_at: num(r.research_at), premium_at: num(r.premium_at), min_price: num(r.min_price),
    };
    const pickSel = h('select', { 'aria-label': 'Where in the range' },
      [['low', 'Low end'], ['mid', 'Middle'], ['high', 'High end']].map(([v, l]) => h('option', { value: v, selected: (r.pick || 'mid') === v }, l)));
    const modeSel = h('select', { 'aria-label': 'Sold-price lookup' },
      [['search', 'Web search (best, ~10¢ each)'], ['knowledge', 'AI knowledge only (~1¢)'], ['off', 'Off (photo price only)']].map(([v, l]) => h('option', { value: v, selected: (r.stage2_mode || 'search') === v }, l)));
    const pair = (a, b) => h('div', { class: 'row' }, a, b);
    const btn = BigButton('Save pricing rules', async () => {
      const n = (el) => (el.value === '' ? null : Number(el.value));
      const vals = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, n(el)]));
      if (Object.values(vals).some((v) => v === null || !isFinite(v) || v < 0)) { toast('Fill in every box with a number.', 'error'); return; }
      if (vals.used_lo > vals.used_hi || vals.nwt_lo > vals.nwt_hi) { toast('The low % must be less than the high %.', 'error'); return; }
      const newTiers = tiers.length ? tiers.map((t) => Object.assign({}, t, { max: { T1: vals.t1, T3: vals.t3, T5: vals.t5 }[t.tier] ?? t.max }))
        : [{ max: vals.t1, tier: 'T1' }, { max: vals.t3, tier: 'T3' }, { max: vals.t5, tier: 'T5' }];
      const rules = Object.assign({}, r, {
        used_pct: [vals.used_lo / 100, vals.used_hi / 100], nwt_pct: [vals.nwt_lo / 100, vals.nwt_hi / 100], pick: pickSel.value,
        bin_below: vals.bin_below, tiers: newTiers, research_at: vals.research_at, premium_at: vals.premium_at, min_price: vals.min_price,
        stage2_mode: modeSel.value,
      });
      const out = await save({ rules }, btn, 'Pricing rules saved. New items use them.');
      if (out) Object.assign(r, out.rules || rules);
    });
    return card('Pricing rules',
      h('p', { class: 'mute' }, 'Prices are a % of what the item sells for used. New items use these right away.'),
      h('span', { class: 'set-lbl' }, 'Used items: % of used value (low / high)'), pair(f.used_lo, f.used_hi),
      h('span', { class: 'set-lbl' }, 'New with tags: % (low / high)'), pair(f.nwt_lo, f.nwt_hi),
      field('Pick from the range', pickSel),
      field('Bin anything under $', f.bin_below),
      h('span', { class: 'set-lbl' }, 'Bin cut-offs: $1 bin up to / $3 bin up to / $5 bin up to'),
      h('div', { class: 'row' }, f.t1, f.t3, f.t5),
      field('Look up sold prices at $ or more', f.research_at),
      field('Premium table at $ or more', f.premium_at),
      field('Lowest price $', f.min_price),
      field('Sold-price lookup', modeSel),
      btn);
  }

  function peopleCard(s) {
    const users = Array.isArray(s.users) ? s.users : [];
    return card('People',
      users.length ? h('p', null, users.join(', ')) : h('p', { class: 'mute' }, 'Nobody yet.'),
      h('p', { class: 'mute' }, 'Everyone who has signed in. Each item and sale is credited to them.'));
  }
}

// ================================================================ styles + tabs
const css = `
.inv-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px; }
.inv-stat { background: var(--bg-2); border-radius: 12px; padding: 8px 4px; text-align: center; min-width: 0; }
.inv-stat b { display: block; font-size: 20px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inv-stat span { display: block; font-size: 13px; color: var(--ink-2); font-weight: 600; }
.inv-note { grid-column: 1 / -1; margin: 2px 0 0; font-size: 15px; color: var(--warn); font-weight: 600; }
.tab-inventory .field { margin-bottom: 8px; }
.inv-photo { display: block; width: 100%; max-height: 300px; object-fit: contain; background: var(--bg-2); border-radius: 14px; margin-bottom: 12px; }
.inv-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.inv-was { font-weight: 700; margin: 4px 0 0; }
.inv-detail h2 { margin-top: 10px; overflow-wrap: anywhere; }
.inv-facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 8px 0 16px; }
.inv-facts dt { color: var(--ink-2); }
.inv-facts dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.inv-actions .btn + .btn { margin-top: 10px; }
.tab-settings .card { margin-bottom: 16px; }
.set-line { margin: 0 0 8px; font-weight: 600; }
.set-ok { color: var(--ok); } .set-bad { color: var(--bad); }
.set-lbl { display: block; font-weight: 600; margin: 4px 0 6px; }
.tab-settings .row { margin-bottom: 14px; }
.set-qr { display: block; width: 180px; height: 180px; object-fit: contain; margin: 8px auto; border: 2px solid var(--line); border-radius: 12px; background: #fff; }
`;
document.head.appendChild(h('style', { 'data-module': 'inventory' }, css));

export const tabs = [
  { id: 'inventory', label: 'Inventory', icon: '📦', roles: ['pricer', 'admin'], render: renderInventory },
  { id: 'settings', label: 'Settings', icon: '⚙️', roles: ['admin'], render: renderSettings },
];
