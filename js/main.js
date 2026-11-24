// Sale Desk shell: login screen + tab router (CONTRACT §9).
// Feature modules are imported dynamically; missing ones are skipped.
// Tab object (§9 + shell additions that other modules rely on):
//   { id, label, icon, roles:[...], badge?: () => number,
//     render(container, ctx),      // container = <section class="screen tab-<id>">
//     onHide?(),                   // called when the user leaves the tab (stop cameras/timers here)
//     keepAlive?: true,            // keep the container between visits: render once, then
//     onShow?(container, ctx) }    //   onShow on each later visit
// Without keepAlive, render() gets a fresh container on every visit and the old one is removed,
// so polling loops should stop when `container.isConnected` is false.
// ctx = { session, tabId, go(tabId), refreshBadges(), isActive() }.
import { session, on, emit, login, logout, recentNames, forgetName } from './state.js';
import { h, BigButton, toast, showError, spinner } from './ui.js';
import { call, MOCK } from './api.js';

const MODULES = ['price', 'inventory', 'checkout', 'dashboard', 'promo'];
const ORDER = ['price', 'review', 'checkout', 'inventory', 'dashboard', 'promo', 'settings'];
const BAR_SLOTS = 4;
const app = document.getElementById('app');
const query = new URLSearchParams(location.search);
const APP_VERSION = '20261123-222721'; // publish.ps1 stamps the publish time here (shown on the More tab)

let allTabs = null;
let containers = {};
let current = null;

// ---------------------------------------------------------------- module loading
async function loadTabs() {
  if (allTabs) return allTabs;
  const results = await Promise.allSettled(MODULES.map((m) => import(`./${m}.js`)));
  const tabs = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value.tabs)) tabs.push(...r.value.tabs);
    else if (r.status === 'rejected') console.info(`Sale Desk: module ${MODULES[i]}.js not loaded (skipped).`, r.reason && r.reason.message);
  });
  const rank = (t) => { const i = ORDER.indexOf(t.id); return i < 0 ? 100 : i; };
  allTabs = tabs.sort((a, b) => rank(a) - rank(b));
  return allTabs;
}
function allowedTabs() {
  if (!session || !allTabs) return [];
  return allTabs.filter((t) => !t.roles || t.roles.includes(session.role));
}
function badgeOf(t) {
  try { return t.badge ? Number(t.badge()) || 0 : 0; } catch (e) { return 0; }
}

// ---------------------------------------------------------------- app frame
async function renderApp() {
  for (const id in containers) { const t = findTab(id); if (t && t.onHide) try { t.onHide(); } catch (e) { /* ignore */ } }
  containers = {};
  current = null;
  app.innerHTML = '';
  if (!session) { renderLogin(); return; }
  app.appendChild(spinner('Loading…'));
  await loadTabs();
  if (!session) return;
  app.innerHTML = '';
  app.appendChild(h('div', { id: 'views' }));
  app.appendChild(h('nav', { class: 'tabbar', id: 'tabbar', 'aria-label': 'Main' }));
  if (MOCK) app.appendChild(h('div', { class: 'mock-flag' }, 'DEMO DATA'));
  show(routeFromHash());
}
function findTab(id) {
  if (id === 'more') return MORE_TAB;
  return allowedTabs().find((t) => t.id === id);
}
function routeFromHash() {
  const id = (location.hash || '').replace(/^#\/?/, '');
  const tabs = allowedTabs();
  if (id === 'more' || tabs.some((t) => t.id === id)) return id;
  return tabs.length ? tabs[0].id : 'more';
}
function barLayout() {
  const tabs = allowedTabs();
  return { bar: tabs.slice(0, BAR_SLOTS), rest: tabs.slice(BAR_SLOTS) };
}
function renderBar() {
  const nav = document.getElementById('tabbar');
  if (!nav) return;
  const { bar, rest } = barLayout();
  const moreBadge = rest.reduce((s, t) => s + badgeOf(t), 0);
  nav.innerHTML = '';
  const item = (id, label, icon, badge) => h('button', {
    type: 'button', class: 'tab' + (current === id ? ' on' : ''), 'aria-current': current === id ? 'page' : null,
    onClick: () => go(id),
  }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon || '•'), h('span', { class: 'tab-label' }, label),
    badge ? h('span', { class: 'badge', 'aria-label': badge + ' waiting' }, badge > 99 ? '99+' : String(badge)) : null);
  for (const t of bar) nav.appendChild(item(t.id, t.label, t.icon, badgeOf(t)));
  nav.appendChild(item('more', 'More', '☰', moreBadge));
}
function ctxFor(id) {
  return {
    session, tabId: id, go, refreshBadges: renderBar,
    isActive: () => current === id,
  };
}
function go(id) {
  if (('#' + id) !== location.hash) location.hash = id; // hashchange -> show()
  else show(id);
}
function show(id) {
  const views = document.getElementById('views');
  if (!views || !session) return;
  const tab = findTab(id) || MORE_TAB;
  id = tab.id;
  if (current && current !== id) {
    const prev = findTab(current);
    if (prev && prev.onHide) try { prev.onHide(); } catch (e) { console.error(e); }
    const prevEl = containers[current];
    if (prevEl) {
      if (prev && prev.keepAlive) prevEl.hidden = true;
      else { prevEl.remove(); delete containers[current]; }
    }
  }
  current = id;
  const ctx = ctxFor(id);
  let el = containers[id];
  if (el && tab.keepAlive) {
    el.hidden = false;
    if (tab.onShow) try { tab.onShow(el, ctx); } catch (e) { console.error(e); }
  } else {
    if (el) el.remove();
    el = h('section', { class: 'screen tab-' + id, 'data-tab': id });
    containers[id] = el;
    views.appendChild(el);
    try {
      const r = tab.render(el, ctx);
      if (r && r.catch) r.catch((e) => { console.error(e); showError(e); });
    } catch (e) {
      console.error('tab render failed', id, e);
      el.appendChild(h('p', { class: 'empty' }, 'This screen had a problem. Try another tab.'));
    }
  }
  window.scrollTo(0, 0);
  document.title = 'Sale Desk · ' + (tab.label || '');
  renderBar();
}
window.addEventListener('hashchange', () => { if (session && document.getElementById('views')) show(routeFromHash()); });
on('badge', () => renderBar());
on('session', () => renderApp());

