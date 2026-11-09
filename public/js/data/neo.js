/* Near-Earth objects: NASA NeoWs (this week) + JPL SBDB orbits + JPL CNEOS close approaches + JPL Horizons refinement. */
import { api, feeds } from '../lib/util.js';
import { smallBodyGeo, bodyContext, hgMagnitude, diameterFromH, toScene, compressR, icrfToEqd, LD_KM, AU_KM } from '../lib/astro.js';

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** "2026-Nov-08 13:28" (TDB, as published by CNEOS) → epoch ms */
function parseCd(s) {
  const m = /^(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], MONTHS[m[2]], +m[3], +m[4], +m[5]) - 69184 : NaN;
}
/** NeoWs names: "469219 Kamo`oalewa (2016 HO3)" → "469219";  "(2026 VK2)" → "2026 VK2" */
export function designation(name) {
  const num = /^\s*(\d+)\s/.exec(name);
  if (num) return num[1];
  const p = /\(([^)]+)\)/.exec(name);
  return (p ? p[1] : name).trim();
}

const SIZES = [[2, 'a person'], [5, 'a car'], [12, 'a school bus'], [30, 'a blue whale'], [60, 'a 20-storey building'],
  [110, 'a football field'], [330, 'the Eiffel Tower'], [830, 'the Burj Khalifa'], [3000, 'a mountain'], [1e9, 'a small city']];
export function sizeComparison(m) {
  if (!Number.isFinite(m)) return '';
  for (const [lim, what] of SIZES) if (m <= lim * 1.4) return `about the size of ${what}`;
  return '';
}

export class NeoManager {
  constructor(app) {
    this.app = app;
    this.list = [];
    this.cad = [];
    this.loading = 0;
    feeds.define('neows', 'NASA NeoWs — asteroid close approaches', 'api.nasa.gov');
    feeds.define('sbdb', 'JPL Small-Body Database — orbits', 'ssd-api.jpl.nasa.gov');
    feeds.define('cad', 'JPL CNEOS close-approach data (60 days)', 'ssd-api.jpl.nasa.gov');
  }

  async load() {
    const now = Date.now();
    const s = iso(now - 3 * 86400e3), e = iso(now + 3 * 86400e3);
    try {
      const r = await api(`/api/neo/feed?start=${s}&end=${e}`);
      this.list = this.parseFeed(r.data);
      this.feedRange = [s, e];
      feeds.ok('neows', r.fetchedAt, `${this.list.length} objects · ${s} → ${e}`);
    } catch (err) {
      feeds.err('neows', err.message);
    }
    this.app.bus.emit('neo:list');
    this.loadCad();
    await this.loadElements(this.list);
  }

  parseFeed(data) {
    const byId = new Map();
    for (const arr of Object.values(data.near_earth_objects || {})) {
      for (const n of arr) {
        const ca = (n.close_approach_data || []).find((c) => c.orbiting_body === 'Earth') || n.close_approach_data?.[0];
        const m = n.estimated_diameter?.meters || {};
        byId.set(n.id, {
          kind: 'neo', id: n.id, name: n.name.replace(/[()]/g, '').trim(), rawName: n.name, des: designation(n.name), H: n.absolute_magnitude_h,
          dMinM: m.estimated_diameter_min, dMaxM: m.estimated_diameter_max, diameterM: Math.sqrt((m.estimated_diameter_min || 0) * (m.estimated_diameter_max || 0)) || null,
          pha: !!n.is_potentially_hazardous_asteroid, sentry: !!n.is_sentry_object, jplUrl: n.nasa_jpl_url, source: 'NASA NeoWs',
          ca: ca ? { t: ca.epoch_date_close_approach, label: ca.close_approach_date_full, missKm: +ca.miss_distance.kilometers, vKms: +ca.relative_velocity.kilometers_per_second, body: ca.orbiting_body } : null,
        });
      }
    }
    return [...byId.values()].sort((a, b) => (a.ca?.t ?? 0) - (b.ca?.t ?? 0));
  }

