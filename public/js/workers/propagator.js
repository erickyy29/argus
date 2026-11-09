/**
 * Real-time SGP4 propagation of the full catalog (runs off the main thread).
 * Each tick returns scene-frame positions/velocities plus topocentric look angles,
 * illumination and a brightness estimate for every object.
 */
import { RE, DEG, makeSatrec, pv, makeObserver, observerEci, look, sunlit, magnitude, sunElevation, sunUnit, enuDir, sat } from './core.js';

let recs = [];      // satrec | null
let stds = [];      // standard magnitudes
let obs = null;
const tmp = [0, 0, 0];

function ingest(objects) {
  let bad = 0;
  for (const o of objects) {
    const r = makeSatrec(o);
    if (!r) bad++;
    recs.push(r); stds.push(o.std ?? 6);
  }
  return bad;
}

function alloc(n, rec) {
  const ok = (a, len) => a && a.length === len;
  return {
    pos: ok(rec?.pos, n * 3) ? rec.pos : new Float32Array(n * 3),
    vel: ok(rec?.vel, n * 3) ? rec.vel : new Float32Array(n * 3),
    st: ok(rec?.st, n) ? rec.st : new Float32Array(n),
  };
}

function tick({ t, seq, sun, recycle }) {
  const n = recs.length;
  const { pos, vel, st } = alloc(n, recycle);
  const az = new Float32Array(n), el = new Float32Array(n), rng = new Float32Array(n), mag = new Float32Array(n);
  const date = new Date(t);
  const g = sat.gstime(date), c = Math.cos(g), s = Math.sin(g);
  const oe = obs ? observerEci(obs, g) : null;
  for (let i = 0; i < n; i++) {
    const r = pv(recs[i], date);
    const k = i * 3;
    if (!r) { st[i] = 0; az[i] = el[i] = rng[i] = mag[i] = NaN; pos[k] = pos[k + 1] = pos[k + 2] = 0; vel[k] = vel[k + 1] = vel[k + 2] = 0; continue; }
    const p = r.position, v = r.velocity;
    pos[k] = p.x / RE; pos[k + 1] = p.z / RE; pos[k + 2] = -p.y / RE;
    vel[k] = v.x / RE; vel[k + 1] = v.z / RE; vel[k + 2] = -v.y / RE;
    const lit = sunlit(p, sun);
    st[i] = lit ? 2 : 1;
    if (obs) {
      look(p, c, s, obs, tmp);
      az[i] = tmp[0]; el[i] = tmp[1]; rng[i] = tmp[2];
      mag[i] = lit && tmp[1] > -2 ? magnitude(stds[i], p, oe, sun, tmp[2]) : NaN;
    } else { az[i] = el[i] = rng[i] = mag[i] = NaN; }
  }
  const sunEl = obs ? sunElevation(obs, sun, g) : NaN;
  postMessage({ type: 'state', seq, t, n, pos, vel, st, az, el, rng, mag, sunEl }, [pos.buffer, vel.buffer, st.buffer, az.buffer, el.buffer, rng.buffer, mag.buffer]);
}

/** Topocentric state of one object at time t. */
function topoAt(i, t, out = {}) {
  const date = new Date(t);
  const r = pv(recs[i], date);
  if (!r) return null;
  const g = sat.gstime(date);
  look(r.position, Math.cos(g), Math.sin(g), obs, tmp);
  out.az = tmp[0]; out.el = tmp[1]; out.range = tmp[2]; out.p = r.position;
  return out;
}

function crossing(i, ta, tb, minEl) {
  // bisection for the elevation crossing between ta and tb (to 0.5 s)
  let a = ta, b = tb;
  const ea = topoAt(i, a)?.el ?? -90;
  for (let k = 0; k < 24 && b - a > 500; k++) {
    const m = (a + b) / 2;
    const em = topoAt(i, m)?.el ?? -90;
    if ((em > minEl) === (ea > minEl)) a = m; else b = m;
  }
  return (a + b) / 2;
}

