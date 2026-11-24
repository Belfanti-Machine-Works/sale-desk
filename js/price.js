// Price tab (camera -> AI price -> countdown -> label) and Review queue (CONTRACT §8, PLAN "Pricing").
import { call, MOCK } from './api.js';
import { session, can, on, emit } from './state.js';
import { h, BigButton, toast, keypad, confirmModal, sheet, money, showError, errorMessage, spinner, empty, imageToJpeg } from './ui.js';
import { openEditItem, brandDisplay } from './edit-item.js';
import { celebrate } from './celebrate.js';
import { soldSearchLinks } from './sold-links.js';

const ROLES = ['label', 'tag', 'item'];
const PROMPTS = {
  label: { title: 'Shoot the brand / size label', sub: 'The little tag sewn inside the collar or side seam.' },
  tag: { title: 'Shoot the price tag', sub: 'The paper hang tag, if it still has one.' },
  item: { title: 'Shoot the whole item', sub: 'Hold it up or lay it flat so the whole thing shows.' },
};
const QUEUE_KEY = 'saleDeskPrintQueue';
const COUNTDOWN_S = 5;

// ================================================================ shared data
let tiersCache = null;
async function tiers() {
  if (tiersCache) return tiersCache;
  try { tiersCache = (await call('tiers.list')).tiers || []; } catch (e) { tiersCache = []; }
  return tiersCache;
}
function tierInfo(item) {
  const t = (tiersCache || []).find((x) => x.tier === item.tier);
  const fallback = { T1: 1, T3: 3, T5: 5, BAG: 10 }[item.tier];
  const price = t ? Number(t.price) : (fallback || item.ai_price);
  return { price, label: t && t.label ? t.label : money(price) + ' bin' };
}

let settingsCache = null;
async function settings(refresh) {
  if (settingsCache && !refresh) return settingsCache;
  try { settingsCache = await call('settings.get'); } catch (e) { settingsCache = settingsCache || {}; }
  return settingsCache;
}
on('settings:saved', (s) => { settingsCache = s; });
on('session', () => { settingsCache = null; tiersCache = null; reviewCount = 0; });

// ---------------------------------------------------------------- review badge
let reviewCount = 0;
let lastReviewFetch = 0;
export async function refreshReviewCount() {
  if (!session || !can('review.list')) return reviewCount;
  try {
    const { items } = await call('review.list');
    setReviewCount(items.filter((i) => i.status === 'review').length);
  } catch (e) { /* badge is best effort */ }
  return reviewCount;
}
function setReviewCount(n) {
  lastReviewFetch = Date.now();
  if (n !== reviewCount) { reviewCount = n; emit('badge', { tab: 'review', count: n }); }
}
setInterval(() => { if (!document.hidden && Date.now() - lastReviewFetch > 55000) refreshReviewCount(); }, 15000);

