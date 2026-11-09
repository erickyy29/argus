# ARGUS · Orbital Awareness Console

A real-time, interactive 3D Earth for **identifying collision risks in orbit**, **tracking how the orbital environment is changing as mega-constellations grow**, and **measuring what that does to the night sky**. It also includes near-Earth asteroids, space weather, NASA Earth-event data, and a pointing link for an **ESP32-S3 robotic mount** that looks wherever you look.

Everything shown is live public data: CelesTrak, NASA, JPL and NOAA. Orbits are propagated in your browser with SGP4.

> Independent project built on public data services. Not affiliated with or endorsed by NASA, JPL, NOAA or CelesTrak.

---

## Quick start

Requirements: **Node.js 20+** and a desktop browser with WebGL (Chrome or Edge recommended; USB mount control needs Web Serial).

```bash
cd argus
node server.mjs
```

Open **http://localhost:8080**. The first start downloads the catalogues: about 7 MB of orbital elements, the 6.6 MB SATCAT and the 23 MB SOCRATES report. These are cached in `.cache/`, so later starts are instant.

### NASA API key

`.env` controls the key for `api.nasa.gov` (only the NeoWs asteroid feed needs it):

```
NASA_API_KEY=DEMO_KEY
```

The key supplied for this project was rejected by api.nasa.gov (`API_KEY_INVALID`), so the app runs on NASA's public `DEMO_KEY`. That allows only a handful of requests per hour, which is enough because the server fetches the feed once every 6 hours. To use your own key, request one at https://api.nasa.gov, paste it into `.env`, and restart. If a key is ever rejected, the server falls back to `DEMO_KEY` automatically. JPL, CelesTrak, EONET, GIBS, EPIC and NOAA need no key.

### Deploy to Vercel

The repo deploys as-is: `vercel.json` serves `public/` from Vercel's CDN and routes `/api/*` and `/vendor/*` to one Vercel Function (`api/index.mjs`), which reuses the same handler as `server.mjs`.

1. In Vercel, **Add New → Project** and import this repository. The framework preset (Other), output directory (`public`) and function settings come from `vercel.json`, so leave the build settings empty.
2. Under **Settings → Environment Variables**, add `NASA_API_KEY` with your own key. `DEMO_KEY` limits are counted per IP address, and Vercel's IPs are shared, so the asteroid feed will often be rate-limited without one.
3. Deploy. The first request after a cold start can take 20–40 s while the catalogues are downloaded. After that, Vercel's CDN serves cached responses (for example, 30 min for orbital elements and conjunctions), so upstream services aren't re-downloaded per visitor.

Notes for the deployed site:
- It is served over HTTPS, so browsers block the mount's **Wi-Fi** link (`ws://`, mixed content). Use **USB (Web Serial)** there, or run the local server for Wi-Fi control.
- Functions run for up to 300 s (`maxDuration` in `vercel.json`), which is the Hobby limit with Fluid compute. If your plan has a lower limit, lower it there.

---

## What it does

### 0 · Location: what is above a place
- Type a place, an address or `lat, lon` into **Go to a place…** (top bar or the **Location** tab), for example *Scarborough Town Centre*. The globe flies there, and the place becomes the observer and mount location.
- **Overhead right now:** how many objects are above the horizon, how many are sunlit, how many are in high-risk encounters, and which are highest.
- **Close approaches in this sky:** upcoming SOCRATES encounters (worst-case Max Pc ≥ 10⁻⁴ or miss < 1 km, between different operators or an active satellite and a dead object) whose time-of-closest-approach position is at least 10° above the place's horizon. They are recomputed with SGP4 from the latest elements, marked ✕ on the globe, flagged *observable* when sunlit against a dark sky, and replayable in 3D.
- A ring shows the area from which objects at 550 km appear more than 10° up. Natural events within 1,000 km are listed too.
- Place search uses OpenStreetMap Nominatim (© OpenStreetMap contributors). Following its usage policy, the app searches only when you press Enter, and the server identifies itself, sends at most 1 request per second and caches results for 30 days. That limit and cache are per server process: on Vercel each function instance has its own, and the CDN shares identical searches for 7 days. If OpenStreetMap answers 429 or 403, lookups pause (for its Retry-After, or 2 / 30 min) and coordinates still work. The public Nominatim service is meant for light use; for heavy public traffic, set `NOMINATIM_URL` to your own Nominatim instance or a hosted Nominatim-compatible geocoder, and put any API key or other parameters it needs in `NOMINATIM_PARAMS` (for example `key=…`; keys are masked in logs and the cache). Search text goes to OpenStreetMap, so don't type anything you'd rather keep private.

