/* Reference frames, Sun/Moon ephemerides, small-body propagation and photometry (main thread). */
import * as A from 'astronomy-engine';
import { gstime } from 'satellite.js';

export const RE = 6378.137;
export const AU_KM = 149597870.7;
export const LD_KM = 384400;
export const DEG = Math.PI / 180;
const F = 1 / 298.257223563, E2 = F * (2 - F);
const TT_UTC_S = 69.184;     // TT − UTC (32.184 s + 37 leap seconds)

export { gstime };
export const toScene = (v) => [v[0] / RE, v[2] / RE, -v[1] / RE];            // ECI km → scene units (Earth radii, Y-up)
export const jdUT = (ms) => ms / 86400000 + 2440587.5;
export const jdTT = (ms) => jdUT(ms) + TT_UTC_S / 86400;

export function geodeticToEcef(latDeg, lonDeg, hKm) {
  const la = latDeg * DEG, lo = lonDeg * DEG, s = Math.sin(la), c = Math.cos(la);
  const N = RE / Math.sqrt(1 - E2 * s * s);
  return [(N + hKm) * c * Math.cos(lo), (N + hKm) * c * Math.sin(lo), (N * (1 - E2) + hKm) * s];
}
export const eciToEcef = ([x, y, z], g) => { const c = Math.cos(g), s = Math.sin(g); return [c * x + s * y, -s * x + c * y, z]; };
export const ecefToEci = ([x, y, z], g) => { const c = Math.cos(g), s = Math.sin(g); return [c * x - s * y, s * x + c * y, z]; };

export function ecefToGeodetic([x, y, z]) {
  const lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2)), h = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat), N = RE / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - E2 * N / (N + h)));
  }
  return { lat: lat / DEG, lon: lon / DEG, alt: h };
}

export class Observer {
  constructor(o) { this.set(o); }
  set({ lat, lon, alt = 0, name = '' }) {
    Object.assign(this, { lat, lon, alt, name });
    this.ecef = geodeticToEcef(lat, lon, alt);
    const la = lat * DEG, lo = lon * DEG, sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    this.E = [-so, co, 0]; this.N = [-sl * co, -sl * so, cl]; this.U = [cl * co, cl * so, sl];
    this.ae = new A.Observer(lat, lon, alt * 1000);
    return this;
  }
  /** Look angles (deg, deg, km) to an ECEF position (km). */
  look([x, y, z]) {
    const dx = x - this.ecef[0], dy = y - this.ecef[1], dz = z - this.ecef[2];
    const e = dx * this.E[0] + dy * this.E[1], n = dx * this.N[0] + dy * this.N[1] + dz * this.N[2], u = dx * this.U[0] + dy * this.U[1] + dz * this.U[2];
    const r = Math.hypot(e, n, u);
    let az = Math.atan2(e, n) / DEG; if (az < 0) az += 360;
    return { az, el: Math.asin(u / r) / DEG, range: r };
  }
  lookEci(eci, g) { return this.look(eciToEcef(eci, g)); }
  /** ENU unit vector → ECEF unit vector. */
  enuToEcef([e, n, u]) { return [e * this.E[0] + n * this.N[0] + u * this.U[0], e * this.E[1] + n * this.N[1] + u * this.U[1], n * this.N[2] + u * this.U[2]]; }
}

export const enuDir = (az, el) => [Math.sin(az * DEG) * Math.cos(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG)];
export function angularSep(az1, el1, az2, el2) {
  const a = enuDir(az1, el1), b = enuDir(az2, el2);
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG;
}

/* ── astronomy-engine wrappers (J2000 → true equator of date ≈ TEME frame used by SGP4) ── */
const applyRot = (r, [x, y, z]) => [r[0][0] * x + r[1][0] * y + r[2][0] * z, r[0][1] * x + r[1][1] * y + r[2][1] * z, r[0][2] * x + r[1][2] * y + r[2][2] * z];
let rotCache = { key: -1, rot: null };
export function eqjToEqdRot(ms) {
  const key = Math.floor(ms / 3600e3);
  if (rotCache.key !== key) rotCache = { key, rot: A.Rotation_EQJ_EQD(A.MakeTime(new Date(key * 3600e3))).rot };
  return rotCache.rot;
}
export const eqjToEqd = (v, ms) => applyRot(eqjToEqdRot(ms), v);

export function sunEci(ms) {
  const v = A.GeoVector(A.Body.Sun, A.MakeTime(new Date(ms)), true);
  return eqjToEqd([v.x * AU_KM, v.y * AU_KM, v.z * AU_KM], ms);
}
export function moonEci(ms) {
  const v = A.GeoMoon(A.MakeTime(new Date(ms)));
  return eqjToEqd([v.x * AU_KM, v.y * AU_KM, v.z * AU_KM], ms);
}
export function earthHelioEqj(ms) {
  const v = A.HelioVector(A.Body.Earth, A.MakeTime(new Date(ms)));
  return [v.x, v.y, v.z];
}

export function bodyHorizon(body, ms, obs) {
  const t = A.MakeTime(new Date(ms));
  const eq = A.Equator(body, t, obs.ae, true, true);
  const h = A.Horizon(t, obs.ae, eq.ra, eq.dec, 'normal');
  return { az: h.azimuth, el: h.altitude, dist: eq.dist * AU_KM, ra: eq.ra, dec: eq.dec };
}

export function twilight(sunEl) {
  if (sunEl > -0.833) return 'Daylight';
  if (sunEl > -6) return 'Civil twilight';
  if (sunEl > -12) return 'Nautical twilight';
  if (sunEl > -18) return 'Astronomical twilight';
  return 'Night';
}