function passes({ req, i, t0, hours, minEl, max = 8 }) {
  if (!obs || !recs[i]) return postMessage({ type: 'passes', req, passes: [], error: 'no orbit' });
  const periodMin = (2 * Math.PI) / recs[i].no;
  const step = periodMin > 600 ? 300e3 : periodMin > 200 ? 120e3 : 20e3;
  const end = t0 + hours * 3600e3;
  const out = [];
  let cur = topoAt(i, t0);
  if (!cur) return postMessage({ type: 'passes', req, passes: [], error: 'propagation failed' });
  // geostationary or always-up objects
  let inPass = cur.el > minEl;
  let pass = inPass ? { aos: t0, aosAz: cur.az, maxEl: cur.el, tca: t0, track: [], visible: false, minMag: 99, ongoing: true } : null;
  for (let t = t0 + step; t <= end && out.length < max; t += step) {
    const s = topoAt(i, t);
    if (!s) break;
    const date = new Date(t), g = sat.gstime(date);
    if (!inPass && s.el > minEl) {
      const aos = crossing(i, t - step, t, minEl);
      const sa = topoAt(i, aos);
      pass = { aos, aosAz: sa?.az ?? s.az, maxEl: s.el, tca: t, track: [], visible: false, minMag: 99 };
      inPass = true;
    }
    if (inPass) {
      if (s.el > pass.maxEl) { pass.maxEl = s.el; pass.tca = t; }
      const sun = sunUnit(t);
      const lit = sunlit(s.p, sun);
      const dark = sunElevation(obs, sun, g) < -6;
      const mg = lit ? magnitude(stds[i], s.p, observerEci(obs, g), sun, s.range) : 99;
      pass.track.push([s.az, s.el, lit ? 1 : 0]);
      if (lit && dark && s.el > 10) { pass.visible = true; pass.minMag = Math.min(pass.minMag, mg); }
      if (s.el <= minEl) {
        pass.los = crossing(i, t - step, t, minEl);
        pass.losAz = topoAt(i, pass.los)?.az ?? s.az;
        // refine culmination with golden-section search
        let a = pass.tca - step, b = pass.tca + step;
        const gr = 0.381966;
        for (let k = 0; k < 20; k++) {
          const m1 = a + gr * (b - a), m2 = b - gr * (b - a);
          if ((topoAt(i, m1)?.el ?? -90) > (topoAt(i, m2)?.el ?? -90)) b = m2; else a = m1;
        }
        const top = topoAt(i, (a + b) / 2);
        if (top) { pass.tca = (a + b) / 2; pass.maxEl = top.el; pass.tcaAz = top.az; pass.tcaRange = top.range; }
        out.push(pass); inPass = false; pass = null;
      }
    }
  }
  if (pass) { pass.los = null; out.push(pass); }
  postMessage({ type: 'passes', req, passes: out, step });
}

/** Smallest angle (rad) between unit vector b and the great-circle arc q→d. */
function arcSep(q, d, b) {
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  let best = Math.min(Math.acos(Math.max(-1, Math.min(1, dot(b, q)))), Math.acos(Math.max(-1, Math.min(1, dot(b, d)))));
  const nx = q[1] * d[2] - q[2] * d[1], ny = q[2] * d[0] - q[0] * d[2], nz = q[0] * d[1] - q[1] * d[0];
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 1e-12) {
    const n = [nx / nl, ny / nl, nz / nl], bn = dot(b, n);
    const bp = [b[0] - bn * n[0], b[1] - bn * n[1], b[2] - bn * n[2]];
    const c1 = (q[1] * bp[2] - q[2] * bp[1]) * n[0] + (q[2] * bp[0] - q[0] * bp[2]) * n[1] + (q[0] * bp[1] - q[1] * bp[0]) * n[2];
    const c2 = (bp[1] * d[2] - bp[2] * d[1]) * n[0] + (bp[2] * d[0] - bp[0] * d[2]) * n[1] + (bp[0] * d[1] - bp[1] * d[0]) * n[2];
    if (c1 >= 0 && c2 >= 0) best = Math.min(best, Math.asin(Math.min(1, Math.abs(bn))));
  }
  return best;
}

