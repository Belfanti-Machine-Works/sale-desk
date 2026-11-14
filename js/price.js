// Price tab (camera -> AI price -> countdown -> label) and Review queue (CONTRACT §8, PLAN "Pricing").
import { call, MOCK } from './api.js';
import { session, can, on, emit } from './state.js';
import { h, BigButton, toast, keypad, Countdown, confirmModal, money, showError, spinner, empty, imageToJpeg } from './ui.js';

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
// printNow(items) -> true if printLabels ran and items were marked labeled; false if not available.
export async function printNow(items) {
  const m = await labelsModule();
  if (!m) return false;
  await m.printLabels(items);
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
  const q = printQueue();
  if (!q.length) return;
  const m = await labelsModule();
  if (!m) { toast("Label printing isn't set up yet. The labels will wait here.", 'error'); return; }
  if (btn) btn.disabled = true;
  try {
    await m.printLabels(q);
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
  const cd = Countdown({ seconds: COUNTDOWN_S, onExpire: () => commit(null), onInterrupt: () => openKeypad() });

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
    root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    saving.hidden = false;
    const params = price === null ? { id: item.id, source: 'ai' } : { id: item.id, final_price: price, source: 'override' };
    try {
      const done = await call('item.accept', params);
      emit('item:priced', done);
      if (done.status === 'binned') {
        toast('Into the ' + tierInfo(done).label + ' it goes!', 'ok');
      } else {
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

  const desc = [item.brand, item.title, item.size].filter(Boolean).join(' · ');
  if (isBin) {
    const t = tierInfo(item);
    root.appendChild(h('p', { class: 'pr-kicker' }, 'Under ' + money((settingsCache && settingsCache.rules && settingsCache.rules.bin_below) || 10) + ': put it in the bin'));
    root.appendChild(h('div', { class: 'pr-card pr-bin' },
      h('button', { type: 'button', class: 'pr-price-btn', 'aria-label': 'Change price', onClick: () => (cd.running ? cd.interrupt() : openKeypad()) },
        h('span', { class: 'price-huge' }, money(t.price)), h('span', { class: 'pr-bin-word' }, 'BIN')),
      h('div', { class: 'pr-desc' }, desc || 'Item'),
      h('div', { class: 'pr-cdrow' }, cd, h('span', { class: 'mute' }, 'Tap the price to change it'))));
    const countBtn = BigButton('+1 counted', async () => {
      countBtn.disabled = true;
      try {
        const tr = await call('tiers.count', { tier: item.tier, delta: 1 });
        countBtn.textContent = '✓ Counted (' + tr.counted_in + ' in the bin)';
      } catch (e) { countBtn.disabled = false; showError(e); }
    }, { variant: 'secondary', class: 'btn-huge' });
    root.appendChild(countBtn);
    root.appendChild(BigButton('Next item ✓', () => commit(null), { class: 'btn-huge' }));
  } else {
    const retail = Number(item.retail_est) || 0;
    root.appendChild(h('div', { class: 'pr-card' },
      item.premium ? h('div', { class: 'pr-flag' }, '★ Premium table') : null,
      h('button', { type: 'button', class: 'pr-price-btn', 'aria-label': 'Change price', onClick: () => (cd.running ? cd.interrupt() : openKeypad()) },
        h('span', { class: 'price-huge' }, money(item.ai_price)), h('span', { class: 'pr-edit' }, '✎ change')),
      item.retail_confident && retail > 0 ? h('div', { class: 'pr-was' }, 'Was ' + money(retail) + ' new') : null,
      h('div', { class: 'pr-desc' }, desc || 'Item'),
      item.nwt ? h('div', { class: 'pill pill-labeled' }, 'New with tags') : null,
      h('div', { class: 'pr-cdrow' }, cd, h('span', { class: 'mute' }, 'Tap the price to change it'))));
    if (opts.mode === 'review') root.appendChild(compsBlock(item));
    root.appendChild(BigButton(opts.mode === 'review' ? 'Looks good ✓' : 'Looks good ✓ Next', () => commit(null), { class: 'btn-huge' }));
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
  return { destroy() { cd.stop(); committed = true; } };
}

function compsBlock(item) {
  const low = Number(item.comp_low) || 0, high = Number(item.comp_high) || 0;
  let links = item.comp_links;
  if (typeof links === 'string') { try { links = JSON.parse(links); } catch (e) { links = []; } }
  links = Array.isArray(links) ? links : [];
  return h('div', { class: 'card pr-comps' },
    h('h3', null, 'What similar items sold for'),
    low || high ? h('p', { class: 'pr-range' }, money(low) + ' – ' + money(high)) : h('p', { class: 'mute' }, 'No sold prices found. The price is from the photo only.'),
    links.length ? h('ul', { class: 'pr-links' }, links.slice(0, 5).map((l) => {
      const url = typeof l === 'string' ? l : l.url;
      const title = typeof l === 'string' ? hostOf(l) : (l.title || hostOf(l.url));
      return /^https?:\/\//.test(url || '') ? h('li', null, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, title + ' ↗')) : null;
    })) : null);
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
      const img = await imageToJpeg(file, 1280, 0.8);
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
          h('div', { class: 't1' }, [it.brand, it.title].filter(Boolean).join(' · ') || it.id),
          h('div', { class: 't2' }, looking ? '⏳ Looking up sold prices…' : lockedBy ? '🔒 ' + lockedBy + ' has it open' : (it.size ? 'Size ' + it.size + ' · ' : '') + it.id)),
        h('div', { class: 'price' }, looking ? '…' : money(it.ai_price)));
    })));
  }
  async function open(it) {
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
.pr-flag { display: inline-block; background: var(--ink); color: #fff; font-weight: 800; padding: 3px 12px; border-radius: 12px; margin-bottom: 6px; }
.pr-cdrow { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 10px; }
.pr-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.pr-comps .pr-range { font-size: 28px; font-weight: 800; margin: 0 0 6px; }
.pr-links { margin: 0; padding-left: 20px; }
.pr-links li { padding: 6px 0; }
.pr-links a { font-weight: 600; }
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