  async loadElements(list) {
    let ok = 0;
    this.loading += list.length;
    for (const o of list) {
      try { await this.fetchElements(o); ok++; } catch (e) { o.elError = e.message; }
      this.loading--;
      this.app.bus.emit('neo:elements', o);
    }
    if (list.length) feeds.ok('sbdb', null, `${ok}/${list.length} orbits loaded`);
  }

  async fetchElements(o) {
    const { data: d } = await api(`/api/sbdb?des=${encodeURIComponent(o.des)}`, { timeout: 45_000 });
    if (!d.orbit) throw new Error(d.message || 'no orbit solution');
    const E = Object.fromEntries(d.orbit.elements.map((x) => [x.name, parseFloat(x.value)]));
    o.el = { a: E.a, e: E.e, i: E.i, om: E.om, w: E.w, ma: Number.isFinite(E.ma) ? E.ma : null, n: E.n, tp: E.tp, epoch: parseFloat(d.orbit.epoch) };
    o.orbit = {
      q: E.q, Q: E.ad, periodDays: E.per, moidAU: parseFloat(d.orbit.moid), cls: d.object.orbit_class?.name, clsCode: d.object.orbit_class?.code,
      firstObs: d.orbit.first_obs, lastObs: d.orbit.last_obs, arcDays: d.orbit.data_arc, nObs: d.orbit.n_obs_used, U: d.orbit.condition_code,
      solution: d.orbit.soln_date, producer: d.orbit.producer, epochJd: parseFloat(d.orbit.epoch), sigmas: Object.fromEntries(d.orbit.elements.map((x) => [x.name, x.sigma])),
    };
    o.spkid = d.object.spkid;
    o.fullname = d.object.fullname?.trim();
    o.pha = o.pha || !!d.object.pha;
    const phys = Object.fromEntries((d.phys_par || []).map((p) => [p.name, parseFloat(p.value)]));
    o.phys = phys;
    if (Number.isFinite(phys.G)) o.G = phys.G;
    if (!Number.isFinite(o.H) && Number.isFinite(phys.H)) o.H = phys.H;
    if (Number.isFinite(phys.diameter)) { o.diameterM = phys.diameter * 1000; o.diameterMeasured = true; }
    if (!o.diameterM && Number.isFinite(o.H)) { o.dMinM = diameterFromH(o.H, 0.25) * 1000; o.dMaxM = diameterFromH(o.H, 0.05) * 1000; o.diameterM = diameterFromH(o.H) * 1000; }
  }

  async loadCad() {
    try {
      const r = await api('/api/cad?days=60&dist=0.05');
      const f = r.data.fields || [], ix = Object.fromEntries(f.map((k, i) => [k, i]));
      this.cad = (r.data.data || []).map((row) => ({
        des: row[ix.des], name: (row[ix.fullname] || row[ix.des]).trim().replace(/[()]/g, ''), t: parseCd(row[ix.cd]), cd: row[ix.cd],
        distKm: +row[ix.dist] * AU_KM, distMinKm: +row[ix.dist_min] * AU_KM, distMaxKm: +row[ix.dist_max] * AU_KM, vKms: +row[ix.v_rel],
        H: +row[ix.h], diameterKm: row[ix.diameter] ? +row[ix.diameter] : null, tSigma: row[ix.t_sigma_f],
      }));
      feeds.ok('cad', r.fetchedAt, `${this.cad.length} approaches within 0.05 AU`);
    } catch (e) { feeds.err('cad', e.message); }
    this.app.bus.emit('neo:cad');
  }

  /** Add an object from the CNEOS list to the scene. */
  async addFromCad(c) {
    let o = this.list.find((x) => x.des === c.des);
    if (o) return o;
    o = { kind: 'neo', id: `cad:${c.des}`, name: c.name, des: c.des, H: c.H, pha: false, source: 'JPL CNEOS', ca: { t: c.t, label: c.cd, missKm: c.distKm, vKms: c.vKms, body: 'Earth' } };
    if (c.diameterKm) { o.diameterM = c.diameterKm * 1000; o.diameterMeasured = true; }
    else if (Number.isFinite(c.H)) { o.dMinM = diameterFromH(c.H, 0.25) * 1000; o.dMaxM = diameterFromH(c.H, 0.05) * 1000; o.diameterM = diameterFromH(c.H) * 1000; }
    this.list.push(o);
    await this.fetchElements(o);
    this.app.bus.emit('neo:list');
    return o;
  }