// ---------------------------------------------------------------- print queue (batch mode)
export function printQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) { /* ignore */ }
  emit('queue', q.length);
}
export function addToQueue(item) {
  const q = printQueue().filter((x) => x.id !== item.id);
  q.push(item);
  saveQueue(q);
  return q.length;
}
async function labelsModule() {
  try {
    const m = await import('./labels.js');
    return typeof m.printLabels === 'function' ? m : null;
  } catch (e) {
    console.info('labels.js not available', e && e.message);
    return null;
  }
}
// Home Screen web apps on iOS ignore window.print(), so there the phone's print screen never opens.
const STANDALONE = navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
// Labels go to the Raspberry Pi print server when it's online (it prints them itself, no print screen).
// -> the backend reply {queued, skipped} when the Pi took them; null if the Pi is offline / not available.
async function sendToPi(items) {
  try {
    const r = await call('print.queue', { ids: items.map((i) => i.id), size: (await settings()).label_size });
    return r && r.pi_online ? r : null;
  } catch (e) {
    console.info('Pi printer not available:', e && e.message);
    return null;
  }
}
// printNow(items) -> true if the labels went to the Pi (it marks them labeled once printed) or the phone's
// print screen ran (marked labeled here); false if neither is possible (caller keeps them in the print list).
export async function printNow(items) {
  if (await sendToPi(items)) return true;
  if (STANDALONE) return false;
  const m = await labelsModule();
  if (!m) return false;
  await m.printLabels(items, { size: (await settings()).label_size });
  await call('item.markLabeled', { ids: items.map((i) => i.id) });
  return true;
}
// After an accept: print right away ('each') or queue for later ('batch' / no labels.js).
async function labelAfterAccept(item) {
  const s = await settings();
  if (s.label_mode === 'each') {
    try {
      if (await printNow([item])) { toast(money(item.final_price) + ' label sent to the printer', 'ok'); return; }
    } catch (e) {
      showError(e);
    }
  }
  const n = addToQueue(item);
  toast('Priced ' + money(item.final_price) + '. ' + n + ' label' + (n === 1 ? '' : 's') + ' waiting to print.', 'ok');
}
async function printQueued(btn) {
  const all = printQueue();
  if (!all.length) return;
  if (btn) btn.disabled = true;
  try {
    const batch = all.slice(0, 100);
    const r = await sendToPi(batch);
    if (r) {
      saveQueue(printQueue().filter((x) => !batch.some((y) => y.id === x.id)));
      const left = all.length - batch.length;
      toast(r.queued + ' label' + (r.queued === 1 ? '' : 's') + ' sent to the label printer' + (left ? '. Tap Print again for the other ' + left + '.' : '.'), 'ok');
      return;
    }
    if (STANDALONE) {
      toast('The label printer is offline. Check that the Pi and the Rollo are plugged in and on, then tap Print again.', 'error');
      return;
    }
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
  const q = printQueue();
  const m = await labelsModule();
  if (!m) { toast("Label printing isn't set up yet. The labels will wait here.", 'error'); return; }
  if (btn) btn.disabled = true;
  try {
    await m.printLabels(q, { size: (await settings()).label_size });
    const ok = await confirmModal('Did all ' + q.length + ' label' + (q.length === 1 ? '' : 's') + ' print OK?', 'Yes, all printed');
    if (ok) {
      await call('item.markLabeled', { ids: q.map((i) => i.id) });
      const left = printQueue().filter((x) => !q.some((y) => y.id === x.id));
      saveQueue(left);
      toast('Done. Stick them on!', 'ok');
    }
  } catch (e) {
    showError(e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ================================================================ result screen (shared by Price + Review)
// showResult(host, item, {mode:'price'|'review', onDone(acceptedItem|null), onBack?}) -> {destroy()}
function showResult(host, item, opts) {
  const isBin = item.route === 'bin';
  let committed = false;
  host.innerHTML = '';
  const root = h('div', { class: 'pr-result' });
  host.appendChild(root);

  const saving = h('p', { class: 'center mute pr-saving', hidden: true }, 'Saving…');
  // Auto-accept timer, shown as the Accept button filling up ("Looks good ✓ 4… 3…"). Driven by
  // requestAnimationFrame so it is smooth; pauses while the screen is hidden; never restarts by itself.
  let okBtn = null, okNum = null;
  const cd = (() => {
    const total = COUNTDOWN_S * 1000;
    let running = true, elapsed = 0, last = null, seen = false, raf = 0, iv = 0;
    function paint() {
      if (!okBtn) return;
      okBtn.style.setProperty('--p', Math.min(1, elapsed / total).toFixed(4));
      okNum.textContent = String(Math.max(1, Math.ceil((total - elapsed) / 1000)));
    }
    // Two clocks feed one tick: a steady 100 ms interval (always runs, even where animation frames are
    // throttled, e.g. iOS Low Power Mode) and requestAnimationFrame for a smooth fill when available.
    function tick(now) {
      if (!running) return;
      if (root.isConnected) seen = true;
      else if (seen) { stop(); return; } // screen was replaced
      if (root.isConnected && !document.hidden) {
        if (last !== null) elapsed += Math.min(now - last, 250);
        last = now;
      } else last = null;
      paint();
      if (elapsed >= total) { stop(); commit(null); }
    }
    function rafLoop(now) { tick(now); if (running) raf = requestAnimationFrame(rafLoop); }
    function stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      clearInterval(iv);
      if (okBtn) { okBtn.style.setProperty('--p', '0'); okNum.textContent = ''; okBtn.classList.add('pr-ok-stopped'); }
      if (hintEl) hintEl.textContent = 'Timer stopped. Tap a button when you\'re ready.';
    }
    return {
      start() { iv = setInterval(() => tick(performance.now()), 100); raf = requestAnimationFrame(rafLoop); },
      stop,
      interrupt() { stop(); openKeypad(); },
      get running() { return running; },
    };
  })();
  // Item photo on the card; tap for a big view (stops the auto-accept so nothing is accepted mid-look).
  // Always show a photo box: the item photo, or a clear placeholder when none was saved / it won't load.
  function thumbEl() {
    const noPhoto = (why) => h('div', { class: 'pr-thumb pr-thumb-none' }, h('span', null, '📷'), h('span', null, why));
    if (!item.thumb_url) return h('div', { class: 'pr-thumb-btn' }, noPhoto('No photo saved'));
    const big = String(item.thumb_url).replace(/([?&]sz=)w\d+/, '$1w1200');
    const img = h('img', { class: 'pr-thumb', src: item.thumb_url, alt: 'Item photo', loading: 'eager', decoding: 'async' });
    const btn = h('button', { type: 'button', class: 'pr-thumb-btn', 'aria-label': 'See the photo bigger', onClick: () => {
      cd.stop();
      const s = sheet(h('div', { class: 'pr-photo-sheet' },
        h('img', { src: big, alt: 'Item photo' }),
        BigButton('Close', () => s.close(), { variant: 'secondary' })));
    } }, img, h('span', { class: 'pr-thumb-zoom' }, '⤢'));
    img.addEventListener('error', () => { btn.replaceWith(h('div', { class: 'pr-thumb-btn' }, noPhoto("Photo didn't load"))); });
    return btn;
  }
  let hintEl = null;
  const hint = () => (hintEl = h('div', { class: 'mute pr-hint' }, 'Accepts by itself when the button fills. Tap Change price to stop it.'));

  async function openKeypad() {
    if (committed) return;
    if (cd.running) cd.stop();
    const v = await keypad({ title: 'Type the price', value: isBin ? tierInfo(item).price : item.ai_price });
    if (v === null || committed) return;
    if (v <= 0) { toast('The price has to be more than $0.', 'error'); return; }
    commit(v);
  }
  async function commit(price) {
    if (committed) return;
    committed = true;
    cd.stop();
    const params = price === null ? { id: item.id, source: 'ai' } : { id: item.id, final_price: price, source: 'override' };
    if (opts.mode === 'price') {
      // Don't make the pricer wait for the save: straight back to the camera, save + label queue in the
      // background. If the save fails, the item is still safe in Review (status 'review').
      opts.onDone(null);
      saveInBackground(params);
      return;
    }
    root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    saving.hidden = false;
    try {
      const done = await call('item.accept', params);
      emit('item:priced', done);
      if (done.status === 'binned') { // legacy items from before bin labels
        toast('Into the ' + tierInfo(done).label + ' it goes!', 'ok');
      } else {
        // Every item gets a label now, bin items included (they also go on their bin's rack).
        if (done.route === 'bin') toast('Label it, then put it in the ' + tierInfo(done).label + '.', 'ok');
        await labelAfterAccept(done);
      }
      opts.onDone(done);
    } catch (e) {
      committed = false;
      saving.hidden = true;
      root.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      showError(e);
      if (e.code === 'ALREADY_SOLD' || e.code === 'NOT_FOUND') opts.onDone(null);
    }
  }

  async function saveInBackground(params) {
    try {
      const done = await call('item.accept', params);
      emit('item:priced', done);
      if (done.route === 'bin') toast(done.id + ': label it, then put it in the ' + tierInfo(done).label + '.', 'ok');
      await labelAfterAccept(done);
    } catch (e) {
      toast(item.id + " didn't save (" + errorMessage(e) + "). It's waiting in Review.", 'error');
      emit('badge');
    }
  }

  const descText = () => [brandDisplay(item), item.title, item.size].filter(Boolean).join(' · ') || 'Item';
  const desc = descText();
  // "Wrong brand? Edit": fix brand / collab / style code. A re-check sends it back to researching (leaves this
  // screen); otherwise the card updates in place and the pricer accepts as usual.
  const descEls = [];
  const descEl = () => { const el = h('div', { class: 'pr-desc' }, desc); descEls.push(el); return el; };
  const editLink = () => h('button', { type: 'button', class: 'linkbtn pr-editlink', onClick: async () => {
    if (committed) return;
    cd.stop();
    const u = await openEditItem(item);
    if (!u || committed) return;
    if (u.status === 'researching') { committed = true; opts.onDone(null); return; }
    Object.assign(item, u);
    descEls.forEach((el) => { el.textContent = descText(); });
  } }, 'Wrong brand? Edit');
  if (isBin) {
    const t = tierInfo(item);
    root.appendChild(h('p', { class: 'pr-kicker' }, 'Under ' + money((settingsCache && settingsCache.rules && settingsCache.rules.bin_below) || 10) + ': label it and put it in the ' + t.label));
    root.appendChild(h('div', { class: 'pr-card pr-bin' },
      thumbEl(),
      h('button', { type: 'button', class: 'pr-price-btn', 'aria-label': 'Change price', onClick: () => (cd.running ? cd.interrupt() : openKeypad()) },
        h('span', { class: 'price-huge' }, money(t.price)), h('span', { class: 'pr-bin-word' }, 'BIN')),
      descEl(), editLink(), hint()));
    if (opts.mode === 'review') root.appendChild(compsBlock(item, () => cd.stop()));
    root.appendChild(actionBar('Accept ✓'));
  } else {
    const retail = Number(item.retail_est) || 0;
    root.appendChild(h('div', { class: 'pr-card' },
      item.premium ? h('div', { class: 'pr-flag' }, '★ Premium table') : null,
      thumbEl(),
      h('button', { type: 'button', class: 'pr-price-btn', 'aria-label': 'Change price', onClick: () => (cd.running ? cd.interrupt() : openKeypad()) },
        h('span', { class: 'price-huge' }, money(item.ai_price)), h('span', { class: 'pr-edit' }, '✎ change')),
      item.retail_confident && retail > 0 ? h('div', { class: 'pr-was' }, 'Was ' + money(retail) + ' new') : null,
      descEl(), editLink(),
      item.nwt ? h('div', { class: 'pill pill-labeled' }, 'New with tags') : null,
      hint()));
    if (opts.mode === 'review') root.appendChild(compsBlock(item, () => cd.stop()));
    else {
      const sold = soldButtons(item, () => cd.stop(), 'Check what it sold for:');
      if (sold) root.appendChild(sold);
    }
    root.appendChild(actionBar('Looks good ✓'));
  }
  // Thumb zone: bar pinned just above the tab bar. Change price on the left, Accept on the right (owner's call).
  function actionBar(okLabel) {
    okBtn = BigButton(okLabel, () => commit(null), { class: 'btn-huge pr-ok' });
    okNum = h('span', { class: 'pr-ok-num' }, String(COUNTDOWN_S));
    okBtn.appendChild(okNum);
    return h('div', { class: 'pr-actions' },
      BigButton('✎ Change price', () => openKeypad(), { variant: 'secondary', class: 'btn-huge pr-change' }),
      okBtn);
  }
  root.appendChild(saving);
  const foot = h('div', { class: 'pr-foot' });
  if (opts.onBack) foot.appendChild(h('button', { type: 'button', class: 'linkbtn', onClick: () => { cd.stop(); opts.onBack(); } }, '← Back to list'));
  foot.appendChild(h('button', { type: 'button', class: 'linkbtn', onClick: async () => {
    cd.stop();
    if (!(await confirmModal('Take this item out of the sale? (You can find it later in Inventory.)', 'Pull it'))) return;
    try { await call('item.pull', { id: item.id }); toast('Pulled ' + item.id, 'ok'); opts.onDone(null); } catch (e) { showError(e); }
  } }, 'Not for sale? Pull it'));
  foot.appendChild(h('span', { class: 'mute' }, item.id));
  root.appendChild(foot);
  cd.start();
  return { destroy() { cd.stop(); committed = true; } };
}

// comp_links entries: strings (older rows), or objects {url, title, kind:'comp'|'search', site?, price?, sold_date?}
// written by Research.js. kind 'search' = the sold-search pages the backend gave the AI (marks it as searched).
function compLinks(item) {
  let links = item.comp_links;
  if (typeof links === 'string') { try { links = JSON.parse(links); } catch (e) { links = []; } }
  return (Array.isArray(links) ? links : []).map((l) => (typeof l === 'string' ? { url: l, title: '', kind: 'comp', legacy: true } : l))
    .filter((l) => l && /^https?:\/\//.test(l.url || ''));
}
const SEARCHED = 'Searched eBay, Poshmark, Depop, Mercari';
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

// "Searched … · 6 listings (1 sold, 5 for sale; asking counted at 75%)" or "… · no matching listings. Check below."
function compsSummary(item, links) {
  const comps = links.filter((l) => l.kind !== 'search');
  const searched = links.some((l) => l.kind === 'search');
  const low = Number(item.comp_low) || 0, high = Number(item.comp_high) || 0;
  if (comps.length) {
    if (comps.every((l) => l.legacy)) return SEARCHED + ' · ' + plural(comps.length, 'sold comp');
    const asking = comps.filter((l) => l.listing === 'asking').length, sold = comps.length - asking;
    const parts = [];
    if (sold) parts.push(sold + ' sold');
    if (asking) parts.push(asking + ' for sale; asking counted at 75%');
    return SEARCHED + ' · ' + plural(comps.length, 'listing') + ' (' + parts.join(', ') + ')';
  }
  if (searched) return SEARCHED + ' · no matching listings. Check below.';
  if (low || high) return 'Sold-price estimate (no listings to show). Check below.';
  return 'Not looked up yet. The price is from the photo. Check below.';
}

// Three one-tap sold searches; any tap stops the auto-accept countdown (the page opens in a new tab).
function soldButtons(item, onTap, label) {
  const links = soldSearchLinks(item);
  if (!links.length) return null;
  return h('div', { class: 'pr-sold' },
    label ? h('p', { class: 'pr-sold-label' }, label) : null,
    h('div', { class: 'pr-sold-row' }, links.map((l) => h('a', {
      class: 'btn btn-secondary pr-sold-btn', href: l.url, target: '_blank', rel: 'noopener noreferrer',
      'data-site': l.site, onClick: () => onTap && onTap(),
    }, l.label))));
}

function compsBlock(item, onTap) {
  const low = Number(item.comp_low) || 0, high = Number(item.comp_high) || 0;
  const links = compLinks(item);
  const comps = links.filter((l) => l.kind !== 'search');
  return h('div', { class: 'card pr-comps' },
    h('p', { class: 'pr-searched' }, compsSummary(item, links)),
    low || high ? h('p', { class: 'pr-range' }, money(low) + ' – ' + money(high)) : null,
    soldButtons(item, onTap),
    comps.length ? h('ul', { class: 'pr-links' }, comps.slice(0, 5).map((l) =>
      h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', onClick: () => onTap && onTap() },
        (l.title || hostOf(l.url)) + ' ↗')))) : null);
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'link'; } }

// ================================================================ Price tab
function renderPrice(container) {
  container.classList.add('tab-price');
  const flow = { step: 0, photos: {}, previews: {}, retake: null, busy: false, result: null };
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', id: 'pr-file', 'aria-hidden': 'true', tabindex: '-1' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) await takePhoto(f);
  });
  const view = h('div');
  container.append(fileInput, view);
  let offQueue = on('queue', () => { if (!flow.result && !flow.busy && container.isConnected) drawShoot(); });

  function reset() {
    if (flow.result) flow.result.destroy();
    Object.assign(flow, { step: 0, photos: {}, previews: {}, retake: null, busy: false, result: null });
    drawShoot();
  }
  function role() { return ROLES[flow.step]; }
  function count() { return Object.keys(flow.photos).length; }

  async function takePhoto(file) {
    const r = role();
    if (!r) return;
    flow.busy = true;
    view.innerHTML = '';
    view.appendChild(spinner('Getting the photo ready…'));
    try {
      // 1024px @ 0.75 is plenty to read tags and ~40% smaller to upload than 1280 @ 0.8 (faster on cell).
      const img = await imageToJpeg(file, 1024, 0.75);
      flow.photos[r] = img.b64;
      flow.previews[r] = img.dataUrl;
    } catch (e) {
      flow.busy = false;
      toast("That photo didn't work. Try again.", 'error');
      drawShoot();
      return;
    }
    flow.busy = false;
    if (flow.retake) { flow.step = ROLES.length; submit(); return; }
    flow.step++;
    if (flow.step >= ROLES.length) submit();
    else drawShoot();
  }

  function drawShoot() {
    if (flow.result) { flow.result.destroy(); flow.result = null; }
    view.innerHTML = '';
    const r = role();
    const p = PROMPTS[r];
    const q = printQueue();
    if (q.length) {
      const pb = BigButton('🖨  Print ' + q.length + ' label' + (q.length === 1 ? '' : 's'), () => printQueued(pb), { variant: 'secondary' });
      view.appendChild(h('div', { class: 'pr-queue' }, pb));
    }
    view.appendChild(h('div', { class: 'pr-steps', 'aria-label': 'Photo ' + (flow.step + 1) + ' of 3' },
      ROLES.map((x, i) => h('span', { class: 'pr-dot' + (i < flow.step ? ' done' : i === flow.step ? ' on' : '') + (flow.photos[x] ? ' has' : '') },
        { label: 'Label', tag: 'Tag', item: 'Item' }[x]))));
    view.appendChild(h('h1', { class: 'pr-prompt' }, flow.retake ? 'Retake the brand / size label' : p.title));
    view.appendChild(h('p', { class: 'mute pr-sub' }, flow.retake ? 'Get close and make sure the words are sharp.' : p.sub));
    view.appendChild(h('label', { class: 'btn btn-primary btn-huge pr-shoot', for: 'pr-file', role: 'button' }, '📷  Take photo'));
    if (r === 'tag' && !flow.retake) view.appendChild(BigButton('Skip: no tag', () => { flow.step++; drawShoot(); }, { variant: 'secondary', class: 'btn-huge' }));
    // The whole-item photo matters most (thumbnail, promo, condition), so it is the only big button at that
    // step; skipping it is a small link. (Real use: 2 of 2 first items were priced without one.)
    const links = h('div', { class: 'pr-links-row' });
    if (r === 'item' && count() >= 1) links.appendChild(h('button', { type: 'button', class: 'linkbtn', onClick: () => submit() }, 'No item photo? Price it anyway'));
    if (r === 'label' && !flow.retake) links.appendChild(h('button', { type: 'button', class: 'linkbtn', onClick: () => { flow.step = 1; drawShoot(); } }, 'No label? Skip it'));
    if (count() || flow.retake) links.appendChild(h('button', { type: 'button', class: 'linkbtn', onClick: reset }, 'Start over'));
    if (MOCK) links.appendChild(h('button', { type: 'button', class: 'linkbtn pr-sample', onClick: () => samplePhoto(r).then(takePhoto) }, 'Use sample photo'));
    view.appendChild(links);
    const shots = ROLES.filter((x) => flow.previews[x]);
    if (shots.length) {
      view.appendChild(h('div', { class: 'pr-thumbs' }, shots.map((x) => h('figure', null,
        h('img', { src: flow.previews[x], alt: x + ' photo' }), h('figcaption', null, { label: 'Label', tag: 'Tag', item: 'Item' }[x])))));
    }
  }

  async function submit() {
    if (!count()) { drawShoot(); return; }
    flow.busy = true;
    view.innerHTML = '';
    view.appendChild(spinner('Figuring out a price…'));
    view.appendChild(h('p', { class: 'center mute' }, 'Usually about 5 seconds.'));
    tiers(); settings(); // warm caches in parallel
    let item;
    celebrate(); // fire-and-forget flourish (server decides if/what)
    try {
      item = await call('item.create', { photos: Object.assign({}, flow.photos) });
    } catch (e) {
      flow.busy = false;
      showError(e);
      view.innerHTML = '';
      view.appendChild(h('h1', null, "That didn't go through"));
      view.appendChild(h('p', null, 'Your photos are still here.'));
      view.appendChild(BigButton('Try again', submit, { class: 'btn-huge' }));
      view.appendChild(BigButton('Start over', reset, { variant: 'secondary' }));
      return;
    }
    await tiers();
    flow.busy = false;
    if (/^LABEL UNREADABLE/i.test(item.notes || '') && flow.photos.label && !flow.retake) { askRetake(item); return; }
    route(item);
  }

  function askRetake(item) {
    view.innerHTML = '';
    view.appendChild(h('h1', null, "Couldn't read the label"));
    view.appendChild(h('p', null, 'A sharper photo of the brand / size label gets a better price. Retake it?'));
    view.appendChild(BigButton('📷  Retake label photo', async () => {
      flow.retake = item.id;
      delete flow.photos.label; delete flow.previews.label;
      flow.step = 0;
      call('item.pull', { id: item.id }).catch(() => { /* the replacement is what matters */ });
      drawShoot();
    }, { class: 'btn-huge' }));
    view.appendChild(BigButton('Skip: use it anyway', () => route(item), { variant: 'secondary', class: 'btn-huge' }));
  }

  function route(item) {
    if (item.route === 'research' || item.status === 'researching') {
      toast("Looking up sold prices… it'll be in Review", 'info');
      // Fire and forget: stage 2 takes 15-60 s. The backend sweep is the backstop.
      call('item.research', { id: item.id }).then(() => refreshReviewCount()).catch(() => refreshReviewCount());
      setReviewCount(reviewCount); // keep badge, refresh soon
      reset();
      return;
    }
    view.innerHTML = '';
    flow.result = showResult(view, item, { mode: 'price', onDone: () => reset() });
  }

  drawShoot();
  container._prReset = reset;
  container._prOff = () => offQueue();
}

