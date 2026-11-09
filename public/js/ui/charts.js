/* Lightweight canvas charts (stacked area / bars / lines, sky plots) with hover read-outs. */
import { fmt } from '../lib/util.js';

const GRID = 'rgba(148,163,184,0.12)', AXIS = '#6b778e', TEXT = '#a3aec2';
const FONT = '10.5px "JetBrains Mono", ui-monospace, monospace';

function prep(canvas, height) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, canvas.parentElement?.clientWidth || canvas.clientWidth || 340);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr);
  canvas.style.width = `${w}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  return { ctx, w, h: height };
}

export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const short = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : fmt.num(v, v < 10 && v % 1 ? 1 : 0));

/**
 * opts: { type: 'area'|'bar'|'line', height, n, series:[{name,color,values}], stacked, yFmt, xLabel(i)->str|null,
 *         markers:[{at,label,color}], bands:[{from,to,color}], tip(i)->html, yMax, logY }
 */
export function drawChart(host, opts) {
  let canvas = host.querySelector('canvas');
  if (!canvas) { canvas = document.createElement('canvas'); host.appendChild(canvas); }
  const H = opts.height || 150;
  const { ctx, w } = prep(canvas, H);
  const n = opts.n ?? opts.series[0]?.values.length ?? 0;
  if (!n) return;
  const pad = { l: 40, r: 8, t: 8, b: 20 };
  const iw = w - pad.l - pad.r, ih = H - pad.t - pad.b;
  const stacked = opts.stacked !== false && opts.type !== 'line';
  const totals = new Array(n).fill(0);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const se of opts.series) { const v = se.values[i] || 0; s = stacked ? s + v : Math.max(s, v); }
    totals[i] = s; if (s > max) max = s;
  }
  const yMax = opts.yMax ?? niceMax(max * 1.04);
  const X = (i) => pad.l + (opts.type === 'bar' ? (i + 0.5) * (iw / n) : (n === 1 ? iw / 2 : (i / (n - 1)) * iw));
  const Y = (v) => pad.t + ih - (v / yMax) * ih;

  for (const b of opts.bands || []) {
    ctx.fillStyle = b.color;
    const x0 = opts.type === 'bar' ? pad.l + b.from * (iw / n) : X(b.from), x1 = opts.type === 'bar' ? pad.l + (b.to + 1) * (iw / n) : X(b.to);
    ctx.fillRect(x0, pad.t, Math.max(1, x1 - x0), ih);
  }
  ctx.font = FONT; ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4, y = Y(v);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y) + 0.5); ctx.lineTo(w - pad.r, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = AXIS; ctx.textAlign = 'right'; ctx.fillText(opts.yFmt ? opts.yFmt(v) : short(v), pad.l - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i < n; i++) { const lab = opts.xLabel?.(i); if (lab) { ctx.fillStyle = AXIS; ctx.fillText(lab, X(i), H - pad.b + 5); } }

  const base = new Array(n).fill(0);
  for (const se of opts.series) {
    ctx.fillStyle = se.color; ctx.strokeStyle = se.color;
    if (opts.type === 'bar') {
      const bw = Math.max(1, (iw / n) * 0.78);
      for (let i = 0; i < n; i++) {
        const v = se.values[i] || 0; if (!v) continue;
        const y0 = Y(base[i]), y1 = Y(base[i] + v);
        ctx.globalAlpha = 0.9; ctx.fillRect(X(i) - bw / 2, y1, bw, y0 - y1); ctx.globalAlpha = 1;
        if (stacked) base[i] += v;
      }
    } else if (opts.type === 'area') {
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const y = Y(base[i] + (se.values[i] || 0)); i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); }
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), Y(base[i]));
      ctx.closePath(); ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const y = Y(base[i] + (se.values[i] || 0)); i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); }
      ctx.lineWidth = 1.4; ctx.stroke();
      for (let i = 0; i < n; i++) base[i] += se.values[i] || 0;
    } else {
      ctx.beginPath(); let started = false;
      for (let i = 0; i < n; i++) {
        const v = se.values[i]; if (!Number.isFinite(v)) { started = false; continue; }
        const y = Y(v); started ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); started = true;
      }
      ctx.lineWidth = se.width || 1.8; ctx.setLineDash(se.dash || []); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  for (const m of opts.markers || []) {
    const x = opts.type === 'bar' ? pad.l + m.at * (iw / n) : pad.l + (m.at / Math.max(1, n - 1)) * iw;
    ctx.strokeStyle = m.color || '#fff'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, pad.t); ctx.lineTo(x + 0.5, pad.t + ih); ctx.stroke(); ctx.setLineDash([]);
    if (m.label) { ctx.fillStyle = m.color || TEXT; ctx.textAlign = x > w - 90 ? 'right' : 'left'; ctx.textBaseline = 'top'; ctx.fillText(m.label, x + (x > w - 90 ? -4 : 4), pad.t + 2 + (m.row || 0) * 12); }
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.3)'; ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ih + 0.5); ctx.lineTo(w - pad.r, pad.t + ih + 0.5); ctx.stroke();

  // legend
  let lg = host.querySelector('.chart-legend');
  if (opts.legend !== false && opts.series.length > 1) {
    if (!lg) { lg = document.createElement('div'); lg.className = 'chart-legend'; host.appendChild(lg); }
    lg.innerHTML = opts.series.map((s) => `<span style="--c:${s.color}">${s.name}</span>`).join('');
  }
  // hover read-out
  if (opts.tip) {
    host.style.position = 'relative';
    let tip = host.querySelector('.chart-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip hidden'; host.appendChild(tip); }
    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left;
      if (x < pad.l || x > w - pad.r) { tip.classList.add('hidden'); return; }
      const i = opts.type === 'bar' ? Math.floor(((x - pad.l) / iw) * n) : Math.round(((x - pad.l) / iw) * (n - 1));
      if (i < 0 || i >= n) return;
      tip.innerHTML = opts.tip(i);
      tip.classList.remove('hidden');
      tip.style.left = `${Math.min(Math.max(X(i), 70), w - 70)}px`;
      tip.style.top = `${Math.max(Y(totals[i]), 30)}px`;
    };
    canvas.onmouseleave = () => tip.classList.add('hidden');
  }
}

/** Polar sky plot (zenith centre, horizon rim, north up, east right). */
export function skyPlot(canvas, { size = 220, tracks = [], points = [], fov = null }) {
  const { ctx } = prepSquare(canvas, size);
  const c = size / 2, R = size / 2 - 16;
  const P = (az, el) => { const r = ((90 - Math.max(0, el)) / 90) * R, a = (az * Math.PI) / 180; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const el of [0, 30, 60]) { ctx.beginPath(); ctx.arc(c, c, ((90 - el) / 90) * R, 0, Math.PI * 2); ctx.stroke(); }
  for (let az = 0; az < 360; az += 45) { const [x, y] = P(az, 0); ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke(); }
  ctx.font = FONT; ctx.fillStyle = AXIS; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, az]) => { const a = (az * Math.PI) / 180; ctx.fillStyle = l === 'N' ? '#ff8a8a' : AXIS; ctx.fillText(l, c + (R + 9) * Math.sin(a), c - (R + 9) * Math.cos(a)); });
  if (fov) {
    ctx.strokeStyle = 'rgba(124,196,255,0.8)'; ctx.setLineDash([3, 3]); ctx.beginPath();
    for (let k = 0; k <= 64; k++) {
      const t = (k / 64) * Math.PI * 2;
      const el = fov.el + fov.r * Math.sin(t), az = fov.az + (fov.r * Math.cos(t)) / Math.max(0.15, Math.cos((Math.min(fov.el, 85) * Math.PI) / 180));
      const [x, y] = P(az, el); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  for (const t of tracks) {
    ctx.lineWidth = t.width || 2;
    for (let k = 1; k < t.pts.length; k++) {
      const a = t.pts[k - 1], b = t.pts[k];
      if (a[1] < 0 && b[1] < 0) continue;
      ctx.strokeStyle = a[2] ? t.color : 'rgba(148,163,184,0.45)';
      const [x0, y0] = P(a[0], a[1]), [x1, y1] = P(b[0], b[1]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
  }
  for (const p of points) {
    if (p.el < -1) continue;
    const [x, y] = P(p.az, p.el);
    ctx.fillStyle = p.color; ctx.strokeStyle = p.color;
    if (p.ring) { ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, p.r || 5, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(x, y, p.r || 3, 0, Math.PI * 2); ctx.fill(); }
    if (p.label) { ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.fillText(p.label, x + 7, y - 7); }
  }
}

function prepSquare(canvas, size) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr; canvas.height = size * dpr; canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size, size);
  return { ctx };
}

/** Compact alt-az dial for the mount HUD: ring = commanded, dot = actual. */
export function mountDial(canvas, { act, cmd, size = 64, sun }) {
  const { ctx } = prepSquare(canvas, size);
  const c = size / 2, R = size / 2 - 4;
  const P = (az, el) => { const r = ((90 - Math.max(0, el)) / 90) * R, a = (az * Math.PI) / 180; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
  ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(c, c, R * (2 / 3), 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(c, c, R / 3, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ff8a8a'; ctx.fillRect(c - 1, 1, 2, 5);
  if (sun && sun.el > 0) { const [x, y] = P(sun.az, sun.el); ctx.fillStyle = 'rgba(255,214,102,0.9)'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
  const [cx, cy] = P(cmd.az, cmd.el);
  ctx.strokeStyle = '#f5b942'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke();
  const [ax, ay] = P(act.az, act.el);
  ctx.strokeStyle = 'rgba(78,168,255,0.6)'; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(ax, ay); ctx.stroke();
  ctx.fillStyle = '#4ea8ff'; ctx.beginPath(); ctx.arc(ax, ay, 3.2, 0, Math.PI * 2); ctx.fill();
}