### 1 · Collision risk (opens first)
- **7-day conjunction report for the whole public catalogue** from CelesTrak SOCRATES: every predicted approach closer than 5 km, ranked by covariance-free *Max Pc* or miss distance.
- **Who can act on it**: each encounter is classed as *same operator* (handled internally), *cross-operator* (two operators must coordinate), or *active ↔ derelict* (only one side can manoeuvre). Includes a breakdown by altitude shell and the most exposed objects.
- **Blind spot made explicit**: SOCRATES only screens active payloads, so collisions between two derelicts are never forecast there.
- **Encounter replay in 3D**: click any conjunction to load both objects, recompute the time of closest approach (TCA) with the latest elements, and watch the approach. The replay reports element age and explains when newer data has moved the encounter.
- **Screen any object yourself**: in-browser SGP4 screening against the ~20,000 loaded objects. It runs an apogee/perigee filter, then 60 s sampling with linear-motion TCA prediction, then golden-section refinement, and reports radial/in-track/cross-track (RIC) miss components and Max Pc.

### 2 · Orbital environment & sustainability
- Population from the full SATCAT: objects in orbit since 1957 by type, payloads launched per year (Starlink vs other constellations), re-entries per year.
- **LEO congestion by altitude shell**, with the altitudes where natural decay takes 5 and 25 years.
- **Disposal outlook**: how many active LEO satellites would *not* re-enter on their own within 5 or 25 years.
- Conjunction burden (share of encounters involving Starlink, debris or rocket bodies), constellation sizes, recent re-entries, the largest fragmentation events, and a sourced list of levers for managing the environment.

### 3 · Night-sky impact
- Sunlit satellites above your horizon right now, how many are naked-eye bright, and how many exceed the recommended brightness limit.
- A **through-the-night forecast** (SGP4 every 10 minutes) showing the dusk and dawn peaks.
- Bright visible passes in the next 24 h.
- **Streak prediction for the mount's camera**: which satellites will cross its field of view during an exposure.

### 4 · Asteroids
- NASA NeoWs close approaches this week, with orbits from the JPL Small-Body Database.
- The next 60 days from JPL CNEOS, and precise geocentric ephemerides from JPL Horizons for the selected object.
- Size estimates, H–G brightness, MOID, orbit-quality metrics, and a distance curve.

### 5 · Space weather & Earth
- NOAA SWPC R/S/G scales, Kp, solar wind, IMF Bz, GOES X-ray flux and alerts, with a note on why storms degrade conjunction forecasts.
- NASA EONET natural events plotted on the globe, and the latest DSCOVR/EPIC full-disk image.

### 6 · Tracking mount (ESP32-S3)
- Simulator, USB (Web Serial) or Wi-Fi (WebSocket) link.
- Modes: **track the selected object**, **follow your Sky-view gaze**, manual, or park.
- Elevation limits, Sun exclusion, azimuth calibration offset and rate feed-forward. Firmware and wiring are in [`firmware/argus_mount/`](firmware/argus_mount/README.md).

---

## Data sources

| Source | Used for | Refresh (server cache) | Key |
|---|---|---|---|
| CelesTrak GP (OMM JSON), 12 groups | orbital elements for ~20 k objects | 2.5 h (CelesTrak updates ~every 2 h) | – |
| CelesTrak SATCAT (`satcat.csv`) | object type, owner, RCS, launch/decay → environment statistics | 12 h | – |
| CelesTrak SOCRATES (`sort-minRange.csv`) | 7-day conjunction report, full catalogue | 6 h | – |
| TLE API (listed on api.nasa.gov) | catalogue search, fallback elements | 1–2 h | – |
| NASA NeoWs | asteroid close approaches this week | 6 h | DEMO_KEY / yours |
| JPL SBDB · CNEOS CAD · Sentry · Horizons | small-body orbits, upcoming approaches, precise ephemerides | 1–24 h | – |
| NASA EONET v3 | open natural events | 15 min | – |
| NASA GIBS (WMS) | Blue Marble, Black Marble, daily VIIRS NOAA-20 true colour | 3 h – 30 d | – |
| NASA Image and Video Library | imagery for the selected object | 24 h | – |
| NASA EPIC (DSCOVR) | latest full-disk Earth image | 1 h | – |
| NOAA SWPC | Kp, scales, real-time solar wind, GOES X-rays, alerts | 1–10 min | – |
| wheretheiss.at | independent live ISS position (SGP4 cross-check) | 4 s | – |
| OpenStreetMap Nominatim | place search (geocoding), on demand | 30 d (CDN 7 d) | – |
| HYG via d3-celestial · NASA SVS CGI Moon Kit | star field, Moon texture | static | – |

The server only proxies this allow-list. It never refetches a source faster than its cache time, and it serves the last good copy (marked *stale*) if a source is down. The **Feeds** button in the top bar shows every feed's status and age.

---

## Accuracy & limitations