// Dev-only (mock mode): a generated "photo" so the flow can be driven without a camera.
let sampleN = 0;
function samplePhoto(r) {
  sampleN++;
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const g = c.getContext('2d');
  const hue = (sampleN * 67) % 360;
  g.fillStyle = `hsl(${hue},45%,80%)`; g.fillRect(0, 0, 900, 1200);
  g.fillStyle = `hsl(${hue},50%,35%)`;
  g.beginPath(); g.moveTo(250, 250); g.lineTo(380, 180); g.quadraticCurveTo(450, 260, 520, 180); g.lineTo(650, 250);
  g.lineTo(760, 420); g.lineTo(650, 480); g.lineTo(640, 1000); g.lineTo(260, 1000); g.lineTo(250, 480); g.lineTo(140, 420); g.closePath(); g.fill();
  g.fillStyle = '#fff'; g.fillRect(300, 560, 300, 160);
  g.fillStyle = '#111'; g.font = 'bold 44px sans-serif'; g.textAlign = 'center';
  g.fillText(String(r || 'item').toUpperCase(), 450, 630); g.fillText('SAMPLE ' + sampleN, 450, 690);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
}

// ================================================================ Review tab
function renderReview(container, ctx) {
  container.classList.add('tab-review');
  let timer = null;
  let current = null;
  const head = h('div', { class: 'topbar' }, h('h1', null, 'Review'));
  const listEl = h('div');
  container.append(head, listEl);

  async function load(quiet) {
    if (!container.isConnected && quiet) return stop();
    if (current) return; // an item is open
    if (!quiet) { listEl.innerHTML = ''; listEl.appendChild(spinner('Loading…')); }
    try {
      const { items } = await call('review.list');
      if (current || (!container.isConnected && quiet)) return;
      setReviewCount(items.filter((i) => i.status === 'review').length);
      drawList(items);
    } catch (e) {
      if (!quiet) { listEl.innerHTML = ''; listEl.appendChild(empty("Couldn't load the list.")); listEl.appendChild(BigButton('Try again', () => load(false))); }
      showError(e);
    }
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function drawList(items) {
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.appendChild(empty('Nothing to review. Nice work!'));
      return;
    }
    const ready = items.filter((i) => i.status === 'review').length;
    listEl.appendChild(h('p', { class: 'mute' }, ready + ' ready to check' + (items.length > ready ? ', ' + (items.length - ready) + ' still looking up' : '') + '. Oldest first.'));
    listEl.appendChild(h('div', { class: 'list' }, items.map((it) => {
      const looking = it.status === 'researching';
      const lockedBy = it.review_lock_by && it.review_lock_by !== (session && session.name) && Date.parse(it.review_lock_until || 0) > Date.now() ? it.review_lock_by : '';
      return h('button', { type: 'button', class: 'li', onClick: () => open(it) },
        h('img', { class: 'thumb', src: it.thumb_url || 'icon.svg', alt: '', loading: 'lazy' }),
        h('div', { class: 'main' },
          h('div', { class: 't1' }, [brandDisplay(it), it.title].filter(Boolean).join(' · ') || it.id),
          h('div', { class: 't2' }, looking ? '⏳ Looking up sold prices…' : lockedBy ? '🔒 ' + lockedBy + ' has it open' : (it.size ? 'Size ' + it.size + ' · ' : '') + it.id)),
        h('div', { class: 'price' }, looking ? '…' : money(it.ai_price)));
    })));
  }
  let opening = false;
  async function open(it) {
    // One open at a time: a second tap while the first is loading used to re-open the item and restart
    // its countdown. Show "Opening…" immediately so the tap clearly registered.
    if (opening || current) return;
    if (it.status !== 'researching') {
      opening = true;
      listEl.innerHTML = '';
      listEl.appendChild(spinner('Opening ' + it.id + '…'));
      try { await openItem(it); } finally { opening = false; }
      return;
    }
    return openItem(it);
  }
  async function openItem(it) {
    if (it.status === 'researching') {
      const again = await confirmModal('Still looking up sold prices for this one. Try the lookup again now?', 'Look it up again');
      if (again) {
        toast("Looking up sold prices… it'll be ready soon", 'info');
        call('item.research', { id: it.id }).then(() => load(true)).catch(() => load(true));
      }
      return;
    }
    let item;
    try {
      item = await call('review.open', { id: it.id });
    } catch (e) {
      if (e.code === 'LOCKED') toast((e.by || it.review_lock_by || 'Someone else') + ' has this one open. Try another.', 'error');
      else showError(e);
      load(true);
      return;
    }
    if (!container.isConnected) return;
    await tiers();
    head.hidden = true;
    listEl.innerHTML = '';
    const back = () => { if (current) current.destroy(); current = null; head.hidden = false; load(false); };
    current = showResult(listEl, item, { mode: 'review', onDone: back, onBack: back });
    window.scrollTo(0, 0);
  }

  load(false);
  timer = setInterval(() => { if (!container.isConnected) stop(); else if (!document.hidden) load(true); }, 20000);
}