/**
 * Predict which objects cross a camera field of view during an exposure.
 * Each object's path between samples is tested as a great-circle arc, so fast movers cannot slip through.
 * Boresight is fixed (az/el) or follows catalog object `target`.
 */
function fov({ req, t0, T, step, az, el, target, half }) {
  if (!obs) return postMessage({ type: 'fov', req, crossings: [] });
  const n = recs.length, K = Math.max(1, Math.round(T / step));
  const halfRad = half * DEG;
  const cand = [];
  const d0 = new Date(t0), g0 = sat.gstime(d0), c0 = Math.cos(g0), s0 = Math.sin(g0);
  for (let i = 0; i < n; i++) {
    const r = pv(recs[i], d0); if (!r) continue;
    look(r.position, c0, s0, obs, tmp);
    if (tmp[1] > -25) cand.push(i);
  }
  const prev = new Float64Array(cand.length * 4).fill(NaN);   // previous direction (3) + elevation
  const hits = new Map();
  let prevBore = null, prevT = t0;
  for (let k = 0; k <= K; k++) {
    const t = t0 + k * step * 1000;
    const date = new Date(t), g = sat.gstime(date), c = Math.cos(g), s = Math.sin(g);
    const sun = sunUnit(t), oe = observerEci(obs, g);
    let bore;
    if (target != null && recs[target]) {
      const r = pv(recs[target], date); if (!r) continue;
      look(r.position, c, s, obs, tmp); bore = enuDir(tmp[0], tmp[1]);
    } else bore = enuDir(az, el);
    const bm = prevBore ? (() => { const v = [bore[0] + prevBore[0], bore[1] + prevBore[1], bore[2] + prevBore[2]]; const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; })() : bore;
    for (let ci = 0; ci < cand.length; ci++) {
      const i = cand[ci];
      if (i === target) continue;
      const r = pv(recs[i], date); if (!r) continue;
      look(r.position, c, s, obs, tmp);
      const d = enuDir(tmp[0], tmp[1]), elNow = tmp[1], range = tmp[2];
      const o = ci * 4, hasPrev = !Number.isNaN(prev[o]);
      const q = hasPrev ? [prev[o], prev[o + 1], prev[o + 2]] : d;
      const elPrev = hasPrev ? prev[o + 3] : elNow;
      prev[o] = d[0]; prev[o + 1] = d[1]; prev[o + 2] = d[2]; prev[o + 3] = elNow;
      if (elNow < 0 && elPrev < 0) continue;
      const sep = hasPrev ? arcSep(q, d, bm) : arcSep(d, d, bore);
      if (sep > halfRad) continue;
      const lit = sunlit(r.position, sun);
      const mg = lit ? magnitude(stds[i], r.position, oe, sun, range) : 99;
      const h = hits.get(i);
      const enter = hasPrev ? prevT : t;
      if (!h) hits.set(i, { i, enter, exit: t, minSep: sep / DEG, lit, mag: mg, range });
      else { h.exit = t; if (sep / DEG < h.minSep) h.minSep = sep / DEG; h.lit ||= lit; h.mag = Math.min(h.mag, mg); }
    }
    prevBore = bore; prevT = t;
  }
  const crossings = [...hits.values()].sort((a, b) => a.enter - b.enter);
  postMessage({ type: 'fov', req, crossings, candidates: cand.length });
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': recs = []; stds = []; { const bad = ingest(m.objects); postMessage({ type: 'ready', count: recs.length, bad }); } break;
      case 'add': { const from = recs.length; const bad = ingest(m.objects); postMessage({ type: 'added', from, count: m.objects.length, bad }); } break;
      case 'observer': obs = makeObserver(m.lat, m.lon, m.alt); break;
      case 'tick': tick(m); break;
      case 'passes': passes(m); break;
      case 'fov': fov(m); break;
      default: break;
    }
  } catch (err) {
    postMessage({ type: 'error', req: m.req, message: String(err && err.message || err) });
  }
};
