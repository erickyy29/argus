/**
 * ARGUS · Orbital Awareness Console — application controller.
 * Owns the simulation clock, the catalogue, the workers, selection state and the render loop.
 */
import { json2satrec, twoline2satrec, propagate, gstime, eciToGeodetic, degreesLat, degreesLong } from 'satellite.js';
import { SceneView } from './scene/scene.js';
import { Drawer } from './ui/drawer.js';
import { Inspector } from './ui/inspector.js';
import { Hud } from './ui/hud.js';
import { NeoManager } from './data/neo.js';
import { Mount } from './robot/mount.js';
import { CATEGORIES, CAT_INDEX, STD_MAG, STD_BY_NAME, NOTABLE, DEFAULT_OBSERVER, FALLBACK_IDS, MOON_COLOR } from './lib/config.js';
import { Vector3 } from 'three';
import { Observer, RE, DEG, toScene, sunEci, moonEci, bodyHorizon, nightWindow, visibilityRadiusDeg } from './lib/astro.js';
import { Bus, api, feeds, store, toast, $, fmt } from './lib/util.js';
import * as Astro from 'astronomy-engine';

const HBR_DEFAULT = { stations: 30, starlink: 8, megaconst: 5, gnss: 5, earthobs: 4, science: 4, geo: 6, active: 3, inactive: 4, debris: 0.5, custom: 3 };
const RATES = [-3600, -600, -60, -10, -1, 0.5, 1, 10, 60, 300, 600, 3600];