// ================================================================ styles + tabs
const css = `
.tab-price .pr-queue { margin-bottom: 14px; }
.pr-steps { display: flex; gap: 8px; margin: 4px 0 18px; }
.pr-dot { flex: 1; text-align: center; padding: 6px 0; border-radius: 10px; background: var(--bg-2); color: var(--ink-2); font-weight: 700; font-size: 16px; border: 2px solid transparent; }
.pr-dot.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.pr-dot.done { background: var(--ok-soft); color: var(--ok); }
.pr-dot.done.has::before { content: '✓ '; }
.pr-prompt { font-size: 32px; line-height: 1.15; margin-bottom: 6px; }
.pr-sub { margin-bottom: 18px; }
.pr-shoot { margin-bottom: 12px; cursor: pointer; }
.pr-links-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin-top: 4px; }
.pr-sample { color: #7a4d00; }
.pr-thumbs { display: flex; gap: 10px; margin-top: 14px; }
.pr-thumbs figure { margin: 0; width: calc((100% - 20px) / 3); }
.pr-thumbs img { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: 10px; border: 2px solid var(--line); display: block; }
.pr-thumbs figcaption { text-align: center; font-size: 15px; color: var(--ink-2); }
.pr-kicker { font-weight: 700; color: var(--ink-2); margin-bottom: 8px; }
.pr-card { border: 3px solid var(--ink); border-radius: 18px; padding: 16px; margin-bottom: 14px; text-align: center; }
.pr-bin { background: #fffbe6; }
.pr-price-btn { display: flex; flex-direction: column; align-items: center; width: 100%; background: none; border: 0; padding: 4px 0; font: inherit; color: var(--ink); cursor: pointer; }
.pr-bin .pr-price-btn { flex-direction: row; justify-content: center; align-items: baseline; gap: 12px; }
.pr-bin-word { font-size: 56px; font-weight: 900; }
.pr-edit { font-size: 16px; font-weight: 700; color: var(--accent); margin-top: 4px; }
.pr-was { font-size: 22px; font-weight: 700; margin-top: 6px; }
.pr-desc { font-size: 20px; margin: 10px 0 6px; overflow-wrap: anywhere; }
.pr-editlink { display: block; margin: 0 auto 6px; font-size: 16px; }
.pr-flag { display: inline-block; background: var(--ink); color: #fff; font-weight: 800; padding: 3px 12px; border-radius: 12px; margin-bottom: 6px; }
.pr-cdrow { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 10px; }
.pr-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.pr-comps { padding: 12px; }
.pr-searched { font-size: 17px; font-weight: 600; line-height: 1.3; margin: 0 0 6px; }
.pr-comps .pr-range { font-size: 28px; font-weight: 800; margin: 0 0 6px; }
.pr-sold { margin: 0 0 6px; }
.pr-sold-label { font-weight: 700; margin: 0 0 6px; }
.pr-sold-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.pr-sold-row .btn { margin: 0; padding: 6px 4px; font-size: 17px; min-height: 64px; overflow-wrap: anywhere; }
.pr-links { margin: 0; padding-left: 20px; }
.pr-links li { padding: 6px 0; }
.pr-links a { font-weight: 600; }
/* Thumb-zone action bar: pinned just above the tab bar; "Change price" on the right for a right thumb. */
.pr-actions { position: fixed; left: calc(16px + var(--safe-left, 0px)); right: calc(16px + var(--safe-right, 0px));
  bottom: calc(var(--tab-h, 68px) + var(--safe-bottom, 0px) + 8px); z-index: 30;
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 10px;
  background: linear-gradient(rgba(255,255,255,0), #fff 12px); }
.pr-result { padding-bottom: 120px; } /* room so the fixed bar never covers the footer links */
.pr-actions .btn { width: 100%; margin: 0; min-height: 96px; font-size: 24px; line-height: 1.15; padding: 8px 10px; }
.pr-actions .pr-change { border-width: 3px; }
/* The Accept button IS the countdown: a darker fill sweeps left->right over 5 s, number counts down. */
.pr-actions .pr-ok { background-image: linear-gradient(90deg, rgba(0,0,0,.32) calc(var(--p, 0) * 100%), transparent 0); }
.pr-ok-num { display: inline-block; min-width: 1.1em; margin-left: 8px; font-variant-numeric: tabular-nums; opacity: .9; }
.pr-hint { font-size: 15px; margin-top: 10px; }
.pr-thumb-btn { position: relative; display: block; margin: 0 auto 8px; padding: 0; border: 0; background: none; cursor: zoom-in; }
.pr-thumb { display: block; height: 132px; max-width: 100%; width: auto; object-fit: contain; border-radius: 12px; border: 2px solid var(--line); background: var(--bg-2); }
.pr-thumb-none { width: 132px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--ink-2); font-size: 14px; font-weight: 700; border-style: dashed; }
.pr-thumb-none span:first-child { font-size: 30px; }
.pr-thumb-zoom { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.6); color: #fff; border-radius: 8px; padding: 0 6px; font-size: 18px; line-height: 26px; }
.pr-photo-sheet img { display: block; width: 100%; max-height: 70vh; object-fit: contain; border-radius: 12px; margin-bottom: 12px; background: var(--bg-2); }
`;
document.head.appendChild(h('style', { 'data-module': 'price' }, css));

export const tabs = [
  {
    id: 'price', label: 'Price', icon: '📷', roles: ['pricer', 'admin'], keepAlive: true,
    render(container) { renderPrice(container); refreshReviewCount(); },
    onShow() { settings(true); },
  },
  {
    id: 'review', label: 'Review', icon: '🔎', roles: ['pricer', 'admin'],
    badge: () => reviewCount,
    render: renderReview,
  },
];