// ---------------------------------------------------------------- More tab (built in)
const MORE_TAB = {
  id: 'more', label: 'More', icon: '☰',
  render(el) {
    const { rest } = barLayout();
    el.appendChild(h('h1', null, 'More'));
    for (const t of rest) {
      const b = badgeOf(t);
      el.appendChild(BigButton([h('span', { 'aria-hidden': 'true' }, t.icon || '•'), ' ' + t.label, b ? h('span', { class: 'badge' }, String(b)) : null],
        () => go(t.id), { variant: 'secondary' }));
    }
    const roleName = { admin: 'Admin', pricer: 'Pricer', helper: 'Helper' }[session.role] || session.role;
    el.appendChild(h('div', { class: 'card', style: { marginTop: '20px' } },
      h('p', null, 'Signed in as ', h('b', null, session.name), ' (' + roleName + ')'),
      BigButton('Switch person / sign out', () => { location.hash = ''; logout(); }, { variant: 'secondary' })));
    const v = APP_VERSION.replace(/^\d{4}(\d{2})(\d{2})-(\d{2})(\d{2}).*/, (m, mo, d, hh, mi) => mo + '/' + d + ' ' + hh + ':' + mi);
    el.appendChild(h('p', { class: 'mute center' }, 'Sale Desk · version ' + v + (MOCK ? ' · demo data' : '')));
  },
};

