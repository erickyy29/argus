/* Left panel: Catalog, Collision risk, Orbital environment, Night sky, Asteroids, Space weather & events, Mount, Search. */
import { $, $$, esc, fmt, api, store, toast, feeds } from '../lib/util.js';
import { CATEGORIES, CAT_INDEX, EONET_COLORS, PC_RED, PC_AMBER } from '../lib/config.js';
import { BRIEF } from '../lib/briefs.js';
import { twilight, moonInfo, bodyHorizon, enuDir, DEG } from '../lib/astro.js';
import { formatLifetime, lifetimeYears } from '../lib/lifetime.js';
import { drawChart } from './charts.js';
import { attachPlaceSearch } from './placesearch.js';
import * as Astro from 'astronomy-engine';

const TITLES = { place: 'Location overview', catalog: 'Catalog & layers', risk: 'Collision risk', environment: 'Orbital environment', sky: 'Night-sky impact', neo: 'Near-Earth asteroids', earth: 'Space weather & Earth events', mount: 'Tracking mount', search: 'Search' };
const CLASS = [
  { key: 'same', label: 'Same operator', color: '#5b6b86', hint: 'Identified fleets only; the operator sees its own fleet more accurately than public data' },
  { key: 'cross', label: 'Cross-operator', color: '#4ea8ff', hint: 'Two operators must share data and coordinate' },
  { key: 'onesided', label: 'Active ↔ derelict', color: '#f5b942', hint: 'Only one side can manoeuvre' },
  { key: 'derelict', label: 'Derelict ↔ derelict', color: '#ff6b6b', hint: 'No one can manoeuvre' },
];
const FILTERS = [['external', 'External'], ['crossop', 'Cross-operator'], ['onesided', 'Active ↔ derelict'], ['crewed', 'Crewed stations'], ['debris', 'Debris & rocket bodies'], ['all', 'All']];
const OWNERS = { US: 'United States', PRC: 'China', UK: 'United Kingdom', CIS: 'Russia / CIS', JPN: 'Japan', IND: 'India', ESA: 'ESA', FR: 'France', GER: 'Germany', TBD: 'To be determined',
  ISS: 'ISS partnership', SES: 'SES', O3B: 'O3b (SES)', GLOB: 'Globalstar', IRID: 'Iridium', ORB: 'Orbcomm', SKOR: 'South Korea', CA: 'Canada', ITSO: 'Intelsat', EUTE: 'Eutelsat', AB: 'Arab Sat', ARGN: 'Argentina', BRAZ: 'Brazil', ISRA: 'Israel', IT: 'Italy', SPN: 'Spain', TURK: 'Türkiye', UAE: 'UAE', AUS: 'Australia' };
const src = (url, label = 'source') => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : '');
const pcCls = (p) => (p >= PC_RED ? 'p4' : p >= PC_AMBER ? 'p5' : 'p6');
const kpi = (v, l, s = '', cls = '') => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const share = (a, b) => (b ? fmt.pct(a / b, 1) : '—');

export class Drawer {
  constructor(app) {
    this.app = app;
    this.el = $('#drawer');
    this.body = $('#drawerBody');
    this.tab = null;
    this.risk = { filter: 'external', sort: 'prob', target: null, hours: 24, threshold: 10, running: false, results: null };
    this.neoSort = 'miss';
    this.searchQ = '';
    $$('.rail button').forEach((b) => b.addEventListener('click', () => (this.tab === b.dataset.tab && !this.el.classList.contains('closed') ? this.close() : this.open(b.dataset.tab))));
    $('#drawerClose').addEventListener('click', () => this.close());
    const re = (tabs) => () => { if (tabs.includes(this.tab)) this.render(); };
    app.bus.on('catalog', (d) => {
      this.riskSet = null;
      if (d?.reload) { this.night = null; this.bright = null; }
      if (['catalog', 'search', 'risk', 'sky'].includes(this.tab)) this.render();
    });
    app.bus.on('layers', re(['catalog']));
    app.bus.on('options', re(['catalog', 'neo']));
    app.bus.on('socrates', re(['risk', 'environment']));
    app.bus.on('risky', () => { this.riskSet = null; if (this.tab === 'risk') this.render(); });
    app.bus.on('place', () => { if (this.tab === 'place') this.renderPlaceConj(); });
    app.bus.on('environment', re(['environment']));
    app.bus.on('neo:list', re(['neo']));
    app.bus.on('neo:cad', re(['neo']));
    app.bus.on('neo:elements', () => { if (this.tab === 'neo') { clearTimeout(this.neoT); this.neoT = setTimeout(() => this.render(), 600); } });
    app.bus.on('events', () => { if (this.tab === 'earth') this.render(); else if (this.tab === 'place') { const h = $('#plEvents'); if (h) h.innerHTML = this.placeEventsHtml(); } });
    app.bus.on('spaceweather', re(['earth']));
    app.bus.on('observer', () => { this.night = null; this.bright = null; if (['sky', 'mount', 'place'].includes(this.tab)) this.render(); });
    app.bus.on('mount:change', re(['mount']));
    app.bus.on('view', re(['mount']));
    app.bus.on('mount:log', () => { const l = $('#mountLog'); if (l) { l.textContent = this.app.mount.log.join('\n'); l.scrollTop = l.scrollHeight; } });
    app.bus.on('selection', () => { if (this.tab === 'risk') this.renderScreenTarget(); });
    window.addEventListener('resize', () => { clearTimeout(this.rsT); this.rsT = setTimeout(() => this.tab && this.render(), 300); });
  }

  open(tab) {
    this.tab = tab;
    store.set('tab', tab);
    this.el.classList.remove('closed');
    document.body.classList.add('drawer-open');
    $$('.rail button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#drawerTitle').textContent = TITLES[tab] || '';
    this.render();
    this.body.scrollTop = 0;
  }
  close() {
    this.el.classList.add('closed');
    document.body.classList.remove('drawer-open');
    $$('.rail button').forEach((b) => b.classList.remove('active'));
    this.tab = null;
  }
  render() {
    if (!this.tab) return;
    const fn = { place: this.renderPlace, catalog: this.renderCatalog, risk: this.renderRisk, environment: this.renderEnvironment, sky: this.renderSky, neo: this.renderNeo, earth: this.renderEarth, mount: this.renderMount, search: this.renderSearch }[this.tab];
    try { fn.call(this); } catch (e) { console.error(e); this.body.innerHTML = `<div class="err">Panel error: ${esc(e.message)}</div>`; }
  }
  /** 4 Hz live refresh for the open tab. */
  tick() {
    if (this.tab === 'place') {
      this.updatePlaceLive();
      if (Date.now() - (this.plConjAt || 0) > 30e3) { this.app.ensurePlaceConjunctions(); this.renderPlaceConj(); }
    }
    if (this.tab === 'sky') this.updateSkyNow();
    if (this.tab === 'mount') this.updateMountLive();
  }

  /* ═════════════════════ Location ═════════════════════ */
  currentPlace() {
    const app = this.app, o = app.observer, p = app.place;
    if (p && Math.abs(p.lat - o.lat) < 1e-6 && Math.abs(p.lon - o.lon) < 1e-6) return p;
    return { name: o.name || 'Observer', label: '', lat: o.lat, lon: o.lon };
  }

  renderPlace() {
    const app = this.app, o = app.observer, P = this.currentPlace(), t = app.clock.now();
    const sun = bodyHorizon(Astro.Body.Sun, t, o), nw = app.nightWindow();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    this.body.innerHTML = `
      <p class="lead">Search any place to see what is above it right now, and which close approaches between satellites and debris will happen in its sky.</p>
      <form class="place-search inpanel" id="pf" role="search" autocomplete="off">
        <svg viewBox="0 0 20 20"><circle cx="8.8" cy="8.8" r="5.6"/><path d="m13 13 4.6 4.6"/></svg>
        <input id="pfi" type="search" placeholder="Place, address or lat, lon — press Enter" spellcheck="false">
        <div class="place-results hidden" id="pfr"></div>
      </form>
      <div class="section">
        <div class="section-title">${esc(P.name)} <span class="src">${fmt.lat(P.lat)} ${fmt.lon(P.lon)}</span></div>
        ${P.label && P.label !== P.name ? `<p class="note" style="margin:-4px 0 8px">${esc(P.label)}</p>` : ''}
        ${P.label && P.label !== 'Coordinates' ? '<p class="note" style="margin:0 0 8px">Place data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a></p>' : ''}
        <div class="kv">
          <div class="k">Sky now</div><div class="v">${twilight(sun.el)} · Sun ${fmt.deg(sun.el, 1)}</div>
          <div class="k">Next dark window</div><div class="v">${nw ? `${fmt.localFull(nw.start)} → ${fmt.local(nw.end)}` : '—'}<br><small>times in ${esc(tz)}</small></div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          <button class="btn small" id="plFly">Fly there</button><button class="btn small" id="plLook">Look up from here</button>
          <button class="btn small" data-goto="sky">Night-sky impact</button><button class="btn small" data-goto="mount">Point the mount</button>
        </div>
      </div>
      <div class="section"><div class="section-title">Overhead right now <span class="src">live SGP4</span></div>
        <div class="kpis" id="plNow"></div><div class="list" id="plOver" style="margin-top:8px"></div></div>
      <div class="section"><div class="section-title">Close approaches in this sky <span class="src" id="plConjSrc">next 48 h · above 10°</span></div>
        <div id="plConj"></div></div>
      <div class="section"><div class="section-title">Natural events within 1,000 km <span class="src">NASA EONET</span></div>
        <div class="list" id="plEvents">${this.placeEventsHtml()}</div></div>
      <details class="method"><summary>How this is worked out</summary><div class="body">
        <p>Close approaches come from the CelesTrak SOCRATES report: upcoming encounters with a worst-case Max Pc of at least 1e-4, or a predicted miss under 1 km, between different operators or between an active satellite and a dead object. For each one, the latest orbital elements are propagated with SGP4 to the time of closest approach to find where in the sky it happens. Encounters at least 10° above this place's horizon are listed and marked ✕ on the globe; click a marker or a row to replay it in 3D.</p>
        <p>The blue ring is drawn at 550 km altitude and marks where an object at that height appears more than 10° above this place's horizon; each ✕ hangs at the encounter's real altitude, with a faint line down to the ground point below it. “Observable” means the encounter point is sunlit while the sky here is dark (Sun below −6°), so a camera could catch both objects.</p>
        <p>Place search: © OpenStreetMap contributors, via Nominatim. Choosing a place also moves the observer and mount location to it.</p>
      </div></details>`;
    attachPlaceSearch({ form: $('#pf'), input: $('#pfi'), results: $('#pfr'), app });
    this.plKey = null;
    this.renderPlaceConj();
    this.updatePlaceLive();
    app.ensurePlaceConjunctions();
    this.body.onclick = (e) => {
      if (e.target.id === 'plFly') return app.scene.flyToSurface(0.95);
      if (e.target.id === 'plLook') { app.scene.setMode('sky'); return; }
      if (e.target.id === 'plRetry') { app.computePlaceConjunctions(); return; }
      if (e.target.id === 'plMarkers') { app.scene.setPlaceOverlayVisible(!(app.scene.placeOverlayVisible ?? true)); this.renderPlaceConj(); return; }
      const go = e.target.closest('[data-goto]'); if (go) return this.open(go.dataset.goto);
      const cj = e.target.closest('[data-cj]');
      if (cj) { const c = app.placeConj?.list?.[Number(cj.dataset.cj)]; if (c) app.viewEncounter({ id1: c.id1, id2: c.id2, tca: c.t, socrates: { rangeKm: c.range, maxProb: c.prob, speedKms: c.speed, dse1: c.dse1, dse2: c.dse2 } }); return; }
      const ov = e.target.closest('[data-sel-i]'); if (ov) { app.select({ kind: 'sat', obj: app.catalog.objects[Number(ov.dataset.selI)] }); return; }
      const ev = e.target.closest('[data-ev-id]');
      if (ev) { const obj = (app.events || []).find((x) => x.id === ev.dataset.evId); if (obj) app.select({ kind: 'event', obj }); return; }
      if (e.target.id === 'plAll') { this.plConjAll = !this.plConjAll; this.renderPlaceConj(); }
    };
  }