- **Orbits** are public GP/TLE element sets propagated with SGP4. Typical LEO accuracy is about a kilometre at epoch, growing by kilometres per day. Low or manoeuvring satellites (e.g. Starlink during orbit changes) can shift by tens to hundreds of km over several days, so predictions far out should be treated as screening, not truth.
- **Max Pc** is a covariance-free worst case: the highest probability consistent with the miss distance and combined hard-body radius. The in-app value assumes an isotropic uncertainty, while SOCRATES' `MAX_PROB` uses a 100:300:100 m radial/in-track/cross-track ellipsoid and can be up to ~3× larger. Colours follow NASA CARA's red threshold (10⁻⁴) and ESA's 10⁻⁵ monitoring level. Those thresholds are defined for covariance-based Pc, so applying them to a worst case over-flags. This is **not an operational conjunction-assessment system**: operators decide using CDMs with covariance from the US Space Force via Space-Track, and NASA notes that public TLEs alone should not drive mitigation decisions.
- **SOCRATES coverage**: active payloads screened against the full public catalogue, 5 km threshold, 7-day window. Encounters between two derelicts are not screened. Per CelesTrak's documentation, intra-fleet pairs among fully operational satellites are skipped, but the current report still lists many Starlink↔Starlink approaches, so that share is shown as reported. Uncatalogued debris (more than 300,000 objects above 1 cm, per NASA) cannot be screened at all.
- **Local screening** covers only the loaded catalogue: active payloads, four fragmentation-debris clouds and the brightest inactive objects. SOCRATES covers the full public catalogue but only for active payloads.
- **Brightness** is a model: a standard magnitude scaled by range with a diffuse-sphere phase law, ±1 mag. Constellation values use measured magnitudes from satmags (Mallama & Cole), and the IAU CPS limit (V 7 at ≤ 550 km, altitude-scaled) is applied to operational satellites only. Attitude, glints and coatings aren't modelled.
- **Natural-decay times** use a circular-orbit exponential-atmosphere model with nominal area-to-mass ratios. Treat them as order-of-magnitude only.
- **Asteroid positions** use two-body propagation of JPL SBDB osculating elements, replaced by JPL Horizons vectors for the selected object. Distances beyond the Moon are drawn log-compressed by default; directions stay true.

---

## Verification

- **Domain facts**: every policy, threshold and night-sky statement in the app (`public/js/lib/briefs.js`) was checked by a sourced, adversarial fact-check on 8 Nov 2026: 55 claims verified, refuted drafts dropped. Re-check policy items such as FCC Part 100, TraCSS and the EU Space Act before publishing; they change quickly.
- **Code**: a four-lens review (astrodynamics, server, front end, claims) produced 40 verified findings, all fixed.
- **Numerical cross-checks**: look angles match satellite.js and astronomy-engine. ISS positions match wheretheiss.at to within a few km. Two-body asteroid positions match JPL Horizons to 0.01–0.4°.

## Architecture

```
server.mjs                    zero-dependency Node server: static files, allow-listed cached proxy,
                              SATCAT environment statistics, SOCRATES indexing & classification
public/
  index.html, css/app.css     layout and design system
  js/main.js                  app controller: clock, catalogue, workers, selection, render loop
  js/scene/scene.js           Three.js scene: Earth shader (GIBS day/night/live), atmosphere, stars,
                              Sun, Moon, GPU point cloud with velocity extrapolation, orbits, picking, sky view
  js/workers/propagator.js    SGP4 for the whole catalogue at ~2 Hz, look angles, illumination, brightness,
                              pass prediction, camera-FOV streak forecast
  js/workers/analysis.js      conjunction screening, through-the-night counts, bright passes
  js/data/neo.js              NeoWs + SBDB + CNEOS + Horizons
  js/robot/mount.js           mount controller (simulator / Web Serial / WebSocket)
  js/ui/                      panels, inspector, HUD, charts
  js/lib/                     astro math, lifetime model, config, sourced reference text
firmware/argus_mount/         ESP32-S3 Arduino firmware + wiring/protocol guide
```

Frames: SGP4 TEME (≈ true equator of date) in km is mapped to the scene as `(x, z, −y) / 6378.137`. The Earth mesh is rotated by GMST, the Sun and Moon come from astronomy-engine rotated J2000 → of-date, and the observer's look angles use WGS-84.

## Controls

| Key | Action |
|---|---|
| drag / scroll | orbit & zoom (Sky view: look around & change field of view) |
| click / double-click | select / select and follow |
| `space` · `+` · `-` · `L` | pause · faster · slower/reverse · back to live |
| `V` · `O` · `R` · `F` | sky view · orbital view · reset camera · focus selection |
| `/` · `Esc` | search · clear selection / leave encounter replay |

## Troubleshooting

- **Port 8080 busy**: `PORT=8090 node server.mjs`.
- **A feed shows an error**: the server retries with back-off and keeps serving the last good copy. CelesTrak asks clients not to re-download unchanged data more than once per update cycle, and the cache respects that.
- **USB mount not listed**: use Chrome or Edge and a data-capable USB cable. On ESP32-S3 enable *USB CDC On Boot*.
- **Blank globe**: the browser must support WebGL 2 (check `chrome://gpu`).
