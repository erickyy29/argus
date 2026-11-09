#!/usr/bin/env node
/**
 * ARGUS · Orbital Awareness Console — local server
 *
 *  • Serves the web app in ./public
 *  • Allow-listed proxy for public space-data services with an on-disk cache.
 *    Each source is refreshed no faster than its publisher updates it, and the
 *    last good copy is served if a source is temporarily unavailable.
 *  • Pre-processes heavy CelesTrak products (SATCAT, SOCRATES) into compact JSON.
 *
 * Zero dependencies (Node.js 20+):   node server.mjs   →   http://localhost:8080
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lifetimeYears, lifetimeAltitude, BALLISTIC } from './public/js/lib/lifetime.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const ON_VERCEL = !!process.env.VERCEL;   // deployed as a Vercel Function (see api/index.mjs, vercel.json)
// Vercel's filesystem is read-only except /tmp; locally the cache lives next to the code.
const CACHE_DIR = process.env.ARGUS_CACHE_DIR || (ON_VERCEL ? path.join(os.tmpdir(), 'argus-cache') : path.join(ROOT, '.cache'));
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const UA = 'ARGUS-Orbital-Console/1.0 (+https://github.com/erickyy29/argus)';   // identifies the app to upstream services
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const JSON_TYPE = 'application/json; charset=utf-8';

const nasa = { key: (process.env.NASA_API_KEY || '').trim() || 'DEMO_KEY' };
// Place search: the public OSM Nominatim by default; point NOMINATIM_URL at your own instance for heavy traffic.
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').trim().replace(/\/+$/, '');
nasa.status = nasa.key === 'DEMO_KEY' ? 'demo' : 'unverified';

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env is optional */ }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || e));
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const redact = (u) => u.replace(/api_key=[^&]+/i, 'api_key=***');
const snippet = (buf) => buf.subarray(0, 240).toString('utf8').replace(/\s+/g, ' ').trim();
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (s) => (s === undefined || s === null || s === '' ? null : Number(s));

/* ───────────────────────────── per-host politeness ───────────────────────────── */

class Limiter {
  constructor(concurrency, gapMs = 0) { Object.assign(this, { concurrency, gapMs, active: 0, queue: [], last: 0, timer: null }); }
  run(fn) { return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.pump(); }); }
  pump() {
    if (this.active >= this.concurrency || !this.queue.length) return;
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) { this.timer ??= setTimeout(() => { this.timer = null; this.pump(); }, wait); return; }
    const job = this.queue.shift();
    this.active++; this.last = Date.now();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    this.pump();
  }
}
const LIMITERS = {
  'celestrak.org': new Limiter(1, 1200),          // sequential and spaced out
  'ssd-api.jpl.nasa.gov': new Limiter(1, 150),    // JPL asks clients not to send concurrent requests
  'ssd.jpl.nasa.gov': new Limiter(1, 400),
  'api.nasa.gov': new Limiter(1, 500),
  'tle.ivanstanojevic.me': new Limiter(2, 150),
  'nominatim.openstreetmap.org': new Limiter(1, 1100),   // OSM Nominatim policy: at most 1 request per second
  'api.wheretheiss.at': new Limiter(1, 1100),     // ~1 request/second limit
};
const DEFAULT_LIMITER = new Limiter(6);
const hostCooldown = new Map();   // host → { until, message }  (set when a host with opt.cooldown answers 429/403)
function retryAfterMs(v) {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}
/** Fail fast (without marking the key as failed) while a host is cooling down or its queue is full. */
function hostBusy(host, limiter, opt) {
  const cd = hostCooldown.get(host);
  if (cd && Date.now() < cd.until) return new HttpError(503, `${cd.message} Try again in about ${Math.max(1, Math.ceil((cd.until - Date.now()) / 60_000))} min.`);
  if (cd) hostCooldown.delete(host);
  if (opt.maxQueue != null && limiter.queue.length + limiter.active >= opt.maxQueue) return new HttpError(503, opt.busyMessage || `${host} is busy; try again shortly.`);
  return null;
}

/* ──────────────────────────────── cache layer ──────────────────────────────── */