// ---------------------------------------------------------------- login
function renderLogin() {
  const names = recentNames();
  const state = { step: names.length ? 'name' : 'newname', name: '', pin: '' };
  const root = h('div', { class: 'screen no-tabs login' });
  app.appendChild(root);
  if (MOCK) app.appendChild(h('div', { class: 'mock-flag' }, 'DEMO DATA'));
  let keyHandler = null;
  const setKeys = (fn) => {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = fn;
    if (fn) document.addEventListener('keydown', fn);
  };
  const header = () => h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('h1', { style: { margin: 0 } }, 'Sale Desk'));

  function draw() {
    root.innerHTML = '';
    setKeys(null);
    root.appendChild(header());
    if (state.step === 'name') drawNames();
    else if (state.step === 'newname') drawNewName();
    else if (state.step === 'pin') drawPin();
    else if (state.step === 'setup') drawSetup();
  }

  function drawNames() {
    root.appendChild(h('h2', null, "Who's using the phone?"));
    root.appendChild(h('div', { class: 'names' }, recentNames().map((n) =>
      BigButton(n, () => { state.name = n; state.step = 'pin'; draw(); }, { variant: 'secondary' }))));
    root.appendChild(BigButton('Someone new', () => { state.step = 'newname'; draw(); }, { variant: 'primary' }));
    root.appendChild(h('div', { class: 'center', style: { marginTop: '12px' } },
      h('button', { type: 'button', class: 'linkbtn', onClick: () => {
        const list = recentNames();
        if (!list.length) return;
        const n = window.prompt('Remove which name from this phone?\n' + list.join(', '));
        if (n) { forgetName(n.trim()); draw(); }
      } }, 'Remove a name')));
  }

  function drawNewName() {
    root.appendChild(h('h2', null, "What's your name?"));
    root.appendChild(h('p', { class: 'mute' }, 'First name is fine. It shows who priced or sold each item.'));
    const input = h('input', { type: 'text', autocomplete: 'given-name', autocapitalize: 'words', maxlength: 30, placeholder: 'Your name', value: state.name, 'aria-label': 'Your name' });
    const next = BigButton('Next', submit, { disabled: !state.name.trim() });
    input.addEventListener('input', () => { next.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    function submit() {
      const v = input.value.trim().replace(/\s+/g, ' ');
      if (!v) return;
      state.name = v; state.step = 'pin'; draw();
    }
    root.appendChild(h('label', { class: 'field' }, input));
    root.appendChild(next);
    if (recentNames().length) root.appendChild(BigButton('Back', () => { state.step = 'name'; draw(); }, { variant: 'secondary' }));
    root.appendChild(h('div', { class: 'center', style: { marginTop: '24px' } },
      h('button', { type: 'button', class: 'linkbtn', onClick: () => { state.step = 'setup'; draw(); } }, 'First-time setup (owner only)')));
    setTimeout(() => input.focus(), 50);
  }

  function drawPin() {
    state.pin = '';
    let busy = false;
    root.appendChild(h('h2', null, 'Hi, ' + state.name + '!'));
    root.appendChild(h('p', { class: 'mute', style: { margin: 0 } }, 'Enter your 4-digit PIN'));
    const dots = h('div', { class: 'pin-dots', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('span')));
    const status = h('p', { class: 'center mute', 'aria-live': 'polite', style: { minHeight: '26px' } });
    const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < state.pin.length));
    const press = async (k) => {
      if (busy) return;
      if (k === 'del') state.pin = state.pin.slice(0, -1);
      else if (state.pin.length < 4) state.pin += k;
      paint();
      if (state.pin.length === 4) {
        busy = true;
        status.textContent = 'Checking…';
        try {
          await login(state.pin, state.name); // emits 'session' -> renderApp()
          setKeys(null);
          toast('Welcome, ' + session.name + '!', 'ok');
        } catch (e) {
          busy = false;
          status.textContent = '';
          state.pin = '';
          paint();
          dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
          showError(e);
        }
      }
    };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    root.append(dots, status, h('div', { class: 'pinpad' }, keys.map((k) => k === ''
      ? h('span', { class: 'blank' })
      : h('button', { type: 'button', 'aria-label': k === 'del' ? 'Delete' : k, onClick: () => press(k) }, k === 'del' ? '⌫' : k))));
    root.appendChild(h('div', { class: 'center', style: { marginTop: '12px' } },
      h('button', { type: 'button', class: 'linkbtn', onClick: () => { state.step = recentNames().length ? 'name' : 'newname'; draw(); } }, 'Not ' + state.name + '? Change name')));
    setKeys((e) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
    });
  }

  function drawSetup() {
    root.appendChild(h('h2', null, 'First-time setup'));
    root.appendChild(h('p', null, 'Choose the admin PIN (4 digits). You only do this once. The other PINs are set later in Settings.'));
    const a = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 4, autocomplete: 'new-password', placeholder: 'New admin PIN', 'aria-label': 'New admin PIN' });
    const b = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 4, autocomplete: 'new-password', placeholder: 'Same PIN again', 'aria-label': 'Repeat admin PIN' });
    const save = BigButton('Save admin PIN', async () => {
      if (!/^\d{4}$/.test(a.value)) { toast('The PIN must be 4 digits.', 'error'); return; }
      if (a.value !== b.value) { toast("The two PINs don't match.", 'error'); return; }
      save.disabled = true;
      try {
        await call('setup.init', { adminPin: a.value });
        toast('Admin PIN saved. Now sign in with it.', 'ok');
        state.step = state.name ? 'pin' : 'newname';
        draw();
      } catch (e) {
        save.disabled = false;
        if (e.code === 'FORBIDDEN') toast('Setup is already done. Sign in with your PIN.', 'error');
        else showError(e);
      }
    });
    root.append(h('label', { class: 'field' }, a), h('label', { class: 'field' }, b), save,
      BigButton('Back', () => { state.step = recentNames().length ? 'name' : 'newname'; draw(); }, { variant: 'secondary' }));
  }

  draw();
}

// ---------------------------------------------------------------- boot
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && query.get('sw') !== '1') return; // keep dev reloads fresh
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Home Screen apps resume without reloading, so check for a new version every time the app comes back.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { shownAt = Date.now(); reg.update().catch(() => {}); }
    });
  }).catch((e) => console.info('SW not registered', e && e.message));
  // A new version took over: reload right away if nobody has tapped since the app opened or came back
  // (nothing is lost), otherwise offer a tap-to-update banner.
  let hadController = !!navigator.serviceWorker.controller, reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // first install, not an update
    if (reloading) return;
    if (lastTap < shownAt && Date.now() - shownAt < 30000) { reloading = true; location.reload(); return; }
    showUpdateBanner();
  });
}
let shownAt = Date.now(), lastTap = 0;
document.addEventListener('pointerdown', () => { lastTap = Date.now(); }, { capture: true, passive: true });
function showUpdateBanner() {
  if (document.getElementById('sd-update')) return;
  const b = h('button', { id: 'sd-update', type: 'button', onClick: () => location.reload(),
    style: { position: 'fixed', left: '12px', right: '12px', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', zIndex: '10000',
      padding: '14px', borderRadius: '12px', border: 'none', background: '#1a5fd0', color: '#fff', fontSize: '18px', fontWeight: '700' } },
    'New version ready. Tap to update.');
  document.body.appendChild(b);
}
registerSW();
renderApp();
window.saleDesk = { emit, go: (id) => go(id) }; // handy for debugging in the console