class Clock {
  constructor() { this.rate = 1; this.paused = false; this.anchorSim = Date.now(); this.anchorReal = performance.now(); }
  now() { return this.paused ? this.anchorSim : this.anchorSim + (performance.now() - this.anchorReal) * this.rate; }
  #reanchor() { this.anchorSim = this.now(); this.anchorReal = performance.now(); }
  setRate(r) { this.#reanchor(); this.rate = r; this.paused = false; }
  toggle() { this.#reanchor(); this.paused = !this.paused; if (!this.paused) this.anchorReal = performance.now(); }
  jump(ms) { this.anchorSim = ms; this.anchorReal = performance.now(); }
  live() { this.rate = 1; this.paused = false; this.jump(Date.now()); }
  faster() { const i = RATES.findIndex((r) => r > this.rate); this.setRate(i < 0 ? RATES[RATES.length - 1] : RATES[i]); }
  slower() { const i = RATES.findLastIndex((r) => r < this.rate); this.setRate(i < 0 ? RATES[0] : RATES[i]); }
  get isLive() { return !this.paused && this.rate === 1 && Math.abs(this.now() - Date.now()) < 3000; }
}

class App {
  constructor() {
    this.bus = new Bus();
    this.clock = new Clock();
    this.observer = new Observer(store.get('observer', DEFAULT_OBSERVER));
    this.place = store.get('place', null);
    this.catalog = { objects: [], byId: new Map(), counts: new Array(CATEGORIES.length).fill(0), meta: null };
    this.state = null;
    this.selection = null;
    this.encounter = null;
    this.jobs = new Map();
    this.jobSeq = 0;
    this.options = { orbits: true, track: true, labels: true, events: true, stars: true, live: true, lights: true, grid: false, neo: true, neoScale: 'compressed', risk: true, ...store.get('options', {}) };
    this.layers = store.get('layers', Object.fromEntries(CATEGORIES.map((c) => [c.id, true])));
    feeds.define('celestrak-gp', 'CelesTrak GP — orbital elements', 'celestrak.org');
    feeds.define('satcat', 'CelesTrak SATCAT — catalogue & environment', 'celestrak.org');
    feeds.define('socrates', 'CelesTrak SOCRATES — conjunctions', 'celestrak.org');
    feeds.define('gibs', 'NASA GIBS — Earth imagery', 'gibs.earthdata.nasa.gov');
    feeds.define('propagation', 'SGP4 propagation (in browser)', 'satellite.js');
  }

  /* ───────────── boot ───────────── */

  async start() {
    const steps = ['Rendering engine', 'Orbital catalogue · CelesTrak', 'SGP4 propagation', 'Earth imagery · NASA GIBS', 'Conjunctions · SOCRATES', 'Asteroids · NASA NeoWs & JPL', 'Events & space weather'];
    const ul = $('#bootSteps');
    ul.innerHTML = steps.map((s, i) => `<li data-i="${i}">${s}</li>`).join('');
    const mark = (i, cls) => { const li = ul.querySelector(`[data-i="${i}"]`); if (li) li.className = cls; };
    mark(0, 'run');
    try {
      this.scene = new SceneView($('#scene'), this);
    } catch (e) {
      mark(0, 'err');
      ul.insertAdjacentHTML('beforeend', `<li class="err">WebGL is unavailable: ${e.message}</li>`);
      return;
    }
    mark(0, 'ok');
    this.scene.setObserver(this.observer);
    this.applyOptions();
    this.neo = new NeoManager(this);
    this.mount = new Mount(this);
    this.hud = new Hud(this);
    this.drawer = new Drawer(this);
    this.inspector = new Inspector(this);
    this.bindEvents();

    // imagery (non-blocking)
    mark(3, 'run');
    const yday = new Date(Date.now() - 30 * 3600e3).toISOString().slice(0, 10);   // last complete UTC day (near-real-time latency)
    this.imageryDate = yday;
    this.scene.loadEarthTextures({
      day: '/api/gibs/BlueMarble_NextGeneration?w=4096', night: '/api/gibs/VIIRS_Black_Marble?w=4096',
      live: `/api/gibs/VIIRS_NOAA20_CorrectedReflectance_TrueColor?w=4096&date=${yday}`,
    }).then((r) => { mark(3, r[0] ? 'ok' : 'err'); r[0] ? feeds.ok('gibs', null, `Blue Marble · Black Marble · VIIRS NOAA-20 ${yday}`) : feeds.err('gibs', 'imagery unavailable'); });

    mark(1, 'run');
    const ok = await this.loadCatalog();
    mark(1, ok ? 'ok' : 'err');
    mark(2, 'ok');
    this.loop();
    this.scene.resetView();
    setTimeout(() => $('#boot').classList.add('done'), 250);
    this.locate();

    mark(4, 'run');
    this.drawer.open(store.get('tab', 'risk'));
    this.loadSocrates().then(() => mark(4, 'ok'), () => mark(4, 'err'));
    mark(5, 'run');
    this.neo.load().then(() => mark(5, 'ok'), () => mark(5, 'err'));
    mark(6, 'run');
    Promise.allSettled([this.loadEvents(), this.loadSpaceWeather(), this.loadEnvironment()]).then(() => mark(6, 'ok'));
    setInterval(() => this.loadSpaceWeather(), 120e3);
    setInterval(() => this.loadEvents(), 15 * 60e3);
    setInterval(() => this.refreshCatalog(), 30 * 60e3);
    setInterval(() => this.issCrossCheck(), 10e3);
    setInterval(() => { if (!this.socrates || Date.now() - (this.socratesAt || 0) > 3600e3) this.loadSocrates().catch(() => {}); else this.loadRisky(); }, 15 * 60e3);
  }

  locate() {
    if (store.get('observer', null) || !navigator.geolocation) return;
    const seq = this.obsSeq || 0;
    navigator.geolocation.getCurrentPosition(
      (p) => { if ((this.obsSeq || 0) === seq) this.setObserver({ lat: p.coords.latitude, lon: p.coords.longitude, alt: (p.coords.altitude || 0) / 1000, name: 'My location' }); },
      () => { if ((this.obsSeq || 0) === seq) toast('Using Kennedy Space Center as the observer. Set your mount location with the pin button (top right).', 'warn', 7000); },
      { timeout: 8000, maximumAge: 3600e3 },
    );
  }

  setObserver(o) {
    this.obsSeq = (this.obsSeq || 0) + 1;
    this.observer.set(o);
    store.set('observer', { lat: o.lat, lon: o.lon, alt: o.alt || 0, name: o.name || '' });
    this.scene.setObserver(this.observer);
    const msg = { type: 'observer', lat: o.lat, lon: o.lon, alt: o.alt || 0 };
    this.prop?.postMessage(msg);
    this.analysis?.postMessage(msg);
    this.nightCache = null;
    if (this.placeConjKey !== `${o.lat.toFixed(5)},${o.lon.toFixed(5)}`) { this.scene.clearPlaceOverlay(); this.placeConj = null; this.placeConjKey = null; }
    if (this.scene.mode === 'orbital' && !this.selection) this.scene.resetView();
    this.bus.emit('observer');
  }

  /* ───────────── place: what is above a location ───────────── */

  goToPlace(p) {
    this.place = { name: p.name, label: p.label || '', lat: p.lat, lon: p.lon };
    store.set('place', this.place);
    this.encSeq = (this.encSeq || 0) + 1;                     // cancel a replay that is still loading
    if (this.encounter) this.closeEncounter(true);           // and return to live time
    else if (!this.clock.isLive) this.clock.live();
    this.select(null);
    this.setObserver({ lat: p.lat, lon: p.lon, alt: 0, name: p.name });
    this.scene.setMode('orbital');
    this.scene.flyToSurface(0.95);
    this.drawer.open('place');                               // renders the panel, which starts the conjunction scan
    toast(`Showing the sky above ${p.name}. Passes, night-sky counts and the mount now use this location.`, '', 6000);
  }

  /** Upcoming high-interest conjunctions (SOCRATES), cached for 15 minutes. */
  upcomingConjunctions() {
    if (this.upcoming && Date.now() - this.upcoming.at < 15 * 60e3) return Promise.resolve(this.upcoming.data);
    this.upcomingP ??= api('/api/socrates/upcoming?hours=48&minPc=1e-4&maxRange=1', { timeout: 420_000 })
      .then(({ data }) => { this.upcoming = { at: Date.now(), data }; return data; })
      .finally(() => { this.upcomingP = null; });
    return this.upcomingP;
  }

  ensurePlaceConjunctions() {
    const key = `${this.observer.lat.toFixed(5)},${this.observer.lon.toFixed(5)}`;
    if (this.placeConjKey === key && this.placeConj && !this.placeConj.error && Date.now() - this.placeConj.at < 15 * 60e3) return;
    if (this.placeBusy === key) return;
    this.computePlaceConjunctions();
  }

  /**
   * Which upcoming close approaches happen in the observer's sky: propagate one of the two objects to TCA with SGP4
   * (they are within a few km of each other then) and keep encounters at least 10° above the horizon.
   */
  async computePlaceConjunctions() {
    if (!this.catalog.objects.length) return;
    const token = (this.placeToken = (this.placeToken || 0) + 1);
    const obs = this.observer, key = `${obs.lat.toFixed(5)},${obs.lon.toFixed(5)}`;
    this.placeBusy = key;
    if (this.placeConjKey !== key) { this.placeConj = null; this.scene.clearPlaceOverlay(); }
    this.bus.emit('place');
    try {
      const data = await this.upcomingConjunctions();
      if (token !== this.placeToken) return;
      const list = [];
      let notLoaded = 0;
      const cutoff = Date.now() - 60e3;
      for (const [id1, id2, t, range, speed, prob, cls, dse1, dse2] of data.rows) {
        if (t < cutoff) continue;
        const o = this.catalog.byId.get(id1) || this.catalog.byId.get(id2);
        if (!o) { notLoaded++; continue; }
        const rec = this.satrec(o);
        if (!rec) continue;
        const date = new Date(t);
        const r = propagate(rec, date);
        if (!r || !r.position || typeof r.position !== 'object') continue;
        const p = r.position, g = gstime(date);
        const look = obs.lookEci([p.x, p.y, p.z], g);
        if (look.el < 10) continue;
        const geo = eciToGeodetic(p, g);
        const sun = sunEci(t), sn = Math.hypot(...sun), su = [sun[0] / sn, sun[1] / sn, sun[2] / sn];
        const d = p.x * su[0] + p.y * su[1] + p.z * su[2];
        const lit = d >= 0 || (p.x - d * su[0]) ** 2 + (p.y - d * su[1]) ** 2 + (p.z - d * su[2]) ** 2 > RE * RE;
        const sunEl = obs.lookEci(sun, g).el;
        const n1 = data.names[id1]?.[0] ?? String(id1), n2 = data.names[id2]?.[0] ?? String(id2);
        list.push({ id1, id2, n1, n2, t, range, speed, prob, cls, dse1, dse2, az: look.az, el: look.el, slantKm: look.range,
          lat: degreesLat(geo.latitude), lon: degreesLong(geo.longitude), altKm: geo.height, lit, dark: sunEl < -6, observable: lit && sunEl < -6 });
      }
      if (token !== this.placeToken) return;
      this.placeConj = { at: Date.now(), list, scanned: data.rows.length, matching: data.matching, truncated: data.truncated, notLoaded, hours: data.hours, publishedAt: data.publishedAt };
      this.placeConjKey = key;
      this.scene.setPlaceOverlay({ lat: obs.lat, lon: obs.lon, ringDeg: visibilityRadiusDeg(550, 10), conj: list });
    } catch (e) {
      if (token === this.placeToken) { this.placeConj = { at: Date.now(), error: e.message }; this.placeConjKey = null; this.scene.clearPlaceOverlay(); }
    } finally {
      if (token === this.placeToken) this.placeBusy = null;
    }
    this.bus.emit('place');
  }

  /* ───────────── catalogue ───────────── */

  async loadCatalog() {
    let data = null;
    try {
      const r = await api('/api/catalog', { timeout: 240_000 });
      data = r.data;
      const fresh = data.sources.filter((s) => !s.error);
      if (!data.rows.length) throw new Error('catalogue is empty');
      feeds.ok('celestrak-gp', fresh[0]?.fetchedAt, `${data.rows.length.toLocaleString()} objects · ${fresh.length}/${data.sources.length} groups`);
    } catch (e) {
      feeds.err('celestrak-gp', e.message);
      toast(`CelesTrak unavailable (${e.message}). Loading key objects from the TLE API instead.`, 'warn', 8000);
      return this.loadFallback();
    }
    const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
    const objects = data.rows.map((r) => this.makeObject({
      id: r[F.id], name: r[F.name], cospar: r[F.cospar], cat: r[F.cat], type: r[F.type], owner: r[F.owner], rcs: r[F.rcs], launch: r[F.launch],
      omm: {
        OBJECT_NAME: r[F.name], OBJECT_ID: r[F.cospar], EPOCH: r[F.epoch], MEAN_MOTION: r[F.n], ECCENTRICITY: r[F.e], INCLINATION: r[F.i],
        RA_OF_ASC_NODE: r[F.raan], ARG_OF_PERICENTER: r[F.argp], MEAN_ANOMALY: r[F.ma], EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
        NORAD_CAT_ID: r[F.id], ELEMENT_SET_NO: r[F.elset], REV_AT_EPOCH: r[F.rev], BSTAR: r[F.bstar], MEAN_MOTION_DOT: r[F.ndot], MEAN_MOTION_DDOT: r[F.nddot],
      },
    }));
    this.catalog.meta = { generatedAt: data.generatedAt, sources: data.sources, satcat: data.satcat };
    this.installCatalog(objects);
    return true;
  }

  async loadFallback() {
    const objs = [];
    for (const id of FALLBACK_IDS) {
      try {
        const { data } = await api(`/api/tle/${id}`);
        objs.push(this.makeObject({ id: data.satelliteId, name: data.name, cospar: '', cat: id === 25544 || id === 48274 ? 'stations' : 'active', tle: [data.line1, data.line2] }));
      } catch { /* skip */ }
    }
    if (!objs.length) return false;
    feeds.warn('celestrak-gp', `fallback: ${objs.length} objects from TLE API`);
    this.installCatalog(objs);
    return true;
  }

  makeObject(o) {
    const cat = typeof o.cat === 'number' ? o.cat : CAT_INDEX[o.cat] ?? CAT_INDEX.active;
    const catId = CATEGORIES[cat].id;
    const epochStr = o.omm?.EPOCH;
    const epoch = epochStr ? Date.parse(`${epochStr.slice(0, 23)}Z`) : o.tle ? tleEpoch(o.tle[0]) : NaN;
    const rcsR = Number.isFinite(o.rcs) && o.rcs > 0 ? Math.sqrt(o.rcs / Math.PI) : 0;
    const byName = STD_BY_NAME.find(([re]) => re.test((o.name || '').toUpperCase()));
    const std = STD_MAG[o.id] ?? byName?.[1] ?? (o.type === 'R/B' && catId !== 'debris' ? 5.0 : CATEGORIES[cat].std);
    return {
      i: -1, id: o.id, name: o.name, cospar: o.cospar, cat, catId, type: o.type ?? null, owner: o.owner ?? null, rcs: o.rcs ?? null, launch: o.launch ?? null,
      omm: o.omm || null, tle: o.tle || null, epoch, std, hbr: o.id === 25544 ? 50 : Math.min(60, Math.max(rcsR, HBR_DEFAULT[catId] ?? 3)),
      n: o.omm?.MEAN_MOTION ?? (o.tle ? parseFloat(o.tle[1].slice(52, 63)) : NaN), e: o.omm?.ECCENTRICITY ?? (o.tle ? parseFloat(`0.${o.tle[1].slice(26, 33)}`) : NaN),
    };
  }

  installCatalog(objects) {
    const c = this.catalog;
    c.objects = objects;
    c.byId = new Map();
    c.counts.fill(0);
    objects.forEach((o, i) => { o.i = i; c.byId.set(o.id, o); c.counts[o.cat]++; });
    this.scene.buildSatellites(objects);
    CATEGORIES.forEach((cat, k) => this.scene.setCategoryVisible(k, this.layers[cat.id] !== false));
    this.startPropagator();
    this.failJobs(this.analysis, 'catalogue reloaded');
    this.analysisReject?.(new Error('catalogue reloaded'));
    this.analysisReady = null;
    this.analysis?.terminate();
    this.analysis = null;
    this.applyRisky();
    this.bus.emit('catalog', { reload: true });
  }

  workerPayload(o, full = false) {
    const base = o.tle ? { tle1: o.tle[0], tle2: o.tle[1] } : { omm: o.omm };
    return full ? { ...base, std: o.std, cat: o.cat, id: o.id, name: o.name, hbr: o.hbr } : { ...base, std: o.std, cat: o.cat };
  }

  failJobs(w, why) {
    if (!w) return;
    for (const [id, j] of this.jobs) if (j.worker === w) { j.reject(new Error(why)); this.jobs.delete(id); }
  }

  startPropagator() {
    this.failJobs(this.prop, 'catalogue reloaded');
    this.prop?.terminate();
    this.tickInflight = false;
    this.spare = null;
    this.state = null;
    const w = (this.prop = new Worker('/js/workers/propagator.js', { type: 'module' }));
    w.onmessage = (e) => this.onPropMessage(e.data);
    w.onerror = (e) => { feeds.err('propagation', e.message || 'worker error'); console.error(e); };
    w.postMessage({ type: 'init', objects: this.catalog.objects.map((o) => this.workerPayload(o)) });
    w.postMessage({ type: 'observer', lat: this.observer.lat, lon: this.observer.lon, alt: this.observer.alt });
  }

  onPropMessage(m) {
    if (m.type === 'state') {
      this.tickInflight = false;
      const old = this.scene.applyState(m);
      if (old) this.spare = old;
      this.state = m;
      this.bus.emit('state', m);
    } else if (m.type === 'ready') {
      feeds.ok('propagation', null, `${m.count.toLocaleString()} objects${m.bad ? ` · ${m.bad} without valid elements` : ''}`);
    } else if (m.req && this.jobs.has(m.req)) {
      const j = this.jobs.get(m.req); this.jobs.delete(m.req);
      m.type === 'error' ? j.reject(new Error(m.message)) : j.resolve(m);
    }
  }

  /** Request/response helper for worker jobs. */
  job(worker, msg, onProgress) {
    const id = ++this.jobSeq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress, worker });
      worker.postMessage({ ...msg, req: id, job: id });
    });
  }

  ensureAnalysis() {
    if (this.analysisReady) return this.analysisReady;
    this.analysisReady = new Promise((resolve, reject) => {
      this.analysisReject = reject;
      const w = (this.analysis = new Worker('/js/workers/analysis.js', { type: 'module' }));
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { this.analysisReject = null; return resolve(w); }
        const j = this.jobs.get(m.job);
        if (!j) return;
        if (m.type === 'progress') return j.onProgress?.(m.p, m.note);
        this.jobs.delete(m.job);
        m.type === 'error' || m.error ? j.reject(new Error(m.message || m.error)) : j.resolve(m);
      };
      w.onerror = (e) => reject(new Error(e.message || 'analysis worker failed'));
      w.postMessage({ type: 'init', objects: this.catalog.objects.map((o) => this.workerPayload(o, true)) });
      w.postMessage({ type: 'observer', lat: this.observer.lat, lon: this.observer.lon, alt: this.observer.alt });
    });
    return this.analysisReady;
  }

  async screen(obj, { hours = 24, threshold = 10 } = {}, onProgress) {
    const w = await this.ensureAnalysis();
    return this.job(w, { type: 'screen', primary: obj.i, t0: this.clock.now(), hours, threshold }, onProgress);
  }
  async nightForecast(onProgress) {
    const w = await this.ensureAnalysis();
    const nw = this.nightWindow();
    if (!nw) throw new Error('no dark window in the next day at this latitude');
    const payloadCats = ['starlink', 'megaconst', 'gnss', 'earthobs', 'science', 'geo', 'active'].map((k) => CAT_INDEX[k]);
    return this.job(w, { type: 'night', t0: nw.start - 30 * 60e3, t1: Math.min(nw.end, nw.start + 86400e3) + 30 * 60e3, stepMin: 10, minEl: 10, starlinkCat: CAT_INDEX.starlink, payloadCats }, onProgress);
  }
  async brightPasses() {
    const w = await this.ensureAnalysis();
    return this.job(w, { type: 'bright', t0: this.clock.now(), hours: 24 });
  }
  passes(obj, hours = 48, minEl = 0) { return this.job(this.prop, { type: 'passes', i: obj.i, t0: this.clock.now(), hours, minEl }); }
  fovForecast({ az, el, half, T, target }) { return this.job(this.prop, { type: 'fov', t0: this.clock.now(), T, step: 2, az, el, half, target }); }

  nightWindow() {
    try { return nightWindow(this.clock.now(), this.observer); } catch { return null; }
  }

  /** Fetch an object by NORAD ID if it is not already loaded (CelesTrak GP, then the TLE API). */
  ensureObject(id) {
    const have = this.catalog.byId.get(id);
    if (have) return Promise.resolve(have);
    this.pendingObj ??= new Map();
    if (this.pendingObj.has(id)) return this.pendingObj.get(id);
    const p = this.#fetchObject(id).finally(() => this.pendingObj.delete(id));
    this.pendingObj.set(id, p);
    return p;
  }

  async #fetchObject(id) {
    let obj = null;
    try {
      const { data } = await api(`/api/gp-catnr/${id}`);
      if (Array.isArray(data) && data[0]) {
        const o = data[0];
        obj = this.makeObject({ id: o.NORAD_CAT_ID, name: o.OBJECT_NAME, cospar: o.OBJECT_ID, cat: 'custom', omm: o });
      }
    } catch { /* fall through */ }
    if (!obj) {
      try {
        const { data } = await api(`/api/tle/${id}`);
        if (data?.line1) obj = this.makeObject({ id: data.satelliteId, name: data.name, cospar: '', cat: 'custom', tle: [data.line1, data.line2] });
      } catch { /* none */ }
    }
    if (!obj) return null;
    try { const { data: sc } = await api(`/api/satcat/${id}`); obj.type = sc.type; obj.owner = sc.owner; obj.rcs = sc.rcs; obj.launch = sc.launch; } catch { /* optional */ }
    this.addObjects([obj]);
    return obj;
  }

  addObjects(list) {
    const c = this.catalog;
    list = list.filter((o, k) => !c.byId.has(o.id) && list.findIndex((x) => x.id === o.id) === k);
    if (!list.length) return;
    for (const o of list) { o.i = c.objects.length; c.objects.push(o); c.byId.set(o.id, o); c.counts[o.cat]++; }
    this.scene.buildSatellites(c.objects);
    CATEGORIES.forEach((cat, k) => this.scene.setCategoryVisible(k, this.layers[cat.id] !== false));
    this.spare = null;
    this.prop.postMessage({ type: 'add', objects: list.map((o) => this.workerPayload(o)) });
    this.analysis?.postMessage({ type: 'add', objects: list.map((o) => this.workerPayload(o, true)) });
    this.tickInflight = false;
    if (this.selection?.kind === 'sat') this.scene.setSelected(this.selection.obj.i);
    this.applyRisky();
    if (this.risky) this.bus.emit('risky');
    this.bus.emit('catalog', { added: list.length });
  }

  async refreshCatalog() {
    if (this.encounter) return;
    try {
      const { data } = await api('/api/catalog', { timeout: 240_000 });
      if (data.generatedAt !== this.catalog.meta?.generatedAt) {
        const sel = this.selection?.kind === 'sat' ? this.selection.obj.id : null;
        const added = this.catalog.objects.filter((o) => o.catId === 'custom');
        await this.loadCatalog();
        if (added.length) this.addObjects(added.filter((o, k) => !this.catalog.byId.has(o.id) && added.findIndex((x) => x.id === o.id) === k).map((o) => ({ ...o, satrec: undefined })));
        if (sel && this.catalog.byId.has(sel)) this.select({ kind: 'sat', obj: this.catalog.byId.get(sel) });
      }
    } catch { /* keep current */ }
  }

  /* ───────────── precise single-object state (main thread) ───────────── */

  satrec(obj) {
    if (obj.satrec === undefined) {
      try { obj.satrec = obj.tle ? twoline2satrec(obj.tle[0], obj.tle[1]) : json2satrec(obj.omm); if (obj.satrec?.error) obj.satrec = null; } catch { obj.satrec = null; }
    }
    return obj.satrec;
  }

  satState(obj, t = this.clock.now()) {
    const rec = this.satrec(obj);
    if (!rec) return null;
    const date = new Date(t);
    const r = propagate(rec, date, { communityDecayCheckEnabled: true });
    if (!r || !r.position || typeof r.position !== 'object') return null;
    const p = r.position, v = r.velocity;
    const g = gstime(date);
    const geo = eciToGeodetic(p, g);
    const look = this.observer.lookEci([p.x, p.y, p.z], g);
    const look2 = this.observer.lookEci([p.x + v.x, p.y + v.y, p.z + v.z], gstime(new Date(t + 1000)));
    const sun = sunEci(t), sn = Math.hypot(...sun);
    const su = [sun[0] / sn, sun[1] / sn, sun[2] / sn];
    const d = p.x * su[0] + p.y * su[1] + p.z * su[2];
    const lit = d >= 0 || (p.x - d * su[0]) ** 2 + (p.y - d * su[1]) ** 2 + (p.z - d * su[2]) ** 2 > RE * RE;
    let mag = NaN;
    if (lit && look.el > -1) {
      const o = this.observer.ecef, c = Math.cos(g), s = Math.sin(g);
      const oe = [c * o[0] - s * o[1], s * o[0] + c * o[1], o[2]];
      const ox = oe[0] - p.x, oy = oe[1] - p.y, oz = oe[2] - p.z;
      const cphi = Math.max(-1, Math.min(1, (ox * su[0] + oy * su[1] + oz * su[2]) / look.range)), phi = Math.acos(cphi);
      const f = (Math.sin(phi) + (Math.PI - phi) * cphi) / Math.PI;
      mag = f > 1e-4 ? obj.std + 5 * Math.log10(look.range / 1000) - 2.5 * Math.log10(f * Math.PI) : NaN;
    }
    return {
      eci: [p.x, p.y, p.z], vel: [v.x, v.y, v.z], speed: Math.hypot(v.x, v.y, v.z), lat: degreesLat(geo.latitude), lon: degreesLong(geo.longitude), alt: geo.height,
      r: Math.hypot(p.x, p.y, p.z), az: look.az, el: look.el, range: look.range, rangeRate: look2.range - look.range, lit, mag,
      scene: toScene([p.x, p.y, p.z]),
    };
  }

  orbitPoints(obj, t, frac = 1, steps = 240) {
    const rec = this.satrec(obj); if (!rec) return null;
    const P = (2 * Math.PI) / rec.no * 60e3;           // ms
    const pts = [], track = [];
    for (let k = 0; k <= steps; k++) {
      const tt = t + (k / steps - 0.5) * P * frac;
      const r = propagate(rec, new Date(tt));
      if (!r || !r.position || typeof r.position !== 'object') continue;
      pts.push(toScene([r.position.x, r.position.y, r.position.z]));
    }
    const span = Math.min(P * 1.5, 6 * 3600e3);
    for (let k = 0; k <= 300; k++) {
      const tt = t - span / 3 + (k / 300) * span;
      const date = new Date(tt);
      const r = propagate(rec, date);
      if (!r || !r.position || typeof r.position !== 'object') continue;
      const geo = eciToGeodetic(r.position, gstime(date));
      track.push([degreesLat(geo.latitude), degreesLong(geo.longitude)]);
    }
    return { pts, track, periodMin: P / 60e3 };
  }

  /* ───────────── selection ───────────── */

  select(sel) {
    this.selection = sel;
    this.scene.setSelected(sel?.kind === 'sat' ? sel.obj.i : -1);
    this.orbitStamp = 0;
    if (!sel) { this.scene.setOrbit(null); this.scene.setGroundTrack(null); this.scene.removeLabel('sel'); }
    if (sel?.kind === 'neo') this.neo.refine(sel.obj);
    this.inspector.show(sel);
    this.bus.emit('selection', sel);
  }

  selectedWorld() {
    const s = this.selection;
    if (!s) return null;
    if (s.kind === 'sat') return this.state ? this.scene.satWorld(s.obj.i, this.dtSnap()) : null;
    if (s.kind === 'neo') { const i = this.neo.list.indexOf(s.obj); const a = this.scene.neoPts?.geometry.attributes.position.array; return i >= 0 && a ? this._v3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]) : null; }
    if (s.kind === 'moon') return this.scene.moon.position.clone();
    return null;
  }
  _v3(x, y, z) { return new Vector3(x, y, z); }

  focus(sel) {
    if (!sel) return;
    if (sel !== this.selection) this.select(sel);
    const dist = sel.kind === 'sat' ? 0.35 : sel.kind === 'neo' ? 6 : 1.2;
    this.scene.flyTo(() => this.selectedWorld(), dist);
  }

  /** Current pointing target for the mount (az/el from the observer). */
  targetLook(t, g) {
    const s = this.selection;
    if (!s) return null;
    if (s.kind === 'sat') { const st = this.satState(s.obj, t); return st && { az: st.az, el: st.el, label: s.obj.name, range: st.range }; }
    if (s.kind === 'neo') { const n = this.neo.stateAt(s.obj, t); if (!n) return null; const l = this.observer.lookEci(n.eci, g); return { ...l, label: s.obj.name }; }
    if (s.kind === 'moon') { const h = bodyHorizon(Astro.Body.Moon, t, this.observer); return { az: h.az, el: h.el, label: 'Moon', range: h.dist }; }
    return null;
  }

  /* ───────────── conjunction encounter view ───────────── */

  async viewEncounter({ id1, id2, tca, socrates = null }) {
    const tok = (this.encSeq = (this.encSeq || 0) + 1);
    toast('Loading both objects and refining the encounter with SGP4…');
    const [a, b] = await Promise.all([this.ensureObject(id1), this.ensureObject(id2)]);
    if (tok !== this.encSeq) return;
    if (!a || !b) { toast('One of the objects has no public orbital elements.', 'err'); return; }
    const ra = this.satrec(a), rb = this.satrec(b);
    const dist = (t) => {
      const d = new Date(t), p = propagate(ra, d), q = propagate(rb, d);
      if (!p?.position || !q?.position || typeof p.position !== 'object' || typeof q.position !== 'object') return Infinity;
      return Math.hypot(p.position.x - q.position.x, p.position.y - q.position.y, p.position.z - q.position.z);
    };
    // Search ±1.2 orbits around the reported TCA: repeating co-orbital encounters shift by whole orbits when elements update.
    const per = Math.max(2 * Math.PI / ra.no, 2 * Math.PI / rb.no) * 60e3;
    const span = Math.min(3 * 3600e3, 1.2 * per);
    const ts = [], ds = [];
    for (let t = tca - span; t <= tca + span; t += 5e3) { ts.push(t); ds.push(dist(t)); }
    const refine = (tc) => {
      let lo = tc - 5e3, hi = tc + 5e3;
      for (let k = 0; k < 40; k++) { const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618; if (dist(m1) < dist(m2)) hi = m2; else lo = m1; }
      const tt = (lo + hi) / 2; return { t: tt, d: dist(tt) };
    };
    const cands = [];
    for (let k = 0; k < ds.length; k++) {
      const prev = k ? ds[k - 1] : Infinity, next = k < ds.length - 1 ? ds[k + 1] : Infinity;
      if (Number.isFinite(ds[k]) && ds[k] <= prev && ds[k] <= next && ds[k] < 400) cands.push(refine(ts[k]));
    }
    if (!cands.length) { const k = ds.indexOf(Math.min(...ds)); cands.push(refine(ts[Math.max(0, k)])); }
    const dmin = Math.min(...cands.map((c) => c.d));
    const pick = cands.filter((c) => c.d <= Math.max(dmin * 1.1, dmin + 0.1)).sort((x, y) => Math.abs(x.t - tca) - Math.abs(y.t - tca))[0];
    const t0 = pick.t, miss = pick.d;
    const sa = this.satState(a, t0), sb = this.satState(b, t0);
    const rel = sa && sb ? Math.hypot(sa.vel[0] - sb.vel[0], sa.vel[1] - sb.vel[1], sa.vel[2] - sb.vel[2]) : NaN;
    const ageA = (t0 - a.epoch) / 86400e3, ageB = (t0 - b.epoch) / 86400e3;
    this.encounter = { a, b, tca: t0, miss, rel, socrates, dist, ageA, ageB, atReported: dist(tca), reportedTca: tca };
    this.clock.jump(t0 - 120e3);
    this.clock.setRate(1);
    this.select({ kind: 'sat', obj: a });
    this.scene.setPair(a.i, b.i);
    const ob = this.orbitPoints(b, t0);
    this.scene.setPairOrbit(ob?.pts);
    this.scene.flyTo(() => this.selectedWorld(), 0.22);
    this.bus.emit('encounter', this.encounter);
  }

  closeEncounter(goLive = true) {
    this.encSeq = (this.encSeq || 0) + 1;
    this.encounter = null;
    this.scene.setPair(-1, -1);
    this.scene.setPairLine(null);
    this.scene.setPairOrbit(null);
    this.scene.removeLabel('pairB');
    if (goLive) this.clock.live();
    this.bus.emit('encounter', null);
  }

  /* ───────────── feeds ───────────── */

  async loadSocrates() {
    try {
      const r = await api('/api/socrates/summary', { timeout: 420_000 });
      this.socrates = r.data;
      this.socratesError = null;
      this.socratesAt = Date.now();
      feeds.ok('socrates', r.data.publishedAt || r.fetchedAt, `${r.data.total.toLocaleString()} conjunctions < 5 km · 7 days`);
      this.bus.emit('socrates');
      this.loadRisky();
    } catch (e) { this.socratesError = e.message; feeds.err('socrates', e.message); this.bus.emit('socrates'); throw e; }
  }
  /** Objects in high-risk external encounters over the next 24 h → pulsing red on the globe. */
  async loadRisky() {
    try {
      const { data } = await api('/api/socrates/risky?hours=24&minPc=1e-4');
      this.risky = data;
      this.applyRisky();
    } catch { this.risky = null; }
    this.bus.emit('risky');
  }
  applyRisky() {
    if (!this.risky) return;
    const idx = [];
    for (const [id] of this.risky.objects) { const o = this.catalog.byId.get(id); if (o) idx.push(o.i); }
    this.risky.shown = idx.length;
    this.scene.setRisk(idx);
  }

  async loadEnvironment() {
    try {
      const r = await api('/api/environment', { timeout: 300_000 });
      this.environment = r.data;
      feeds.ok('satcat', r.data.satcatFetchedAt, `${r.data.totals.catalogued.toLocaleString()} catalogued · ${r.data.totals.onOrbit.toLocaleString()} in orbit`);
    } catch (e) { feeds.err('satcat', e.message); }
    this.bus.emit('environment');
  }
  async loadEvents() {
    feeds.define('eonet', 'NASA EONET — natural events', 'eonet.gsfc.nasa.gov');
    try {
      const r = await api('/api/eonet?days=30');
      this.events = (r.data.events || []).map((e) => {
        const g = e.geometry?.[e.geometry.length - 1];
        if (!g) return null;
        let lon, lat;
        if (g.type === 'Point') [lon, lat] = g.coordinates;
        else if (g.type === 'Polygon') { const ring = g.coordinates[0]; lon = ring.reduce((s, p) => s + p[0], 0) / ring.length; lat = ring.reduce((s, p) => s + p[1], 0) / ring.length; }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { kind: 'event', id: e.id, title: e.title, cat: e.categories?.[0]?.id, catTitle: e.categories?.[0]?.title, date: Date.parse(g.date), lat, lon,
          mag: g.magnitudeValue, magUnit: g.magnitudeUnit, sources: e.sources || [], link: e.link, track: e.geometry.length };
      }).filter(Boolean);
      this.scene.buildEvents(this.events);
      feeds.ok('eonet', r.fetchedAt, `${this.events.length} open events · 30 days`);
    } catch (e) { feeds.err('eonet', e.message); }
    this.bus.emit('events');
  }
  async loadSpaceWeather() {
    feeds.define('swpc', 'NOAA SWPC — space weather', 'services.swpc.noaa.gov');
    const parts = ['kp', 'scales', 'wind', 'mag', 'xray', 'alerts'];
    const out = {};
    let ok = 0;
    await Promise.all(parts.map(async (p) => { try { out[p] = (await api(`/api/swpc/${p}`)).data; ok++; } catch { out[p] = null; } }));
    this.spaceWeather = out;
    ok ? feeds.ok('swpc', null, `${ok}/${parts.length} products`) : feeds.err('swpc', 'unavailable');
    this.bus.emit('spaceweather');
  }
  async issCrossCheck() {
    if (document.hidden || !this.clock.isLive) return;
    const iss = this.catalog.byId.get(25544);
    if (!iss) return;
    feeds.define('iss', 'wheretheiss.at — independent ISS position', 'api.wheretheiss.at');
    try {
      const { data } = await api('/api/iss', { timeout: 10_000 });
      const st = this.satState(iss, data.timestamp * 1000);
      if (!st) return;
      const ll = (la, lo, h) => { const a = la * DEG, b = lo * DEG, r = RE + h; return [r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a)]; };
      const p = ll(data.latitude, data.longitude, data.altitude), q = ll(st.lat, st.lon, st.alt);
      this.issCheck = { delta: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), at: data.timestamp * 1000, alt: data.altitude, vis: data.visibility };
      feeds.ok('iss', data.timestamp * 1000, `SGP4 vs API: ${fmt.km(this.issCheck.delta)}`);
    } catch (e) { feeds.warn('iss', e.message); }
  }

  /* ───────────── options ───────────── */

  setLayer(catId, on) { this.layers[catId] = on; store.set('layers', this.layers); this.scene.setCategoryVisible(CAT_INDEX[catId], on); this.bus.emit('layers'); }
  setOption(k, v) { this.options[k] = v; store.set('options', this.options); this.applyOptions(); this.bus.emit('options'); }
  applyOptions() {
    const o = this.options, s = this.scene;
    s.earthMat.uniforms.uLiveOn.value = o.live ? 1 : 0;
    s.earthMat.uniforms.uNightOn.value = o.lights ? 1 : 0;
    s.grid.visible = o.grid;
    if (s.stars) s.stars.visible = o.stars;
    s.eventsVisible = o.events; if (s.eventPts) s.eventPts.visible = o.events;
    s.neoVisible = o.neo; if (s.neoPts) s.neoPts.visible = o.neo;
    s.setRiskVisible(o.risk);
    if (!o.orbits) s.setOrbit(null);
    if (!o.track) s.setGroundTrack(null);
    this.orbitStamp = 0;
    document.body.classList.toggle('no-labels', !o.labels);
  }

  /* ───────────── input ───────────── */

  bindEvents() {
    this.bus.on('click', (hit) => {
      if (!hit) return;
      if (hit.kind === 'sat') this.select({ kind: 'sat', obj: this.catalog.objects[hit.i] });
      else if (hit.kind === 'neo') this.select({ kind: 'neo', obj: this.neo.list[hit.i] });
      else if (hit.kind === 'moon') this.select({ kind: 'moon' });
      else if (hit.kind === 'event') this.select({ kind: 'event', obj: this.events[hit.i] });
      else if (hit.kind === 'earth') this.select({ kind: 'earth', lat: hit.lat, lon: hit.lon });
      else if (hit.kind === 'conj') {
        const c = this.placeConj?.list?.[hit.i];
        if (c) this.viewEncounter({ id1: c.id1, id2: c.id2, tca: c.t, socrates: { rangeKm: c.range, maxProb: c.prob, speedKms: c.speed, dse1: c.dse1, dse2: c.dse2 } });
      }
    });
    this.bus.on('focus', (hit) => {
      if (hit.kind === 'sat') this.focus({ kind: 'sat', obj: this.catalog.objects[hit.i] });
      else if (hit.kind === 'neo') this.focus({ kind: 'neo', obj: this.neo.list[hit.i] });
      else if (hit.kind === 'moon') this.focus({ kind: 'moon' });
    });
    this.bus.on('neo:elements', () => { this.neoDirty = true; });
    this.bus.on('neo:list', () => { this.neoDirty = true; });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); this.clock.toggle(); }
      else if (e.key === '+' || e.key === '=') this.clock.faster();
      else if (e.key === '-' || e.key === '_') this.clock.slower();
      else if (e.key === 'l' || e.key === 'L') { this.closeEncounter(false); this.clock.live(); }
      else if (e.key === 'v' || e.key === 'V') this.scene.setMode('sky');
      else if (e.key === 'o' || e.key === 'O') this.scene.setMode('orbital');
      else if (e.key === 'r' || e.key === 'R') this.scene.resetView();
      else if (e.key === 'f' || e.key === 'F') this.focus(this.selection);
      else if (e.key === 'Escape') { if (this.encounter) this.closeEncounter(); else this.select(null); }
      else if (e.key === '/') { e.preventDefault(); this.drawer.open('search'); }
      else if (this.scene.mode === 'sky' && e.key.startsWith('Arrow')) {
        const k = e.shiftKey ? 5 : 1;
        if (e.key === 'ArrowLeft') this.scene.sky.az = (this.scene.sky.az - k + 360) % 360;
        if (e.key === 'ArrowRight') this.scene.sky.az = (this.scene.sky.az + k) % 360;
        if (e.key === 'ArrowUp') this.scene.sky.el = Math.min(89.9, this.scene.sky.el + k);
        if (e.key === 'ArrowDown') this.scene.sky.el = Math.max(-5, this.scene.sky.el - k);
      }
    });
    document.addEventListener('visibilitychange', () => { this.lastFrame = performance.now(); });
  }

  /* ───────────── render loop ───────────── */

  dtSnap() { return this.state ? (this.clock.now() - this.state.t) / 1000 : 0; }

  loop() {
    const step = () => {
      requestAnimationFrame(step);
      try { this.frame(); } catch (e) { if (!this.frameErr) { this.frameErr = true; console.error(e); toast(`Render error: ${e.message}`, 'err'); } }
    };
    this.lastFrame = performance.now();
    this.lastSlow = 0;
    requestAnimationFrame(step);
  }

  frame() {
    const nowReal = performance.now();
    this.lastFrame = nowReal;
    const t = this.clock.now();
    const date = new Date(t);
    const g = gstime(date);
    const sun = sunEci(t);
    const sunDir = toScene(sun);
    const moon = toScene(moonEci(t));

    // propagation ticks: ~2 Hz in real time, as fast as possible when time is warped
    if (this.prop && !this.tickInflight) {
      const interval = this.clock.isLive || this.clock.paused ? 500 : 60;
      if (nowReal - (this.lastTick || 0) > interval || (this.state && Math.abs(t - this.state.t) > 30e3 && !this.clock.paused)) {
        this.lastTick = nowReal;
        this.tickInflight = true;
        const sn = Math.hypot(...sun);
        const msg = { type: 'tick', t, sun: [sun[0] / sn, sun[1] / sn, sun[2] / sn] };
        const transfer = [];
        if (this.spare && this.spare.pos.length === this.catalog.objects.length * 3) { msg.recycle = this.spare; transfer.push(this.spare.pos.buffer, this.spare.vel.buffer, this.spare.st.buffer); }
        this.spare = null;
        this.prop.postMessage(msg, transfer);
      }
    }

    // NEO positions (≤ a few hundred objects)
    let neoPositions = null;
    if (this.neo?.list.length && this.options.neo) {
      if (this.neoDirty) { this.scene.buildNeos(this.neo.list); this.neoDirty = false; this.lastNeo = 0; }
      if (!this.clock.isLive || nowReal - (this.lastNeo || 0) > 1000) { neoPositions = this.neo.scenePositions(t, this.options.neoScale); this.lastNeo = nowReal; }
    }

    // selection orbit / ground track (recomputed every few minutes of simulated time)
    const sel = this.selection;
    if (sel?.kind === 'sat' && (this.options.orbits || this.options.track)) {
      if (!this.orbitStamp || Math.abs(t - this.orbitStamp) > 120e3) {
        const o = this.orbitPoints(sel.obj, t);
        const col = parseInt(CATEGORIES[sel.obj.cat].color.slice(1), 16);
        this.scene.setOrbit(this.options.orbits ? o?.pts : null, col === 0xffffff ? 0x7cc4ff : col);
        this.scene.setGroundTrack(this.options.track ? o?.track : null, col === 0xffffff ? 0x7cc4ff : col);
        this.orbitStamp = t;
      }
    } else if (sel?.kind === 'neo' && this.options.orbits) {
      if (!this.orbitStamp || Math.abs(t - this.orbitStamp) > 3600e3 || this.neoTrajDirty) {
        this.scene.setOrbit(this.neo.trajectory(sel.obj, t, this.options.neoScale), 0xffb347);
        this.scene.setGroundTrack(null);
        this.orbitStamp = t; this.neoTrajDirty = false;
      }
    } else if (this.orbitStamp !== -1 && !(sel?.kind === 'sat' || sel?.kind === 'neo')) {
      this.scene.setOrbit(null); this.scene.setGroundTrack(null); this.orbitStamp = -1;
    }

    // encounter line
    if (this.encounter && this.state) {
      const e = this.encounter;
      this.scene.setPairLine(this.scene.satWorld(e.a.i, this.dtSnap()), this.scene.satWorld(e.b.i, this.dtSnap()));
    }

    this.updateLabels();
    this.scene.frame({ gmst: g, sunDir, moonPos: moon, dtSnap: this.dtSnap(), neoPositions });

    // mount + HUD at 20 Hz
    if (nowReal - this.lastSlow > 50) {
      const dt = (nowReal - this.lastSlow) / 1000;
      this.lastSlow = nowReal;
      const sunLook = this.observer.lookEci(sun, g);
      const target = this.targetLook(t, g);
      const view = this.scene.mode === 'sky' ? { az: this.scene.sky.az, el: this.scene.sky.el } : null;
      this.mount.update(Math.min(dt, 0.5), { target, view, sun: sunLook });
      this.scene.setMount({ act: this.mount.act, cmd: this.mount.cmd, fov: this.mount.cfg.fov, show: true });
      this.hud.update(t, { sunLook, target });
      this.hoverPick();
    }
    if (nowReal - (this.lastInspector || 0) > 250) { this.lastInspector = nowReal; this.inspector.tick(t); this.drawer.tick(t); }
  }

  hoverPick() {
    const p = this.scene.pointer;
    if (!p.inside || !p.moved) return;
    p.moved = false;
    const hit = this.scene.pick(p.x, p.y, 9);
    this.hover = hit;
    this.scene.setHover(hit?.kind === 'sat' ? hit.i : -1);
    this.hud.tooltip(hit, p.x, p.y);
    this.scene.canvas.style.cursor = hit ? 'pointer' : this.scene.mode === 'sky' ? 'grab' : 'default';
  }

  updateLabels() {
    const s = this.scene;
    if (!this.options.labels) { for (const k of [...s.labels.keys()]) if (!k.startsWith('compass')) s.removeLabel(k); return; }
    if (this.state) {
      for (const [id, text] of Object.entries(NOTABLE)) {
        const o = this.catalog.byId.get(Number(id));
        if (o && this.layers[o.catId] !== false && this.state.st[o.i] > 0) s.setLabel(`n:${id}`, text, () => s.satWorld(o.i, this.dtSnap()), this.selection?.obj === o ? 'sel' : '', CATEGORIES[o.cat].color);
        else s.removeLabel(`n:${id}`);
      }
    }
    s.setLabel('moon', 'Moon', () => s.moon.position, this.selection?.kind === 'moon' ? 'sel' : 'minor', MOON_COLOR);
    s.setLabel('observer', this.observer.name ? `Mount · ${this.observer.name}` : 'Mount', () => (s.mode === 'orbital' && s.obsLocal ? s.obsLocal.clone().multiplyScalar(1.001).applyMatrix4(s.earth.matrixWorld) : null), 'minor', '#4ea8ff');
    const sel = this.selection;
    if (sel?.kind === 'sat' && !NOTABLE[sel.obj.id]) s.setLabel('sel', sel.obj.name, () => s.satWorld(sel.obj.i, this.dtSnap()), 'sel', CATEGORIES[sel.obj.cat].color);
    else if (sel?.kind === 'neo') s.setLabel('sel', sel.obj.name, () => this.selectedWorld(), 'sel', sel.obj.pha ? '#ff5d5d' : '#ffb347');
    else s.removeLabel('sel');
    if (this.encounter) s.setLabel('pairB', this.encounter.b.name, () => s.satWorld(this.encounter.b.i, this.dtSnap()), 'sel', '#ff8a8a');
    // label the three nearest NEOs
    if (this.options.neo && this.neo?.list.length) {
      const near = this.neo.list.map((o, i) => [o, i]).filter(([o]) => o.now).sort((a, b) => a[0].now.dKm - b[0].now.dKm).slice(0, 3);
      const keep = new Set(near.map(([o]) => `neo:${o.id}`));
      for (const k of [...s.labels.keys()]) if (k.startsWith('neo:') && !keep.has(k)) s.removeLabel(k);
      for (const [o, i] of near) {
        if (sel?.obj === o) { s.removeLabel(`neo:${o.id}`); continue; }
        s.setLabel(`neo:${o.id}`, `${o.name} · ${fmt.ld(o.now.dKm)}`, () => { const a = s.neoPts?.geometry.attributes.position.array; return a ? this._v3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]) : null; }, 'minor', o.pha ? '#ff5d5d' : '#ffb347');
      }
    } else {
      for (const k of [...s.labels.keys()]) if (k.startsWith('neo:')) s.removeLabel(k);
    }
  }
}

function tleEpoch(l1) {
  const y = Number(l1.slice(18, 20)), d = parseFloat(l1.slice(20, 32));
  return Date.UTC(y < 57 ? 2000 + y : 1900 + y, 0, 1) + (d - 1) * 86400e3;
}

const app = new App();
window.argus = app;
app.start();
