/* Shared SGP4 / topocentric helpers for the web workers. */
import * as sat from '/vendor/satellite.js';

export { sat };
export const RE = 6378.137;
export const DEG = Math.PI / 180;
const F = 1 / 298.257223563, E2 = F * (2 - F);
const PROPAGATE_OPTS = { communityDecayCheckEnabled: true };

export function makeSatrec(o) {
  try {
    const rec = o.tle1 ? sat.twoline2satrec(o.tle1, o.tle2) : sat.json2satrec(o.omm);
    return rec && !rec.error ? rec : null;
  } catch { return null; }
}

/** TEME position/velocity (km, km/s) or null. */
export function pv(rec, date) {
  if (!rec) return null;
  try {
    const r = sat.propagate(rec, date, PROPAGATE_OPTS);
    if (!r || !r.position || typeof r.position !== 'object' || !Number.isFinite(r.position.x)) return null;
    return r;
  } catch { return null; }
}

export function makeObserver(lat, lon, altKm) {
  const la = lat * DEG, lo = lon * DEG;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  const N = RE / Math.sqrt(1 - E2 * sl * sl);
  return {
    lat, lon, alt: altKm,
    x: (N + altKm) * cl * co, y: (N + altKm) * cl * so, z: (N * (1 - E2) + altKm) * sl,
    E: [-so, co, 0], N: [-sl * co, -sl * so, cl], U: [cl * co, cl * so, sl],
  };
}

/** Observer position in ECI (km) for Greenwich sidereal angle g. */
export function observerEci(obs, g) {
  const c = Math.cos(g), s = Math.sin(g);
  return [c * obs.x - s * obs.y, s * obs.x + c * obs.y, obs.z];
}

/** Unit vector toward the Sun (ECI) at epoch ms. */
export function sunUnit(ms) {
  const { rsun } = sat.sunPos(ms / 86400000 + 2440587.5);
  const n = Math.hypot(rsun.x, rsun.y, rsun.z);
  return [rsun.x / n, rsun.y / n, rsun.z / n];
}

/** Writes [az°, el°, range km] into out for ECI position p. */
export function look(p, c, s, obs, out) {
  const xe = c * p.x + s * p.y, ye = -s * p.x + c * p.y, ze = p.z;
  const dx = xe - obs.x, dy = ye - obs.y, dz = ze - obs.z;
  const e = dx * obs.E[0] + dy * obs.E[1];
  const n = dx * obs.N[0] + dy * obs.N[1] + dz * obs.N[2];
  const u = dx * obs.U[0] + dy * obs.U[1] + dz * obs.U[2];
  const r = Math.sqrt(e * e + n * n + u * u);
  let az = Math.atan2(e, n) / DEG; if (az < 0) az += 360;
  out[0] = az; out[1] = Math.asin(u / r) / DEG; out[2] = r;
  return out;
}

/** Cylindrical Earth-shadow test. */
export function sunlit(p, sun) {
  const d = p.x * sun[0] + p.y * sun[1] + p.z * sun[2];
  if (d >= 0) return true;
  const qx = p.x - d * sun[0], qy = p.y - d * sun[1], qz = p.z - d * sun[2];
  return qx * qx + qy * qy + qz * qz > RE * RE;
}

/**
 * Apparent visual magnitude estimate: standard magnitude at 1000 km and 90° phase, scaled by range and a
 * diffuse-sphere phase law. Typical error ±1 mag (attitude, solar arrays and glints are not modelled).
 */
export function magnitude(std, p, obsEci, sun, range) {
  const ox = obsEci[0] - p.x, oy = obsEci[1] - p.y, oz = obsEci[2] - p.z;
  const cosPhi = Math.max(-1, Math.min(1, (ox * sun[0] + oy * sun[1] + oz * sun[2]) / range));
  const phi = Math.acos(cosPhi);
  const f = (Math.sin(phi) + (Math.PI - phi) * cosPhi) / Math.PI;
  if (f <= 1e-4) return 99;
  return std + 5 * Math.log10(range / 1000) - 2.5 * Math.log10(f * Math.PI);
}

export function sunElevation(obs, sun, g) {
  const c = Math.cos(g), s = Math.sin(g);
  const xe = c * sun[0] + s * sun[1], ye = -s * sun[0] + c * sun[1], ze = sun[2];
  return Math.asin(xe * obs.U[0] + ye * obs.U[1] + ze * obs.U[2]) / DEG;
}

/** Unit vector in local ENU for az/el (deg). */
export function enuDir(az, el) {
  const a = az * DEG, e = el * DEG;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}
