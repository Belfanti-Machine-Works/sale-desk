// Little celebration when an item is submitted for pricing. Whether it plays (and what flies across)
// is decided by the server per user (`fun.egg`); this public file holds no names or artwork.
import { call } from './api.js';
import { session } from './state.js';

let cfg = null, cfgToken = null;

async function config() {
  const token = session && session.token;
  if (cfg && cfgToken === token) return cfg;
  try { cfg = await call('fun.egg'); } catch (e) { cfg = { enabled: false }; }
  cfgToken = token;
  return cfg;
}

export async function celebrate() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const c = await config();
    if (!c || !c.enabled) return;
    const rare = Array.isArray(c.sprite) && Math.random() < (Number(c.odds) || 0);
    fly(rare ? spriteHead(c.sprite, c.palette || {}) : starHead(), rare);
  } catch (e) { /* never let a flourish break pricing */ }
}

function starHead() {
  const s = document.createElement('div');
  s.textContent = '★';
  Object.assign(s.style, {
    font: '700 44px/1 -apple-system, system-ui, sans-serif', color: '#fff7c2',
    textShadow: '0 0 10px #fff, 0 0 22px #ffd54a, 0 0 40px #ff9f1c',
  });
  return s;
}

function spriteHead(rows, palette) {
  const px = 6, w = Math.max(...rows.map((r) => r.length)), hgt = rows.length;
  const c = document.createElement('canvas');
  c.width = w * px; c.height = hgt * px;
  const g = c.getContext('2d');
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.' || !palette[ch]) return;
    g.fillStyle = palette[ch]; g.fillRect(x * px, y * px, px, px);
  }));
  Object.assign(c.style, { imageRendering: 'pixelated', filter: 'drop-shadow(0 0 6px #ffd54a)' });
  return c;
}

function fly(head, big) {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'fixed', left: '0', top: (8 + Math.random() * 22) + 'vh', zIndex: '99999',
    pointerEvents: 'none', display: 'flex', alignItems: 'center',
  });
  const trail = document.createElement('div');
  Object.assign(trail.style, {
    width: big ? '220px' : '160px', height: big ? '10px' : '6px', borderRadius: '6px', marginRight: '-6px',
    background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,236,150,.55) 60%, rgba(255,255,255,.95))',
    filter: 'blur(1px)',
  });
  wrap.append(trail, head);
  document.body.appendChild(wrap);
  const vw = window.innerWidth, drop = 90 + Math.random() * 60;
  const anim = wrap.animate([
    { transform: `translate(${-0.45 * vw - 240}px, 0) rotate(8deg)`, opacity: 0 },
    { opacity: 1, offset: 0.12 },
    { opacity: 1, offset: 0.85 },
    { transform: `translate(${vw + 60}px, ${drop}px) rotate(8deg)`, opacity: 0 },
  ], { duration: big ? 2200 : 1300, easing: 'cubic-bezier(.3,.1,.4,1)' });
  anim.onfinish = () => wrap.remove();
  setTimeout(() => wrap.remove(), 4000); // belt and braces
}
