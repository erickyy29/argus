/* Small DOM, formatting and data-fetch helpers. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Bus extends EventTarget {
  on(type, fn) { const h = (e) => fn(e.detail); this.addEventListener(type, h); return () => this.removeEventListener(type, h); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`argus:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`argus:${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
};

const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF = [0, 1, 2, 3, 4].map(nf);
const pad = (n, w = 2) => String(n).padStart(w, '0');

export const fmt = {
  int: (n) => (Number.isFinite(n) ? NF[0].format(Math.round(n)) : '—'),
  num: (n, d = 1) => (Number.isFinite(n) ? NF[Math.min(4, d)].format(n) : '—'),
  pct: (x, d = 1) => (Number.isFinite(x) ? `${NF[d].format(x * 100)}%` : '—'),
  deg: (x, d = 2) => (Number.isFinite(x) ? `${NF[d].format(x)}°` : '—'),
  lat: (x) => (Number.isFinite(x) ? `${NF[2].format(Math.abs(x))}° ${x >= 0 ? 'N' : 'S'}` : '—'),
  lon: (x) => (Number.isFinite(x) ? `${NF[2].format(Math.abs(x))}° ${x >= 0 ? 'E' : 'W'}` : '—'),
  km(km) {
    if (!Number.isFinite(km)) return '—';
    const a = Math.abs(km);
    if (a < 1) return `${NF[0].format(km * 1000)} m`;
    if (a < 100) return `${NF[2].format(km)} km`;
    if (a < 1e6) return `${NF[0].format(km)} km`;
    return `${NF[2].format(km / 1e6)} M km`;
  },
  ld: (km) => (Number.isFinite(km) ? `${NF[km / 384400 < 10 ? 2 : 1].format(km / 384400)} LD` : '—'),
  au: (km) => (Number.isFinite(km) ? `${NF[4].format(km / 149597870.7)} AU` : '—'),
  speed: (kms) => (Number.isFinite(kms) ? `${NF[2].format(kms)} km/s` : '—'),
  sci(x, d = 1) {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    let e = Math.floor(Math.log10(Math.abs(x)));
    if (e >= -2 && e <= 3) return NF[Math.max(0, Math.min(4, d + 1 - e))].format(x);
    let m = +(x / 10 ** e).toFixed(d);
    if (Math.abs(m) >= 10) { m /= 10; e += 1; }
    return `${m.toFixed(d)}e${e}`;
  },
  pc(p) { if (!Number.isFinite(p)) return '—'; if (p >= 1) return '≥ 1'; return fmt.sci(p, 1); },
  odds(p) { if (!(p > 0)) return '—'; if (p >= 0.5) return 'near-certain overlap'; return `1 in ${NF[0].format(Math.round(1 / p))}`; },
  utc(ms, sec = true) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${sec ? `:${pad(d.getUTCSeconds())}` : ''}`;
  },
  hms(ms) { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; },
  local(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); },
  localFull(ms) { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); },
  dur(sec) {
    if (!Number.isFinite(sec)) return '—';
    const s = Math.abs(sec);
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} m ${pad(Math.round(s % 60))} s`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} m`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
  },
  rel(ms, now = Date.now()) {
    const dt = (ms - now) / 1000;
    if (!Number.isFinite(dt)) return '—';
    if (Math.abs(dt) < 30) return 'now';
    return dt > 0 ? `in ${fmt.dur(dt)}` : `${fmt.dur(-dt)} ago`;
  },
  age(iso) { const t = typeof iso === 'number' ? iso : Date.parse(iso); return Number.isFinite(t) ? fmt.rel(t) : '—'; },
};

/* ── data feeds registry (drives the status indicator in the top bar) ── */
class FeedRegistry {
  constructor() { this.feeds = new Map(); this.listeners = new Set(); }
  define(id, label, source) { if (!this.feeds.has(id)) this.feeds.set(id, { id, label, source, status: 'pending', at: null, msg: '' }); }
  set(id, patch) { const f = this.feeds.get(id); if (!f) return; Object.assign(f, patch, { updated: Date.now() }); this.listeners.forEach((fn) => fn()); }
  ok(id, at, msg = '') { this.set(id, { status: 'ok', at: at ? Date.parse(at) || at : Date.now(), msg }); }
  warn(id, msg) { this.set(id, { status: 'warn', msg }); }
  err(id, msg) { this.set(id, { status: 'err', msg }); }
  onChange(fn) { this.listeners.add(fn); }
  list() { return [...this.feeds.values()]; }
}
export const feeds = new FeedRegistry();

/** Fetch JSON from the local server. Resolves to { data, fetchedAt, cache }. */
export async function api(path, { timeout = 90_000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(path, { signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return { data: body, fetchedAt: res.headers.get('x-fetched-at'), cache: res.headers.get('x-cache') };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('request timed out');
    throw e;
  } finally { clearTimeout(timer); }
}

export function toast(message, kind = '', ms = 4200) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, ms);
}

/** Run async tasks with limited concurrency. */
export async function pool(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
