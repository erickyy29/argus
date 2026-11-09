/* Place search box (OpenStreetMap Nominatim via /api/geocode). Searches on submit only — Nominatim's usage
   policy forbids search-as-you-type — and also accepts raw coordinates such as "43.776, -79.258". */
import { api, esc, fmt } from '../lib/util.js';

/** "43.776, -79.258", "43.776 N 79.258 W", "43.776°N, 79.258°W" → { lat, lon } or null */
export function parseLatLon(s) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i.exec(s || '');
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[3]);
  if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /w/i.test(m[4])) lon = -Math.abs(lon);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

const OSM_CREDIT = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · search by Nominatim';

export function attachPlaceSearch({ form, input, results, app }) {
  let items = [], active = -1, lastQuery = '', seq = 0;
  const close = () => { results.classList.add('hidden'); active = -1; seq++; };
  const choose = (p) => { close(); input.value = p.name; input.blur(); app.goToPlace(p); };
  const highlight = () => results.querySelectorAll('[data-pi]').forEach((el, k) => el.classList.toggle('active', k === active));
  const render = () => {
    results.innerHTML = (items.length
      ? items.map((p, k) => `<div class="pr" data-pi="${k}"><b>${esc(p.name)}</b><small>${esc(p.label)}</small><small>${esc(p.kind)} · ${fmt.lat(p.lat)} ${fmt.lon(p.lon)}</small></div>`).join('')
      : '<div class="attr">No places found. Try adding a city, or type coordinates like 43.776, -79.258.</div>')
      + `<div class="attr">${OSM_CREDIT}</div>`;
    results.classList.remove('hidden');
    active = items.length ? 0 : -1;
    highlight();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim().replace(/\s+/g, ' ');
    if (!q) return;
    const ll = parseLatLon(q);
    if (ll) return choose({ name: `${fmt.lat(ll.lat)}, ${fmt.lon(ll.lon)}`, label: 'Coordinates', lat: ll.lat, lon: ll.lon });
    if (q === lastQuery && items.length && !results.classList.contains('hidden')) return choose(items[Math.max(0, active)]);
    const my = ++seq;
    items = []; lastQuery = '';   // the old list is gone from view, so Enter must not pick from it
    results.innerHTML = '<div class="attr">Searching OpenStreetMap…</div>';
    results.classList.remove('hidden');
    try {
      // normalised so identical searches share one cache entry (server and CDN)
      const { data } = await api(`/api/geocode?q=${encodeURIComponent(q.toLowerCase())}`, { timeout: 25_000 });
      if (my !== seq || input.value.trim().replace(/\s+/g, ' ') !== q) return;   // superseded or dismissed
      items = data.results || [];
      lastQuery = q;
      render();
    } catch (err) {
      if (my !== seq) return;
      items = [];
      results.innerHTML = `<div class="attr">Search failed: ${esc(err.message)}</div>`;
    }
  });
  input.addEventListener('keydown', (e) => {
    if (results.classList.contains('hidden') || !items.length) { if (e.key === 'Escape') input.blur(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; highlight(); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('input', () => { if (input.value.trim().replace(/\s+/g, ' ') !== lastQuery) close(); });
  results.addEventListener('click', (e) => { const r = e.target.closest('[data-pi]'); if (r) choose(items[Number(r.dataset.pi)]); });
  const onDoc = (e) => {
    if (!form.isConnected) { document.removeEventListener('pointerdown', onDoc); return; }   // form was re-rendered away
    if (!form.contains(e.target)) close();
  };
  document.addEventListener('pointerdown', onDoc);
}
