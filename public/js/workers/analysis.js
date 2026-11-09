/**
 * Long-running analyses (separate worker so the live propagation never stalls):
 *  • screen  — conjunction screening of one object against the loaded catalog (SGP4)
 *  • night   — sunlit-satellite counts over the coming night for the observer
 *  • bright  — visible passes of the brightest objects in the next 24 h
 */
import { RE, makeSatrec, pv, makeObserver, observerEci, look, sunlit, magnitude, sunElevation, sunUnit, sat } from './core.js';

let recs = [];
let meta = [];     // { id, name, cat, std, hbr }
let obs = null;
const tmp = [0, 0, 0];

function ingest(objects) {
  for (const o of objects) { recs.push(makeSatrec(o)); meta.push({ id: o.id, name: o.name, cat: o.cat, std: o.std ?? 6, hbr: o.hbr ?? 3 }); }
}

const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = norm(a); return [a[0] / n, a[1] / n, a[2] / n]; };

function distAt(P, Q, t) {
  const d = new Date(t);
  const a = pv(P, d), b = pv(Q, d);
  if (!a || !b) return Infinity;
  return norm(sub(b.position, a.position));
}

/**
 * Conjunction screening: apogee/perigee filter → 60 s sampling with linear-motion TCA prediction →
 * golden-section refinement of each candidate approach.
 */
function screen({ job, primary, t0, hours = 24, threshold = 10 }) {
  const P = recs[primary];
  if (!P) return postMessage({ type: 'screen', job, error: 'primary orbit unavailable' });
  const periodMin = (2 * Math.PI) / P.no;
  const dt = periodMin < 200 ? 60 : 300;
  const K = Math.ceil((hours * 3600) / dt);
  const dates = Array.from({ length: K + 1 }, (_, k) => new Date(t0 + k * dt * 1000));
  const pp = new Float64Array((K + 1) * 3).fill(NaN), pvv = new Float64Array((K + 1) * 3);
  for (let k = 0; k <= K; k++) {
    const r = pv(P, dates[k]); if (!r) continue;
    pp.set([r.position.x, r.position.y, r.position.z], k * 3);
    pvv.set([r.velocity.x, r.velocity.y, r.velocity.z], k * 3);
  }
  const pLo = P.altp * RE, pHi = P.alta * RE, pad = threshold + 40;
  const cand = [];
  for (let j = 0; j < recs.length; j++) {
    const Q = recs[j];
    if (!Q || j === primary) continue;
    const qLo = Q.altp * RE, qHi = Q.alta * RE;
    if (qLo - pad > pHi || pLo - pad > qHi) continue;
    cand.push(j);
  }
  postMessage({ type: 'progress', job, p: 0, note: `${cand.length.toLocaleString()} objects share the altitude band` });
  const results = [];
  let colocated = 0, refined = 0;
  const gate = threshold + 25;
  for (let c = 0; c < cand.length; c++) {
    const j = cand[c], Q = recs[j];
    let maxD = 0, minD = Infinity;
    const events = [];
    for (let k = 0; k <= K; k++) {
      if (Number.isNaN(pp[k * 3])) continue;
      const r = pv(Q, dates[k]); if (!r) continue;
      const dx = r.position.x - pp[k * 3], dy = r.position.y - pp[k * 3 + 1], dz = r.position.z - pp[k * 3 + 2];
      const vx = r.velocity.x - pvv[k * 3], vy = r.velocity.y - pvv[k * 3 + 1], vz = r.velocity.z - pvv[k * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxD) maxD = d; if (d < minD) minD = d;
      const vv = vx * vx + vy * vy + vz * vz;
      if (vv < 1e-12) continue;
      const tau = -(dx * vx + dy * vy + dz * vz) / vv;
      if (Math.abs(tau) > dt * 0.75) continue;
      const lx = dx + vx * tau, ly = dy + vy * tau, lz = dz + vz * tau;
      if (Math.sqrt(lx * lx + ly * ly + lz * lz) < gate) events.push(dates[k].getTime() + tau * 1000);
    }
    if (maxD < 30 && minD < 30) { colocated++; continue; }   // docked / formation-flying pair
    events.sort((a, b) => a - b);
    let last = -Infinity;
    for (const te of events) {
      if (te - last < 120e3) continue;
      last = te;
      // golden-section search for the minimum distance in [te-45 s, te+45 s]
      let a = te - 45e3, b = te + 45e3;
      const gr = 0.381966;
      let m1 = a + gr * (b - a), m2 = b - gr * (b - a), f1 = distAt(P, Q, m1), f2 = distAt(P, Q, m2);
      for (let it = 0; it < 26 && b - a > 5; it++) {
        if (f1 < f2) { b = m2; m2 = m1; f2 = f1; m1 = a + gr * (b - a); f1 = distAt(P, Q, m1); }
        else { a = m1; m1 = m2; f1 = f2; m2 = b - gr * (b - a); f2 = distAt(P, Q, m2); }
      }
      refined++;
      const tca = (a + b) / 2;
      if (tca < t0 || tca > t0 + hours * 3600e3) continue;
      const date = new Date(tca);
      const sa = pv(P, date), sb = pv(Q, date);
      if (!sa || !sb) continue;
      const dvec = sub(sb.position, sa.position), miss = norm(dvec);
      if (miss > threshold) continue;
      const r1 = [sa.position.x, sa.position.y, sa.position.z], v1 = [sa.velocity.x, sa.velocity.y, sa.velocity.z];
      const R = unit(r1), C = unit(cross(r1, v1)), I = cross(C, R);
      const dv = sub(sb.velocity, sa.velocity);
      const hbrKm = (meta[primary].hbr + meta[j].hbr) / 1000;
      const maxPc = miss <= hbrKm ? 1 : Math.min(1, (hbrKm * hbrKm) / (Math.E * miss * miss));
      results.push({
        j, id: meta[j].id, name: meta[j].name, cat: meta[j].cat, tca, missKm: miss,
        radialKm: dot(dvec, R), intrackKm: dot(dvec, I), crossKm: dot(dvec, C), relSpeed: norm(dv), hbrM: hbrKm * 1000, maxPc,
      });
    }
    if (c % 200 === 0) postMessage({ type: 'progress', job, p: c / cand.length });
  }
  results.sort((x, y) => x.missKm - y.missKm);
  postMessage({ type: 'screen', job, primary, results, candidates: cand.length, colocated, refined, stepS: dt, hours, threshold, t0 });
}

