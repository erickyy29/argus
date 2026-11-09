/** Object categories. `std` = standard visual magnitude (1000 km range, 50 % illuminated) used for brightness estimates. */
export const CATEGORIES = [
  { id: 'stations', label: 'Space stations & crew vehicles', short: 'Stations', color: '#ffffff', size: 6.5, std: 1.5 },
  { id: 'starlink', label: 'Starlink', short: 'Starlink', color: '#8b9cff', size: 1.9, std: 7.2 },
  { id: 'megaconst', label: 'Other mega-constellations', sub: 'OneWeb · Amazon Leo (Kuiper) · Qianfan · Guowang', short: 'Mega-const.', color: '#c084fc', size: 2.1, std: 6.5 },
  { id: 'gnss', label: 'Navigation (GNSS)', sub: 'GPS · GLONASS · Galileo · BeiDou', short: 'GNSS', color: '#3ddc97', size: 3, std: 5.5 },
  { id: 'earthobs', label: 'Weather & Earth observation', short: 'Earth obs.', color: '#38bdf8', size: 3, std: 5.0 },
  { id: 'science', label: 'Science missions', short: 'Science', color: '#facc15', size: 3.4, std: 4.5 },
  { id: 'geo', label: 'Geostationary', short: 'GEO', color: '#fb923c', size: 2.6, std: 5.0 },
  { id: 'active', label: 'Other active satellites', short: 'Active', color: '#7dd3fc', size: 2.2, std: 5.5 },
  { id: 'inactive', label: 'Inactive & rocket bodies', sub: 'brightest tracked objects', short: 'Inactive', color: '#a8b3c7', size: 2.8, std: 4.5 },
  { id: 'debris', label: 'Fragmentation debris', sub: 'FY-1C · Cosmos 2251 · Iridium 33 · Cosmos 1408', short: 'Debris', color: '#ff6b6b', size: 1.8, std: 9.0 },
  { id: 'custom', label: 'Added objects', sub: 'from search & conjunction reports', short: 'Added', color: '#f472b6', size: 4.2, std: 6.0 },
];
export const CAT_INDEX = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));

/** Per-object brightness overrides (standard magnitudes). */
export const STD_MAG = { 25544: -1.8, 48274: 0.5, 20580: 2.5 };
/**
 * Constellation brightness (mean measured magnitude range-adjusted to 1,000 km, satmags.netlify.app, Mallama & Cole;
 * not phase-normalised — an approximation of a standard magnitude). First match wins.
 */
export const STD_BY_NAME = [
  [/^STARLINK.*\[DTC\]/, 6.74], [/^STARLINK/, 7.3], [/^ONEWEB/, 7.41], [/^(KUIPER|AMAZON)/, 6.86],
  [/^QIANFAN/, 5.42], [/^(GUOWANG|HULIANWANG|SATNET)/, 4.04], [/^BLUEBIRD/, 4.27],
];

export const NEO_COLOR = '#ffb347';
export const PHA_COLOR = '#ff5d5d';
export const MOON_COLOR = '#d7dce6';

export const EONET_COLORS = {
  wildfires: '#ff7a45', severeStorms: '#a78bfa', volcanoes: '#ff4d4f', seaLakeIce: '#67e8f9', floods: '#60a5fa',
  dustHaze: '#d6b98c', earthquakes: '#f5b942', landslides: '#c08457', snow: '#e5e7eb', drought: '#eab308',
  tempExtremes: '#fb923c', waterColor: '#2dd4bf', manmade: '#94a3b8',
};

/** Notable objects that get a permanent label. */
export const NOTABLE = { 25544: 'ISS', 48274: 'Tiangong', 20580: 'Hubble' };

/** Fallback objects fetched from the TLE API if CelesTrak is unreachable. */
export const FALLBACK_IDS = [25544, 48274, 20580, 43013, 49260, 25994, 27424, 51850, 33591, 37849, 54234, 44713];

export const DEFAULT_OBSERVER = { lat: 28.5729, lon: -80.649, alt: 0.003, name: 'Kennedy Space Center (default)' };

// Colour thresholds applied to the covariance-free worst-case Max Pc (an upper bound, so they over-flag):
export const PC_RED = 1e-4;     // NASA CARA red: detailed monitoring and mitigation planning
export const PC_AMBER = 1e-5;   // ESA internal monitoring level (CARA monitors more closely from 1e-7)

export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
