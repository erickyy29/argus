/**
 * Natural orbital-decay estimate (shared by the browser app and the local server).
 *
 * Model: circular-orbit decay  da/dt = -B · ρ(h) · sqrt(μ·a)
 *   B  = Cd·A/m  (m²/kg) — nominal ballistic parameter by object type
 *   ρ  = piecewise-exponential atmosphere, moderate solar activity
 *        (Vallado, "Fundamentals of Astrodynamics and Applications", Table 8-4)
 * Lifetime = time for the orbit to decay from h to 150 km (re-entry follows within days).
 *
 * This is an order-of-magnitude planning estimate, not a re-entry prediction:
 * real lifetimes depend on attitude, area-to-mass ratio and the solar cycle
 * (a factor of 2–5 either way is typical).
 */

const MU = 3.986004418e14;     // m³/s²
const RE_M = 6378137;          // m

// [base altitude km, density kg/m³, scale height km]
const ATMOSPHERE = [
  [0, 1.225, 7.249], [25, 3.899e-2, 6.349], [30, 1.774e-2, 6.682], [40, 3.972e-3, 7.554],
  [50, 1.057e-3, 8.382], [60, 3.206e-4, 7.714], [70, 8.770e-5, 6.549], [80, 1.905e-5, 5.799],
  [90, 3.396e-6, 5.382], [100, 5.297e-7, 5.877], [110, 9.661e-8, 7.263], [120, 2.438e-8, 9.473],
  [130, 8.484e-9, 12.636], [140, 3.845e-9, 16.149], [150, 2.070e-9, 22.523], [180, 5.464e-10, 29.740],
  [200, 2.789e-10, 37.105], [250, 7.248e-11, 45.546], [300, 2.418e-11, 53.628], [350, 9.518e-12, 53.298],
  [400, 3.725e-12, 58.515], [450, 1.585e-12, 60.828], [500, 6.967e-13, 63.822], [600, 1.454e-13, 71.835],
  [700, 3.614e-14, 88.667], [800, 1.170e-14, 124.64], [900, 5.245e-15, 181.05], [1000, 3.019e-15, 268.00],
];

/** Nominal Cd·A/m (m²/kg) by SATCAT object type. */
export const BALLISTIC = { PAY: 0.01, 'R/B': 0.005, DEB: 0.05, UNK: 0.02 };

export function density(hKm) {
  let row = ATMOSPHERE[0];
  for (const r of ATMOSPHERE) { if (hKm >= r[0]) row = r; else break; }
  return row[1] * Math.exp(-(hKm - row[0]) / row[2]);
}

// Cumulative decay time (years) from altitude h (1 km grid) down to 150 km, for B_REF.
const B_REF = 0.01;
const H_MIN = 150, H_MAX = 3000;
const TABLE = (() => {
  const t = new Float64Array(H_MAX - H_MIN + 1);
  let acc = 0;
  for (let h = H_MIN + 1; h <= H_MAX; h++) {
    const hm = h - 0.5;                                   // midpoint of the 1 km step
    const a = RE_M + hm * 1000;
    const rate = B_REF * density(hm) * Math.sqrt(MU * a);  // m/s of semi-major-axis loss
    acc += 1000 / rate;                                    // seconds to lose 1 km
    t[h - H_MIN] = acc / (365.25 * 86400);
  }
  return t;
})();

/** Effective altitude used for slightly eccentric orbits (drag concentrates near perigee). */
export function effectiveAltitude(perigeeKm, apogeeKm = perigeeKm) {
  const span = Math.max(0, apogeeKm - perigeeKm);
  return span < 100 ? (perigeeKm + apogeeKm) / 2 : perigeeKm + Math.min(0.25 * span, 150);
}

/**
 * Estimated natural lifetime in years.
 * @param {number} perigeeKm @param {number} apogeeKm
 * @param {number} B Cd·A/m in m²/kg (default: payload)
 * @param {number} solar density multiplier (0.5 quiet … 2.5 very active Sun)
 */
export function lifetimeYears(perigeeKm, apogeeKm = perigeeKm, B = BALLISTIC.PAY, solar = 1) {
  const h = effectiveAltitude(perigeeKm, apogeeKm);
  if (!Number.isFinite(h)) return NaN;
  if (h <= H_MIN) return 0;
  const hi = Math.min(h, H_MAX);
  const i = Math.floor(hi) - H_MIN, f = hi - Math.floor(hi);
  const base = i + 1 < TABLE.length ? TABLE[i] * (1 - f) + TABLE[i + 1] * f : TABLE[TABLE.length - 1];
  return base * (B_REF / B) / solar;
}

/** Altitude (km) at which a circular orbit has the given natural lifetime. */
export function lifetimeAltitude(years, B = BALLISTIC.PAY, solar = 1) {
  const target = years * B / B_REF * solar;
  for (let i = 1; i < TABLE.length; i++) if (TABLE[i] >= target) return H_MIN + i;
  return H_MAX;
}

export function formatLifetime(years) {
  if (!Number.isFinite(years)) return '—';
  if (years < 1 / 52) return `${Math.max(1, Math.round(years * 365))} days`;
  if (years < 1) return `${Math.round(years * 52)} weeks`;
  if (years < 10) return `${years.toFixed(1)} years`;
  if (years < 1000) return `${Math.round(years)} years`;
  return years > 9999 ? '> 10,000 years' : `${Math.round(years / 100) * 100} years`;
}
