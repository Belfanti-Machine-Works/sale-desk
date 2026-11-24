// Sale Desk session + tiny event bus (CONTRACT §9).
// `session` is a live ES-module binding: importers always see the current value
// ({token, role, name} or null). It is declared with `let` so it can change on login/logout.
import { call } from './api.js';

const KEY = 'saleDeskSession';
const NAMES_KEY = 'saleDeskNames';

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.token && s.role && s.name) return s;
  } catch (e) { /* ignore */ }
  return null;
}
export let session = load();

// ---- role table (CONTRACT §3). admin ⊃ pricer ⊃ helper.
const HELPER = ['scan', 'checkout', 'sales.list', 'dashboard', 'tiers.list', 'events.list', 'settings.get', 'fun.egg'];
// events.save is not in the §3 table; the promo agent edits events, so it sits with promo.* at pricer+.
const PRICER = ['voidSale', 'item.*', 'review.*', 'inventory.*', 'tiers.count', 'promo.*', 'events.save', 'print.queue', 'print.status'];
const ADMIN = ['settings.*', 'setup.*', 'reports.*']; // item.delete is pricer+ (covered by item.*)
const PUBLIC = ['login', 'setup.init'];
export const ROLE_ACTIONS = {
  helper: HELPER,
  pricer: HELPER.concat(PRICER),
  admin: HELPER.concat(PRICER, ADMIN),
};
function match(pattern, action) {
  if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}
// can(action) -> bool for the current session's role.
export function can(action, role) {
  if (PUBLIC.includes(action)) return true;
  const r = role || (session && session.role);
  if (!r) return false;
  return (ROLE_ACTIONS[r] || []).some((p) => match(p, action));
}
// hasRole('pricer') -> true for pricer or admin.
export function hasRole(min) {
  const order = { helper: 1, pricer: 2, admin: 3 };
  return !!session && (order[session.role] || 0) >= (order[min] || 99);
}

// ---- events: 'session', 'badge', 'item:priced', 'sale:done' (+ any others)
const handlers = {};
export function on(evt, fn) {
  (handlers[evt] = handlers[evt] || []).push(fn);
  return () => { handlers[evt] = (handlers[evt] || []).filter((f) => f !== fn); };
}
export function emit(evt, data) {
  for (const fn of (handlers[evt] || []).slice()) {
    try { fn(data); } catch (e) { console.error('handler for', evt, 'failed', e); }
  }
}

// ---- names used on this device (for the login name picker)
export function recentNames() {
  try { return JSON.parse(localStorage.getItem(NAMES_KEY) || '[]'); } catch (e) { return []; }
}
function rememberName(name) {
  const list = recentNames().filter((n) => n.toLowerCase() !== name.toLowerCase());
  list.unshift(name);
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(list.slice(0, 12))); } catch (e) { /* ignore */ }
}
export function forgetName(name) {
  const list = recentNames().filter((n) => n !== name);
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

// ---- login / logout
export async function login(pin, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  const data = await call('login', { pin: String(pin), name: clean });
  session = { token: data.token, role: data.role, name: data.name || clean };
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
  rememberName(session.name);
  emit('session', session);
  return session;
}
export function logout() {
  if (!session) return;
  session = null;
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  emit('session', null);
}