let DISK_CACHE = true;
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { DISK_CACHE = false; log(`disk cache disabled (${e.code || e.message}); using memory only`); }
const memCache = new Map();   // key → entry { key, url, type, fetchedAt, lastModified, etag, body, gz? } (LRU order)
const MEM_LIMIT = 256 * 1024 * 1024;
let memBytes = 0;
const entryBytes = (e) => (e?.body?.length || 0) + (e?.gz?.length || 0);
function memPut(key, entry) {
  const old = memCache.get(key);
  if (old) { memBytes -= entryBytes(old); memCache.delete(key); }
  memCache.set(key, entry); memBytes += entryBytes(entry);
  for (const [k, e] of memCache) { if (memBytes <= MEM_LIMIT || k === key) break; memCache.delete(k); memBytes -= entryBytes(e); }
}
function memGet(key) { const e = memCache.get(key); if (e) { memCache.delete(key); memCache.set(key, e); } return e; }
(async () => {   // prune disk entries untouched for 60 days
  if (!DISK_CACHE) return;
  try {
    for (const f of await fsp.readdir(CACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(CACHE_DIR, f);
      const st = await fsp.stat(p);
      if (Date.now() - st.mtimeMs > 60 * DAY) { await fsp.rm(p, { force: true }); await fsp.rm(p.replace(/\.json$/, '.bin'), { force: true }); }
    }
  } catch { /* ignore */ }
})();
const inflight = new Map();   // key → Promise
const failures = new Map();   // key → { at, message }
const feedState = new Map();  // feed → { ok, at, message }

const cachePath = (key) => path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex'));

async function readDisk(key) {
  if (!DISK_CACHE) return null;
  try {
    const base = cachePath(key);
    const meta = JSON.parse(await fsp.readFile(base + '.json', 'utf8'));
    return { ...meta, body: await fsp.readFile(base + '.bin') };
  } catch { return null; }
}
async function writeDisk(entry) {
  if (!DISK_CACHE) return;
  const base = cachePath(entry.key);
  const { body, gz, ...meta } = entry;
  try {
    await fsp.writeFile(base + '.bin', body);
    await fsp.writeFile(base + '.json', JSON.stringify(meta));
  } catch (e) { log(`cache write failed (${e.code || e.message})`); }
}
function noteFeed(feed, ok, message = '') { if (feed) feedState.set(feed, { ok, at: Date.now(), message }); }

/**
 * Fetch `url` through the cache.
 * opt: ttl, swr (serve stale & refresh in background), retryAfter (failure back-off),
 *      validate(buf,res) (throw to reject a payload), type, timeout, feed, headers
 */
async function getCached(key, url, opt = {}) {
  const ttl = opt.ttl ?? HOUR;
  let entry = memGet(key);
  if (!entry) { entry = await readDisk(key); if (entry) memPut(key, entry); }
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  if (age < ttl) return { entry, cache: 'HIT' };

  const fail = failures.get(key);
  if (fail && Date.now() - fail.at < (opt.retryAfter ?? 2 * MIN)) {
    if (entry) return { entry, cache: 'STALE' };
    throw new HttpError(502, fail.message);
  }
  let job = inflight.get(key);
  if (!job) {
    job = refresh(key, url, entry, opt).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  if (entry && opt.swr) { job.catch(() => {}); return { entry, cache: 'STALE' }; }
  return job;
}

async function refresh(key, url, prev, opt) {
  const host = new URL(url).hostname;
  const limiter = LIMITERS[host] || DEFAULT_LIMITER;
  const busy = hostBusy(host, limiter, opt);
  if (busy) { if (prev) return { entry: prev, cache: 'STALE' }; throw busy; }
  const t0 = Date.now();
  try {
    const result = await limiter.run(async () => {
      const headers = { 'user-agent': UA, accept: opt.accept || '*/*', ...(opt.headers || {}) };
      if (prev?.lastModified) headers['if-modified-since'] = prev.lastModified;
      if (prev?.etag) headers['if-none-match'] = prev.etag;
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(opt.timeout ?? 30_000) });
      if (res.status === 304 && prev) return { notModified: true };
      return { res, body: Buffer.from(await res.arrayBuffer()) };
    });
    if (result.notModified) {
      prev.fetchedAt = Date.now();
      memPut(key, prev); writeDisk(prev).catch(() => {});
      failures.delete(key); noteFeed(opt.feed, true, 'not modified');
      return { entry: prev, cache: 'REVALIDATED' };
    }
    const { res, body } = result;
    if (!res.ok) {
      if (opt.cooldown && (res.status === 429 || res.status === 403)) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? (res.status === 429 ? 2 * MIN : 30 * MIN);
        hostCooldown.set(host, { until: Date.now() + Math.min(wait, 6 * HOUR), message: opt.cooldown });
        const err = new HttpError(503, `${opt.cooldown} Try again in about ${Math.max(1, Math.ceil(wait / MIN))} min.`);
        err.detail = `${host} responded ${res.status}: ${snippet(body)}`;
        throw err;
      }
      // upstream body kept for the server log only; clients get a clean message
      const err = new HttpError(res.status, `${host} responded ${res.status}`);
      err.detail = snippet(body);
      throw err;
    }
    opt.validate?.(body, res);
    const stored = opt.transform ? opt.transform(body) : body;
    const entry = {
      key, url: redact(url), type: opt.type || res.headers.get('content-type') || 'application/octet-stream',
      fetchedAt: Date.now(), lastModified: res.headers.get('last-modified'), etag: res.headers.get('etag'), body: stored,
    };
    memPut(key, entry);
    await writeDisk(entry);
    failures.delete(key); noteFeed(opt.feed, true);
    log(`↓ ${host} ${key} — ${(body.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return { entry, cache: 'MISS' };
  } catch (err) {
    const message = err.name === 'TimeoutError' ? `${host} timed out` : err.message;
    failures.set(key, { at: Date.now(), message });
    noteFeed(opt.feed, false, message);
    log(`✗ ${host} ${key} — ${message}${err.detail ? ` — ${err.detail}` : ''}${prev ? ' (serving last good copy)' : ''}`);
    if (prev) return { entry: prev, cache: 'STALE' };
    throw err instanceof HttpError ? err : new HttpError(502, message);
  }
}

function validJson(buf) { try { JSON.parse(buf.toString('utf8')); } catch { throw new Error(`invalid JSON: ${snippet(buf)}`); } }
function validJsonArray(buf) {
  let v; try { v = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`unexpected response: ${snippet(buf)}`); }
  if (!Array.isArray(v)) throw new Error(`unexpected response: ${snippet(buf)}`);
}
function validImage(buf, res) {
  const t = res.headers.get('content-type') || '';
  if (!t.startsWith('image/') || buf.length < 1000) throw new Error(`not an image (${t}): ${snippet(buf)}`);
}

/* ──────────────────────────────── responses ──────────────────────────────── */

const COMPRESSIBLE = /json|text|javascript|csv|xml|svg/;

/**
 * On Vercel each function instance starts cold with an empty cache, so successful responses are cached by
 * Vercel's CDN (s-maxage). That keeps upstream services (CelesTrak in particular) from being re-downloaded
 * per instance. Locally the disk cache does this job and responses stay no-store.
 */
const CDN_POLICY = [
  [/^\/vendor\//, 31536000, 86400], [/^\/api\/gibs\//, 86400, 3600], [/^\/api\/(sbdb|images|epic-image)/, 86400, 3600],
  [/^\/api\/(environment|satcat)/, 3600, 300], [/^\/api\/socrates\/upcoming$/, 300, 60, 300],
  [/^\/api\/(catalog|socrates|neo|cad|horizons|tle|gp|gp-catnr|epic|sentry)/, 1800, 120],
  [/^\/api\/eonet/, 600, 120], [/^\/api\/swpc\//, 60, 30], [/^\/api\/iss$/, 4, 0], [/^\/api\/geocode$/, 604800, 86400],
];
function cdnCacheControl(pathname) {
  for (const [re, sMax, browser, swr] of CDN_POLICY) {
    if (re.test(pathname)) return `public, max-age=${browser}, s-maxage=${sMax}, stale-while-revalidate=${swr ?? Math.max(30, sMax * 4)}`;
  }
  return null;
}
function send(req, res, status, body, type, extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
  if (res.argusCache && status < 400) headers['cache-control'] = res.argusCache;
  if (buf.length > 1400 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf, { level: 6 }); headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding';
  }
  headers['content-length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const sendJson = (req, res, status, obj, extra) => send(req, res, status, JSON.stringify(obj), JSON_TYPE, extra);

function sendEntry(req, res, { entry, cache }, extra = {}) {
  const headers = {
    'content-type': entry.type, 'x-cache': cache, 'x-fetched-at': new Date(entry.fetchedAt).toISOString(),
    'x-source': new URL(entry.url).hostname, 'cache-control': 'no-store', ...extra,
  };
  if (res.argusCache) headers['cache-control'] = res.argusCache;
  const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzipOk && entry.body.length > 1400 && COMPRESSIBLE.test(entry.type)) {
    entry.gz ??= zlib.gzipSync(entry.body, { level: 6 });
    headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding';
    headers['content-length'] = entry.gz.length;
    res.writeHead(200, headers); return res.end(req.method === 'HEAD' ? undefined : entry.gz);
  }
  headers['content-length'] = entry.body.length;
  res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : entry.body);
}
const meta = (r) => ({ 'x-cache': r.cache, 'x-fetched-at': new Date(r.entry.fetchedAt).toISOString() });

/* ────────────────────────────── CSV helpers ────────────────────────────── */

function parseCsvLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function forEachCsvRow(buf, fn) {
  const text = buf.toString('utf8');
  let start = 0, header = null, row = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start); if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (!line) continue;
    const f = parseCsvLine(line);
    if (!header) { header = Object.fromEntries(f.map((h, i) => [h.trim().toUpperCase(), i])); continue; }
    fn(f, header, row++);
  }
  return header;
}

/* ─────────────────────────────── CelesTrak GP ─────────────────────────────── */

/** Groups merged into the live catalog (CelesTrak names). */
const GP_GROUPS = ['stations', 'active', 'visual', 'gnss', 'weather', 'resource', 'science', 'geo',
  'cosmos-1408-debris', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
const GP_EXTRA = ['starlink', 'oneweb', 'kuiper', 'last-30-days', 'noaa', 'goes', 'planet', 'spire', 'amateur',
  'cubesat', 'military', 'radar', 'geodetic', 'engineering', 'education', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
  'sbas', 'intelsat', 'ses', 'iridium-next', 'orbcomm', 'globalstar', 'tdrss', 'sarsat', 'argos', 'x-comm', 'other-comm'];
const GP_ALLOWED = new Set([...GP_GROUPS, ...GP_EXTRA]);

const gpGroup = (group) => getCached(`gp:${group}`,
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`,
  { ttl: 150 * MIN, swr: true, retryAfter: 20 * MIN, timeout: 120_000, validate: validJsonArray, type: JSON_TYPE, feed: 'celestrak-gp' });

const MEGA = /^(ONEWEB|KUIPER|QIANFAN|GUOWANG|SATNET|HULIANWANG)/;
const CREWED = /^(ISS|POISK|CSS|TIANHE|WENTIAN|MENGTIAN|SZ-\d+ MODULE|SOYUZ|PROGRESS|CREW DRAGON|DRAGON|SHENZHOU|TIANZHOU|CYGNUS|HTV|STARLINER|AXIOM)/;
function classify(name, groups, type) {
  const n = (name || '').toUpperCase();
  if ([...groups].some((g) => g.endsWith('-debris')) || type === 'DEB' || /\bDEB\b/.test(n)) return 'debris';
  if (groups.has('stations') && CREWED.test(n)) return 'stations';
  if (n.startsWith('STARLINK')) return 'starlink';
  if (MEGA.test(n)) return 'megaconst';
  if (groups.has('gnss')) return 'gnss';
  if (groups.has('weather') || groups.has('resource')) return 'earthobs';
  if (groups.has('science')) return 'science';
  if (groups.has('geo')) return 'geo';
  if (groups.has('active')) return 'active';
  return 'inactive';
}

const CATALOG_FIELDS = ['id', 'name', 'cospar', 'cat', 'epoch', 'n', 'e', 'i', 'raan', 'argp', 'ma', 'bstar',
  'ndot', 'nddot', 'elset', 'rev', 'type', 'owner', 'rcs', 'launch'];
const ommRow = (o, cat, sc) => [o.NORAD_CAT_ID, o.OBJECT_NAME, o.OBJECT_ID, cat, o.EPOCH, o.MEAN_MOTION, o.ECCENTRICITY,
  o.INCLINATION, o.RA_OF_ASC_NODE, o.ARG_OF_PERICENTER, o.MEAN_ANOMALY, o.BSTAR, o.MEAN_MOTION_DOT, o.MEAN_MOTION_DDOT,
  o.ELEMENT_SET_NO, o.REV_AT_EPOCH, sc?.type ?? null, sc?.owner ?? null, sc?.rcs ?? null, sc?.launch ?? null];

let catalogMemo = null;
let catalogBuilding = null;
async function buildCatalog() {
  if (catalogBuilding) return catalogBuilding;
  catalogBuilding = (async () => {
    const results = [];
    for (const g of GP_GROUPS) {
      try { results.push({ g, ...(await gpGroup(g)) }); } catch (e) { results.push({ g, error: e.message }); }
    }
    const stamp = results.map((r) => (r.entry ? r.entry.fetchedAt : 'x')).join(',') + '|' + (satcatDb?.stamp ?? 0);
    if (catalogMemo?.stamp === stamp) return catalogMemo;
    const objs = new Map(); const groups = new Map(); const sources = [];
    for (const r of results) {
      if (!r.entry) { sources.push({ group: r.g, error: r.error }); continue; }
      const list = JSON.parse(r.entry.body.toString('utf8'));
      sources.push({ group: r.g, count: list.length, fetchedAt: new Date(r.entry.fetchedAt).toISOString(), cache: r.cache });
      for (const o of list) {
        if (!objs.has(o.NORAD_CAT_ID)) objs.set(o.NORAD_CAT_ID, o);
        let s = groups.get(o.NORAD_CAT_ID); if (!s) groups.set(o.NORAD_CAT_ID, (s = new Set()));
        s.add(r.g);
      }
    }
    const rows = [];
    for (const [id, o] of objs) {
      const sc = satcatDb?.byId.get(id);
      rows.push(ommRow(o, classify(o.OBJECT_NAME, groups.get(id), sc?.type), sc));
    }
    const doc = { generatedAt: new Date().toISOString(), source: 'CelesTrak GP (OMM) · SATCAT', satcat: !!satcatDb, sources, fields: CATALOG_FIELDS, rows };
    const stations = new Set([...groups].filter(([id, s]) => s.has('stations') && CREWED.test((objs.get(id)?.OBJECT_NAME || '').toUpperCase())).map(([id]) => id));
    catalogMemo = { stamp, json: Buffer.from(JSON.stringify(doc)), count: rows.length, stations };
    catalogMemo.gz = zlib.gzipSync(catalogMemo.json, { level: 6 });
    log(`catalog: ${rows.length} objects from ${sources.filter((s) => !s.error).length}/${GP_GROUPS.length} groups${satcatDb ? ' (+SATCAT)' : ''}`);
    return catalogMemo;
  })().finally(() => { catalogBuilding = null; });
  return catalogBuilding;
}

/* ─────────────────────────────── CelesTrak SATCAT ─────────────────────────────── */

let satcatDb = null;
const ACTIVE_OPS = new Set(['+', 'P', 'B', 'S', 'X']);
const CONSTELLATIONS = [
  ['Starlink', /^STARLINK/], ['OneWeb', /^ONEWEB/], ['Kuiper', /^KUIPER/], ['Qianfan', /^QIANFAN/],
  ['Guowang', /^(GUOWANG|SATNET|HULIANWANG)/], ['Iridium', /^IRIDIUM/], ['Globalstar', /^GLOBALSTAR/],
  ['Orbcomm', /^ORBCOMM/], ['Planet', /^(FLOCK|SKYSAT|PELICAN|TANAGER)/], ['Spire', /^LEMUR/],
];

async function ensureSatcat() {
  const r = await getCached('satcat', 'https://celestrak.org/pub/satcat.csv', {
    ttl: 12 * HOUR, swr: true, retryAfter: 30 * MIN, timeout: 240_000, type: 'text/csv', feed: 'celestrak-satcat',
    validate: (b) => { if (!b.subarray(0, 64).toString().startsWith('OBJECT_NAME')) throw new Error(`SATCAT: unexpected format: ${snippet(b)}`); },
  });
  if (!satcatDb || satcatDb.stamp !== r.entry.fetchedAt) {
    const t0 = Date.now();
    satcatDb = buildSatcat(r.entry);
    log(`SATCAT: ${satcatDb.byId.size} records indexed in ${Date.now() - t0} ms`);
  }
  return satcatDb;
}

function buildSatcat(entry) {
  const byId = new Map();
  const rows = [];
  forEachCsvRow(entry.body, (f, h) => {
    const r = {
      name: f[h.OBJECT_NAME], cospar: f[h.OBJECT_ID], id: Number(f[h.NORAD_CAT_ID]), type: f[h.OBJECT_TYPE],
      ops: f[h.OPS_STATUS_CODE], owner: f[h.OWNER], launch: f[h.LAUNCH_DATE], site: f[h.LAUNCH_SITE],
      decay: f[h.DECAY_DATE], period: num(f[h.PERIOD]), inc: num(f[h.INCLINATION]), apogee: num(f[h.APOGEE]),
      perigee: num(f[h.PERIGEE]), rcs: num(f[h.RCS]), center: f[h.ORBIT_CENTER], orbitType: f[h.ORBIT_TYPE],
    };
    if (!Number.isFinite(r.id)) return;
    byId.set(r.id, r); rows.push(r);
  });
  return { stamp: entry.fetchedAt, fetchedAt: new Date(entry.fetchedAt).toISOString(), byId, stats: environmentStats(rows, entry) };
}

function regimeOf(r) {
  if (r.apogee == null || r.perigee == null) return 'Other';
  if (r.apogee < 2000) return 'LEO';
  if (Math.abs(r.perigee - 35786) < 300 && Math.abs(r.apogee - 35786) < 300) return 'GEO';
  if (r.perigee >= 2000 && r.apogee < 35586) return 'MEO';
  return 'HEO/GTO';
}
const typeKey = (t) => (t === 'PAY' ? 'PAY' : t === 'R/B' ? 'RB' : t === 'DEB' ? 'DEB' : 'UNK');
const RE_KM = 6378.137;

function environmentStats(rows, entry) {
  const now = Date.now();
  const thisYear = new Date(now).getUTCFullYear();
  const years = []; for (let y = 1957; y <= thisYear; y++) years.push(y);
  const yi = (y) => y - 1957;
  const zero = () => years.map(() => 0);
  const earth = rows.filter((r) => r.center === 'EA');
  const onOrbit = earth.filter((r) => !r.decay && r.orbitType === 'ORB');

  // Growth curve — debris is dated by an estimated cataloguing date (NORAD IDs are issued in time order).
  const sorted = [...earth].sort((a, b) => a.id - b.id);
  let runningMax = '1957-10-04';
  const diff = { PAY: zero(), RB: zero(), DEB: zero(), UNK: zero() };
  const diffEnd = { PAY: zero(), RB: zero(), DEB: zero(), UNK: zero() };
  for (const r of sorted) {
    const launch = r.launch || runningMax;
    let cat = launch;
    if (r.type === 'PAY' || r.type === 'R/B') { if (launch > runningMax) runningMax = launch; }
    else if (runningMax > cat) cat = runningMax;
    const cy = Number(cat.slice(0, 4)); if (!(cy >= 1957 && cy <= thisYear)) continue;
    const k = typeKey(r.type);
    diff[k][yi(cy)]++;
    if (r.decay) { const dy = Number(r.decay.slice(0, 4)); if (dy >= 1957 && dy <= thisYear) diffEnd[k][yi(dy)]++; }
  }
  const growth = {};
  for (const k of Object.keys(diff)) { let acc = 0; growth[k] = years.map((_, i) => (acc += diff[k][i] - diffEnd[k][i])); }

  // Launch cadence (payloads by launch year) and re-entries by year.
  const launches = { Starlink: zero(), 'Other constellations': zero(), 'All other payloads': zero() };
  const reentries = { PAY: zero(), RB: zero(), DEB: zero(), UNK: zero() };
  for (const r of earth) {
    if (r.type === 'PAY' && r.launch) {
      const y = Number(r.launch.slice(0, 4));
      if (y >= 1957 && y <= thisYear) {
        const n = (r.name || '').toUpperCase();
        const k = n.startsWith('STARLINK') ? 'Starlink' : MEGA.test(n) ? 'Other constellations' : 'All other payloads';
        launches[k][yi(y)]++;
      }
    }
    if (r.decay) { const y = Number(r.decay.slice(0, 4)); if (y >= 1957 && y <= thisYear) reentries[typeKey(r.type)][yi(y)]++; }
  }

  // Current population.
  const byType = { PAY: 0, RB: 0, DEB: 0, UNK: 0 };
  const byRegime = {};
  let activePayloads = 0, deadPayloads = 0, unknownPayloads = 0;
  for (const r of onOrbit) {
    byType[typeKey(r.type)]++;
    if (r.type === 'PAY' && r.ops === '-') deadPayloads++;
    else if (r.type === 'PAY' && !ACTIVE_OPS.has(r.ops)) unknownPayloads++;
    const g = regimeOf(r);
    byRegime[g] ??= { PAY: 0, RB: 0, DEB: 0, UNK: 0, active: 0 };
    byRegime[g][typeKey(r.type)]++;
    if (r.type === 'PAY' && ACTIVE_OPS.has(r.ops)) { activePayloads++; byRegime[g].active++; }
  }

  // Constellations among active payloads.
  const constellations = CONSTELLATIONS.map(([name, re]) => ({ name, active: 0, onOrbit: 0 }));
  const owners = new Map();
  for (const r of onOrbit) {
    if (r.type !== 'PAY') continue;
    const n = (r.name || '').toUpperCase();
    const active = ACTIVE_OPS.has(r.ops);
    CONSTELLATIONS.forEach(([, re], i) => { if (re.test(n)) { constellations[i].onOrbit++; if (active) constellations[i].active++; } });
    if (active) owners.set(r.owner, (owners.get(r.owner) || 0) + 1);
  }

  // LEO altitude shells (200–2000 km, 25 km bins) and spatial density.
  const BIN = 25, H0 = 200, H1 = 2000, nb = (H1 - H0) / BIN;
  const shellKeys = ['Starlink', 'Other active', 'Inactive payloads', 'Rocket bodies', 'Debris', 'Unknown'];   // 'Inactive' includes unknown status
  const shells = Object.fromEntries(shellKeys.map((k) => [k, new Array(nb).fill(0)]));
  for (const r of onOrbit) {
    if (r.apogee == null || r.perigee == null || r.perigee >= H1) continue;
    let k;
    if (r.type === 'PAY') k = ACTIVE_OPS.has(r.ops) ? ((r.name || '').toUpperCase().startsWith('STARLINK') ? 'Starlink' : 'Other active') : 'Inactive payloads';
    else k = r.type === 'R/B' ? 'Rocket bodies' : r.type === 'DEB' ? 'Debris' : 'Unknown';
    if (r.apogee - r.perigee <= 50) {
      const b = Math.floor(((r.apogee + r.perigee) / 2 - H0) / BIN); if (b >= 0 && b < nb) shells[k][b] += 1;
    } else {
      // fraction of the orbital period spent in each shell (Kepler time of flight)
      const rp = RE_KM + r.perigee, ra = RE_KM + r.apogee, a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
      const M = (rr) => { const x = Math.min(ra, Math.max(rp, rr)); const E = Math.acos(Math.min(1, Math.max(-1, (1 - x / a) / e))); return E - e * Math.sin(E); };
      const b0 = Math.max(0, Math.floor((r.perigee - H0) / BIN)), b1 = Math.min(nb - 1, Math.floor((r.apogee - H0) / BIN));
      for (let b = b0; b <= b1; b++) shells[k][b] += (M(RE_KM + H0 + (b + 1) * BIN) - M(RE_KM + H0 + b * BIN)) / Math.PI;
    }
  }
  const RE = RE_KM;
  const shellVolume = (h) => (4 / 3) * Math.PI * ((RE + h + BIN) ** 3 - (RE + h) ** 3);
  const density = new Array(nb).fill(0).map((_, b) => {
    let total = 0; for (const k of shellKeys) total += shells[k][b];
    return total / shellVolume(H0 + b * BIN);
  });

  // Disposal outlook: natural decay time of active LEO payloads (nominal payload ballistic parameter).
  const outlook = { '< 5 yr': 0, '5–25 yr': 0, '25–100 yr': 0, '> 100 yr': 0 };
  for (const r of onOrbit) {
    if (r.type !== 'PAY' || !ACTIVE_OPS.has(r.ops) || r.apogee == null || r.apogee >= 2000) continue;
    const y = lifetimeYears(r.perigee, r.apogee, BALLISTIC.PAY);
    outlook[y < 5 ? '< 5 yr' : y < 25 ? '5–25 yr' : y < 100 ? '25–100 yr' : '> 100 yr']++;
  }

  // Recent re-entries.
  const since30 = isoDate(now - 30 * DAY);
  const recent = earth.filter((r) => r.decay && r.decay >= since30).sort((a, b) => (a.decay < b.decay ? 1 : -1));
  const recentByType = { PAY: 0, RB: 0, DEB: 0, UNK: 0 };
  for (const r of recent) recentByType[typeKey(r.type)]++;
  const launched30 = earth.filter((r) => r.launch && r.launch >= since30 && r.type === 'PAY').length;

  // Major fragmentation events: everything catalogued under the parent launch designators.
  const FRAG = [['1999-025'], ['1997-051', '1993-036'], ['1982-092'], ['2024-140']];
  const fragmentations = Object.fromEntries(FRAG.map((pre) => {
    const objs = earth.filter((r) => pre.some((p) => (r.cospar || '').startsWith(p)));
    return [pre.join(','), { catalogued: objs.length, onOrbit: objs.filter((r) => !r.decay).length }];
  }));

  return {
    generatedAt: new Date().toISOString(), source: 'CelesTrak SATCAT', satcatFetchedAt: new Date(entry.fetchedAt).toISOString(), fragmentations,
    totals: { onOrbit: onOrbit.length, activePayloads, deadPayloads, unknownPayloads, byType, catalogued: rows.length },
    byRegime, years, growth, launches, reentries,
    constellations: constellations.filter((c) => c.onOrbit > 0).sort((a, b) => b.active - a.active),
    owners: [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([owner, count]) => ({ owner, count })),
    shells: { binKm: BIN, fromKm: H0, toKm: H1, series: shells, densityPerKm3: density },
    lifetime: { altitude5yr: lifetimeAltitude(5), altitude25yr: lifetimeAltitude(25), altitude100yr: lifetimeAltitude(100), outlook, model: 'circular decay, exponential atmosphere (moderate solar activity), Cd·A/m = 0.01 m²/kg' },
    recentReentries: { days: 30, byType: recentByType, count: recent.length, list: recent.slice(0, 30).map((r) => ({ id: r.id, name: r.name, type: r.type, owner: r.owner, decay: r.decay, launch: r.launch })) },
    launchedLast30Days: launched30,
  };
}

/* ─────────────────────────────── CelesTrak SOCRATES ─────────────────────────────── */

let socratesDb = null;
async function ensureSocrates() {
  await ensureSatcat().catch(() => {});
  const r = await getCached('socrates', 'https://celestrak.org/SOCRATES/sort-minRange.csv', {
    ttl: 6 * HOUR, swr: true, retryAfter: 30 * MIN, timeout: 400_000, type: 'text/csv', feed: 'celestrak-socrates',
    validate: (b) => { if (!/NORAD_CAT_ID_1/i.test(b.subarray(0, 400).toString())) throw new Error(`SOCRATES: unexpected format: ${snippet(b)}`); },
  });
  if (!socratesDb || socratesDb.stamp !== r.entry.fetchedAt || socratesDb.satStamp !== (satcatDb?.stamp ?? 0)) {
    const t0 = Date.now();
    socratesDb = buildSocrates(r.entry);
    log(`SOCRATES: ${socratesDb.n} conjunctions indexed in ${Date.now() - t0} ms`);
  }
  // Run metadata (primaries/secondaries screened, computation interval) is only published on the HTML report.
  if (!socratesDb.summary.run) {
    try {
      const h = await getCached('socrates-run', 'https://celestrak.org/SOCRATES/table-socrates.php?NAME=,&ORDER=MAXPROB&MAX=1',
        { ttl: 6 * HOUR, swr: true, retryAfter: 30 * MIN, type: 'text/html', timeout: 60_000 });
      const t = h.entry.body.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const m = /Considering:\s*([\d,]+)\s*Primaries,\s*([\d,]+)\s*Secondaries/i.exec(t);
      const asOf = /Data current as of\s*([^|]+?UTC)/i.exec(t);
      const run = /Computation run time:\s*([\dhms .]+)/i.exec(t);
      if (m) socratesDb.summary.run = { primaries: Number(m[1].replace(/,/g, '')), secondaries: Number(m[2].replace(/,/g, '')), dataAsOf: asOf?.[1]?.trim() ?? null, runTime: run?.[1]?.trim() ?? null };
    } catch { /* optional metadata */ }
  }
  return socratesDb;
}

function buildSocrates(entry) {
  const cols = { id1: [], id2: [], dse1: [], dse2: [], tca: [], range: [], speed: [], prob: [], dil: [] };
  const names = new Map();
  const nameOf = (raw) => { const m = /^(.*?)\s*\[(.)\]\s*$/.exec(raw || ''); return m ? [m[1], m[2]] : [raw || '', '']; };
  forEachCsvRow(entry.body, (f, h) => {
    const id1 = Number(f[h.NORAD_CAT_ID_1]), id2 = Number(f[h.NORAD_CAT_ID_2]);
    if (!Number.isFinite(id1) || !Number.isFinite(id2)) return;
    if (!names.has(id1)) names.set(id1, nameOf(f[h.OBJECT_NAME_1]));
    if (!names.has(id2)) names.set(id2, nameOf(f[h.OBJECT_NAME_2]));
    cols.id1.push(id1); cols.id2.push(id2);
    cols.dse1.push(Number(f[h.DSE_1])); cols.dse2.push(Number(f[h.DSE_2]));
    cols.tca.push(Date.parse(f[h.TCA].trim().replace(' ', 'T') + 'Z'));
    cols.range.push(Number(f[h.TCA_RANGE])); cols.speed.push(Number(f[h.TCA_RELATIVE_SPEED]));
    cols.prob.push(Number(f[h.MAX_PROB])); cols.dil.push(Number(f[h.DILUTION]));
  });
  const n = cols.id1.length;
  const docked = new Uint8Array(n);
  const cls = new Uint8Array(n);          // 0 same operator · 1 cross-operator · 2 active↔derelict · 3 derelict↔derelict
  const altKm = new Float32Array(n).fill(NaN);
  const byObject = new Map();
  let minT = Infinity, maxT = -Infinity, nDocked = 0;
  const counts = { lt1km: 0, lt100m: 0, p1e3: 0, p1e4: 0, p1e5: 0, starlinkAny: 0, starlinkBoth: 0, debrisAny: 0, rbAny: 0, payloadPair: 0 };
  const classes = [0, 1, 2, 3].map(() => ({ total: 0, lt1km: 0, p1e4: 0 }));
  const SHELL = 25, S0 = 200, S1 = 2000, ns = (S1 - S0) / SHELL;
  const shells = [0, 1, 2, 3].map(() => new Array(ns).fill(0));
  const exposure = new Map();
  const perDay = new Map();
  const info = new Map();
  const objInfo = (id) => {
    let o = info.get(id);
    if (o) return o;
    const [name, status] = names.get(id);
    const sc = satcatDb?.byId.get(id);
    const type = sc?.type || (/\bDEB\b/.test(name) ? 'DEB' : /\bR\/B\b/.test(name) ? 'R/B' : null);
    const active = type === 'PAY' ? ACTIVE_OPS.has(status || sc?.ops) : ACTIVE_OPS.has(status) && type !== 'DEB' && type !== 'R/B';
    o = { active, op: operatorKey(name, sc), alt: sc && sc.apogee != null && sc.perigee != null && sc.apogee - sc.perigee < 300 ? (sc.apogee + sc.perigee) / 2 : NaN };
    info.set(id, o);
    return o;
  };
  for (let i = 0; i < n; i++) {
    const isDocked = cols.speed[i] < 0.01 && cols.range[i] < 0.05 && CREWED.test(names.get(cols.id1[i])[0].toUpperCase()) && CREWED.test(names.get(cols.id2[i])[0].toUpperCase());
    docked[i] = isDocked ? 1 : 0;
    for (const id of [cols.id1[i], cols.id2[i]]) { let a = byObject.get(id); if (!a) byObject.set(id, (a = [])); a.push(i); }
    if (isDocked) { nDocked++; continue; }
    const t = cols.tca[i]; if (t < minT) minT = t; if (t > maxT) maxT = t;
    const d = isoDate(t); perDay.set(d, (perDay.get(d) || 0) + 1);
    const close = cols.range[i] < 1, risky = cols.prob[i] >= 1e-4;
    if (close) counts.lt1km++;
    if (cols.range[i] < 0.1) counts.lt100m++;
    if (cols.prob[i] >= 1e-3) counts.p1e3++;
    if (risky) counts.p1e4++;
    if (cols.prob[i] >= 1e-5) counts.p1e5++;
    const s1 = names.get(cols.id1[i])[0].toUpperCase().startsWith('STARLINK');
    const s2 = names.get(cols.id2[i])[0].toUpperCase().startsWith('STARLINK');
    if (s1 || s2) counts.starlinkAny++;
    if (s1 && s2) counts.starlinkBoth++;
    const t1 = satcatDb?.byId.get(cols.id1[i])?.type, t2 = satcatDb?.byId.get(cols.id2[i])?.type;
    if (t1 === 'DEB' || t2 === 'DEB') counts.debrisAny++;
    if (t1 === 'R/B' || t2 === 'R/B') counts.rbAny++;
    if (t1 === 'PAY' && t2 === 'PAY') counts.payloadPair++;
    const a = objInfo(cols.id1[i]), b = objInfo(cols.id2[i]);
    const k = a.active && b.active ? (a.op === b.op ? 0 : 1) : a.active || b.active ? 2 : 3;
    cls[i] = k;
    classes[k].total++; if (close) classes[k].lt1km++; if (risky) classes[k].p1e4++;
    const alt = Number.isFinite(a.alt) ? a.alt : b.alt;
    altKm[i] = alt;
    if (alt >= S0 && alt < S1) shells[k][Math.floor((alt - S0) / SHELL)]++;
    if (close && k !== 0) for (const id of [cols.id1[i], cols.id2[i]]) exposure.set(id, (exposure.get(id) || 0) + 1);
  }
  const mostExposed = [...exposure.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([id, count]) => {
    const [name, status] = names.get(id); const sc = satcatDb?.byId.get(id);
    return { id, name, status, type: sc?.type ?? null, owner: sc?.owner ?? null, count, altKm: objInfo(id).alt };
  });
  return {
    stamp: entry.fetchedAt, satStamp: satcatDb?.stamp ?? 0, n, cols, names, docked, cls, altKm, byObject,
    summary: {
      source: 'CelesTrak SOCRATES Plus', fetchedAt: new Date(entry.fetchedAt).toISOString(),
      publishedAt: entry.lastModified ? new Date(entry.lastModified).toISOString() : null,
      windowStart: Number.isFinite(minT) ? new Date(minT).toISOString() : null, windowEnd: Number.isFinite(maxT) ? new Date(maxT).toISOString() : null,
      thresholdKm: 5, total: n - nDocked, dockedPairsExcluded: nDocked, objectsInvolved: byObject.size, satcatJoined: !!satcatDb,
      counts, perDay: [...perDay.entries()].sort(),
      classes: { labels: ['Same operator (identified fleets)', 'Cross-operator', 'Active ↔ derelict', 'Derelict ↔ derelict'], stats: classes },
      shells: { binKm: SHELL, fromKm: S0, toKm: S1, byClass: shells },
      mostExposed,
    },
  };
}

/** Operator grouping: known constellations by name, otherwise the SATCAT owner code. */
const OPERATORS = [[/^STARLINK/, 'SpaceX'], [/^ONEWEB/, 'Eutelsat OneWeb'], [/^KUIPER/, 'Amazon'], [/^QIANFAN/, 'Spacesail'],
  [/^(GUOWANG|SATNET|HULIANWANG)/, 'China SatNet'], [/^IRIDIUM/, 'Iridium'], [/^GLOBALSTAR/, 'Globalstar'], [/^ORBCOMM/, 'Orbcomm'],
  [/^(FLOCK|SKYSAT|PELICAN|TANAGER)/, 'Planet'], [/^LEMUR/, 'Spire']];
const COMPANY_OWNERS = new Set(['SES', 'O3B', 'ITSO', 'EUTE', 'GLOB', 'IRID', 'ORB']);
function operatorKey(name, sc) {
  const n = (name || '').toUpperCase();
  for (const [re, op] of OPERATORS) if (re.test(n)) return op;
  if (sc?.owner && COMPANY_OWNERS.has(sc.owner)) return `owner:${sc.owner}`;
  return `obj:${sc?.id ?? n}`;   // unidentified operator → treated as distinct (conservative)
}

function socratesRow(db, i) {
  const { cols, names } = db;
  const [n1, s1] = names.get(cols.id1[i]); const [n2, s2] = names.get(cols.id2[i]);
  return {
    id1: cols.id1[i], name1: n1, status1: s1, dse1: cols.dse1[i], type1: satcatDb?.byId.get(cols.id1[i])?.type ?? null,
    id2: cols.id2[i], name2: n2, status2: s2, dse2: cols.dse2[i], type2: satcatDb?.byId.get(cols.id2[i])?.type ?? null,
    tca: new Date(cols.tca[i]).toISOString(), rangeKm: cols.range[i], speedKms: cols.speed[i], maxProb: cols.prob[i],
    dilutionKm: cols.dil[i], docked: !!db.docked[i], coorbital: cols.speed[i] < 0.1, cls: db.cls[i], altKm: Number.isFinite(db.altKm[i]) ? Math.round(db.altKm[i]) : null,
  };
}

/* ─────────────────────────────── route handlers ─────────────────────────────── */

const ROUTES = [];
const route = (re, fn) => ROUTES.push([re, fn]);

route(/^\/api\/health$/, (req, res) => sendJson(req, res, 200, {
  ok: true, server: 'argus', uptimeS: Math.round(process.uptime()), cacheEntries: memCache.size,
  nasaKey: { mode: nasa.key === 'DEMO_KEY' ? 'DEMO_KEY' : 'custom', status: nasa.status },
  feeds: Object.fromEntries(feedState), satcat: satcatDb?.fetchedAt ?? null, socrates: socratesDb?.summary.fetchedAt ?? null,
}));

route(/^\/api\/catalog$/, async (req, res) => {
  if (!satcatDb) await Promise.race([ensureSatcat().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  const c = await buildCatalog();
  const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gzipOk ? c.gz : c.json;
  res.writeHead(200, { 'content-type': JSON_TYPE, 'cache-control': res.argusCache || 'no-store', 'content-length': body.length, ...(gzipOk ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : body);
});

route(/^\/api\/gp\/([a-z0-9-]+)$/i, async (req, res, m) => {
  const g = m[1].toLowerCase();
  if (!GP_ALLOWED.has(g)) throw new HttpError(404, `unknown CelesTrak group "${g}"`);
  sendEntry(req, res, await gpGroup(g));
});

route(/^\/api\/gp-catnr\/(\d{1,9})$/, async (req, res, m) => {
  sendEntry(req, res, await getCached(`gp-catnr:${m[1]}`, `https://celestrak.org/NORAD/elements/gp.php?CATNR=${m[1]}&FORMAT=json`,
    { ttl: 150 * MIN, retryAfter: 10 * MIN, validate: validJsonArray, type: JSON_TYPE, feed: 'celestrak-gp' }));
});

route(/^\/api\/satcat\/(\d{1,9})$/, async (req, res, m) => {
  const db = await ensureSatcat();
  const rec = db.byId.get(Number(m[1]));
  if (!rec) throw new HttpError(404, 'not in SATCAT');
  sendJson(req, res, 200, rec, { 'x-fetched-at': db.fetchedAt });
});

route(/^\/api\/environment$/, async (req, res) => {
  const db = await ensureSatcat();
  sendJson(req, res, 200, db.stats, { 'x-fetched-at': db.fetchedAt });
});

route(/^\/api\/socrates\/summary$/, async (req, res) => {
  const db = await ensureSocrates();
  sendJson(req, res, 200, db.summary, { 'x-fetched-at': db.summary.fetchedAt });
});

/**
 * Ranked conjunction lists. filter: all | cross (drops Starlink↔Starlink pairs, which SpaceX screens and
 * manoeuvres internally) | debris (debris or rocket body involved) | crewed (a space-station object involved).
 * sort: prob | range | soon (Max Pc ≥ 1e-5, soonest first). Past TCAs are dropped at request time.
 */
function socratesList(db, filter, sort) {
  const key = `${filter}:${sort}`;
  db.lists ??= new Map();
  if (db.lists.has(key)) return db.lists.get(key);
  const { cols, names } = db;
  const isSL = (id) => names.get(id)[0].toUpperCase().startsWith('STARLINK');
  const junk = (id) => { const t = satcatDb?.byId.get(id)?.type; return t === 'DEB' || t === 'R/B' || /\b(DEB|R\/B)\b/.test(names.get(id)[0]); };
  const crewed = catalogMemo?.stations ?? new Set([25544, 48274]);
  const idx = [];
  for (let i = 0; i < db.n; i++) {
    if (db.docked[i]) continue;
    const a = cols.id1[i], b = cols.id2[i];
    if (filter === 'cross' && isSL(a) && isSL(b)) continue;
    if (filter === 'external' && db.cls[i] !== 1 && db.cls[i] !== 2) continue;
    if (filter === 'crossop' && db.cls[i] !== 1) continue;
    if (filter === 'onesided' && db.cls[i] !== 2) continue;
    if (filter === 'derelict' && db.cls[i] !== 3) continue;
    if (filter === 'debris' && !junk(a) && !junk(b)) continue;
    if (filter === 'crewed' && !crewed.has(a) && !crewed.has(b)) continue;
    if (sort === 'soon' && cols.prob[i] < 1e-5) continue;
    idx.push(i);
  }
  const cmp = sort === 'range' ? (x, y) => cols.range[x] - cols.range[y]
    : sort === 'soon' ? (x, y) => cols.tca[x] - cols.tca[y]
      : (x, y) => cols.prob[y] - cols.prob[x] || cols.range[x] - cols.range[y];
  idx.sort(cmp);
  const out = { idx: Int32Array.from(idx) };
  db.lists.set(key, out);
  return out;
}

route(/^\/api\/socrates\/top$/, async (req, res, m, q) => {
  const db = await ensureSocrates();
  const limit = Math.min(400, Math.max(1, Number(q.get('limit')) || 100));
  const filter = ['all', 'external', 'cross', 'crossop', 'onesided', 'derelict', 'debris', 'crewed'].includes(q.get('filter')) ? q.get('filter') : 'all';
  const sort = ['prob', 'range', 'soon'].includes(q.get('sort')) ? q.get('sort') : 'prob';
  const list = socratesList(db, filter, sort);
  const cutoff = Date.now() - 10 * MIN;
  const live = [];
  let matching = 0;
  for (const i of list.idx) { if (db.cols.tca[i] < cutoff) continue; matching++; if (live.length < limit) live.push(i); }
  sendJson(req, res, 200, { summary: db.summary, filter, sort, matching, rows: live.map((i) => socratesRow(db, i)) }, { 'x-fetched-at': db.summary.fetchedAt });
});

/**
 * Upcoming conjunctions of interest (compact rows), so the browser can work out which ones happen in the sky
 * above a chosen place. Kept: Max Pc ≥ minPc OR miss ≤ maxRange km; same-operator pairs only with same=1.
 */
route(/^\/api\/socrates\/upcoming$/, async (req, res, m, q) => {
  const db = await ensureSocrates();
  const hours = Math.min(168, Math.max(1, Number(q.get('hours')) || 48));
  const minPc = Math.min(1, Math.max(1e-8, Number(q.get('minPc')) || 1e-4));
  const maxRange = Math.min(5, Math.max(0, Number(q.get('maxRange')) || 1));
  const same = q.get('same') === '1';
  const now = Date.now(), end = now + hours * HOUR, CAP = 8000;
  const idx = [];
  for (let i = 0; i < db.n; i++) {
    if (db.docked[i] || (!same && db.cls[i] === 0)) continue;
    const t = db.cols.tca[i];
    if (t < now - 10 * MIN || t > end) continue;
    if (db.cols.prob[i] < minPc && db.cols.range[i] > maxRange) continue;
    idx.push(i);
  }
  idx.sort((a, b) => db.cols.tca[a] - db.cols.tca[b]);
  const names = {};
  const rows = idx.slice(0, CAP).map((i) => {
    const a = db.cols.id1[i], b = db.cols.id2[i];
    names[a] ??= db.names.get(a); names[b] ??= db.names.get(b);
    return [a, b, db.cols.tca[i], db.cols.range[i], db.cols.speed[i], db.cols.prob[i], db.cls[i], db.cols.dse1[i], db.cols.dse2[i]];
  });
  sendJson(req, res, 200, {
    hours, minPc, maxRangeKm: maxRange, includeSameOperator: same, matching: idx.length, truncated: Math.max(0, idx.length - CAP),
    publishedAt: db.summary.publishedAt, fields: ['id1', 'id2', 'tcaMs', 'rangeKm', 'speedKms', 'maxProb', 'cls', 'dse1', 'dse2'], names, rows,
  }, { 'x-fetched-at': db.summary.fetchedAt });
});

/**
 * Place search via OpenStreetMap Nominatim. Usage policy: ≤ 1 request/s (limiter above), an identifying User-Agent,
 * results cached (30 days here, 7 days at the CDN), and no search-as-you-type — the client only searches on submit.
 * At most 12 lookups wait in the queue; a 429/403 pauses lookups for Retry-After (or 2 / 30 min).
 */
route(/^\/api\/geocode$/, async (req, res, m, q) => {
  const s = (q.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (s.length < 2) throw new HttpError(400, 'query too short');
  const params = new URLSearchParams({ q: s, format: 'jsonv2', limit: '6', 'accept-language': 'en' });
  const r = await getCached(`geocode:${s.toLowerCase()}`, `${NOMINATIM_URL}/search?${params}`, {
    ttl: 30 * DAY, retryAfter: MIN, validate: validJsonArray, type: JSON_TYPE, feed: 'osm-nominatim', timeout: 20_000,
    maxQueue: 12, busyMessage: 'Place search is busy (OpenStreetMap allows one lookup per second). Try again in a few seconds, or type coordinates such as 43.776, -79.258.',
    cooldown: 'Place search is paused because OpenStreetMap asked us to slow down. You can still type coordinates such as 43.776, -79.258.',
  });
  const results = JSON.parse(r.entry.body.toString('utf8')).map((p) => ({
    name: p.name || String(p.display_name || '').split(',')[0], label: p.display_name, lat: Number(p.lat), lon: Number(p.lon),
    kind: [p.category, p.type].filter(Boolean).join(' · '), importance: p.importance ?? 0,
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  sendJson(req, res, 200, { query: s, attribution: '© OpenStreetMap contributors (ODbL) · search by Nominatim', results }, meta(r));
});

/** Objects in external (cross-operator or active↔derelict) encounters with Max Pc ≥ minPc in the next `hours`. */
route(/^\/api\/socrates\/risky$/, async (req, res, m, q) => {
  const db = await ensureSocrates();
  const hours = Math.min(168, Math.max(1, Number(q.get('hours')) || 24));
  const minPc = Math.min(1, Math.max(1e-8, Number(q.get('minPc')) || 1e-4));
  const now = Date.now(), end = now + hours * HOUR;
  const best = new Map();
  let events = 0;
  for (let i = 0; i < db.n; i++) {
    if (db.docked[i] || db.cls[i] === 0) continue;
    const t = db.cols.tca[i];
    if (t < now - 10 * MIN || t > end || db.cols.prob[i] < minPc) continue;
    events++;
    for (const id of [db.cols.id1[i], db.cols.id2[i]]) {
      const b = best.get(id);
      if (!b || db.cols.prob[i] > b[1]) best.set(id, [id, db.cols.prob[i], new Date(t).toISOString(), db.cols.range[i]]);
    }
  }
  sendJson(req, res, 200, { hours, minPc, events, count: best.size, objects: [...best.values()] }, { 'x-fetched-at': db.summary.fetchedAt });
});

route(/^\/api\/socrates\/object\/(\d{1,9})$/, async (req, res, m) => {
  const db = await ensureSocrates();
  const idx = db.byObject.get(Number(m[1])) || [];
  const rows = idx.map((i) => socratesRow(db, i)).sort((a, b) => (a.tca < b.tca ? -1 : 1));
  sendJson(req, res, 200, { summary: db.summary, rows }, { 'x-fetched-at': db.summary.fetchedAt });
});

// TLE API listed on api.nasa.gov (mirror of CelesTrak GP data)
route(/^\/api\/tle\/search$/, async (req, res, m, q) => {
  const s = (q.get('q') || '').trim().slice(0, 60);
  if (s.length < 2) throw new HttpError(400, 'query too short');
  sendEntry(req, res, await getCached(`tle-search:${s.toLowerCase()}`, `https://tle.ivanstanojevic.me/api/tle/?search=${encodeURIComponent(s)}&page-size=25`,
    { ttl: HOUR, validate: validJson, type: JSON_TYPE, feed: 'tle-api' }));
});
route(/^\/api\/tle\/(\d{1,9})$/, async (req, res, m) => {
  sendEntry(req, res, await getCached(`tle:${m[1]}`, `https://tle.ivanstanojevic.me/api/tle/${m[1]}`,
    { ttl: 2 * HOUR, validate: validJson, type: JSON_TYPE, feed: 'tle-api' }));
});

// NASA NeoWs (api.nasa.gov) — key from .env, automatic DEMO_KEY fallback.
async function nasaGet(key, pathAndQuery, opt) {
  const attempt = () => getCached(key, `https://api.nasa.gov${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(nasa.key)}`,
    { validate: validJson, type: JSON_TYPE, transform: (b) => Buffer.from(b.toString('utf8').replace(/api_key=[^"&\s]+/g, 'api_key=REDACTED')), ...opt });
  try {
    const r = await attempt();
    if (nasa.status === 'unverified' && r.cache === 'MISS') nasa.status = 'valid';
    return r;
  } catch (e) {
    if (e.status === 403 && /API_KEY_INVALID/.test(e.detail || e.message) && nasa.key !== 'DEMO_KEY') {
      log('NASA API key rejected (API_KEY_INVALID) — falling back to DEMO_KEY');
      nasa.key = 'DEMO_KEY'; nasa.status = 'invalid'; failures.delete(key);
      return attempt();
    }
    throw e;
  }
}
route(/^\/api\/neo\/feed$/, async (req, res, m, q) => {
  const start = q.get('start'), end = q.get('end');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new HttpError(400, 'start/end must be YYYY-MM-DD');
  const span = (Date.parse(end) - Date.parse(start)) / DAY;
  if (!(span >= 0 && span <= 7)) throw new HttpError(400, 'NeoWs feed spans at most 7 days');
  const r = await nasaGet(`neo-feed2:${start}:${end}`, `/neo/rest/v1/feed?start_date=${start}&end_date=${end}`,
    { ttl: 6 * HOUR, retryAfter: 30 * MIN, feed: 'nasa-neows' });
  sendEntry(req, res, r, { 'x-nasa-key': nasa.key === 'DEMO_KEY' ? 'DEMO_KEY' : 'custom' });
});

// JPL Small-Body Database (orbit + physical parameters)
route(/^\/api\/sbdb$/, async (req, res, m, q) => {
  const des = (q.get('des') || '').trim();
  if (!/^[\w\s()/-]{1,40}$/.test(des)) throw new HttpError(400, 'bad designation');
  // full-prec=1: without it SBDB rounds elements to ~3 significant digits (degrees of position error for NEOs).
  sendEntry(req, res, await getCached(`sbdb-fp:${des.toLowerCase()}`, `https://ssd-api.jpl.nasa.gov/sbdb.api?des=${encodeURIComponent(des)}&phys-par=1&full-prec=1`,
    { ttl: DAY, retryAfter: 5 * MIN, validate: validJson, type: JSON_TYPE, feed: 'jpl-sbdb', timeout: 40_000 }));
});

// JPL CNEOS close-approach data
route(/^\/api\/cad$/, async (req, res, m, q) => {
  const days = Math.min(365, Math.max(1, Number(q.get('days')) || 60));
  const dist = Math.min(0.2, Math.max(0.001, Number(q.get('dist')) || 0.05));
  sendEntry(req, res, await getCached(`cad:${days}:${dist}`,
    `https://ssd-api.jpl.nasa.gov/cad.api?date-min=now&date-max=%2B${days}&dist-max=${dist}&sort=date&diameter=true&fullname=true`,
    { ttl: HOUR, validate: validJson, type: JSON_TYPE, feed: 'jpl-cad' }));
});

// JPL Sentry impact monitoring (summary table)
route(/^\/api\/sentry$/, async (req, res) => {
  sendEntry(req, res, await getCached('sentry', 'https://ssd-api.jpl.nasa.gov/sentry.api',
    { ttl: 6 * HOUR, validate: validJson, type: JSON_TYPE, feed: 'jpl-sentry' }));
});

// JPL Horizons — geocentric state vectors (ICRF, km & km/s) around "now", for precise asteroid pointing.
route(/^\/api\/horizons\/vectors$/, async (req, res, m, q) => {
  const id = (q.get('id') || '').trim();
  if (!/^\d{4,9}$/.test(id)) throw new HttpError(400, 'id must be a JPL SPK-ID');
  const block = 6 * HOUR;
  const start = Math.floor(Date.now() / block) * block - DAY;
  const stop = start + 84 * HOUR;
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const params = new URLSearchParams({
    format: 'json', COMMAND: `'DES=${id};'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS',
    CENTER: "'500@399'", START_TIME: `'${fmt(start)}'`, STOP_TIME: `'${fmt(stop)}'`, STEP_SIZE: "'30 m'",
    REF_PLANE: 'FRAME', REF_SYSTEM: 'ICRF', VEC_TABLE: '2', VEC_CORR: 'NONE', CSV_FORMAT: 'YES', OUT_UNITS: 'KM-S', TIME_TYPE: 'UT',
  });
  const r = await getCached(`horizons:${id}:${start}`, `https://ssd.jpl.nasa.gov/api/horizons.api?${params}`,
    { ttl: 12 * HOUR, retryAfter: 5 * MIN, validate: validJson, type: JSON_TYPE, feed: 'jpl-horizons', timeout: 45_000 });
  const j = JSON.parse(r.entry.body.toString('utf8'));
  const txt = j.result || '';
  const s = txt.indexOf('$$SOE'), e = txt.indexOf('$$EOE');
  if (s < 0 || e < 0) throw new HttpError(404, (j.error || txt.slice(0, 200)).trim() || 'no ephemeris');
  const rows = [];
  for (const line of txt.slice(s + 5, e).split('\n')) {
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 8 || !Number.isFinite(Number(f[0]))) continue;
    rows.push([Number(f[0]), Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5]), Number(f[6]), Number(f[7])]);
  }
  sendJson(req, res, 200, { source: 'JPL Horizons', id, frame: 'ICRF geocentric', timeScale: 'UT (JD)', units: 'km, km/s', rows }, meta(r));
});

// NASA EONET natural events
route(/^\/api\/eonet$/, async (req, res, m, q) => {
  const days = Math.min(365, Math.max(1, Number(q.get('days')) || 30));
  sendEntry(req, res, await getCached(`eonet:${days}`, `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=${days}`,
    { ttl: 15 * MIN, validate: validJson, type: JSON_TYPE, feed: 'nasa-eonet', timeout: 40_000 }));
});

// NASA Image and Video Library
route(/^\/api\/images$/, async (req, res, m, q) => {
  const s = (q.get('q') || '').trim().slice(0, 80);
  if (s.length < 2) throw new HttpError(400, 'query too short');
  const r = await getCached(`images:${s.toLowerCase()}`, `https://images-api.nasa.gov/search?q=${encodeURIComponent(s)}&media_type=image&page_size=24`,
    { ttl: DAY, validate: validJson, type: JSON_TYPE, feed: 'nasa-images' });
  const j = JSON.parse(r.entry.body.toString('utf8'));
  const items = (j.collection?.items || []).map((it) => {
    const d = it.data?.[0] || {};
    const thumb = (it.links || []).find((l) => l.render === 'image' && /~thumb|~small|~medium/.test(l.href))?.href || it.links?.[0]?.href;
    return { id: d.nasa_id, title: d.title, date: d.date_created, center: d.center, description: (d.description || '').slice(0, 400), thumb };
  }).filter((x) => x.thumb && x.id);
  sendJson(req, res, 200, { query: s, total: j.collection?.metadata?.total_hits ?? items.length, items }, meta(r));
});

// NASA EPIC (DSCOVR full-disk Earth imagery) — keyless endpoint
route(/^\/api\/epic$/, async (req, res) => {
  sendEntry(req, res, await getCached('epic', 'https://epic.gsfc.nasa.gov/api/natural', { ttl: HOUR, validate: validJson, type: JSON_TYPE, feed: 'nasa-epic' }));
});
route(/^\/api\/epic-image\/(\d{4})-(\d{2})-(\d{2})\/(epic_[\w]+)$/, async (req, res, m) => {
  const [, y, mo, d, name] = m;
  sendEntry(req, res, await getCached(`epic-img:${name}`, `https://epic.gsfc.nasa.gov/archive/natural/${y}/${mo}/${d}/thumbs/${name}.jpg`,
    { ttl: 30 * DAY, validate: validImage, type: 'image/jpeg', timeout: 40_000 }), { 'cache-control': 'public, max-age=86400' });
});

// NASA GIBS imagery for the globe (equirectangular WMS)
const GIBS_LAYERS = {
  BlueMarble_NextGeneration: 'static', VIIRS_Black_Marble: 'static', VIIRS_CityLights_2012: 'static',
  VIIRS_NOAA20_CorrectedReflectance_TrueColor: 'daily', VIIRS_SNPP_CorrectedReflectance_TrueColor: 'daily',
  MODIS_Terra_CorrectedReflectance_TrueColor: 'daily',
};
route(/^\/api\/gibs\/([A-Za-z0-9_]+)$/, async (req, res, m, q) => {
  const layer = m[1], kind = GIBS_LAYERS[layer];
  if (!kind) throw new HttpError(404, 'unknown GIBS layer');
  const w = [1024, 2048, 4096].includes(Number(q.get('w'))) ? Number(q.get('w')) : 4096;
  let date = q.get('date');
  const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Date.parse(date) > Date.now() - 30 * DAY && Date.parse(date) < Date.now();
  if (kind === 'daily' && !okDate) date = isoDate(Date.now() - 30 * HOUR);
  const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}`
    + `&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${w}&HEIGHT=${w / 2}&FORMAT=image/jpeg${kind === 'daily' ? `&TIME=${date}` : ''}`;
  const settled = kind === 'static' || Date.parse(date) < Date.now() - 2 * DAY;
  const r = await getCached(`gibs:${layer}:${w}:${kind === 'daily' ? date : 'static'}`, url,
    { ttl: settled ? 30 * DAY : 3 * HOUR, timeout: 180_000, validate: validImage, type: 'image/jpeg', feed: 'nasa-gibs' });
  sendEntry(req, res, r, { 'cache-control': 'public, max-age=3600', 'x-imagery-date': kind === 'daily' ? date : 'static' });
});

// NOAA SWPC space weather (trimmed to what the dashboard needs)
const SWPC = {
  kp: ['products/noaa-planetary-k-index.json', 10 * MIN, (j) => j.slice(-56)],
  scales: ['products/noaa-scales.json', 5 * MIN, (j) => j],
  alerts: ['products/alerts.json', 5 * MIN, (j) => j.slice(0, 12).map((a) => ({ id: a.product_id, issued: a.issue_datetime, message: String(a.message || '').slice(0, 900) }))],
  wind: ['json/rtsw/rtsw_wind_1m.json', MIN, (j) => j.filter((x) => x.active).slice(0, 360).map((x) => ({ t: x.time_tag, speed: x.proton_speed, density: x.proton_density, temp: x.proton_temperature, source: x.source }))],
  mag: ['json/rtsw/rtsw_mag_1m.json', MIN, (j) => j.filter((x) => x.active).slice(0, 360).map((x) => ({ t: x.time_tag, bt: x.bt, bz: x.bz_gsm, source: x.source }))],
  xray: ['json/goes/primary/xrays-6-hour.json', MIN, (j) => j.filter((x) => x.energy === '0.1-0.8nm').map((x) => ({ t: x.time_tag, flux: x.flux }))],
};
route(/^\/api\/swpc\/(kp|scales|alerts|wind|mag|xray)$/, async (req, res, m) => {
  const [p, ttl, trim] = SWPC[m[1]];
  const r = await getCached(`swpc:${m[1]}`, `https://services.swpc.noaa.gov/${p}`, { ttl, validate: validJson, type: JSON_TYPE, feed: 'noaa-swpc' });
  sendJson(req, res, 200, trim(JSON.parse(r.entry.body.toString('utf8'))), meta(r));
});

// Independent live ISS position (cross-check for our SGP4 propagation)
route(/^\/api\/iss$/, async (req, res) => {
  sendEntry(req, res, await getCached('iss-live', 'https://api.wheretheiss.at/v1/satellites/25544',
    { ttl: 4000, retryAfter: 15_000, validate: validJson, type: JSON_TYPE, feed: 'wheretheiss' }));
});

// Pinned front-end libraries, cached locally after the first load (versioned URLs are immutable).
const VENDOR = {
  'three.module.js': 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
  'OrbitControls.js': 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js',
  'satellite.js': 'https://cdn.jsdelivr.net/npm/satellite.js@7.1.0/+esm',
  'astronomy.js': 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/esm/astronomy.js',
  'stars.6.json': 'https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@master/data/stars.6.json',
  'moon.jpg': 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg',   // NASA SVS CGI Moon Kit (LRO)
};
route(/^\/vendor\/([\w.-]+)$/, async (req, res, m) => {
  const url = VENDOR[m[1]];
  if (!url) throw new HttpError(404, 'unknown vendor file');
  const type = m[1].endsWith('.json') ? JSON_TYPE : m[1].endsWith('.jpg') ? 'image/jpeg' : 'text/javascript; charset=utf-8';
  sendEntry(req, res, await getCached(`vendor:${url}`, url, { ttl: 365 * DAY, type, timeout: 60_000 }), { 'cache-control': 'public, max-age=86400' });
});

/* ──────────────────────────────── static files ──────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': JSON_TYPE, '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'forbidden');
  let body;
  try { body = await fsp.readFile(file); } catch { throw new HttpError(404, 'not found'); }
  send(req, res, 200, body, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'cache-control': 'no-cache' });
}

/* ──────────────────────────────── server ──────────────────────────────── */

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);
const hostAllowed = (h) => { const name = (h || '').replace(/:\d+$/, ''); return ALLOWED_HOSTS.has(name) || /^\d{1,3}(\.\d{1,3}){3}$/.test(name); };

/** The request handler: used by the local HTTP server below and exported as the Vercel Function (api/index.mjs). */
export async function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(req, res, 400, { error: 'bad request' }); }
  // vercel.json rewrites /api/* and /vendor/* to this function and passes the original route in __route.
  if ((url.pathname === '/api/index' || url.pathname === '/api') && url.searchParams.has('__route')) {
    const route = url.searchParams.get('__route');
    url.searchParams.delete('__route');
    try { url = new URL(`/${route.replace(/^\/+/, '')}${url.search}`, 'http://localhost'); } catch { return sendJson(req, res, 400, { error: 'bad request' }); }
  } else url.searchParams.delete('__route');
  // Block DNS-rebinding locally: only answer to localhost, IP literals or explicitly allowed host names.
  if (!ON_VERCEL && !hostAllowed(req.headers.host)) return sendJson(req, res, 421, { error: 'misdirected request' });
  res.argusCache = ON_VERCEL && (req.method === 'GET' || req.method === 'HEAD') ? cdnCacheControl(url.pathname) : null;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    for (const [re, fn] of ROUTES) {
      const m = url.pathname.match(re);
      if (m) return await fn(req, res, m, url.searchParams);
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'unknown endpoint');
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 503) log(`! ${url.pathname}: ${err.message}`);   // expected back-pressure (busy / rate-limit pause)
    else if (status >= 500 && status !== 502) log(`! ${url.pathname}: ${err.stack || err.message}`);
    if (!res.headersSent) sendJson(req, res, status, { error: err.message });
    else res.end();
  }
}
export default handler;

const server = http.createServer(handler);

if (!ON_VERCEL) startLocalServer();

function startLocalServer() {
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Start with another port:  PORT=8090 node server.mjs`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ARGUS · Orbital Awareness Console\n  → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  console.log(`  NASA API key: ${nasa.key === 'DEMO_KEY' ? 'DEMO_KEY (set NASA_API_KEY in .env for higher limits)' : 'custom key from .env'}`);
  console.log(`  Cache: ${path.relative(process.cwd(), CACHE_DIR) || CACHE_DIR}\n`);
  // Warm the heavy, slow-changing products in the background (each is fetched at most once per TTL).
  (async () => {
    await ensureSatcat().catch((e) => log('SATCAT warm-up failed:', e.message));
    await buildCatalog().catch((e) => log('catalog warm-up failed:', e.message));
    await ensureSocrates().catch((e) => log('SOCRATES warm-up failed:', e.message));
  })();
});
}