  placeEventsHtml() {
    const o = this.app.observer;
    const near = (this.app.events || []).map((e) => ({ e, d: gcKm(o.lat, o.lon, e.lat, e.lon) })).filter((x) => x.d < 1000).sort((a, b) => a.d - b.d);
    return near.length ? near.slice(0, 8).map(({ e, d }) => `<div class="row cols" data-ev-id="${esc(e.id)}"><div style="min-width:0"><div class="t"><span class="sw" style="background:${EONET_COLORS[e.cat] || '#ccc'};border-radius:2px"></span>${esc(e.title)}</div><div class="m">${esc(e.catTitle)} · ${fmt.age(e.date)}</div></div><div class="r">${fmt.int(d)} km</div></div>`).join('')
      : '<div class="empty">No open natural events within 1,000 km.</div>';
  }

  renderPlaceConj() {
    const host = $('#plConj'); if (!host) return;
    this.plConjAt = Date.now();   // tick() refreshes (and retries after an error) at most every 30 s
    const app = this.app, pc = app.placeConj, now = app.clock.now();
    if (!pc) { host.innerHTML = '<div class="empty">Finding the close approaches that happen above this place…</div>'; return; }
    if (pc.error) { host.innerHTML = `<div class="callout danger">Couldn't load conjunction data: ${esc(pc.error)} <button class="btn small" id="plRetry">Retry</button></div>`; return; }
    const live = pc.list.map((c, i) => [c, i]).filter(([c]) => c.t >= Date.now() - 60e3);
    const L = live.map(([c]) => c), risky = L.filter((c) => c.prob >= PC_RED).length, obs = L.filter((c) => c.observable).length;
    const rows = this.plConjAll ? live : live.slice(0, 40);
    const shown = app.scene.placeOverlayVisible ?? true;
    const src = $('#plConjSrc'); if (src) src.textContent = `next ${pc.hours} h · above 10° · SOCRATES ${fmt.age(pc.publishedAt)}`;
    host.innerHTML = `
      <div class="kpis three">${kpi(fmt.int(L.length), 'In this sky', `of ${fmt.int(pc.scanned)} upcoming encounters`)}${kpi(fmt.int(risky), 'Max Pc ≥ 10⁻⁴', 'worst case', risky ? 'alert' : '')}${kpi(fmt.int(obs), 'Observable', 'sunlit, dark sky here', obs ? 'good' : '')}</div>
      <p class="note">${pc.notLoaded ? `${fmt.int(pc.notLoaded)} encounters between two objects outside the loaded catalogue could not be placed. ` : ''}${pc.truncated ? `Only the first ${fmt.int(pc.scanned)} of ${fmt.int(pc.matching)} encounters were checked. ` : ''}✕ markers on the globe show where each one happens. <button class="btn small" id="plMarkers">${shown ? 'Hide' : 'Show'} markers</button></p>
      <div class="list" style="margin-top:8px">${L.length ? rows.map(([c, i]) => `<div class="row conj" data-cj="${i}" title="Replay this encounter in 3D">
          <div class="pc ${c.prob >= PC_RED ? 'p4' : c.prob >= PC_AMBER ? 'p5' : 'p6'}">${fmt.pc(c.prob)}</div>
          <div style="min-width:0"><div class="t pair"><span class="n">${esc(c.n1)}</span><span class="x">↔</span><span class="n">${esc(c.n2)}</span></div>
            <div class="m">${fmt.localFull(c.t)} · ${fmt.rel(c.t, now)} · ${compass(c.az)} ${fmt.deg(c.el, 0)} · ${fmt.int(c.altKm)} km up${c.observable ? ' · <span class="badge obs">observable</span>' : ''}</div></div>
          <div class="r">${fmt.km(c.range)}<br><span style="color:var(--text-3)">${fmt.speed(c.speed)}</span></div></div>`).join('')
        : '<div class="empty">No high-interest close approaches above 10° in this sky in the next 48 hours.</div>'}</div>
      ${L.length > 40 ? `<p class="note">${this.plConjAll ? `Showing all ${fmt.int(L.length)}.` : `Showing the first 40 of ${fmt.int(L.length)} (soonest first).`} <button class="btn small" id="plAll">${this.plConjAll ? 'Show fewer' : 'Show all'}</button></p>` : ''}`;
  }

  /** Live counts for the Location tab (4 Hz); the list is rebuilt only when its membership changes. */
  updatePlaceLive() {
    const app = this.app, s = app.state, host = $('#plNow');
    if (!host || !s) return;
    if (!this.riskSet) this.riskSet = new Set(app.scene.riskIdx || []);
    let up = 0, up30 = 0, lit = 0, risk = 0;
    const top = [];
    for (let i = 0; i < s.n; i++) {
      const el = s.el[i];
      if (!(el > 0)) continue;
      up++;
      if (el >= 30) up30++;
      if (el >= 10 && s.st[i] === 2) lit++;
      if (this.riskSet.has(i)) risk++;
      if (top.length < 6 || el > top[top.length - 1][1]) { top.push([i, el]); top.sort((a, b) => b[1] - a[1]); if (top.length > 6) top.pop(); }
    }
    host.innerHTML = kpi(fmt.int(up), 'Above the horizon', `${fmt.int(up30)} higher than 30°`) + kpi(fmt.int(lit), 'Sunlit above 10°', s.sunEl < -6 ? 'visible against a dark sky' : 'sky too bright to see them')
      + kpi(fmt.int(risk), 'In a high-risk encounter', 'pulsing red on the globe', risk ? 'alert' : '');
    const key = top.map(([i]) => i).join(',');
    if (key === this.plKey) return;
    this.plKey = key;
    const list = $('#plOver');
    if (list) list.innerHTML = top.map(([i, el]) => { const o = app.catalog.objects[i]; return `<div class="row cols" data-sel-i="${i}"><div style="min-width:0"><div class="t"><span class="sw" style="background:${CATEGORIES[o.cat].color}"></span>${esc(o.name)}</div><div class="m">${CATEGORIES[o.cat].short} · ${compass(s.az[i])} · ${fmt.km(s.rng[i])} away</div></div><div class="r">${fmt.deg(el, 0)}</div></div>`; }).join('');
  }

  /* ═════════════════════ Catalog ═════════════════════ */
  renderCatalog() {
    const app = this.app, c = app.catalog;
    const ages = c.objects.map((o) => o.epoch).filter(Number.isFinite).sort((a, b) => a - b);
    const median = ages.length ? ages[Math.floor(ages.length / 2)] : NaN;
    const opt = (k, label, sub) => `<div class="opt-row"><div>${label}${sub ? `<small>${sub}</small>` : ''}</div><button class="switch ${app.options[k] ? 'on' : ''}" data-opt="${k}" aria-label="${esc(label)}"></button></div>`;
    this.body.innerHTML = `
      <div class="section">
        <div class="section-title">Tracked objects <span class="src">${fmt.int(c.objects.length)} · median element age ${fmt.age(median)}</span></div>
        ${CATEGORIES.map((cat, i) => c.counts[i] ? `<div class="layer-row"><span class="sw" style="background:${cat.color}"></span><div class="name">${cat.label}${cat.sub ? `<small>${cat.sub}</small>` : ''}</div><span class="cnt">${fmt.int(c.counts[i])}</span><button class="switch ${app.layers[cat.id] !== false ? 'on' : ''}" data-layer="${cat.id}" aria-label="Toggle ${esc(cat.label)}"></button></div>` : '').join('')}
        <div style="display:flex;gap:6px;margin-top:8px"><button class="btn small" data-all="1">Show all</button><button class="btn small" data-all="0">Hide all</button><button class="btn small" data-only="debris">Debris only</button><button class="btn small" data-only="starlink">Starlink only</button></div>
      </div>
      <div class="section">
        <div class="section-title">Display</div>
        ${opt('risk', 'Pulse objects in high-risk encounters', 'external encounter in the next 24 h whose worst-case Max Pc reaches 10⁻⁴')}${opt('orbits', 'Orbit of selected object')}${opt('track', 'Ground track of selected object')}${opt('labels', 'Labels')}
        ${opt('neo', 'Near-Earth asteroids')}${opt('events', 'Natural events (NASA EONET)')}
        ${opt('live', 'Daily satellite imagery', `NASA GIBS · VIIRS NOAA-20 · ${app.imageryDate || ''}`)}${opt('lights', 'City lights on the night side', 'NASA Black Marble')}
        ${opt('stars', 'Star field', 'HYG catalogue, positions of date')}${opt('grid', 'Latitude / longitude grid')}
      </div>
      <div class="section">
        <div class="section-title">Sources</div>
        <div class="list">${(c.meta?.sources || []).map((s) => `<div class="row cols"><div class="t">CelesTrak GROUP=${esc(s.group)}</div><div class="r">${s.error ? '<span class="badge danger">error</span>' : `${fmt.int(s.count)} · ${fmt.age(s.fetchedAt)}`}</div></div>`).join('')}</div>
        <p class="note">Orbital elements are CelesTrak GP (OMM) sets propagated with SGP4 in a web worker. Positions refresh twice per second and interpolate smoothly between updates.</p>
      </div>`;
    this.body.onclick = (e) => {
      const l = e.target.closest('[data-layer]'); if (l) return app.setLayer(l.dataset.layer, !l.classList.contains('on'));
      const o = e.target.closest('[data-opt]'); if (o) return app.setOption(o.dataset.opt, !o.classList.contains('on'));
      const a = e.target.closest('[data-all]'); if (a) { CATEGORIES.forEach((cat) => app.setLayer(cat.id, a.dataset.all === '1')); return; }
      const only = e.target.closest('[data-only]'); if (only) CATEGORIES.forEach((cat) => app.setLayer(cat.id, cat.id === only.dataset.only));
    };
  }

