// Sale Desk service worker: caches the app shell only. Never touches API calls
// (those are cross-origin POSTs to Apps Script and are passed straight through).
// index.html is network-first so updates land; other shell files are
// stale-while-revalidate. Bump VERSION on each publish to drop old caches.
const VERSION = 'sale-desk-20261123-215837';
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.json', 'icon.svg',
  'js/main.js', 'js/api.js', 'js/state.js', 'js/ui.js', 'js/price.js', 'js/inventory.js', 'js/edit-item.js', 'js/celebrate.js',
  'js/sold-links.js',
];
// Other agents' modules: cached if present, ignored if missing.
const OPTIONAL = ['js/labels.js', 'js/checkout.js', 'js/dashboard.js', 'js/promo.js'];
const CDN = [
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.concat(OPTIONAL, CDN).map((u) => c.add(u).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('sale-desk-') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // API calls are POST: never cached
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CDN.includes(url.href);
  if (!sameOrigin && !isCdn) return; // Apps Script, Drive thumbnails, etc.: straight to network
  if (sameOrigin && url.pathname.endsWith('/mock-api.js')) return; // dev only
  if (req.mode === 'navigate' || (sameOrigin && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')))) {
    e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(staleWhileRevalidate(req, e));
});

async function networkFirst(req) {
  const c = await caches.open(VERSION);
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) c.put('index.html', res.clone());
    return res;
  } catch (err) {
    return (await c.match('index.html')) || (await c.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(req, e) {
  const c = await caches.open(VERSION);
  const key = req.url.split('?')[0];
  const hit = await c.match(key);
  const fresh = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) c.put(key, res.clone());
    return res;
  }).catch(() => null);
  if (hit) {
    e.waitUntil(fresh);
    return hit;
  }
  return (await fresh) || Response.error();
}
