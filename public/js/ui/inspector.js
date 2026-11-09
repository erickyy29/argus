/* Right panel: details for the selected satellite, asteroid, Moon, natural event or Earth location. */
import { $, $$, esc, fmt, api, toast } from '../lib/util.js';
import { CATEGORIES, EONET_COLORS, PC_RED, PC_AMBER } from '../lib/config.js';
import { orbitFromMeanMotion, regime, moonInfo, bodyHorizon, gstime, LD_KM, AU_KM, RE, DEG } from '../lib/astro.js';
import { lifetimeYears, formatLifetime, BALLISTIC } from '../lib/lifetime.js';
import { sizeComparison } from '../data/neo.js';
import { drawChart, skyPlot } from './charts.js';
import * as Astro from 'astronomy-engine';

const TYPE = { PAY: 'Payload', 'R/B': 'Rocket body', DEB: 'Debris', UNK: 'Unknown' };
const OPS = { '+': 'Operational', '-': 'Non-operational', P: 'Partially operational', B: 'Backup', S: 'Spare', X: 'Extended mission', D: 'Decayed', '?': 'Unknown' };
const pcCls = (p) => (p >= PC_RED ? 'p4' : p >= PC_AMBER ? 'p5' : 'p6');
const kv = (rows) => `<div class="kv">${rows.filter(Boolean).map(([k, v, id]) => `<div class="k">${k}</div><div class="v"${id ? ` id="${id}"` : ''}>${v}</div>`).join('')}</div>`;
const compass = (az) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16];

export class Inspector {
  constructor(app) {
    this.app = app;
    this.el = $('#inspector');
    this.tab = 'overview';
    this.sel = null;
    this.cache = new Map();
    app.bus.on('neo:refined', (o) => { if (this.sel?.obj === o) this.render(); });
    app.bus.on('neo:elements', (o) => { if (this.sel?.obj === o) this.render(); });
  }

  show(sel) {
    const prev = this.sel;
    this.sel = sel;
    if (!sel) { this.el.classList.add('hidden'); document.body.classList.remove('inspector-open'); return; }
    if (!prev || prev.kind !== sel.kind) this.tab = 'overview';
    this.el.classList.remove('hidden');
    document.body.classList.add('inspector-open');
    this.render();
  }

  tabsFor(kind) {
    return {
      sat: [['overview', 'Overview'], ['orbit', 'Orbit'], ['risk', 'Conjunctions'], ['passes', 'Passes'], ['imagery', 'Imagery'], ['data', 'Data']],
      neo: [['overview', 'Overview'], ['approach', 'Approach'], ['orbit', 'Orbit'], ['imagery', 'Imagery']],
      moon: [['overview', 'Overview'], ['imagery', 'Imagery']],
      event: [['overview', 'Overview'], ['imagery', 'Imagery']],
      earth: [['overview', 'Location']],
    }[kind];
  }

  render() {
    const s = this.sel; if (!s) return;
    const head = this.header(s);
    const tabs = this.tabsFor(s.kind);
    if (!tabs.some(([k]) => k === this.tab)) this.tab = tabs[0][0];
    this.el.innerHTML = `<div class="insp-head">${head}</div>
      ${tabs.length > 1 ? `<div class="insp-tabs">${tabs.map(([k, l]) => `<button data-itab="${k}" class="${k === this.tab ? 'active' : ''}">${l}</button>`).join('')}</div>` : ''}
      <div class="insp-body" id="inspBody"></div>`;
    this.el.onclick = (e) => this.onClick(e);
    this.renderBody();
  }