export function moonInfo(ms, obs) {
  const t = A.MakeTime(new Date(ms));
  const phase = A.MoonPhase(t);
  const ill = A.Illumination(A.Body.Moon, t);
  const names = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const h = bodyHorizon(A.Body.Moon, ms, obs);
  return { phase, name: names[Math.round(phase / 45) % 8], illum: ill.phase_fraction, mag: ill.mag, ...h };
}

/** Next dark window (Sun below −6°, geometric), or the current one if it is already dark; 24 h during polar night. */
export function nightWindow(ms, obs, depth = -6) {
  const t = A.MakeTime(new Date(ms));
  const eq = A.Equator(A.Body.Sun, t, obs.ae, true, true);
  const sunEl = A.Horizon(t, obs.ae, eq.ra, eq.dec).altitude;   // geometric, consistent with SearchAltitude
  let dusk;
  if (sunEl < depth) {
    dusk = A.SearchAltitude(A.Body.Sun, obs.ae, -1, A.MakeTime(new Date(ms - 86400e3)), 1, depth);
    if (!dusk || dusk.date.getTime() > ms) dusk = A.MakeTime(new Date(ms));   // polar night or search miss: start now
  } else dusk = A.SearchAltitude(A.Body.Sun, obs.ae, -1, t, 1.2, depth);
  if (!dusk) return null;                                                   // polar day
  const dawn = A.SearchAltitude(A.Body.Sun, obs.ae, +1, dusk, 1.2, depth);
  if (!dawn) {
    if (sunEl < depth) { const s0 = dusk.date.getTime(); return { start: s0, end: s0 + 86400e3, dark: true, polar: true }; }
    return null;
  }
  return { start: dusk.date.getTime(), end: dawn.date.getTime(), dark: sunEl < depth };
}

/* ── small bodies ── */
const EPS = 23.4392911 * DEG;
const eclToEqj = ([x, y, z]) => [x, Math.cos(EPS) * y - Math.sin(EPS) * z, Math.sin(EPS) * y + Math.cos(EPS) * z];

/** Two-body heliocentric position (AU, ecliptic J2000) from osculating elements at JD(TT). */
export function keplerEcl(el, jd) {
  const n = el.n ?? 0.9856076686 / Math.pow(el.a, 1.5);
  const e = el.e;
  let M = el.ma != null ? el.ma + n * (jd - el.epoch) : n * (jd - el.tp);
  M = (((M % 360) + 540) % 360 - 180) * DEG;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 50; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  const xp = el.a * (Math.cos(E) - e), yp = el.a * Math.sqrt(1 - e * e) * Math.sin(E);
  const O = el.om * DEG, w = el.w * DEG, i = el.i * DEG;
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i);
  return [
    (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
    (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

/** Per-frame context shared by all small bodies. */
export function bodyContext(ms) { return { ms, earth: earthHelioEqj(ms), rot: eqjToEqdRot(ms) }; }

/** Geocentric state of a small body: ECI-of-date km vector plus distances and phase angle. */
export function smallBodyGeo(el, ctx) {
  const h = eclToEqj(keplerEcl(el, jdTT(ctx.ms)));
  const g = [h[0] - ctx.earth[0], h[1] - ctx.earth[1], h[2] - ctx.earth[2]];
  const r = Math.hypot(...h), d = Math.hypot(...g);
  const cosA = (h[0] * g[0] + h[1] * g[1] + h[2] * g[2]) / (r * d);
  return { eci: applyRot(ctx.rot, [g[0] * AU_KM, g[1] * AU_KM, g[2] * AU_KM]), rAU: r, dAU: d, phase: Math.acos(Math.max(-1, Math.min(1, cosA))) };
}

/** Rotate an ICRF/J2000 km vector into the of-date frame. */
export const icrfToEqd = (v, ms) => applyRot(eqjToEqdRot(ms), v);

/** IAU H–G apparent magnitude. */
export function hgMagnitude(H, G, rAU, dAU, alpha) {
  const t = Math.tan(alpha / 2);
  const p1 = Math.exp(-3.33 * Math.pow(t, 0.63)), p2 = Math.exp(-1.87 * Math.pow(t, 1.22));
  return H + 5 * Math.log10(rAU * dAU) - 2.5 * Math.log10((1 - G) * p1 + G * p2);
}
export const diameterFromH = (H, albedo = 0.14) => (1329 / Math.sqrt(albedo)) * 10 ** (-H / 5);  // km

/** Radial compression so deep-space objects fit the scene (directions are preserved). */
export const COMPRESS_R0 = 70;
export const compressR = (r) => (r <= COMPRESS_R0 ? r : COMPRESS_R0 * (1 + Math.log(r / COMPRESS_R0)));

/** Ground radius (deg of arc) of the area from which an object at hKm appears above minEl degrees. */
export function visibilityRadiusDeg(hKm, minEl = 10) {
  const e = minEl * DEG;
  return (Math.acos((RE / (RE + hKm)) * Math.cos(e)) - e) / DEG;
}

/** Classical orbital elements from mean motion (rev/day) & eccentricity. */
export function orbitFromMeanMotion(nRevDay, e) {
  const n = (nRevDay * 2 * Math.PI) / 86400;
  const a = Math.cbrt(398600.4418 / (n * n));
  return { a, periodMin: 1440 / nRevDay, perigee: a * (1 - e) - RE, apogee: a * (1 + e) - RE };
}
export function regime(perigee, apogee, periodMin) {
  if (apogee < 2000) return 'LEO';
  if (Math.abs(periodMin - 1436) < 30 && apogee - perigee < 1000) return 'GEO';
  if (perigee > 2000 && apogee < 35000) return 'MEO';
  return perigee < 2000 && apogee > 20000 ? 'HEO' : 'High orbit';
}