  /* ═════════════════════ Collision risk ═════════════════════ */
  renderRisk() {
    const s = this.app.socrates, st = s?.classes?.stats;
    const total = s?.total || 0;
    const head = !s ? (this.app.socratesError ? `<div class="callout danger">SOCRATES report unavailable: ${esc(this.app.socratesError)} <button class="btn small" id="socRetry">Retry</button></div>`
      : `<div class="empty">Loading the CelesTrak SOCRATES report (≈ 23 MB on first run, then cached)…</div>`) : `
      <div class="section">
        <div class="section-title">Next 7 days · payloads vs full catalogue <span class="src">SOCRATES · published ${fmt.age(s.publishedAt)}</span></div>
        <div class="kpis">
          ${kpi(fmt.int(total), 'Close approaches < 5 km', s.windowStart ? `${fmt.utc(Date.parse(s.windowStart), false)} → ${fmt.utc(Date.parse(s.windowEnd), false)}` : '')}
          ${kpi(fmt.int(s.counts.lt1km), 'Closer than 1 km', `${fmt.int(s.counts.lt100m)} closer than 100 m`, 'warn')}
          ${kpi(fmt.int(s.counts.p1e4), `Max Pc ≥ 10⁻⁴`, 'covariance-free worst case', 'alert')}
          ${kpi(share(s.counts.starlinkAny, total), 'Involve a Starlink', `${share(s.counts.starlinkBoth, total)} are Starlink ↔ Starlink`)}
        </div>
      </div>
      <div class="section">
        <div class="section-title">Who can act on it</div>
        <div class="classbar">${CLASS.slice(0, 3).map((c, k) => `<i style="flex:${st[k].total || 0.0001};background:${c.color}" title="${c.label}: ${fmt.int(st[k].total)}"></i>`).join('')}</div>
        <div style="margin-top:8px">${CLASS.slice(0, 3).map((c, k) => `<div class="class-row" data-filter="${['same', 'crossop', 'onesided'][k]}" title="${k ? 'Show these encounters' : ''}"><div><div class="t"><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:${c.color}"></span>${c.label} · ${share(st[k].total, total)}</div><div class="m">${c.hint}</div></div><div class="r">${fmt.int(st[k].total)}<small>${fmt.int(st[k].lt1km)} under 1 km</small><small>${fmt.int(st[k].p1e4)} with Pc ≥ 10⁻⁴</small></div></div>`).join('')}</div>
        ${this.app.risky ? `<div class="callout danger" style="display:flex;justify-content:space-between;gap:10px;align-items:center"><span><b>${fmt.int(this.app.risky.count)} objects</b> are in ${fmt.int(this.app.risky.events)} external encounters in the next 24 h whose worst-case Max Pc reaches 10⁻⁴. ${fmt.int(this.app.risky.shown ?? 0)} of them are loaded and <b>pulse red</b> on the globe. Worst case is an upper bound: the true Pc is usually far lower.</span><button class="switch ${this.app.options.risk ? 'on' : ''}" data-opt="risk" aria-label="Pulse objects in high-risk encounters"></button></div>` : ''}
        <div class="callout warn"><b>Blind spot:</b> SOCRATES screens ${s.run ? `${fmt.int(s.run.primaries)} active payloads against ${fmt.int(s.run.secondaries)} catalogued objects` : 'active payloads against the catalogue'}. Encounters between two derelicts (dead satellites, rocket bodies, debris) are not screened — and nobody can manoeuvre to avoid them. Use “Screen an object” below on a rocket body to probe them.</div>
      </div>
      <div class="section">
        <div class="section-title">Where conjunctions concentrate <span class="src">by altitude of the first object</span></div>
        <div class="chart" id="chShell"></div>
      </div>`;
    this.body.innerHTML = `
      <p class="lead">Identify close approaches before they happen, see who is able to act, and replay any encounter in 3D.</p>
      ${head}
      <div class="section">
        <div class="section-title">Highest-risk encounters <span class="src" id="riskCount"></span></div>
        <div class="chips">${FILTERS.map(([k, l]) => `<button class="chip ${this.risk.filter === k ? 'active' : ''}" data-rf="${k}">${l}</button>`).join('')}</div>
        <div class="seg" style="margin-bottom:10px">${[['prob', 'Max Pc'], ['range', 'Miss distance'], ['soon', 'Soonest (Pc ≥ 10⁻⁵)']].map(([k, l]) => `<button class="${this.risk.sort === k ? 'active' : ''}" data-rs="${k}">${l}</button>`).join('')}</div>
        <div class="list" id="riskList"><div class="empty">${s ? 'Loading…' : 'Waiting for SOCRATES…'}</div></div>
      </div>
      ${s?.mostExposed?.length ? `<div class="section"><div class="section-title">Most exposed objects <span class="src">external encounters &lt; 1 km, 7 days</span></div>
        <div class="list">${s.mostExposed.slice(0, 8).map((o) => `<div class="row cols" data-sel-id="${o.id}"><div><div class="t">${esc(o.name)}</div><div class="m">NORAD ${o.id} · ${esc(o.type || '?')} · ${o.owner ? esc(OWNERS[o.owner] || o.owner) : '—'}${Number.isFinite(o.altKm) ? ` · ${fmt.int(o.altKm)} km` : ''}</div></div><div class="r">${o.count}×</div></div>`).join('')}</div></div>` : ''}
      <div class="section">
        <div class="section-title">Screen an object yourself <span class="src">SGP4 · in your browser</span></div>
        <p class="lead">Propagates one object against every loaded object (${fmt.int(this.app.catalog.objects.length)}), finds each close approach and refines its time of closest approach.</p>
        <div id="screenTarget"></div>
        <div class="field-row"><div class="field"><label>Window</label><div class="seg">${[24, 72].map((h) => `<button class="${this.risk.hours === h ? 'active' : ''}" data-rh="${h}">${h} h</button>`).join('')}</div></div>
          <div class="field"><label>Report closer than</label><div class="seg">${[5, 10, 25].map((d) => `<button class="${this.risk.threshold === d ? 'active' : ''}" data-rt="${d}">${d} km</button>`).join('')}</div></div></div>
        <button class="btn primary" id="screenRun" ${this.risk.running ? 'disabled' : ''}>Run screening</button>
        <div class="progress ${this.risk.running ? '' : 'hidden'}" id="screenProg"><i></i></div><div class="note" id="screenNote"></div>
        <div class="list" id="screenList"></div>
      </div>
      ${this.methodNotes()}`;
    this.renderScreenTarget();
    if (this.risk.results) this.renderScreenResults();
    if (s) {
      const sh = s.shells, a0 = Math.round((300 - sh.fromKm) / sh.binKm), n = Math.round((1300 - 300) / sh.binKm);
      const km = (i) => sh.fromKm + (a0 + i) * sh.binKm;
      drawChart($('#chShell'), {
        type: 'bar', height: 150, n,
        series: CLASS.slice(0, 3).map((c, k) => ({ name: c.label, color: c.color, values: sh.byClass[k].slice(a0, a0 + n) })),
        xLabel: (i) => (km(i) % 200 === 0 ? `${km(i)} km` : null),
        tip: (i) => `${km(i)}–${km(i) + sh.binKm} km<br>${CLASS.slice(0, 3).map((c, k) => `${c.label}: ${fmt.int(sh.byClass[k][a0 + i])}`).join('<br>')}`,
      });
      this.loadRiskList();
    }
    this.body.onclick = (e) => {
      const f = e.target.closest('[data-rf]'); if (f) { this.risk.filter = f.dataset.rf; $$('[data-rf]').forEach((b) => b.classList.toggle('active', b === f)); return this.loadRiskList(); }
      const f2 = e.target.closest('[data-filter]'); if (f2 && f2.dataset.filter !== 'same') { this.risk.filter = f2.dataset.filter; $$('[data-rf]').forEach((b) => b.classList.toggle('active', b.dataset.rf === this.risk.filter)); this.loadRiskList(); $('#riskList').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      const so = e.target.closest('[data-rs]'); if (so) { this.risk.sort = so.dataset.rs; $$('[data-rs]').forEach((b) => b.classList.toggle('active', b === so)); return this.loadRiskList(); }
      const h = e.target.closest('[data-rh]'); if (h) { this.risk.hours = Number(h.dataset.rh); $$('[data-rh]').forEach((b) => b.classList.toggle('active', b === h)); return; }
      const t = e.target.closest('[data-rt]'); if (t) { this.risk.threshold = Number(t.dataset.rt); $$('[data-rt]').forEach((b) => b.classList.toggle('active', b === t)); return; }
      const enc = e.target.closest('[data-enc]'); if (enc) { const r = this.riskRows?.[Number(enc.dataset.enc)]; if (r) this.app.viewEncounter({ id1: r.id1, id2: r.id2, tca: Date.parse(r.tca), socrates: r }); return; }
      const loc = e.target.closest('[data-loc]'); if (loc) { const r = this.risk.results?.results[Number(loc.dataset.loc)]; if (r) this.app.viewEncounter({ id1: this.risk.results.primaryId, id2: r.id, tca: r.tca }).then(() => { if (this.app.encounter) { this.app.encounter.local = r; this.app.bus.emit('encounter', this.app.encounter); } }); return; }
      const sid = e.target.closest('[data-sel-id]'); if (sid) { this.app.ensureObject(Number(sid.dataset.selId)).then((o) => o && this.app.select({ kind: 'sat', obj: o })); return; }
      const pick = e.target.closest('[data-target]'); if (pick) { this.risk.target = Number(pick.dataset.target); this.renderScreenTarget(); return; }
      const opt = e.target.closest('[data-opt]'); if (opt) { this.app.setOption(opt.dataset.opt, !opt.classList.contains('on')); opt.classList.toggle('on'); return; }
      if (e.target.id === 'screenRun') this.runScreening();
      if (e.target.id === 'socRetry') { e.target.disabled = true; this.app.loadSocrates().catch(() => {}); }
    };
  }

  methodNotes() {
    const notes = BRIEF.risk_method_notes;
    return `<details class="method"><summary>How to read these numbers</summary><div class="body">
      <p><b>Miss distance</b> is the predicted separation at the time of closest approach (TCA), from public GP/TLE data propagated with SGP4.</p>
      <p><b>Max Pc</b> is a covariance-free worst case: the highest collision probability consistent with the miss distance and the objects' combined hard-body radius, for any uncertainty size. It flags encounters worth a closer look; it is not the operational Pc an operator computes from covariance data.</p>
      <p>Colour coding: <span class="badge danger">≥ 1e-4</span> NASA CARA's red threshold (detailed monitoring and mitigation planning); <span class="badge warn">≥ 1e-5</span> ESA's internal monitoring level. CARA already monitors more closely from 1e-7. All three are defined for covariance-based Pc, so applying them to a worst-case Max Pc over-flags. ${src(BRIEF.pc_thresholds.source_url, 'NASA CA handbook')}</p>
      ${notes.length ? `<ul>${notes.map((n) => `<li>${esc(n.text)} ${src(n.source_url)}</li>`).join('')}</ul>` : ''}
      <p>Local screening: apogee/perigee filter → 60 s sampling with linear-motion TCA prediction → golden-section refinement to milliseconds. Docked and formation-flying pairs (always within 30 km) are excluded. Hard-body radii are estimated from SATCAT radar cross-section with conservative minimums by object class.</p>
    </div></details>`;
  }

  renderScreenTarget() {
    const host = $('#screenTarget'); if (!host) return;
    const app = this.app, sel = app.selection?.kind === 'sat' ? app.selection.obj : null;
    if (sel && this.risk.target == null) this.risk.target = sel.id;
    const chosen = app.catalog.byId.get(this.risk.target) || sel || app.catalog.byId.get(25544);
    if (chosen) this.risk.target = chosen.id;
    const quick = [[25544, 'ISS'], [48274, 'Tiangong'], [20580, 'Hubble']].filter(([id]) => app.catalog.byId.has(id));
    host.innerHTML = `<div class="field"><label>Object</label><div class="row cols sel" style="cursor:default"><div><div class="t">${chosen ? esc(chosen.name) : 'Select an object on the globe'}</div><div class="m">${chosen ? `NORAD ${chosen.id} · ${CATEGORIES[chosen.cat].short}` : ''}</div></div><div class="r">${sel && sel.id !== chosen?.id ? `<button class="btn small" data-target="${sel.id}">Use selected</button>` : ''}</div></div></div>
      <div class="chips">${quick.map(([id, n]) => `<button class="chip ${chosen?.id === id ? 'active' : ''}" data-target="${id}">${n}</button>`).join('')}</div>`;
  }

  async loadRiskList() {
    const list = $('#riskList'); if (!list) return;
    list.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { data } = await api(`/api/socrates/top?filter=${this.risk.filter}&sort=${this.risk.sort}&limit=60`);
      if (!$('#riskList')) return;
      this.riskRows = data.rows;
      $('#riskCount').textContent = `${fmt.int(data.matching)} matching · showing ${data.rows.length}`;
      const now = this.app.clock.now();
      list.innerHTML = data.rows.length ? data.rows.map((r, i) => `<div class="row conj" data-enc="${i}" title="Replay this encounter in 3D">
          <div class="pc ${pcCls(r.maxProb)}">${fmt.pc(r.maxProb)}</div>
          <div style="min-width:0"><div class="t pair"><span class="n">${esc(r.name1)}</span><span class="x">↔</span><span class="n">${esc(r.name2)}</span></div>
            <div class="m">${fmt.utc(Date.parse(r.tca), false)} UTC · ${fmt.rel(Date.parse(r.tca), now)}${r.altKm ? ` · ${fmt.int(r.altKm)} km` : ''} · <span title="Age of the orbital elements at TCA (days since epoch)" style="color:${Math.max(r.dse1, r.dse2) > 3 ? 'var(--warn)' : 'inherit'}">elements ${fmt.num(Math.max(r.dse1, r.dse2), 1)} d old</span></div></div>
          <div class="r">${fmt.km(r.rangeKm)}<br><span style="color:var(--text-3)">${fmt.speed(r.speedKms)}</span></div></div>`).join('')
        : '<div class="empty">No upcoming conjunctions match this filter.</div>';
    } catch (e) { list.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  async runScreening() {
    const app = this.app, obj = app.catalog.byId.get(this.risk.target);
    if (!obj) return toast('Select an object first.', 'warn');
    if (this.risk.running) return toast('A screening is already running.', 'warn');
    const token = (this.risk.token = (this.risk.token || 0) + 1);
    this.risk.results = null;
    this.risk.running = true;
    $('#screenRun').disabled = true;
    $('#screenProg')?.classList.remove('hidden');
    $('#screenNote').textContent = 'Preparing the analysis worker…';
    $('#screenList').innerHTML = '';
    const t0 = performance.now();
    try {
      const res = await app.screen(obj, { hours: this.risk.hours, threshold: this.risk.threshold }, (p, note) => {
        const bar = $('#screenProg > i'); if (bar) bar.style.width = `${Math.round(p * 100)}%`;
        if (note) { const n = $('#screenNote'); if (n) n.textContent = note; }
      });
      res.primaryId = obj.id; res.primaryName = obj.name; res.elapsed = (performance.now() - t0) / 1000;
      if (token === this.risk.token) this.risk.results = res;
    } catch (e) { if (token === this.risk.token) toast(`Screening failed: ${e.message}`, 'err'); }
    if (token !== this.risk.token) return;
    this.risk.running = false;
    if (this.tab === 'risk') { $('#screenRun').disabled = false; $('#screenProg')?.classList.add('hidden'); this.renderScreenResults(); }
  }

  renderScreenResults() {
    const r = this.risk.results, host = $('#screenList'), note = $('#screenNote');
    if (!r || !host) return;
    const app = this.app;
    note.innerHTML = `<b>${esc(r.primaryName)}</b>: ${fmt.int(r.candidates)} objects share its altitude band; ${r.results.length} approach${r.results.length === 1 ? '' : 'es'} closer than ${r.threshold} km in the next ${r.hours} h${r.colocated ? ` (${r.colocated} docked/formation objects skipped)` : ''} · ${r.elapsed.toFixed(1)} s.`;
    host.innerHTML = r.results.length ? r.results.slice(0, 50).map((x, i) => {
      const cat = CATEGORIES[x.cat] || CATEGORIES[0];
      return `<div class="row conj" data-loc="${i}" title="Replay in 3D">
        <div class="pc ${pcCls(x.maxPc)}">${fmt.pc(x.maxPc)}</div>
        <div style="min-width:0"><div class="t"><span class="sw" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${cat.color};margin-right:6px"></span>${esc(x.name)}</div>
        <div class="m">${fmt.utc(x.tca, false)} UTC · ${fmt.rel(x.tca, app.clock.now())} · R ${x.radialKm.toFixed(2)} / I ${x.intrackKm.toFixed(2)} / C ${x.crossKm.toFixed(2)} km</div></div>
        <div class="r">${fmt.km(x.missKm)}<br><span style="color:var(--text-3)">${fmt.speed(x.relSpeed)}</span></div></div>`;
    }).join('') : '<div class="empty">No close approaches found in the loaded catalogue for this window.</div>';
  }

  /* ═════════════════════ Orbital environment ═════════════════════ */
  renderEnvironment() {
    const E = this.app.environment, s = this.app.socrates;
    if (!E) { this.body.innerHTML = '<div class="empty">Loading the CelesTrak satellite catalogue (SATCAT)…</div>'; return; }
    const T = E.totals, sl = E.constellations.find((c) => c.name === 'Starlink');
    const y0 = E.years.indexOf(2000);
    this.body.innerHTML = `
      <p class="lead">How crowded Earth orbit is, how fast it is growing, and whether today's satellites will clean up after themselves.</p>
      <div class="section">
        <div class="section-title">Population today <span class="src">SATCAT · ${fmt.age(E.satcatFetchedAt)}</span></div>
        <div class="kpis three">
          ${kpi(fmt.int(T.onOrbit), 'Tracked in orbit')}${kpi(fmt.int(T.activePayloads), 'Active payloads')}${kpi(sl ? share(sl.active, T.activePayloads) : '—', 'of active are Starlink')}
          ${kpi(fmt.int(T.byType.DEB), 'Debris fragments', '', 'alert')}${kpi(fmt.int(T.byType.RB), 'Rocket bodies', '', 'warn')}${kpi(fmt.int(T.deadPayloads ?? T.byType.PAY - T.activePayloads), 'Dead payloads', T.unknownPayloads != null ? `${fmt.int(T.unknownPayloads)} more with unknown status` : '')}
        </div>
        <p class="note">${fmt.int(E.launchedLast30Days)} payloads launched and ${fmt.int(E.recentReentries.count)} objects re-entered in the last 30 days. Only objects large enough to be tracked (typically > 10 cm in LEO) are catalogued.</p>
      </div>
      <div class="section"><div class="section-title">Objects in Earth orbit since 1957</div><div class="chart" id="chGrowth"></div>
        <p class="note">Debris is dated by its estimated cataloguing date. Drops follow re-entries, e.g. high solar activity speeding up decay.</p></div>
      <div class="section"><div class="section-title">Payloads launched per year</div><div class="chart" id="chLaunch"></div></div>
      <div class="section"><div class="section-title">Congestion by altitude (LEO) <span class="src">objects per 25 km shell</span></div><div class="chart" id="chShells"></div>
        <p class="note">Dashed lines: altitudes where a typical satellite takes 5 and 25 years to re-enter naturally (${fmt.int(E.lifetime.altitude5yr)} km and ${fmt.int(E.lifetime.altitude25yr)} km; ${esc(E.lifetime.model)}). Anything left above them persists for decades to centuries.</p></div>
      <div class="section"><div class="section-title">Disposal outlook <span class="src">active LEO payloads · natural decay time</span></div><div class="chart" id="chOutlook"></div>
        <p class="note">Under the FCC 5-year rule (US-licensed or US-market satellites) and ESA's Zero Debris approach, satellites above the 5-year line must be actively de-orbited at end of life. The international IADC/UN guideline is 25 years. Satellites that fail before disposal stay up as debris.</p></div>
      ${s ? `<div class="section"><div class="section-title">Conjunction burden this week <span class="src">SOCRATES</span></div>
        <div class="kpis">${kpi(share(s.counts.starlinkAny, s.total), 'involve a Starlink')}${kpi(share(s.counts.debrisAny, s.total), 'involve a debris fragment')}${kpi(share(s.counts.rbAny, s.total), 'involve a rocket body')}${kpi(share(s.classes.stats[1].total, s.total), 'need cross-operator coordination')}</div></div>` : ''}
      <div class="section"><div class="section-title">Mega-constellations <span class="src">active / in orbit</span></div>
        <div class="list">${E.constellations.map((c) => `<div class="row cols"><div class="t">${esc(c.name)}</div><div class="r">${fmt.int(c.active)} / ${fmt.int(c.onOrbit)}</div></div>`).join('')}</div>
        ${BRIEF.planned_constellations.length ? `<div class="section-title" style="margin-top:14px">Planned or authorised</div><div class="list">${BRIEF.planned_constellations.map((p) => `<div class="row"><div class="t">${esc(p.name)} <span style="color:var(--text-3);font-weight:400">· ${esc(p.operator)}</span></div><div class="m" style="white-space:normal">${esc(p.planned)}</div><div class="m" style="white-space:normal">${esc(p.status_note)} ${src(p.source_url, '↗')}</div></div>`).join('')}</div>` : ''}</div>
      <div class="section"><div class="section-title">Re-entries per year</div><div class="chart" id="chReentry"></div></div>
      <div class="section"><div class="section-title">Recent re-entries <span class="src">last 30 days</span></div>
        <div class="list">${E.recentReentries.list.slice(0, 10).map((r) => `<div class="row cols"><div><div class="t">${esc(r.name)}</div><div class="m">NORAD ${r.id} · ${esc(r.type)} · launched ${esc(r.launch || '—')}</div></div><div class="r">${esc(r.decay)}</div></div>`).join('')}</div></div>
      ${this.leversHtml()}
      ${BRIEF.fragmentation_events.length ? `<div class="section"><div class="section-title">Largest debris-generating events</div>
        <div class="list">${BRIEF.fragmentation_events.map((f) => { const live = E.fragmentations?.[(f.intdes || []).join(',')]; return `<div class="row cols"><div style="min-width:0"><div class="t">${esc(f.name)}</div><div class="m">${esc(f.date)} · ${esc(/km/.test(f.altitude_km) || /not/.test(f.altitude_km) ? f.altitude_km : `${f.altitude_km} km`)} ${src(f.source_url, '↗')}</div></div><div class="r">${live ? `${fmt.int(live.catalogued)} catalogued<br><span style="color:var(--text-3)">${fmt.int(live.onOrbit)} still in orbit</span>` : esc(f.tracked_fragments)}</div></div>`; }).join('')}</div>
        <p class="note">Counts are live from SATCAT: every object catalogued under each launch designator. Debris from the first three events is drawn on the globe.</p></div>` : ''}
      ${BRIEF.environment_facts.length ? `<div class="section"><div class="section-title">Context</div><ul class="note" style="padding-left:16px">${BRIEF.environment_facts.map((f) => `<li>${esc(f.text)} ${src(f.source_url)}</li>`).join('')}</ul></div>` : ''}`;
    const yrs = E.years;
    drawChart($('#chGrowth'), {
      type: 'area', height: 160, n: yrs.length,
      series: [['PAY', 'Payloads', '#7dd3fc'], ['RB', 'Rocket bodies', '#f5b942'], ['DEB', 'Debris', '#ff6b6b'], ['UNK', 'Unknown', '#94a3b8']].map(([k, n, c]) => ({ name: n, color: c, values: E.growth[k] })),
      xLabel: (i) => (yrs[i] % 10 === 0 ? String(yrs[i]) : null),
      tip: (i) => `${yrs[i]}${yrs[i] === new Date().getUTCFullYear() ? ' (to date)' : ''}<br>Payloads ${fmt.int(E.growth.PAY[i])}<br>Rocket bodies ${fmt.int(E.growth.RB[i])}<br>Debris ${fmt.int(E.growth.DEB[i])}`,
    });
    const ly = E.years.slice(y0), off = y0;
    drawChart($('#chLaunch'), {
      type: 'bar', height: 150, n: ly.length,
      series: [['Starlink', '#8b9cff'], ['Other constellations', '#c084fc'], ['All other payloads', '#7dd3fc']].map(([k, c]) => ({ name: k, color: c, values: E.launches[k].slice(off) })),
      xLabel: (i) => (ly[i] % 5 === 0 ? String(ly[i]) : null),
      tip: (i) => `${ly[i]}<br>Starlink ${fmt.int(E.launches.Starlink[off + i])}<br>Other constellations ${fmt.int(E.launches['Other constellations'][off + i])}<br>Other ${fmt.int(E.launches['All other payloads'][off + i])}`,
    });
    const sh = E.shells, nb = sh.series.Starlink.length;
    const keys = [['Starlink', '#8b9cff'], ['Other active', '#7dd3fc'], ['Inactive payloads', '#a8b3c7'], ['Rocket bodies', '#f5b942'], ['Debris', '#ff6b6b'], ['Unknown', '#64748b']];
    const at = (km) => (km - sh.fromKm) / sh.binKm;
    drawChart($('#chShells'), {
      type: 'bar', height: 170, n: nb, series: keys.map(([k, c]) => ({ name: k, color: c, values: sh.series[k] })),
      xLabel: (i) => ((sh.fromKm + i * sh.binKm) % 400 === 0 ? `${sh.fromKm + i * sh.binKm}` : null),
      markers: [{ at: at(E.lifetime.altitude5yr), label: '5 yr', color: '#3ddc97' }, { at: at(E.lifetime.altitude25yr), label: '25 yr', color: '#f5b942', row: 1 }],
      tip: (i) => `${sh.fromKm + i * sh.binKm}–${sh.fromKm + (i + 1) * sh.binKm} km<br>${keys.map(([k]) => `${k}: ${fmt.int(sh.series[k][i])}`).join('<br>')}<br>density ${fmt.sci(sh.densityPerKm3[i], 2)} /km³<br>natural decay ≈ ${formatLifetime(lifetimeAt(sh.fromKm + (i + 0.5) * sh.binKm))}`,
    });
    const O = E.lifetime.outlook, ok = Object.keys(O);
    drawChart($('#chOutlook'), { type: 'bar', height: 120, n: ok.length, legend: false, series: [{ name: 'Active LEO payloads', color: '#7dd3fc', values: ok.map((k) => O[k]) }], xLabel: (i) => ok[i], tip: (i) => `${ok[i]}: ${fmt.int(O[ok[i]])} satellites` });
    const ry = E.years.slice(y0);
    drawChart($('#chReentry'), {
      type: 'bar', height: 130, n: ry.length,
      series: [['PAY', 'Payloads', '#7dd3fc'], ['RB', 'Rocket bodies', '#f5b942'], ['DEB', 'Debris', '#ff6b6b']].map(([k, n, c]) => ({ name: n, color: c, values: E.reentries[k].slice(off) })),
      xLabel: (i) => (ry[i] % 5 === 0 ? String(ry[i]) : null),
      tip: (i) => `${ry[i]}<br>Payloads ${fmt.int(E.reentries.PAY[off + i])}<br>Rocket bodies ${fmt.int(E.reentries.RB[off + i])}<br>Debris ${fmt.int(E.reentries.DEB[off + i])}`,
    });
  }

  leversHtml() {
    const L = BRIEF.sustainability_levers;
    if (!L.length) return '';
    return `<div class="section"><div class="section-title">Managing the orbital environment sustainably</div>
      ${L.map((l, i) => `<div class="lever"><div class="ico">${i + 1}</div><div><div class="h">${esc(l.title)}</div><div class="d">${esc(l.detail)} ${src(l.source_url)}</div></div></div>`).join('')}</div>`;
  }

  /* ═════════════════════ Night sky ═════════════════════ */
  renderSky() {
    const app = this.app, o = app.observer, t = app.clock.now();
    const sun = bodyHorizon(Astro.Body.Sun, t, o), moon = moonInfo(t, o), nw = app.nightWindow();
    const lim = BRIEF.brightness_limit;
    this.body.innerHTML = `
      <p class="lead">How satellites change the sky above <b>${esc(o.name || 'the observer')}</b> — for the eye, for telescopes and for your mount's camera.</p>
      <div class="section"><div class="section-title">Conditions</div>
        <div class="kv">
          <div class="k">Sky</div><div class="v">${twilight(sun.el)} · Sun ${fmt.deg(sun.el, 1)}</div>
          <div class="k">Moon</div><div class="v">${moon.name} · ${fmt.pct(moon.illum, 0)} lit · ${moon.el > 0 ? `up ${fmt.deg(moon.el, 0)}` : 'below horizon'}</div>
          <div class="k">Next dark window</div><div class="v">${nw ? `${fmt.localFull(nw.start)} → ${fmt.local(nw.end)}` : '—'}<br><small>Sun below −6° · times in your time zone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || 'local')})</small></div>
        </div></div>
      <div class="section"><div class="section-title">Right now <span class="src">sunlit objects above 10°</span></div>
        <div class="kpis" id="skyNow"></div><p class="note" id="skyNowNote"></p></div>
      <div class="section"><div class="section-title">Through the night <span class="src">SGP4 · every 10 min</span></div>
        <div class="chart" id="chNight"><div class="empty">Computing…</div></div><div class="progress" id="nightProg"><i></i></div><p class="note" id="nightNote"></p></div>
      <div class="section"><div class="section-title">Bright passes in the next 24 h <span class="src">brightest catalogued objects · sunlit, dark sky, ≈ mag ≤ 4.5</span></div>
        <div class="list" id="brightList"><div class="empty">Computing…</div></div></div>
      <div class="section"><div class="section-title">Why it matters</div>
        ${BRIEF.night_sky_notes.length ? `<ul class="note" style="padding-left:16px">${BRIEF.night_sky_notes.map((n) => `<li>${esc(n.text)} ${src(n.source_url)}</li>`).join('')}</ul>` : ''}
        ${lim.formula_text ? `<div class="callout"><b>Brightness guideline:</b> ${esc(lim.formula_text)} ${src(lim.source_url)}</div>` : ''}
        <p class="note">Brightness here is a model estimate (standard magnitude scaled by range and a diffuse-sphere phase law, ±1 mag); attitude, solar-array glints and coatings are not modelled.</p></div>`;
    this.updateSkyNow();
    this.loadNight();
    this.loadBright();
  }

  updateSkyNow() {
    const app = this.app, s = app.state, host = $('#skyNow');
    if (!host || !s) return;
    const lim = BRIEF.brightness_limit.v_limit_at_550km || 7;
    let lit = 0, sl = 0, naked = 0, faintLim = 0, up = 0;
    const slCat = CAT_INDEX.starlink;
    const cats = app.scene.sat?.cat, P = app.scene.sat?.pos;
    const payloadCats = new Set(['starlink', 'megaconst', 'gnss', 'earthobs', 'science', 'geo', 'active'].map((k) => CAT_INDEX[k]));
    for (let i = 0; i < s.n; i++) {
      if (!(s.el[i] >= 10)) continue;
      up++;
      if (s.st[i] !== 2) continue;
      lit++;
      if (cats && cats[i] === slCat) sl++;
      const m = s.mag[i];
      if (m <= 6) naked++;
      const h = P ? Math.hypot(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) * 6378.137 - 6378.137 : 550;
      if (cats && payloadCats.has(cats[i]) && m < lim + 2.5 * Math.log10(Math.max(h, 550) / 550)) faintLim++;
    }
    host.innerHTML = kpi(fmt.int(lit), 'Sunlit above 10°', `${fmt.int(up)} above 10° in total`) + kpi(share(sl, lit), 'of them Starlink')
      + kpi(fmt.int(naked), 'Naked-eye (≈ mag ≤ 6)', 'under dark skies', naked ? 'warn' : '') + kpi(fmt.int(faintLim), 'Satellites brighter than the IAU limit', `operational satellites · V ${lim} at ≤ 550 km, altitude-scaled`, faintLim ? 'alert' : '');
    const note = $('#skyNowNote');
    if (note) note.textContent = s.sunEl > -6 ? `It is ${twilight(s.sunEl).toLowerCase()} at the observer, so these objects are lit but not visible against the bright sky.` : 'Every sunlit object above the horizon can leave a streak in wide-field telescope exposures.';
  }

  async loadNight() {
    const app = this.app;
    const key = `${app.observer.lat.toFixed(2)},${app.observer.lon.toFixed(2)},${new Date(app.clock.now()).toISOString().slice(0, 13)}`;
    if (this.night?.key !== key) {
      this.night = { key, promise: app.nightForecast((p) => { const b = $('#nightProg > i'); if (b) b.style.width = `${Math.round(p * 100)}%`; }) };
    }
    try {
      const r = await this.night.promise;
      if (this.tab !== 'sky' || !$('#chNight')) return;
      $('#nightProg')?.classList.add('hidden');
      const n = r.t.length;
      const bands = [];
      for (let i = 0; i < n; i++) if (r.sunEl[i] < -18) bands.push(i);
      const band = bands.length ? [{ from: bands[0], to: bands[bands.length - 1], color: 'rgba(78,168,255,0.06)' }] : [];
      $('#chNight').innerHTML = '';
      drawChart($('#chNight'), {
        type: 'area', height: 160, n,
        series: [{ name: 'Starlink', color: '#8b9cff', values: r.starlink }, { name: 'Other sunlit objects', color: '#7dd3fc', values: r.lit.map((v, i) => v - r.starlink[i]) }],
        bands: band,
        xLabel: (i) => (i % 18 === 0 ? new Date(r.t[i]).toLocaleTimeString([], { hour: 'numeric' }) : null),
        tip: (i) => `${fmt.local(r.t[i])} · Sun ${fmt.deg(r.sunEl[i], 0)}<br>Sunlit above ${r.minEl}°: ${fmt.int(r.lit[i])}<br>Starlink: ${fmt.int(r.starlink[i])}<br>Naked-eye (≈≤6): ${fmt.int(r.naked[i])}`,
      });
      const peak = Math.max(...r.lit), mid = r.lit[Math.floor(n / 2)];
      $('#nightNote').innerHTML = `Peak ${fmt.int(peak)} sunlit objects above ${r.minEl}° (around ${fmt.local(r.t[r.lit.indexOf(peak)])}); ${fmt.int(mid)} near local midnight. Satellites are most numerous right after dusk and before dawn, when they are still in sunlight while the ground is dark. The shaded band is astronomical night.`;
    } catch (e) { const c = $('#chNight'); if (c) c.innerHTML = `<div class="empty">${esc(e.message)}</div>`; $('#nightProg')?.classList.add('hidden'); }
  }

  async loadBright() {
    const app = this.app;
    if (!this.bright || this.bright.key !== this.night?.key) this.bright = { key: this.night?.key, promise: app.brightPasses() };
    try {
      const r = await this.bright.promise;
      const host = $('#brightList'); if (!host) return;
      host.innerHTML = r.passes.length ? r.passes.slice(0, 12).map((p) => `<div class="row cols" data-sel-id="${p.id}"><div><div class="t">${esc(p.name)}</div><div class="m">${fmt.localFull(p.start)} → ${fmt.local(p.end)} · max ${fmt.deg(p.maxEl, 0)} · ${compass(p.startAz)} → ${compass(p.endAz)}</div></div><div class="r">≈ ${p.minMag.toFixed(1)}</div></div>`).join('')
        : '<div class="empty">No bright visible passes of the brightest objects in the next 24 hours.</div>';
      host.onclick = (e) => { const r2 = e.target.closest('[data-sel-id]'); if (r2) { const o = app.catalog.byId.get(Number(r2.dataset.selId)); if (o) app.select({ kind: 'sat', obj: o }); } };
    } catch (e) { const h = $('#brightList'); if (h) h.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  /* ═════════════════════ Asteroids ═════════════════════ */
  renderNeo() {
    const app = this.app, N = app.neo;
    const list = [...N.list];
    const sorters = { miss: (a, b) => (a.ca?.missKm ?? 1e12) - (b.ca?.missKm ?? 1e12), date: (a, b) => (a.ca?.t ?? 0) - (b.ca?.t ?? 0), size: (a, b) => (b.diameterM ?? 0) - (a.diameterM ?? 0) };
    list.sort(sorters[this.neoSort]);
    const week = N.list.filter((o) => o.source === 'NASA NeoWs');
    const pha = week.filter((o) => o.pha).length;
    const closest = [...week].sort(sorters.miss)[0], largest = [...week].sort(sorters.size)[0];
    const now = app.clock.now();
    this.body.innerHTML = `
      <p class="lead">Asteroids passing Earth this week (NASA NeoWs), with orbits from the JPL Small-Body Database and precise ephemerides from JPL Horizons for the selected object.</p>
      <div class="section"><div class="section-title">This week <span class="src">${N.feedRange ? `${N.feedRange[0]} → ${N.feedRange[1]}` : ''}</span></div>
        <div class="kpis">${kpi(fmt.int(week.length), 'Close approaches', N.loading ? `loading orbits… ${N.loading} left` : 'orbits loaded')}${kpi(fmt.int(pha), 'Potentially hazardous', 'PHA: MOID ≤ 0.05 AU, H ≤ 22', pha ? 'warn' : '')}
          ${kpi(closest?.ca ? fmt.ld(closest.ca.missKm) : '—', 'Closest approach', closest ? esc(closest.name) : '')}${kpi(largest?.diameterM ? `${fmt.int(largest.diameterM)} m` : '—', 'Largest (estimated)', largest ? esc(largest.name) : '')}</div>
        <div class="opt-row"><div>Distance scale<small>Log-compressed beyond the Moon keeps asteroids on screen; directions stay true</small></div>
          <div class="seg"><button class="${app.options.neoScale !== 'true' ? 'active' : ''}" data-scale="compressed">Compressed</button><button class="${app.options.neoScale === 'true' ? 'active' : ''}" data-scale="true">True</button></div></div></div>
      <div class="section"><div class="section-title">Close approaches <span class="src">NASA NeoWs · JPL SBDB</span></div>
        <div class="seg" style="margin-bottom:8px">${[['miss', 'Closest'], ['date', 'Date'], ['size', 'Largest']].map(([k, l]) => `<button class="${this.neoSort === k ? 'active' : ''}" data-ns="${k}">${l}</button>`).join('')}</div>
        <div class="list">${list.map((o) => `<div class="row cols ${app.selection?.obj === o ? 'sel' : ''}" data-neo="${N.list.indexOf(o)}"><div style="min-width:0"><div class="t">${esc(o.name)} ${o.pha ? '<span class="badge danger">PHA</span>' : ''}${o.sentry ? ' <span class="badge warn">Sentry</span>' : ''}</div>
          <div class="m">${o.ca ? `${fmt.utc(o.ca.t, false)} · ${fmt.rel(o.ca.t, now)}` : ''} · ~${fmt.int(o.diameterM)} m${o.el ? '' : o.elError ? ' · no orbit' : ' · orbit…'}</div></div>
          <div class="r">${o.ca ? fmt.ld(o.ca.missKm) : '—'}<br><span style="color:var(--text-3)">${o.ca ? fmt.speed(o.ca.vKms) : ''}</span></div></div>`).join('') || '<div class="empty">Loading NeoWs feed…</div>'}</div></div>
      <div class="section"><div class="section-title">Next 60 days within 0.05 AU <span class="src">JPL CNEOS</span></div>
        <div class="list">${N.cad.map((c, i) => `<div class="row cols" data-cad="${i}"><div style="min-width:0"><div class="t">${esc(c.name)}</div><div class="m">${esc(c.cd)} TDB · ${fmt.rel(c.t, now)} · H ${fmt.num(c.H, 1)}${c.diameterKm ? ` · ${fmt.int(c.diameterKm * 1000)} m` : ''}</div></div><div class="r">${fmt.ld(c.distKm)}<br><span style="color:var(--text-3)">${fmt.speed(c.vKms)}</span></div></div>`).join('') || '<div class="empty">Loading CNEOS data…</div>'}</div>
        <p class="note">Click an entry to load its orbit from JPL SBDB and show it on the globe.</p></div>`;
    this.body.onclick = async (e) => {
      const sc = e.target.closest('[data-scale]'); if (sc) { app.setOption('neoScale', sc.dataset.scale); app.neoTrajDirty = true; return; }
      const ns = e.target.closest('[data-ns]'); if (ns) { this.neoSort = ns.dataset.ns; return this.renderNeo(); }
      const r = e.target.closest('[data-neo]'); if (r) { const o = N.list[Number(r.dataset.neo)]; if (o?.el) app.focus({ kind: 'neo', obj: o }); else if (o) app.select({ kind: 'neo', obj: o }); return; }
      const c = e.target.closest('[data-cad]'); if (c) {
        try { toast('Loading orbit from JPL SBDB…'); const o = await N.addFromCad(N.cad[Number(c.dataset.cad)]); app.neoDirty = true; app.focus({ kind: 'neo', obj: o }); } catch (err) { toast(`Could not load orbit: ${err.message}`, 'err'); }
      }
    };
  }

  /* ═════════════════════ Space weather & events ═════════════════════ */
  renderEarth() {
    const app = this.app, W = app.spaceWeather || {}, ev = app.events || [];
    const sc = W.scales?.['0'];
    const kp = W.kp || [], kpNow = kp.length ? kp[kp.length - 1].Kp : NaN;
    const wind = W.wind?.[0], mag = W.mag?.[0], xr = W.xray || [], xNow = xr.length ? xr[xr.length - 1].flux : NaN;
    const scale = (k, l) => { const v = Number(sc?.[k]?.Scale ?? 0); return `<div class="wx lv${v}"><div class="k">${k}${v}</div><div class="l">${l} · ${esc(sc?.[k]?.Text || 'none')}</div></div>`; };
    const byCat = {};
    ev.forEach((e) => { (byCat[e.cat] ??= []).push(e); });
    this.body.innerHTML = `
      <div class="section"><div class="section-title">Space weather now <span class="src">NOAA SWPC</span></div>
        <div class="wx-scales">${scale('R', 'Radio blackout')}${scale('S', 'Radiation storm')}${scale('G', 'Geomagnetic storm')}</div>
        <div class="kpis" style="margin-top:8px">${kpi(fmt.num(kpNow, 2), 'Planetary Kp', kp.length ? fmt.age(Date.parse(`${kp[kp.length - 1].time_tag}Z`)) : '', kpNow >= 5 ? 'alert' : kpNow >= 4 ? 'warn' : '')}
          ${kpi(Number.isFinite(xNow) ? flareClass(xNow) : '—', 'GOES X-ray (0.1–0.8 nm)', Number.isFinite(xNow) ? `${fmt.sci(xNow, 1)} W/m²` : '')}
          ${kpi(wind ? `${fmt.int(wind.speed)} <small>km/s</small>` : '—', 'Solar wind speed', wind ? `${fmt.num(wind.density, 1)} p/cm³ · ${esc(wind.source)}` : '')}
          ${kpi(mag ? `${fmt.num(mag.bz, 1)} <small>nT</small>` : '—', 'IMF Bz (GSM)', mag ? `Bt ${fmt.num(mag.bt, 1)} nT` : '', mag && mag.bz < -10 ? 'alert' : '')}</div>
        <div class="chart" id="chKp"></div>
        <div class="callout"><b>Why it matters for collision risk:</b> geomagnetic storms heat and expand the upper atmosphere. Drag on LEO objects rises, orbits decay faster, and along-track prediction errors grow, so conjunction forecasts become less certain until fresh orbit data arrive.</div>
        ${(W.alerts || []).slice(0, 3).map((a) => `<div class="alert-msg">${esc(a.message.split('\n').slice(0, 9).join('\n'))}</div>`).join('')}</div>
      <div class="section"><div class="section-title">Natural events on Earth <span class="src">NASA EONET · open, 30 days</span></div>
        <div class="chips">${Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `<span class="badge"><span class="sw" style="background:${EONET_COLORS[k] || '#ccc'}"></span>${esc(v[0].catTitle)} ${v.length}</span>`).join('')}</div>
        <div class="list">${ev.slice().sort((a, b) => b.date - a.date).slice(0, 40).map((e) => `<div class="row cols" data-ev="${ev.indexOf(e)}"><div style="min-width:0"><div class="t"><span class="sw" style="display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;background:${EONET_COLORS[e.cat] || '#ccc'}"></span>${esc(e.title)}</div><div class="m">${esc(e.catTitle)} · ${fmt.lat(e.lat)} ${fmt.lon(e.lon)}</div></div><div class="r">${fmt.age(e.date)}</div></div>`).join('') || '<div class="empty">Loading EONET…</div>'}</div></div>
      <div class="section"><div class="section-title">Earth from L1 <span class="src">NASA EPIC · DSCOVR</span></div><div id="epic"><div class="empty">Loading…</div></div></div>`;
    if (kp.length) {
      const last = kp.slice(-24);
      drawChart($('#chKp'), { type: 'bar', height: 110, n: last.length, legend: false, yMax: 9,
        series: [{ name: 'Kp', color: '#7dd3fc', values: last.map((k) => k.Kp) }],
        xLabel: (i) => (i % 8 === 0 ? last[i].time_tag.slice(5, 10) : null), tip: (i) => `${last[i].time_tag.replace('T', ' ').slice(0, 16)} UTC<br>Kp ${last[i].Kp}` });
    }
    this.body.onclick = (e) => { const r = e.target.closest('[data-ev]'); if (r) { const ev2 = app.events[Number(r.dataset.ev)]; app.select({ kind: 'event', obj: ev2 }); } };
    this.loadEpic();
  }

  async loadEpic() {
    try {
      if (!this.epic) this.epic = (await api('/api/epic')).data;
      const latest = this.epic[this.epic.length - 1];
      const d = latest.date.slice(0, 10);
      const host = $('#epic'); if (!host) return;
      host.innerHTML = `<img class="epic" alt="Full-disk Earth image from NASA EPIC" src="/api/epic-image/${d}/${esc(latest.image)}"><p class="note">${esc(latest.date)} UTC · centred on ${fmt.lat(latest.centroid_coordinates.lat)}, ${fmt.lon(latest.centroid_coordinates.lon)} · ${esc(latest.caption)}</p>`;
      feeds.define('epic', 'NASA EPIC — Earth from L1', 'epic.gsfc.nasa.gov'); feeds.ok('epic', Date.parse(`${latest.date.replace(' ', 'T')}Z`), latest.image);
    } catch (e) { const h = $('#epic'); if (h) h.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  /* ═════════════════════ Mount ═════════════════════ */
  renderMount() {
    const m = this.app.mount, c = m.cfg;
    const num = (k, label, step = 1, min = '', max = '') => `<div class="field"><label>${label}</label><input type="number" data-cfg="${k}" value="${c[k]}" step="${step}" min="${min}" max="${max}"></div>`;
    this.body.innerHTML = `
      <p class="lead">Streams pointing commands to an ESP32-S3 alt-az mount. The mount tracks the selected object, or wherever you look in Sky view.</p>
      <div class="section"><div class="section-title">Link <span class="src">${esc(m.status === 'sim' ? 'simulator active' : m.status)}</span></div>
        <div class="seg" style="margin-bottom:10px">${[['sim', 'Simulator'], ['serial', 'USB (Web Serial)'], ['ws', 'Wi-Fi (WebSocket)']].map(([k, l]) => `<button class="${c.transport === k ? 'active' : ''}" data-tr="${k}">${l}</button>`).join('')}</div>
        ${c.transport === 'ws' ? `<div class="field"><label>Mount address</label><input data-cfg="wsUrl" value="${esc(c.wsUrl)}" spellcheck="false"></div>` : ''}
        ${c.transport === 'serial' ? `<div class="field"><label>Baud rate</label><input type="number" data-cfg="baud" value="${c.baud}"></div>${'serial' in navigator ? '' : '<div class="callout warn">Web Serial needs Chrome or Edge on desktop.</div>'}` : ''}
        ${c.transport !== 'sim' ? `<button class="btn ${m.connected ? 'danger' : 'primary'}" id="mConnect">${m.connected ? 'Disconnect' : m.status === 'connecting' ? 'Connecting…' : 'Connect'}</button>` : '<p class="note">The simulator slews a virtual mount at the configured rates so you can rehearse without hardware.</p>'}
      </div>
      <div class="section"><div class="section-title">Mode</div>
        <div class="seg">${[['off', 'Off'], ['track', 'Track selected'], ['view', 'Follow view'], ['manual', 'Manual'], ['park', 'Park']].map(([k, l]) => `<button class="${c.mode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
        <div class="mount-grid" style="margin-top:12px"><div class="dial-card"><div class="l">Commanded</div><div class="v" id="mCmd">—</div></div><div class="dial-card"><div class="l">Actual</div><div class="v" id="mAct">—</div></div></div>
        <p class="note" id="mInfo"></p>
        ${c.mode === 'manual' ? `<div class="field"><label>Azimuth <span id="mzA">${m.manual.az}</span>°</label><input type="range" min="0" max="359.9" step="0.1" value="${m.manual.az}" data-man="az"></div>
          <div class="field"><label>Elevation <span id="mzE">${m.manual.el}</span>°</label><input type="range" min="0" max="90" step="0.1" value="${m.manual.el}" data-man="el"></div>` : ''}
        ${c.mode === 'view' && this.app.scene.mode !== 'sky' ? '<button class="btn" id="mSky">Open Sky view</button>' : ''}
      </div>
      <div class="section"><div class="section-title">Camera field of view</div>
        <div class="field-row">${num('fov', 'Field of view °', 0.5, 0.5, 120)}${num('exposure', 'Exposure s', 5, 5, 600)}</div>
        <div class="section-title" style="margin-top:4px">In view now</div><div class="list" id="mInView"></div>
        <button class="btn" id="mForecast" style="margin-top:8px">Predict satellite streaks for one exposure</button><div class="list" id="mStreaks"></div>
      </div>
      <div class="section"><div class="section-title">Limits & calibration</div>
        <div class="field-row three">${num('minEl', 'Min elevation °', 1, -5, 89)}${num('maxEl', 'Max elevation °', 1, 1, 90)}${num('sunGuard', 'Sun exclusion °', 1, 0, 60)}</div>
        <div class="field-row three">${num('azOffset', 'Azimuth offset °', 0.1, -180, 180)}${num('rateHz', 'Command rate Hz', 1, 1, 50)}${num('slewAz', 'Sim slew az °/s', 1, 1, 360)}</div>
        <p class="note">Azimuth offset is added before sending, so you can align a mount whose zero is not true north (point it at the Moon or Polaris, then adjust).</p></div>
      <div class="section"><div class="section-title">Protocol</div>
        <pre class="code">AZEL &lt;az°&gt; &lt;el°&gt; &lt;az rate °/s&gt; &lt;el rate °/s&gt;\\n
PARK · STOP · PING          (host → mount)
POS &lt;az°&gt; &lt;el°&gt; · PONG · HELLO …   (mount → host)</pre>
        <p class="note">Firmware for the ESP32-S3 is in <code>firmware/argus_mount/</code> (USB CDC + optional Wi-Fi WebSocket, two servos or steppers).</p>
        <div class="log" id="mountLog">${esc(m.log.join('\n'))}</div></div>`;
    this.mInViewKey = null;
    this.updateMountLive();
    this.body.onclick = async (e) => {
      const tr = e.target.closest('[data-tr]'); if (tr) { if (m.connected) await m.disconnect(); c.transport = tr.dataset.tr; m.save(); return this.renderMount(); }
      const md = e.target.closest('[data-mode]'); if (md) { m.setMode(md.dataset.mode); return this.renderMount(); }
      if (e.target.id === 'mConnect') { try { m.connected ? await m.disconnect() : await m.connect(c.transport); } catch (err) { toast(err.message, 'err'); } return this.renderMount(); }
      if (e.target.id === 'mSky') { this.app.scene.setMode('sky'); return this.renderMount(); }
      if (e.target.id === 'mForecast') return this.runStreaks();
      const sid = e.target.closest('[data-sel-i]'); if (sid) this.app.select({ kind: 'sat', obj: this.app.catalog.objects[Number(sid.dataset.selI)] });
    };
    this.body.oninput = (e) => {
      const man = e.target.closest('[data-man]');
      if (man) { m.manual[man.dataset.man] = Number(man.value); const l = $(man.dataset.man === 'az' ? '#mzA' : '#mzE'); if (l) l.textContent = man.value; }
    };
    this.body.onchange = (e) => {
      const k = e.target.dataset.cfg; if (!k) return;
      if (e.target.type === 'number') {
        const v = Number(e.target.value);
        if (e.target.value.trim() === '' || !Number.isFinite(v)) { e.target.value = c[k]; return; }
        const lo = e.target.min !== '' ? Number(e.target.min) : -Infinity, hi = e.target.max !== '' ? Number(e.target.max) : Infinity;
        c[k] = Math.min(hi, Math.max(lo, v));
        e.target.value = c[k];
      } else c[k] = e.target.value.trim();
      m.save();
    };
  }

  updateMountLive() {
    const app = this.app, m = app.mount, s = app.state;
    const cmd = $('#mCmd'); if (!cmd) return;
    cmd.textContent = `${fmt.deg(m.cmd.az, 2)} / ${fmt.deg(m.cmd.el, 2)}`;
    $('#mAct').textContent = `${fmt.deg(m.act.az, 2)} / ${fmt.deg(m.act.el, 2)}`;
    $('#mInfo').textContent = `${m.goalLabel} · pointing error ${fmt.deg(m.pointingError, 2)}${m.connected ? ` · ${fmt.int(m.sent)} commands sent` : ''}${m.flags.length ? ` · ⚠ ${m.flags.join(', ')}` : ''}`;
    const host = $('#mInView');
    if (!host || !s) return;
    const b = enuDir(m.act.az, m.act.el), ch = Math.cos((m.cfg.fov / 2) * DEG);
    const hits = [];
    for (let i = 0; i < s.n; i++) {
      if (!(s.el[i] > 0)) continue;
      const d = enuDir(s.az[i], s.el[i]);
      const c = d[0] * b[0] + d[1] * b[1] + d[2] * b[2];
      if (c >= ch) hits.push([i, Math.acos(Math.min(1, c)) / DEG]);
    }
    hits.sort((x, y) => x[1] - y[1]);
    const key = `${hits.slice(0, 8).map(([i]) => i).join(',')}|${hits.length}`;
    if (key === this.mInViewKey) return;
    this.mInViewKey = key;
    host.innerHTML = hits.length ? hits.slice(0, 8).map(([i, sep]) => { const o = app.catalog.objects[i]; return `<div class="row cols" data-sel-i="${i}"><div class="t">${esc(o.name)}</div><div class="r">${fmt.deg(sep, 1)} off-axis${s.st[i] === 2 && Number.isFinite(s.mag[i]) ? ` · ≈${s.mag[i].toFixed(1)}` : ' · dark'}</div></div>`; }).join('') + (hits.length > 8 ? `<div class="note">+${hits.length - 8} more</div>` : '')
      : '<div class="empty">No catalogued object inside the field of view.</div>';
  }

  async runStreaks() {
    const app = this.app, m = app.mount, host = $('#mStreaks');
    host.innerHTML = '<div class="empty">Propagating…</div>';
    const target = m.cfg.mode === 'track' && app.selection?.kind === 'sat' ? app.selection.obj.i : null;
    try {
      const r = await app.fovForecast({ az: m.act.az, el: m.act.el, half: m.cfg.fov / 2, T: m.cfg.exposure, target });
      const lit = r.crossings.filter((x) => x.lit);
      host.innerHTML = `<p class="note">${fmt.int(r.crossings.length)} objects cross the ${m.cfg.fov}° field during the next ${m.cfg.exposure} s${target != null ? ' (tracking the target)' : ''}; ${fmt.int(lit.length)} are sunlit and would leave a streak.</p>`
        + lit.slice(0, 10).map((x) => { const o = app.catalog.objects[x.i]; return `<div class="row cols" data-sel-i="${x.i}"><div><div class="t">${esc(o.name)}</div><div class="m">+${((x.enter - app.clock.now()) / 1000).toFixed(0)} s → +${((x.exit - app.clock.now()) / 1000).toFixed(0)} s · ${fmt.km(x.range)}</div></div><div class="r">≈ ${x.mag.toFixed(1)}</div></div>`; }).join('');
    } catch (e) { host.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  /* ═════════════════════ Search ═════════════════════ */
  renderSearch() {
    this.body.innerHTML = `<div class="search-box"><svg viewBox="0 0 20 20"><circle cx="8.8" cy="8.8" r="5.6"/><path d="m13 13 4.6 4.6"/></svg><input id="q" placeholder="Name, NORAD ID or COSPAR ID (e.g. ISS, 25544, 1998-067A)" value="${esc(this.searchQ)}" autocomplete="off"></div>
      <div class="list" id="qLocal"></div>
      <div class="section"><div class="section-title">Not loaded? Search the full catalogue <span class="src">TLE API · api.nasa.gov listing</span></div>
        <button class="btn" id="qRemote">Search TLE API</button><div class="list" id="qRemoteList"></div></div>`;
    const q = $('#q');
    q.focus();
    q.oninput = () => { this.searchQ = q.value; this.searchLocal(); };
    q.onkeydown = (e) => { if (e.key === 'Enter') { const first = $('#qLocal [data-sel-i]'); if (first) first.click(); else this.searchRemote(); } };
    $('#qRemote').onclick = () => this.searchRemote();
    this.body.onclick = async (e) => {
      const s = e.target.closest('[data-sel-i]'); if (s) { const o = this.app.catalog.objects[Number(s.dataset.selI)]; this.app.focus({ kind: 'sat', obj: o }); return; }
      const add = e.target.closest('[data-add]'); if (add) {
        const m = this.remote?.[Number(add.dataset.add)];
        if (!m) return;
        const existing = this.app.catalog.byId.get(m.satelliteId);
        const obj = existing || this.app.makeObject({ id: m.satelliteId, name: m.name, cospar: '', cat: 'custom', tle: [m.line1, m.line2] });
        if (!existing) this.app.addObjects([obj]);
        this.app.focus({ kind: 'sat', obj: this.app.catalog.byId.get(m.satelliteId) || obj });
        this.renderRemote();
      }
    };
    this.searchLocal();
    this.renderRemote();
  }
  renderRemote() {
    const host = $('#qRemoteList'); if (!host || !this.remote) return;
    host.innerHTML = this.remote.length ? this.remote.map((m, i) => `<div class="row cols"><div><div class="t">${esc(m.name)}</div><div class="m">NORAD ${m.satelliteId} · elements ${fmt.age(Date.parse(m.date))}</div></div><div class="r"><button class="btn small" data-add="${i}">${this.app.catalog.byId.has(m.satelliteId) ? 'Show' : 'Add'}</button></div></div>`).join('')
      : '<div class="empty">No matches.</div>';
  }
  searchLocal() {
    const host = $('#qLocal'); if (!host) return;
    const q = this.searchQ.trim().toUpperCase();
    if (!q) { host.innerHTML = '<p class="note">Press / anywhere to search.</p>'; return; }
    const out = [];
    for (const o of this.app.catalog.objects) {
      if (String(o.id) === q || (o.cospar && o.cospar.toUpperCase() === q) || o.name.toUpperCase().includes(q)) out.push(o);
      if (out.length >= 60) break;
    }
    out.sort((a, b) => (a.name.toUpperCase().startsWith(q) ? 0 : 1) - (b.name.toUpperCase().startsWith(q) ? 0 : 1) || a.name.length - b.name.length);
    host.innerHTML = out.length ? out.map((o) => `<div class="row cols" data-sel-i="${o.i}"><div><div class="t"><span class="sw" style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:${CATEGORIES[o.cat].color}"></span>${esc(o.name)}</div><div class="m">NORAD ${o.id}${o.cospar ? ` · ${esc(o.cospar)}` : ''} · ${CATEGORIES[o.cat].short}</div></div><div class="r">${Number.isFinite(o.epoch) ? fmt.age(o.epoch) : ''}</div></div>`).join('')
      : '<div class="empty">Not in the loaded catalogue — try the TLE API below.</div>';
  }
  async searchRemote() {
    const host = $('#qRemoteList'), q = this.searchQ.trim();
    if (q.length < 2) return toast('Type at least two characters.', 'warn');
    host.innerHTML = '<div class="empty">Searching…</div>';
    try {
      const { data } = await api(`/api/tle/search?q=${encodeURIComponent(q)}`);
      feeds.define('tle-api', 'TLE API (api.nasa.gov listing)', 'tle.ivanstanojevic.me'); feeds.ok('tle-api', null, `"${q}": ${data.totalItems} results`);
      this.remote = data.member || [];
      this.renderRemote();
    } catch (e) { host.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
}

const lifetimeAt = (h) => lifetimeYears(h, h);

function compass(az) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8]; }
function gcKm(la1, lo1, la2, lo2) {
  const a = la1 * DEG, b = la2 * DEG, d = (lo2 - lo1) * DEG;
  return 6371 * Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d)));
}
function flareClass(f) {
  const cls = f >= 1e-4 ? ['X', 1e-4] : f >= 1e-5 ? ['M', 1e-5] : f >= 1e-6 ? ['C', 1e-6] : f >= 1e-7 ? ['B', 1e-7] : ['A', 1e-8];
  return `${cls[0]}${(Math.floor((f / cls[1]) * 10) / 10).toFixed(1)}`;
}
