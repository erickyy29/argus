/* Top bar (clock, observer, feeds), mount HUD, encounter HUD, legend and hover tooltip. */
import { $, $$, esc, fmt, feeds, toast } from '../lib/util.js';
import { CATEGORIES, NEO_COLOR, PHA_COLOR, DEFAULT_OBSERVER } from '../lib/config.js';
import { RE } from '../lib/astro.js';
import { mountDial } from './charts.js';
import { attachPlaceSearch } from './placesearch.js';

const FLAG_TEXT = { below: 'Target below the horizon — holding at the horizon on its azimuth', sun: 'Sun exclusion — refusing to point near the Sun', limit: 'Elevation limit reached' };

export class Hud {
  constructor(app) {
    this.app = app;
    $$('[data-time]').forEach((b) => b.addEventListener('click', () => {
      const c = app.clock, k = b.dataset.time;
      if (k === 'pause') c.toggle(); else if (k === 'faster') c.faster(); else if (k === 'slower') c.slower();
      else if (k === 'live') { app.closeEncounter(false); c.live(); }
    }));
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => app.scene.setMode(b.dataset.view)));
    app.bus.on('view', (m) => {
      $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === m));
      if (m === 'sky') toast('Sky view: drag to look around, scroll to zoom. Set the mount to "Follow view" and it points wherever you look.', '', 6000);
    });
    $('#resetView').addEventListener('click', () => app.scene.resetView());
    $('#observerBtn').addEventListener('click', (e) => this.observerPopover(e.currentTarget));
    $('#feedsBtn').addEventListener('click', (e) => this.feedsPopover(e.currentTarget));
    $('#mountHud').addEventListener('click', () => app.drawer.open('mount'));
    attachPlaceSearch({ form: $('#placeForm'), input: $('#placeInput'), results: $('#placeResults'), app });
    document.addEventListener('pointerdown', (e) => { const p = $('#popover'); if (!p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest('#observerBtn, #feedsBtn')) p.classList.add('hidden'); });
    feeds.onChange(() => { this.renderFeedsDot(); if (this.pop === 'feeds') this.renderFeeds(); });
    app.bus.on('observer', () => this.renderObserver());
    app.bus.on('layers', () => this.renderLegend());
    app.bus.on('options', () => this.renderLegend());
    app.bus.on('catalog', () => this.renderLegend());
    app.bus.on('encounter', () => this.renderEncounter());
    app.bus.on('risky', () => this.renderLegend());
    this.renderObserver();
    this.renderLegend();
    this.renderFeedsDot();
  }

  /* ── clock & HUDs (20 Hz) ── */
  update(t, { sunLook }) {
    const c = this.app.clock;
    $('#clockTime').textContent = fmt.hms(t);
    $('#clockDate').textContent = `${new Date(t).toISOString().slice(0, 10)} UTC · ${fmt.local(t)} local`;
    const badge = $('#modeBadge');
    const live = c.isLive;
    badge.className = `mode-badge ${live ? 'live' : 'sim'}`;
    badge.textContent = live ? 'LIVE' : c.paused ? 'PAUSED' : 'SIM';
    const dt = (t - Date.now()) / 1000;
    $('#rateLabel').textContent = c.paused ? '⏸' : `×${c.rate}`;
    $('#rateLabel').title = live ? 'Real time' : `${dt >= 0 ? '+' : '−'}${fmt.dur(Math.abs(dt))} from now`;
    $('#pauseBtn').innerHTML = c.paused ? '<svg viewBox="0 0 20 20"><path d="M7 5l8 5-8 5z"/></svg>' : '<svg viewBox="0 0 20 20"><path d="M7 5v10M13 5v10"/></svg>';
    this.renderMount(sunLook);
    if (this.app.encounter) this.updateEncounter(t);
  }

  renderMount(sun) {
    const m = this.app.mount, c = m.cfg;
    const host = $('#mountHud');
    if (!this.mountBuilt) {
      host.innerHTML = `<div class="hm-head"><span>Tracking mount</span><span class="status" id="hmStatus"><i></i><span></span></span></div>
        <div class="hm-body"><canvas id="hmDial" width="64" height="64"></canvas><div class="hm-vals" id="hmVals"></div></div><div class="warnline hidden" id="hmWarn"></div>`;
      this.mountBuilt = true;
    }
    const st = $('#hmStatus');
    const label = { sim: 'Simulator', connecting: 'Connecting…', serial: 'USB serial', ws: 'Wi-Fi' }[m.status];
    st.className = `status ${m.connected ? 'on' : m.status === 'sim' ? 'sim' : ''}`;
    st.lastElementChild.textContent = `${label} · ${c.mode === 'track' ? 'Track' : c.mode === 'view' ? 'Follow view' : c.mode[0].toUpperCase() + c.mode.slice(1)}`;
    mountDial($('#hmDial'), { act: m.act, cmd: m.cmd, size: 64, sun });
    $('#hmVals').innerHTML = `<span>AZ</span> <b>${fmt.deg(m.act.az, 1).padStart(7)}</b> &nbsp;<span>EL</span> <b>${fmt.deg(m.act.el, 1)}</b><br>
      <span>cmd ${fmt.deg(m.cmd.az, 1)} / ${fmt.deg(m.cmd.el, 1)} · err ${fmt.deg(m.pointingError, 2)}</span><br>
      <span class="hm-target">→ ${esc(m.goalLabel)}</span>`;
    const w = $('#hmWarn');
    const f = m.flags[0];
    w.classList.toggle('hidden', !f);
    if (f) w.textContent = `⚠ ${FLAG_TEXT[f]}`;
  }

  renderEncounter() {
    const e = this.app.encounter, host = $('#encounterHud');
    if (!e) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const s = e.socrates;
    const shift = s && Math.abs(e.miss - s.rangeKm) > Math.max(5, 10 * s.rangeKm);
    host.innerHTML = `<div class="eh"><span>Conjunction replay · SGP4</span><span><button class="btn small" id="encLive">Back to live</button> <button class="btn small" id="encTca">Jump to TCA</button></span></div>
      <div class="ep">${esc(e.a.name)} <span style="color:var(--text-3)">↔</span> ${esc(e.b.name)}</div>
      <div class="ev"><span>Separation <b id="encSep">—</b></span><span>TCA <b id="encT">—</b></span><span>v<sub>rel</sub> <b>${fmt.speed(e.rel)}</b></span></div>
      <div class="ev"><span>Latest elements: miss <b>${fmt.km(e.miss)}</b> at ${fmt.hms(e.tca)} UTC</span>${s ? `<span>SOCRATES: <b>${fmt.km(s.rangeKm)}</b> at ${fmt.hms(e.reportedTca)} · Max Pc <b>${fmt.pc(s.maxProb)}</b></span>` : ''}${e.local ? `<span>Max Pc <b>${fmt.pc(e.local.maxPc)}</b></span>` : ''}</div>
      <div class="ev"><span>Element age at TCA: <b>${fmt.num(e.ageA, 1)} d</b> / <b>${fmt.num(e.ageB, 1)} d</b>${s ? ` (SOCRATES run: ${fmt.num(s.dse1, 1)} d / ${fmt.num(s.dse2, 1)} d)` : ''}</span></div>
      ${shift ? '<div class="ev" style="color:var(--warn)">The latest elements move this encounter. Predictions several days out shift by tens to hundreds of km for low or manoeuvring satellites, so operators re-screen as new tracking arrives.</div>' : ''}`;
    $('#encLive').onclick = () => this.app.closeEncounter(true);
    $('#encTca').onclick = () => { this.app.clock.jump(e.tca - 20e3); this.app.clock.setRate(0.5); };
  }
  updateEncounter(t) {
    const e = this.app.encounter;
    const sep = $('#encSep'), tt = $('#encT');
    if (!sep) return;
    sep.textContent = fmt.km(e.dist(t));
    const d = (e.tca - t) / 1000;
    tt.textContent = Math.abs(d) < 0.5 ? 'now' : d > 0 ? `in ${d < 600 ? `${d.toFixed(1)} s` : fmt.dur(d)}` : `${(-d).toFixed(1)} s ago`;
  }

  /* ── legend ── */
  renderLegend() {
    const app = this.app;
    const cats = CATEGORIES.map((c, i) => ({ c, n: app.catalog.counts[i] })).filter(({ c, n }) => n && app.layers[c.id] !== false);
    const extra = [];
    if (app.options.neo) extra.push(`<span><i style="background:${NEO_COLOR}"></i>Asteroid</span><span><i style="background:${PHA_COLOR}"></i>Potentially hazardous</span>`);
    if (app.options.events) extra.push('<span><i style="background:#ff7a45;border-radius:1px"></i>EONET event</span>');
    if (app.options.risk && app.risky?.shown) extra.unshift('<span><i style="background:#ff3d4d;box-shadow:0 0 6px #ff3d4d"></i>Worst-case Pc ≥ 1e-4 · 24 h</span>');
    $('#legend').innerHTML = `<div class="lg">${cats.map(({ c }) => `<span><i style="background:${c.color}"></i>${c.short}</span>`).join('')}${extra.join('')}<span><i style="background:#4ea8ff"></i>Mount</span></div>
      <div class="credit">CelesTrak · NASA NeoWs · EONET · GIBS · Image Library · EPIC · JPL SSD/CNEOS · NOAA SWPC${app.options.neo && app.options.neoScale !== 'true' ? ' · distances beyond the Moon are log-compressed' : ''}</div>`;
  }

  /* ── tooltip ── */
  tooltip(hit, x, y) {
    const tip = $('#tooltip');
    if (!hit) { tip.classList.add('hidden'); return; }
    const app = this.app;
    let title = '', meta = '';
    if (hit.kind === 'sat') {
      const o = app.catalog.objects[hit.i], s = app.state;
      title = o.name;
      const k = hit.i * 3, p = app.scene.sat.pos;
      const alt = Math.hypot(p[k], p[k + 1], p[k + 2]) * RE - RE;
      const parts = [CATEGORIES[o.cat].short, `${fmt.int(alt)} km`];
      if (s && s.el[hit.i] > 0) parts.push(`el ${fmt.deg(s.el[hit.i], 0)}`);
      if (s && Number.isFinite(s.mag[hit.i]) && s.el[hit.i] > 0) parts.push(`≈ mag ${s.mag[hit.i].toFixed(1)}`);
      if (s && s.st[hit.i] === 1) parts.push('in shadow');
      meta = parts.join(' · ');
    } else if (hit.kind === 'neo') {
      const o = app.neo.list[hit.i];
      title = o.name;
      meta = [o.pha ? 'PHA' : 'NEO', o.now ? fmt.ld(o.now.dKm) : '', o.diameterM ? `~${fmt.int(o.diameterM)} m` : ''].filter(Boolean).join(' · ');
    } else if (hit.kind === 'moon') { title = 'Moon'; meta = 'Click for phase, distance and pointing'; }
    else if (hit.kind === 'event') { const e = app.events[hit.i]; title = e.title; meta = `${e.catTitle} · ${fmt.age(e.date)}`; }
    else if (hit.kind === 'conj') {
      const c = app.placeConj?.list?.[hit.i];
      if (!c) { tip.classList.add('hidden'); return; }
      title = `${c.n1} ↔ ${c.n2}`;
      meta = `${fmt.rel(c.t, app.clock.now())} · miss ${fmt.km(c.range)} · Max Pc ${fmt.pc(c.prob)} · ${fmt.deg(c.el, 0)} up · click to replay`;
    }
    tip.innerHTML = `<div class="tt">${esc(title)}</div><div class="tm">${esc(meta)}</div>`;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    tip.classList.remove('hidden');
  }

  /* ── observer ── */
  renderObserver() {
    const o = this.app.observer;
    $('#observerLabel').textContent = `${fmt.lat(o.lat)}  ${fmt.lon(o.lon)}`;
    $('#observerBtn').title = `Observer / mount: ${o.name || 'custom'} — click to change`;
  }
  place(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 348, r.right - 340))}px`;
    pop.classList.remove('hidden');
  }
  observerPopover(anchor) {
    const pop = $('#popover'), o = this.app.observer;
    if (this.pop === 'obs' && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
    this.pop = 'obs';
    pop.innerHTML = `<h3>Observer & mount location</h3><p class="note" style="margin:0 0 10px">Look angles, passes, night-sky counts and mount pointing are computed for this site.</p>
      <div class="field"><label>Name</label><input id="obName" value="${esc(o.name)}"></div>
      <div class="field-row three"><div class="field"><label>Latitude °</label><input id="obLat" type="number" step="0.0001" value="${o.lat.toFixed(4)}"></div>
      <div class="field"><label>Longitude °</label><input id="obLon" type="number" step="0.0001" value="${o.lon.toFixed(4)}"></div>
      <div class="field"><label>Altitude m</label><input id="obAlt" type="number" step="1" value="${Math.round(o.alt * 1000)}"></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn primary" id="obSave">Save</button><button class="btn" id="obGeo">Use my location</button><button class="btn" id="obKsc">Kennedy Space Center</button></div>
      <p class="note">Tip: click anywhere on the globe and choose “Set observer here”.</p>`;
    this.place(pop, anchor);
    const set = (v) => { this.app.setObserver(v); pop.classList.add('hidden'); toast(`Observer set to ${v.name || `${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}`}`); };
    $('#obSave').onclick = () => {
      const lat = parseFloat($('#obLat').value), lon = parseFloat($('#obLon').value), alt = (parseFloat($('#obAlt').value) || 0) / 1000;
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return toast('Latitude must be within ±90° and longitude within ±180°.', 'err');
      set({ lat, lon, alt, name: $('#obName').value.trim() });
    };
    $('#obKsc').onclick = () => set({ ...DEFAULT_OBSERVER, name: 'Kennedy Space Center' });
    $('#obGeo').onclick = () => {
      if (!navigator.geolocation) return toast('Geolocation is not available in this browser.', 'err');
      navigator.geolocation.getCurrentPosition((p) => set({ lat: p.coords.latitude, lon: p.coords.longitude, alt: (p.coords.altitude || 0) / 1000, name: 'My location' }),
        (e) => toast(`Location unavailable: ${e.message}`, 'err'), { timeout: 10000 });
    };
  }

  /* ── feeds ── */
  renderFeedsDot() {
    const list = feeds.list();
    const bad = list.filter((f) => f.status === 'err').length, warn = list.filter((f) => f.status === 'warn').length, ok = list.filter((f) => f.status === 'ok').length;
    $('#feedsDot').className = `dot ${bad ? 'err' : warn ? 'warn' : ok ? 'ok' : ''}`;
    $('#feedsLabel').textContent = `${ok}/${list.length} feeds`;
  }
  feedsPopover(anchor) {
    const pop = $('#popover');
    if (this.pop === 'feeds' && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
    this.pop = 'feeds';
    this.renderFeeds();
    this.place(pop, anchor);
  }
  renderFeeds() {
    const pop = $('#popover');
    const rows = feeds.list().map((f) => `<div class="feed"><i class="${f.status === 'ok' ? 'ok' : f.status === 'err' ? 'err' : f.status === 'warn' ? 'warn' : ''}"></i>
      <div>${esc(f.label)}<small>${esc(f.msg || f.source)}</small></div><div class="r">${f.at ? fmt.age(f.at) : f.status === 'pending' ? 'loading' : ''}</div></div>`).join('');
    pop.innerHTML = `<h3>Live data feeds</h3><p class="note" style="margin:0 0 6px">Cached by the local server and refreshed on each publisher's cadence; the last good copy is used if a source is down.</p>${rows}`;
  }
}
