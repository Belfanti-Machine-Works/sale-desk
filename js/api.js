// Sale Desk API wrapper (CONTRACT §2, §9). The ONLY place that talks to the backend.
import { session, logout } from './state.js';

// Deployed Apps Script /exec URL. Filled in by the orchestrator at deploy time.
// (Public repo: never put secrets here. The URL itself is not a secret.)
const DEPLOYED_API_URL = 'https://script.google.com/macros/s/AKfycbz28KUsB_NiT_9f8mxTywq3pO-Gg01HXWbauLfR4fKBbMYjH8XBY6BhoWAdUEr-SSQT/exec';

const params = new URLSearchParams(location.search);

function pickApiUrl() {
  const q = params.get('api');
  if (q) {
    try { localStorage.setItem('saleDeskApi', q); } catch (e) { /* ignore */ }
    return q;
  }
  try { if (localStorage.getItem('saleDeskApi')) return localStorage.getItem('saleDeskApi'); } catch (e) { /* ignore */ }
  return DEPLOYED_API_URL;
}
export const API_URL = pickApiUrl();

function pickMock() {
  if (params.get('mock') === '0') {
    try { localStorage.removeItem('saleDeskMock'); } catch (e) { /* ignore */ }
    return false;
  }
  if (params.get('mock') === '1') return true;
  try { return localStorage.getItem('saleDeskMock') === '1'; } catch (e) { return false; }
}
// True when calls go to the in-memory fake (js/mock-api.js).
export const MOCK = pickMock();

export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) if (k !== 'code' && k !== 'message') this[k] = v;
    }
  }
}

const NO_TOKEN = ['login', 'setup.init'];
const TIMEOUT_MS = 120000;

let mockMod = null;
async function viaMock(body) {
  if (!mockMod) mockMod = await import('./mock-api.js');
  const { action, ...rest } = body;
  return mockMod.handle(action, rest);
}

async function viaNetwork(body) {
  if (!API_URL) throw new ApiError('NO_SERVER', 'No API URL configured');
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'follow',
      signal: ctl ? ctl.signal : undefined,
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { throw new ApiError('INTERNAL', 'Bad response from server'); }
  } finally {
    if (t) clearTimeout(t);
  }
}

// call(action, params) -> Promise<data>; throws ApiError{code, message}.
export async function call(action, params = {}) {
  const body = Object.assign({}, params, { action });
  if (!NO_TOKEN.includes(action) && session && session.token) body.token = session.token;
  const send = MOCK ? viaMock : viaNetwork;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await send(body);
      break;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // fetch rejected (offline, DNS, CORS, abort): retry once, then give up.
      if (attempt >= 1) throw new ApiError('NETWORK', (e && e.message) || 'Network error');
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!res || typeof res !== 'object') throw new ApiError('INTERNAL', 'Empty response');
  if (res.ok) return res.data;
  const err = res.error || {};
  const apiErr = new ApiError(err.code || 'INTERNAL', err.message || 'Error', err);
  if (apiErr.code === 'AUTH' && action !== 'login' && session) logout(); // expired/invalid token -> back to PIN screen
  throw apiErr;
}