  /** Precise geocentric ephemeris for one object from JPL Horizons. */
  async refine(o) {
    if (o.hz || o.hzLoading || !(o.spkid || /^\d+$/.test(o.id))) return;
    o.hzLoading = true;
    try {
      const { data } = await api(`/api/horizons/vectors?id=${o.spkid || o.id}`, { timeout: 60_000 });
      const rows = data.rows || [];
      if (rows.length > 2) o.hz = { t: rows.map((r) => (r[0] - 2440587.5) * 864e5), p: rows.map((r) => [r[1], r[2], r[3]]), v: rows.map((r) => [r[4], r[5], r[6]]) };
      feeds.define('horizons', 'JPL Horizons — precise ephemerides', 'ssd.jpl.nasa.gov');
      feeds.ok('horizons', null, `${o.name}: ${rows.length} vectors`);
    } catch (e) { o.hzError = e.message; }
    o.hzLoading = false;
    this.app.bus.emit('neo:refined', o);
  }

  horizonsEci(o, ms) {
    const h = o.hz;
    if (!h || ms < h.t[0] || ms > h.t[h.t.length - 1]) return null;
    let k = 0;
    while (k < h.t.length - 2 && h.t[k + 1] < ms) k++;
    const t0 = h.t[k], t1 = h.t[k + 1], dt = (t1 - t0) / 1000, s = (ms - t0) / (t1 - t0);
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const p = [0, 1, 2].map((i) => h00 * h.p[k][i] + h10 * dt * h.v[k][i] + h01 * h.p[k + 1][i] + h11 * dt * h.v[k + 1][i]);
    return icrfToEqd(p, ms);
  }

  /** Geocentric state (ECI-of-date km) for every object at time ms; also caches photometry. */
  stateAt(o, ms, ctx = bodyContext(ms)) {
    if (!o.el) return null;
    const g = smallBodyGeo(o.el, ctx);
    const hz = this.horizonsEci(o, ms);
    const eci = hz || g.eci;
    const dKm = Math.hypot(...eci);
    const mag = Number.isFinite(o.H) ? hgMagnitude(o.H, o.G ?? 0.15, g.rAU, dKm / AU_KM, g.phase) : NaN;
    return { eci, dKm, rAU: g.rAU, phase: g.phase, mag, source: hz ? 'JPL Horizons' : 'two-body (SBDB elements)' };
  }

  scenePositions(ms, scale) {
    const ctx = bodyContext(ms);
    return this.list.map((o) => {
      const s = this.stateAt(o, ms, ctx);
      o.now = s;
      if (!s) return null;
      const p = toScene(s.eci), r = Math.hypot(...p);
      const f = scale === 'true' ? 1 : compressR(r) / r;
      return [p[0] * f, p[1] * f, p[2] * f];
    });
  }

  /** Geocentric distance curve around now for charts. */
  distanceSeries(o, ms, days = 10, steps = 160) {
    const t = [], d = [];
    for (let k = 0; k <= steps; k++) {
      const tt = ms + (k / steps - 0.5) * 2 * days * 86400e3;
      const s = this.stateAt(o, tt);
      if (s) { t.push(tt); d.push(s.dKm / LD_KM); }
    }
    return { t, d };
  }

  /** Geocentric trajectory (scene units) for the orbit line. */
  trajectory(o, ms, scale, days = 30, steps = 240) {
    const out = [];
    for (let k = 0; k <= steps; k++) {
      const tt = ms + (k / steps - 0.5) * 2 * days * 86400e3;
      const s = this.stateAt(o, tt);
      if (!s) continue;
      const p = toScene(s.eci), r = Math.hypot(...p), f = scale === 'true' ? 1 : compressR(r) / r;
      out.push([p[0] * f, p[1] * f, p[2] * f]);
    }
    return out;
  }
}