/** Counts of sunlit objects above `minEl` from t0 to t1 (observer-dependent). */
function night({ job, t0, t1, stepMin = 10, minEl = 10, starlinkCat, payloadCats = [] }) {
  const payload = new Set(payloadCats);
  if (!obs) return postMessage({ type: 'night', job, error: 'observer not set' });
  const steps = Math.max(2, Math.floor((t1 - t0) / (stepMin * 60e3)) + 1);
  const out = { t: [], lit: [], starlink: [], naked: [], satcon: [], sunEl: [] };
  for (let k = 0; k < steps; k++) {
    const t = t0 + k * stepMin * 60e3, date = new Date(t);
    const g = sat.gstime(date), c = Math.cos(g), s = Math.sin(g);
    const sun = sunUnit(t), oe = observerEci(obs, g);
    let lit = 0, sl = 0, naked = 0, satcon = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = pv(recs[i], date); if (!r) continue;
      look(r.position, c, s, obs, tmp);
      if (tmp[1] < minEl || !sunlit(r.position, sun)) continue;
      lit++;
      if (meta[i].cat === starlinkCat) sl++;
      const m = magnitude(meta[i].std, r.position, oe, sun, tmp[2]);
      const h = Math.hypot(r.position.x, r.position.y, r.position.z) - RE;
      if (m <= 6) naked++;
      if (payload.has(meta[i].cat) && m < 7 + 2.5 * Math.log10(Math.max(h, 550) / 550)) satcon++;   // IAU CPS recommendation (operational satellites)
    }
    out.t.push(t); out.lit.push(lit); out.starlink.push(sl); out.naked.push(naked); out.satcon.push(satcon); out.sunEl.push(sunElevation(obs, sun, g));
    postMessage({ type: 'progress', job, p: (k + 1) / steps });
  }
  postMessage({ type: 'night', job, ...out, minEl, stepMin });
}

/** Visible (sunlit, dark-sky) passes of bright objects in the next `hours`. */
function bright({ job, t0, hours = 24, maxStd = 4, magLimit = 4.5 }) {
  if (!obs) return postMessage({ type: 'bright', job, error: 'observer not set' });
  const list = [];
  const step = 30e3, end = t0 + hours * 3600e3;
  const idx = meta.map((m, i) => i).filter((i) => recs[i] && meta[i].std <= maxStd && (2 * Math.PI) / recs[i].no < 200);
  for (const i of idx) {
    let cur = null;
    for (let t = t0; t <= end; t += step) {
      const date = new Date(t);
      const r = pv(recs[i], date); if (!r) break;
      const g = sat.gstime(date);
      look(r.position, Math.cos(g), Math.sin(g), obs, tmp);
      const sun = sunUnit(t);
      const vis = tmp[1] > 10 && sunlit(r.position, sun) && sunElevation(obs, sun, g) < -6;
      if (vis) {
        const m = magnitude(meta[i].std, r.position, observerEci(obs, g), sun, tmp[2]);
        if (!cur) cur = { i, id: meta[i].id, name: meta[i].name, start: t, startAz: tmp[0], end: t, endAz: tmp[0], maxEl: tmp[1], maxElAt: t, minMag: m };
        cur.end = t; cur.endAz = tmp[0];
        if (tmp[1] > cur.maxEl) { cur.maxEl = tmp[1]; cur.maxElAt = t; }
        if (m < cur.minMag) cur.minMag = m;
      } else if (cur) {
        if (cur.minMag <= magLimit) list.push(cur);
        cur = null;
      }
    }
    if (cur && cur.minMag <= magLimit) list.push(cur);
  }
  list.sort((a, b) => a.start - b.start);
  postMessage({ type: 'bright', job, passes: list.slice(0, 40) });
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': recs = []; meta = []; ingest(m.objects); postMessage({ type: 'ready', count: recs.length }); break;
      case 'add': ingest(m.objects); break;
      case 'observer': obs = makeObserver(m.lat, m.lon, m.alt); break;
      case 'screen': screen(m); break;
      case 'night': night(m); break;
      case 'bright': bright(m); break;
      default: break;
    }
  } catch (err) {
    postMessage({ type: 'error', job: m.job, message: String(err && err.message || err) });
  }
};