  header(s) {
    const close = '<button class="icon-btn" data-act="close" title="Close (Esc)"><svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button>';
    const track = '<button class="btn small" data-act="track"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.4"/><circle cx="10" cy="10" r="1.2" class="fill"/></svg>Track with mount</button>';
    const focus = '<button class="btn small" data-act="focus">Focus camera</button>';
    if (s.kind === 'sat') {
      const o = s.obj, cat = CATEGORIES[o.cat];
      const orb = orbitFromMeanMotion(o.n, o.e);
      const ageH = (this.app.clock.now() - o.epoch) / 3600e3;
      return `<div class="insp-title"><h2>${esc(o.name)}</h2>${close}</div>
        <div class="insp-sub">NORAD ${o.id}${o.cospar ? ` · ${esc(o.cospar)}` : ''}${o.owner ? ` · ${esc(o.owner)}` : ''}</div>
        <div class="insp-badges"><span class="badge"><span class="sw" style="background:${cat.color}"></span>${cat.short}</span>
          ${o.type ? `<span class="badge">${TYPE[o.type] || o.type}</span>` : ''}<span class="badge">${regime(orb.perigee, orb.apogee, orb.periodMin)}</span>
          <span class="badge ${ageH > 72 ? 'warn' : ''}" title="Age of the orbital elements">Elements ${fmt.age(o.epoch)}</span><span class="badge" id="iLit">—</span></div>
        <div class="insp-actions">${track}${focus}<button class="btn small" data-act="screen">Screen conjunctions</button><button class="btn small" data-act="copy">Copy elements</button></div>`;
    }
    if (s.kind === 'neo') {
      const o = s.obj;
      return `<div class="insp-title"><h2>${esc(o.fullname || o.name)}</h2>${close}</div>
        <div class="insp-sub">${o.spkid ? `SPK ${o.spkid}` : `NeoWs ${esc(o.id)}`}${o.orbit?.cls ? ` · ${esc(o.orbit.cls)}` : ''}</div>
        <div class="insp-badges">${o.pha ? '<span class="badge danger">Potentially hazardous</span>' : '<span class="badge">Near-Earth object</span>'}${o.sentry ? '<span class="badge warn">Sentry impact monitoring</span>' : ''}
          <span class="badge">~${fmt.int(o.diameterM)} m</span><span class="badge info" id="iEph">${o.hz ? 'JPL Horizons' : o.hzLoading ? 'refining…' : 'two-body'}</span></div>
        <div class="insp-actions">${o.el ? track + focus : ''}${o.jplUrl || o.spkid ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(o.jplUrl || `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${o.spkid}`)}">JPL SBDB ↗</a>` : ''}</div>`;
    }
    if (s.kind === 'moon') return `<div class="insp-title"><h2>The Moon</h2>${close}</div><div class="insp-sub">Geocentric ephemeris · astronomy-engine (VSOP87/ELP)</div><div class="insp-actions">${track}${focus}</div>`;
    if (s.kind === 'event') {
      const e = s.obj;
      return `<div class="insp-title"><h2>${esc(e.title)}</h2>${close}</div><div class="insp-sub">${esc(e.id)}</div>
        <div class="insp-badges"><span class="badge"><span class="sw" style="background:${EONET_COLORS[e.cat] || '#ccc'};border-radius:2px"></span>${esc(e.catTitle)}</span><span class="badge">${fmt.age(e.date)}</span></div>
        <div class="insp-actions"><a class="btn small" target="_blank" rel="noopener" href="https://worldview.earthdata.nasa.gov/?v=${(e.lon - 6).toFixed(2)},${(e.lat - 4).toFixed(2)},${(e.lon + 6).toFixed(2)},${(e.lat + 4).toFixed(2)}&t=${new Date(e.date).toISOString().slice(0, 10)}">Open in NASA Worldview ↗</a></div>`;
    }
    return `<div class="insp-title"><h2>${fmt.lat(s.lat)}, ${fmt.lon(s.lon)}</h2>${close}</div><div class="insp-actions"><button class="btn small primary" data-act="observer">Set observer / mount here</button></div>`;
  }

  async onClick(e) {
    const t = e.target.closest('[data-itab]');
    if (t) { this.tab = t.dataset.itab; $$('.insp-tabs button', this.el).forEach((b) => b.classList.toggle('active', b === t)); return this.renderBody(); }
    const a = e.target.closest('[data-act]');
    if (!a) {
      const enc = e.target.closest('[data-enc]');
      if (enc) { const r = this.socRows?.[Number(enc.dataset.enc)]; if (r) this.app.viewEncounter({ id1: r.id1, id2: r.id2, tca: Date.parse(r.tca), socrates: r }); }
      const pass = e.target.closest('[data-pass]');
      if (pass) { this.passIdx = Number(pass.dataset.pass); this.renderPasses(); }
      return;
    }
    const app = this.app, s = this.sel;
    switch (a.dataset.act) {
      case 'close': app.select(null); break;
      case 'track': app.mount.setMode('track'); toast(`Mount tracking ${s.kind === 'moon' ? 'the Moon' : s.obj.name}`); break;
      case 'focus': app.focus(s); break;
      case 'screen': app.drawer.open('risk'); app.drawer.risk.target = s.obj.id; app.drawer.renderScreenTarget(); app.drawer.runScreening(); break;
      case 'copy': {
        const o = s.obj;
        const txt = o.tle ? o.tle.join('\n') : JSON.stringify(o.omm, null, 1);
        try { await navigator.clipboard.writeText(txt); toast('Orbital elements copied'); } catch { toast('Clipboard unavailable', 'err'); }
        break;
      }
      case 'observer': app.setObserver({ lat: s.lat, lon: s.lon, alt: 0, name: `${fmt.lat(s.lat)} ${fmt.lon(s.lon)}` }); toast('Observer moved — look angles, passes and night-sky counts now use this site.'); break;
      default: break;
    }
  }

  renderBody() {
    const s = this.sel, body = $('#inspBody');
    if (!body) return;
    if (this.tab === 'imagery') return this.renderImagery();
    if (s.kind === 'sat') {
      if (this.tab === 'overview') body.innerHTML = this.satOverview();
      if (this.tab === 'orbit') this.satOrbit();
      if (this.tab === 'risk') this.satRisk();
      if (this.tab === 'passes') { this.passIdx = 0; this.passData = null; this.renderPasses(); }
      if (this.tab === 'data') this.satData();
    } else if (s.kind === 'neo') {
      if (this.tab === 'overview') body.innerHTML = this.neoOverview();
      if (this.tab === 'approach') this.neoApproach();
      if (this.tab === 'orbit') this.neoOrbit();
    } else if (s.kind === 'moon') body.innerHTML = this.moonOverview();
    else if (s.kind === 'event') body.innerHTML = this.eventOverview();
    else body.innerHTML = this.earthOverview();
    this.tick(this.app.clock.now());
  }

  /* live refresh (4 Hz) */
  tick(t) {
    const s = this.sel; if (!s || this.tab !== 'overview') return;
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    if (s.kind === 'sat') {
      const st = this.app.satState(s.obj, t);
      if (!st) { set('iAlt', 'propagation failed (decayed or invalid elements)'); return; }
      set('iAlt', `${fmt.num(st.alt, 1)} km`);
      set('iSpd', `${fmt.num(st.speed, 3)} km/s <small>(${fmt.int(st.speed * 3600)} km/h)</small>`);
      set('iSub', `${fmt.lat(st.lat)}, ${fmt.lon(st.lon)}`);
      set('iGeo', fmt.km(st.r));
      set('iLook', `${fmt.deg(st.az, 1)} ${compass(st.az)} / ${fmt.deg(st.el, 1)}${st.el < 0 ? ' <small>below horizon</small>' : ''}`);
      set('iRange', `${fmt.km(st.range)} <small>${st.rangeRate >= 0 ? 'receding' : 'approaching'} ${fmt.num(Math.abs(st.rangeRate), 2)} km/s</small>`);
      const dark = (this.app.state?.sunEl ?? 0) < -6;
      set('iVis', st.lit ? (st.el > 0 ? `≈ mag ${fmt.num(st.mag, 1)} ${!dark ? '<small>· sky too bright</small>' : st.el <= 10 ? '<small>· low on the horizon</small>' : st.mag <= 6 ? '<small>· naked-eye now</small>' : '<small>· binoculars / telescope</small>'}` : 'Sunlit, below horizon') : 'In Earth\'s shadow');
      const b = document.getElementById('iLit'); if (b) { b.textContent = st.lit ? 'Sunlit' : 'In shadow'; b.className = `badge ${st.lit ? 'warn' : ''}`; }
      if (s.obj.id === 25544 && this.app.issCheck) set('iIss', `${fmt.km(this.app.issCheck.delta)} <small>vs wheretheiss.at, ${fmt.age(this.app.issCheck.at)}</small>`);
    } else if (s.kind === 'neo') {
      const o = s.obj, n = this.app.neo.stateAt(o, t);
      if (!n) return;
      const look = this.app.observer.lookEci(n.eci, gstime(new Date(t)));
      const n2 = this.app.neo.stateAt(o, t + 60e3);
      set('nDist', `${fmt.km(n.dKm)}<br><small>${fmt.ld(n.dKm)} · ${fmt.au(n.dKm)}</small>`);
      set('nRate', n2 ? `${fmt.num((n2.dKm - n.dKm) / 60, 2)} km/s <small>${n2.dKm > n.dKm ? 'receding' : 'approaching'}</small>` : '—');
      set('nLook', `${fmt.deg(look.az, 1)} ${compass(look.az)} / ${fmt.deg(look.el, 1)}${look.el < 0 ? ' <small>below horizon</small>' : ''}`);
      set('nMag', Number.isFinite(n.mag) ? `≈ ${fmt.num(n.mag, 1)} <small>${n.mag < 6 ? 'naked eye' : n.mag < 12 ? 'binoculars / small telescope' : n.mag < 20 ? 'large amateur telescope' : 'survey telescopes only'}</small>` : '—');
      set('nLight', `${fmt.num(n.dKm / 299792.458, 1)} s`);
      set('nSrc', `${n.source}${o.hz ? '' : o.hzLoading ? ' <small>(refining with Horizons…)</small>' : ''}`);
    } else if (s.kind === 'moon') {
      const m = moonInfo(t, this.app.observer);
      set('mDist', `${fmt.km(m.dist)} <small>${fmt.num(m.dist / RE, 1)} Earth radii</small>`);
      set('mPhase', `${m.name} · ${fmt.pct(m.illum, 0)} illuminated`);
      set('mLook', `${fmt.deg(m.az, 1)} ${compass(m.az)} / ${fmt.deg(m.el, 1)}`);
      set('mMag', fmt.num(m.mag, 1));
    }
  }

  /* ── satellites ── */
  satOverview() {
    const o = this.sel.obj, orb = orbitFromMeanMotion(o.n, o.e);
    const B = BALLISTIC[o.type] ?? (o.catId === 'debris' ? BALLISTIC.DEB : BALLISTIC.PAY);
    const life = orb.perigee < 2000 ? lifetimeYears(orb.perigee, orb.apogee, B) : Infinity;
    const ecc = orb.apogee - orb.perigee > 2000;
    const rcsClass = !Number.isFinite(o.rcs) ? 'not published' : o.rcs < 0.1 ? 'small (< 0.1 m²)' : o.rcs < 1 ? 'medium (0.1–1 m²)' : 'large (> 1 m²)';
    let comply = '';
    if (Number.isFinite(life)) comply = life <= 5 ? '<span class="badge ok">re-enters within 5 yr</span>' : life <= 25 ? '<span class="badge warn">5–25 yr without manoeuvre</span>' : '<span class="badge danger">&gt; 25 yr unless de-orbited</span>';
    return `<div class="section"><div class="section-title">Live state <span class="src">SGP4</span></div>
      ${kv([['Altitude', '—', 'iAlt'], ['Speed', '—', 'iSpd'], ['Sub-satellite point', '—', 'iSub'], ['Geocentric distance', '—', 'iGeo'],
        ['Az / El from observer', '—', 'iLook'], ['Range', '—', 'iRange'], ['Brightness', '—', 'iVis'], o.id === 25544 ? ['Independent check', '—', 'iIss'] : null])}</div>
      <div class="section"><div class="section-title">Size & identity <span class="src">CelesTrak SATCAT</span></div>
      ${kv([['Object type', esc(TYPE[o.type] || o.type || '—')], ['Owner', esc(o.owner || '—')], ['Launch date', esc(o.launch || '—')],
        ['Radar cross-section', Number.isFinite(o.rcs) ? `${fmt.num(o.rcs, 2)} m² <small>${rcsClass}</small>` : rcsClass],
        ['Hard-body radius used', `${fmt.num(o.hbr, 1)} m <small>for Max Pc</small>`],
        ['Natural decay', Number.isFinite(life) ? `≈ ${formatLifetime(life)}<br>${comply}${ecc ? '<br><small>highly eccentric orbit: luni-solar perturbations make this very uncertain</small>' : ''}` : 'perigee above 2,000 km: no meaningful drag decay']])}
      <p class="note">Natural decay is an order-of-magnitude estimate (nominal area-to-mass ratio for a ${esc(TYPE[o.type] || 'payload').toLowerCase()}, moderate solar activity).</p></div>`;
  }

  satOrbit() {
    const o = this.sel.obj, om = o.omm, orb = orbitFromMeanMotion(o.n, o.e), body = $('#inspBody');
    const rec = this.app.satrec(o);
    const el = om ? om : rec ? { INCLINATION: rec.inclo / DEG, RA_OF_ASC_NODE: rec.nodeo / DEG, ARG_OF_PERICENTER: rec.argpo / DEG, MEAN_ANOMALY: rec.mo / DEG, BSTAR: rec.bstar } : {};
    body.innerHTML = `<div class="section"><div class="section-title">Orbital elements <span class="src">${om ? 'CelesTrak GP (OMM, TEME)' : 'TLE'}</span></div>
      ${kv([['Epoch', `${fmt.utc(o.epoch)} UTC<br><small>${fmt.age(o.epoch)}</small>`], ['Regime', regime(orb.perigee, orb.apogee, orb.periodMin)],
        ['Period', `${fmt.num(orb.periodMin, 2)} min`], ['Semi-major axis', `${fmt.num(orb.a, 1)} km`], ['Apogee altitude', `${fmt.num(orb.apogee, 1)} km`], ['Perigee altitude', `${fmt.num(orb.perigee, 1)} km`],
        ['Eccentricity', fmt.num(o.e, 7)], ['Inclination', fmt.deg(el.INCLINATION, 4)], ['RAAN', fmt.deg(el.RA_OF_ASC_NODE, 4)], ['Argument of perigee', fmt.deg(el.ARG_OF_PERICENTER, 4)],
        ['Mean anomaly', fmt.deg(el.MEAN_ANOMALY, 4)], ['Mean motion', `${fmt.num(o.n, 8)} rev/day`], ['B* drag term', fmt.sci(el.BSTAR, 4)],
        om ? ['Revolution number', fmt.int(om.REV_AT_EPOCH)] : null, om ? ['Element set', fmt.int(om.ELEMENT_SET_NO)] : null])}</div>
      <div class="section"><div class="section-title">Altitude over the next 3 orbits</div><div class="chart" id="chAlt"></div></div>`;
    const t0 = this.app.clock.now(), P = orb.periodMin * 60e3, n = 180, alt = [], ts = [];
    for (let k = 0; k <= n; k++) { const t = t0 + (k / n) * 3 * P; const st = this.app.satState(o, t); ts.push(t); alt.push(st ? st.alt : NaN); }
    const lo = Math.min(...alt.filter(Number.isFinite)), hi = Math.max(...alt.filter(Number.isFinite));
    drawChart($('#chAlt'), { type: 'line', height: 140, n: n + 1, legend: false, yMax: hi + (hi - lo) * 0.1 + 1,
      series: [{ name: 'Altitude', color: CATEGORIES[o.cat].color === '#ffffff' ? '#7cc4ff' : CATEGORIES[o.cat].color, values: alt }],
      xLabel: (i) => (i % 60 === 0 ? fmt.local(ts[i]) : null), tip: (i) => `${fmt.utc(ts[i])}<br>${fmt.num(alt[i], 1)} km`, yFmt: (v) => fmt.int(v) });
  }

  async satRisk() {
    const o = this.sel.obj, body = $('#inspBody');
    body.innerHTML = `<div class="section"><div class="section-title">Conjunctions · next 7 days <span class="src">CelesTrak SOCRATES · payloads vs full catalogue</span></div><div class="list" id="iSoc"><div class="empty">Loading…</div></div></div>
      <div class="section"><div class="section-title">Local screening <span class="src">SGP4 vs ${fmt.int(this.app.catalog.objects.length)} loaded objects</span></div>
      <p class="lead">Run an independent 24 h screening from the latest elements in your browser.</p><button class="btn primary" data-act="screen">Screen ${esc(o.name)}</button></div>`;
    try {
      const { data } = await api(`/api/socrates/object/${o.id}`);
      if (this.sel?.obj !== o || this.tab !== 'risk') return;
      const now = this.app.clock.now();
      this.socRows = data.rows.filter((r) => !r.docked && Date.parse(r.tca) > now - 600e3);
      const host = $('#iSoc');
      host.innerHTML = this.socRows.length ? this.socRows.map((r, i) => {
        const other = r.id1 === o.id ? { n: r.name2, s: r.status2, t: r.type2 } : { n: r.name1, s: r.status1, t: r.type1 };
        return `<div class="row conj" data-enc="${i}" title="Replay in 3D"><div class="pc ${pcCls(r.maxProb)}">${fmt.pc(r.maxProb)}</div>
          <div style="min-width:0"><div class="t">${esc(other.n)} <span style="color:var(--text-3);font-weight:400">${esc(TYPE[other.t] || '')}${other.s ? ` [${esc(other.s)}]` : ''}</span></div>
          <div class="m">${fmt.utc(Date.parse(r.tca), false)} UTC · ${fmt.rel(Date.parse(r.tca), now)}</div></div>
          <div class="r">${fmt.km(r.rangeKm)}<br><span style="color:var(--text-3)">${fmt.speed(r.speedKms)}</span></div></div>`;
      }).join('') : `<div class="empty">No conjunctions closer than 5 km in the SOCRATES window${data.rows.some((r) => r.docked) ? ' (docked partners excluded)' : ''}.</div>`;
      if (o.type && o.type !== 'PAY') host.insertAdjacentHTML('afterbegin', '<div class="callout warn">SOCRATES only lists this object\'s encounters with active payloads. Approaches to other derelicts are not screened, so run local screening below.</div>');
    } catch (e) { const h = $('#iSoc'); if (h) h.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  async renderPasses() {
    const o = this.sel.obj, body = $('#inspBody');
    if (!this.passData) {
      body.innerHTML = '<div class="empty">Predicting passes…</div>';
      try { this.passData = await this.app.passes(o, 48, 0); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
      if (this.sel?.obj !== o || this.tab !== 'passes') return;
    }
    const P = this.passData.passes, now = this.app.clock.now();
    if (!P.length) { body.innerHTML = '<div class="empty">No passes above the horizon in the next 48 hours from this observer.</div>'; return; }
    const sel = P[this.passIdx] || P[0];
    body.innerHTML = `<div class="section"><div class="section-title">Next passes over ${esc(this.app.observer.name || 'the observer')} <span class="src">48 h</span></div>
      <canvas class="skyplot" id="iSky"></canvas>
      <p class="note" style="text-align:center">Pass ${this.passIdx + 1}: ${fmt.localFull(sel.aos)} · max ${fmt.deg(sel.maxEl, 1)} ${sel.tcaAz != null ? compass(sel.tcaAz) : ''}${sel.visible ? ` · visible, ≈ mag ${fmt.num(sel.minMag, 1)}` : ''}</p>
      <div class="list">${P.map((p, i) => `<div class="row cols ${i === this.passIdx ? 'sel' : ''}" data-pass="${i}"><div><div class="t">${fmt.localFull(p.aos)} ${p.visible ? '<span class="badge warn">visible</span>' : ''}</div>
        <div class="m">${compass(p.aosAz)} → ${p.losAz != null ? compass(p.losAz) : '…'} · ${p.los ? fmt.dur((p.los - p.aos) / 1000) : 'in progress'} · ${fmt.rel(p.aos, now)}</div></div><div class="r">${fmt.deg(p.maxEl, 0)}</div></div>`).join('')}</div>
      <p class="note">Times in your time zone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || 'local')}). “Visible” = sunlit while the sky is dark (Sun below −6°) and above 10°.</p></div>`;
    const st = this.app.satState(o, now);
    skyPlot($('#iSky'), { size: 230, tracks: [{ pts: sel.track, color: CATEGORIES[o.cat].color === '#ffffff' ? '#7cc4ff' : CATEGORIES[o.cat].color }],
      points: [st && st.el > 0 ? { az: st.az, el: st.el, color: '#fff', r: 4, label: 'now' } : null, { az: this.app.mount.act.az, el: this.app.mount.act.el, color: '#4ea8ff', ring: true, r: 6 }].filter(Boolean) });
  }

  satData() {
    const o = this.sel.obj;
    $('#inspBody').innerHTML = `<div class="section"><div class="section-title">Orbital elements as received</div><pre class="code">${esc(o.tle ? o.tle.join('\n') : JSON.stringify(o.omm, null, 1))}</pre></div>
      <div class="section"><div class="section-title">References</div><div class="list">
        <a class="row cols" target="_blank" rel="noopener" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${o.id}"><div class="t">CelesTrak SATCAT record ↗</div></a>
        <a class="row cols" target="_blank" rel="noopener" href="https://celestrak.org/NORAD/elements/gp.php?CATNR=${o.id}&FORMAT=tle"><div class="t">Latest TLE at CelesTrak ↗</div></a>
        <a class="row cols" target="_blank" rel="noopener" href="https://celestrak.org/SOCRATES/search.php?CATNR=${o.id}"><div class="t">SOCRATES search for this object ↗</div></a></div>
        <p class="note">Propagated with SGP4 (satellite.js 7.1) in the TEME frame; look angles use the WGS-84 observer and GMST.</p></div>`;
  }

  /* ── asteroids ── */
  neoOverview() {
    const o = this.sel.obj;
    const d = o.diameterM;
    return `<div class="section"><div class="section-title">Now</div>
      ${kv([['Distance from Earth', '—', 'nDist'], ['Range rate', '—', 'nRate'], ['Az / El from observer', '—', 'nLook'], ['Estimated magnitude', '—', 'nMag'], ['Light time', '—', 'nLight'], ['Ephemeris', '—', 'nSrc']])}</div>
      <div class="section"><div class="section-title">Size</div>
      ${kv([['Diameter', o.diameterMeasured ? `${fmt.int(d)} m <small>measured</small>` : `${fmt.int(o.dMinM)}–${fmt.int(o.dMaxM)} m <small>from H, albedo 0.25–0.05</small>`],
        ['Comparison', esc(sizeComparison(d)) || '—'], ['Absolute magnitude H', fmt.num(o.H, 2)], o.phys?.rot_per ? ['Rotation period', `${fmt.num(o.phys.rot_per, 3)} h`] : null])}</div>
      ${o.el ? '' : `<p class="note">${o.elError ? `Orbit unavailable: ${esc(o.elError)}` : 'Loading orbit from JPL SBDB…'}</p>`}`;
  }

  neoApproach() {
    const o = this.sel.obj, ca = o.ca, body = $('#inspBody');
    body.innerHTML = `<div class="section"><div class="section-title">Close approach <span class="src">${esc(o.source)}</span></div>
      ${ca ? kv([['Date', `${fmt.utc(ca.t, false)} UTC<br><small>${fmt.rel(ca.t, this.app.clock.now())}</small>`], ['Miss distance', `${fmt.km(ca.missKm)}<br><small>${fmt.ld(ca.missKm)} · ${fmt.au(ca.missKm)}</small>`],
        ['Relative velocity', fmt.speed(ca.vKms)], ['Orbiting body', esc(ca.body)]]) : '<div class="empty">No approach data.</div>'}</div>
      <div class="section"><div class="section-title">Distance from Earth · ±10 days</div><div class="chart" id="chNeo">${o.el ? '' : '<div class="empty">Needs the orbit…</div>'}</div>
      <p class="note">1 LD (lunar distance) = ${fmt.int(LD_KM)} km. Curve from ${o.hz ? 'JPL Horizons vectors where available, otherwise ' : ''}two-body propagation of the JPL SBDB osculating elements.</p></div>`;
    if (!o.el) return;
    const t = this.app.clock.now(), sr = this.app.neo.distanceSeries(o, t, 10, 160);
    const nowIdx = Math.round((sr.t.length - 1) / 2);
    drawChart($('#chNeo'), { type: 'line', height: 150, n: sr.t.length, legend: false, series: [{ name: 'Distance', color: o.pha ? '#ff5d5d' : '#ffb347', values: sr.d }],
      markers: [{ at: nowIdx, label: 'now', color: '#a3aec2' }, ...(ca ? [{ at: ((ca.t - sr.t[0]) / (sr.t[sr.t.length - 1] - sr.t[0])) * (sr.t.length - 1), label: 'closest', color: '#ffb347', row: 1 }] : [])],
      xLabel: (i) => (i % 40 === 0 ? new Date(sr.t[i]).toISOString().slice(5, 10) : null), yFmt: (v) => `${fmt.num(v, v < 10 ? 1 : 0)}`, tip: (i) => `${fmt.utc(sr.t[i], false)}<br>${fmt.num(sr.d[i], 2)} LD` });
  }

  neoOrbit() {
    const o = this.sel.obj, e = o.el, r = o.orbit, body = $('#inspBody');
    if (!e) { body.innerHTML = '<div class="empty">Orbit not loaded yet.</div>'; return; }
    const sig = (k) => (r.sigmas?.[k] ? ` <small>±${esc(r.sigmas[k])}</small>` : '');
    body.innerHTML = `<div class="section"><div class="section-title">Heliocentric orbit <span class="src">JPL SBDB · ecliptic J2000</span></div>
      ${kv([['Orbit class', esc(r.cls || '—')], ['Epoch', `JD ${fmt.num(r.epochJd, 1)} TDB`], ['Semi-major axis a', `${fmt.num(e.a, 6)} AU${sig('a')}`], ['Eccentricity e', `${fmt.num(e.e, 6)}${sig('e')}`],
        ['Inclination i', `${fmt.deg(e.i, 4)}${sig('i')}`], ['Ascending node Ω', fmt.deg(e.om, 4)], ['Arg. of perihelion ω', fmt.deg(e.w, 4)], ['Mean anomaly M', fmt.deg(e.ma, 4)],
        ['Perihelion q', `${fmt.num(r.q, 5)} AU`], ['Aphelion Q', `${fmt.num(r.Q, 5)} AU`], ['Period', `${fmt.num(r.periodDays, 1)} days (${fmt.num(r.periodDays / 365.25, 2)} yr)`],
        ['Earth MOID', `${fmt.num(r.moidAU, 6)} AU <small>${fmt.ld(r.moidAU * AU_KM)}</small>`], ['Observation arc', `${esc(r.firstObs || '?')} → ${esc(r.lastObs || '?')}<br><small>${fmt.int(r.arcDays)} days · ${fmt.int(r.nObs)} observations</small>`],
        ['Uncertainty U', `${esc(r.U ?? '—')} <small>0 = well determined · 9 = poorly</small>`], ['Solution', `${esc(r.solution || '—')} · ${esc(r.producer || '')}`]])}</div>`;
  }

  /* ── Moon / events / Earth ── */
  moonOverview() {
    return `<div class="section"><div class="section-title">Now</div>${kv([['Distance', '—', 'mDist'], ['Phase', '—', 'mPhase'], ['Az / El from observer', '—', 'mLook'], ['Visual magnitude', '—', 'mMag']])}
      <p class="note">Useful as a calibration target: point the mount at the Moon and adjust the azimuth offset until it is centred.</p></div>`;
  }
  eventOverview() {
    const e = this.sel.obj;
    return `<div class="section"><div class="section-title">Event <span class="src">NASA EONET</span></div>
      ${kv([['Category', esc(e.catTitle)], ['Latest observation', `${fmt.utc(e.date, false)} UTC`], ['Location', `${fmt.lat(e.lat)}, ${fmt.lon(e.lon)}`],
        Number.isFinite(e.mag) ? ['Magnitude', `${fmt.num(e.mag, 1)} ${esc(e.magUnit || '')}`] : null, ['Track points', fmt.int(e.track)]])}</div>
      <div class="section"><div class="section-title">Sources</div><div class="list">${e.sources.map((s) => `<a class="row cols" href="${esc(s.url)}" target="_blank" rel="noopener"><div class="t">${esc(s.id)} ↗</div></a>`).join('') || '<div class="empty">—</div>'}</div></div>`;
  }
  earthOverview() {
    const s = this.sel, t = this.app.clock.now();
    const obs = { ae: new Astro.Observer(s.lat, s.lon, 0) };
    const sun = bodyHorizon(Astro.Body.Sun, t, obs);
    const lst = ((t / 3600e3 + s.lon / 15) % 24 + 24) % 24;
    const near = (this.app.events || []).filter((e) => greatCircleKm(s.lat, s.lon, e.lat, e.lon) < 500);
    return `<div class="section">${kv([['Latitude', fmt.lat(s.lat)], ['Longitude', fmt.lon(s.lon)], ['Mean solar time', `${String(Math.floor(lst)).padStart(2, '0')}:${String(Math.floor((lst % 1) * 60)).padStart(2, '0')}`], ['Sun elevation', fmt.deg(sun.el, 1)], ['EONET events within 500 km', fmt.int(near.length)]])}
      <p class="note">Set this point as the observer to compute look angles, passes and night-sky impact for it — e.g. where your mount will be deployed.</p></div>`;
  }

  /* ── NASA Image and Video Library ── */
  async renderImagery() {
    const s = this.sel, body = $('#inspBody');
    const q = imageQuery(s);
    body.innerHTML = `<div class="section"><div class="section-title">NASA Image and Video Library <span class="src">“${esc(q)}”</span></div><div class="thumbs" id="iImgs"><div class="empty">Searching…</div></div></div>`;
    try {
      let r = this.cache.get(q) || (await api(`/api/images?q=${encodeURIComponent(q)}`)).data;
      if (this.sel !== s || this.tab !== 'imagery') return;
      if (!r.items.length && q !== 'satellite') r = (await api('/api/images?q=satellite')).data;
      if (this.sel !== s || this.tab !== 'imagery') return;
      this.cache.set(q, r);
      const host = $('#iImgs'); if (!host) return;
      host.innerHTML = r.items.slice(0, 12).map((it) => `<a class="thumb" href="https://images.nasa.gov/details/${encodeURIComponent(it.id)}" target="_blank" rel="noopener" title="${esc(it.description)}"><img loading="lazy" src="${esc(it.thumb)}" alt="${esc(it.title)}"><div>${esc(it.title)}</div></a>`).join('') || '<div class="empty">No images found.</div>';
    } catch (e) { if (this.sel !== s || this.tab !== 'imagery') return; const h = $('#iImgs'); if (h) h.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
}

function imageQuery(s) {
  if (s.kind === 'moon') return 'Moon lunar surface';
  if (s.kind === 'neo') return 'near-Earth asteroid';
  if (s.kind === 'event') return { wildfires: 'wildfire satellite', severeStorms: 'hurricane from space', volcanoes: 'volcano eruption from space', seaLakeIce: 'sea ice', floods: 'flooding from space', dustHaze: 'dust storm from space' }[s.obj.cat] || 'Earth from space';
  if (s.kind !== 'sat') return 'Earth from space';
  const o = s.obj, n = o.name.toUpperCase();
  if (o.id === 25544 || n.startsWith('ISS')) return 'International Space Station';
  if (o.id === 20580 || n.startsWith('HST')) return 'Hubble Space Telescope';
  if (n.startsWith('STARLINK')) return 'Starlink';
  if (/TIANHE|TIANGONG|CSS/.test(n)) return 'Tiangong space station';
  if (n.startsWith('NOAA')) return 'NOAA satellite';
  if (n.startsWith('GOES')) return 'GOES satellite';
  if (n.startsWith('LANDSAT')) return 'Landsat';
  if (n.startsWith('TDRS')) return 'TDRS satellite';
  if (/NAVSTAR|GPS/.test(n)) return 'GPS satellite';
  if (/DRAGON|CREW/.test(n)) return 'Crew Dragon';
  if (/SOYUZ/.test(n)) return 'Soyuz spacecraft';
  if (o.catId === 'debris') return 'orbital debris';
  if (o.type === 'R/B') return 'rocket upper stage';
  const word = (o.name.match(/[A-Za-z]{3,}/) || ['satellite'])[0];
  return `${word} satellite`;
}

function greatCircleKm(la1, lo1, la2, lo2) {
  const a = la1 * DEG, b = la2 * DEG, d = (lo2 - lo1) * DEG;
  return 6371 * Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d)));
}
