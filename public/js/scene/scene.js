/**
 * 3D scene: Earth (NASA GIBS imagery, real-time terminator), stars (HYG catalogue), Sun, Moon,
 * the propagated catalogue as GPU points, near-Earth objects, EONET events, orbits, ground tracks,
 * observer + mount boresight, labels, picking and the observer "sky view".
 *
 * Frames: world = ECI/TEME of date mapped to Three.js Y-up as (x, z, −y), 1 unit = 1 Earth radius.
 * The Earth group is rotated by GMST so its children use Earth-fixed coordinates.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/OrbitControls';
import { CATEGORIES, hexToRgb, EONET_COLORS, NEO_COLOR, PHA_COLOR } from '../lib/config.js';
import { DEG, eqjToEqd } from '../lib/astro.js';
import { clamp } from '../lib/util.js';

const ecefToLocal = (v) => new THREE.Vector3(v[0], v[2], -v[1]);   // ECEF (any unit) → Earth-group local

/** Same orbit-plane extrapolation as the point shader (exact for circular orbits). */
export function extrapolate(px, py, pz, vx, vy, vz, dt, out) {
  const hx = py * vz - pz * vy, hy = pz * vx - px * vz, hz = px * vy - py * vx;
  const hl = Math.hypot(hx, hy, hz), r2 = px * px + py * py + pz * pz;
  if (hl < 1e-9 || r2 < 1e-9) return out.set(px + vx * dt, py + vy * dt, pz + vz * dt);
  const nx = hx / hl, ny = hy / hl, nz = hz / hl, th = (hl / r2) * dt, c = Math.cos(th), s = Math.sin(th);
  const k = 1 + ((px * vx + py * vy + pz * vz) / r2) * dt;
  return out.set((px * c + (ny * pz - nz * py) * s) * k, (py * c + (nz * px - nx * pz) * s) * k, (pz * c + (nx * py - ny * px) * s) * k);
}
const STAR_R = 9000, SUN_R = 8000;

const POINT_VS = /* glsl */`
  attribute vec3 velocity; attribute vec3 color; attribute float size; attribute float cat; attribute float state; attribute float risk;
  uniform float uDt; uniform float uPx; uniform float uVis[16]; uniform float uSel; uniform float uHov; uniform vec2 uPair; uniform float uTime; uniform float uRiskOn;
  varying vec3 vColor; varying float vAlpha; varying float vHot;
  vec3 extrap(vec3 p, vec3 v, float dt) {
    vec3 h = cross(p, v); float hl = length(h); float r2 = dot(p, p);
    if (hl < 1e-9 || r2 < 1e-9) return p + v * dt;
    vec3 n = h / hl; float th = hl / r2 * dt;
    return (p * cos(th) + cross(n, p) * sin(th)) * (1.0 + dot(p, v) / r2 * dt);
  }
  void main() {
    vec3 p = extrap(position, velocity, uDt);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    float id = float(gl_VertexID);
    float hot = (abs(id - uSel) < 0.5 || abs(id - uHov) < 0.5 || abs(id - uPair.x) < 0.5 || abs(id - uPair.y) < 0.5) ? 1.0 : 0.0;
    float vis = max(uVis[int(cat + 0.5)], hot) * step(0.5, state);
    float lit = state > 1.5 ? 1.0 : 0.45;
    float r = risk * uRiskOn * (1.0 - hot);
    float pulse = 0.5 + 0.5 * sin(uTime * 4.0);
    gl_PointSize = vis * mix(mix(size, max(size * 2.4, 11.0), hot), 6.0 + 4.0 * pulse, r) * uPx;
    vColor = mix(mix(color * (0.5 + 0.5 * lit), vec3(1.0), hot * 0.35), vec3(1.0, 0.24, 0.3), r);
    vAlpha = mix(mix(0.5 + 0.5 * lit, 1.0, hot), 0.75 + 0.25 * pulse, r);
    vHot = max(hot, r);
  }`;
const POINT_FS = /* glsl */`
  varying vec3 vColor; varying float vAlpha; varying float vHot;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.16, d);
    if (vHot > 0.5) a = max(smoothstep(0.5, 0.44, d) * smoothstep(0.3, 0.37, d), smoothstep(0.2, 0.1, d));
    gl_FragColor = vec4(vColor, a * vAlpha);
  }`;

const EARTH_VS = /* glsl */`
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() {
    vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const EARTH_FS = /* glsl */`
  uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uLive;
  uniform vec3 uSun; uniform float uLiveOn; uniform float uNightOn; uniform float uGround;
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() {
    vec3 n = normalize(vN);
    float mu = dot(n, uSun);
    float day = smoothstep(-0.10, 0.16, mu);
    vec3 base = texture2D(uDay, vUv).rgb;
    vec3 live = texture2D(uLive, vUv).rgb;
    // feather the edge of no-data regions (polar night, unprocessed swaths) with a 5-tap mask
    vec2 o = vec2(0.0035, 0.0045);
    float m0 = smoothstep(0.012, 0.05, max(live.r, max(live.g, live.b)));
    vec3 l1 = texture2D(uLive, vUv + vec2(o.x, 0.0)).rgb, l2 = texture2D(uLive, vUv - vec2(o.x, 0.0)).rgb;
    vec3 l3 = texture2D(uLive, vUv + vec2(0.0, o.y)).rgb, l4 = texture2D(uLive, vUv - vec2(0.0, o.y)).rgb;
    float mk = (m0 + smoothstep(0.012, 0.05, max(l1.r, max(l1.g, l1.b))) + smoothstep(0.012, 0.05, max(l2.r, max(l2.g, l2.b)))
      + smoothstep(0.012, 0.05, max(l3.r, max(l3.g, l3.b))) + smoothstep(0.012, 0.05, max(l4.r, max(l4.g, l4.b)))) / 5.0;
    float liveMask = uLiveOn * m0 * smoothstep(0.35, 1.0, mk);
    vec3 dcol = mix(base, live, liveMask);
    float lambert = clamp(mu * 1.08 + 0.12, 0.0, 1.0);
    vec3 col = dcol * (0.035 + 0.965 * lambert);
    float lum = dot(texture2D(uNight, vUv).rgb, vec3(0.299, 0.587, 0.114));
    vec3 city = vec3(1.0, 0.76, 0.46) * smoothstep(0.32, 0.95, lum) * 1.9 * uNightOn;
    col = mix(city + dcol * 0.018, col, day);
    vec3 v = normalize(cameraPosition - vW);
    vec3 hv = normalize(uSun + v);
    float water = clamp((dcol.b - max(dcol.r, dcol.g)) * 6.0 + 0.15, 0.0, 1.0) * (1.0 - 0.7 * liveMask);
    col += vec3(1.0, 0.93, 0.8) * pow(max(dot(n, hv), 0.0), 70.0) * water * day * 0.45;
    float term = max(0.0, 1.0 - abs(mu) * 5.0);
    col += vec3(0.22, 0.08, 0.02) * term * 0.3;
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    col += vec3(0.22, 0.42, 0.85) * fres * (0.08 + 0.55 * day) * 0.7;
    gl_FragColor = vec4(col * uGround, 1.0);
  }`;
const ATMO_FS = /* glsl */`
  uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
  void main() {
    vec3 n = normalize(vN); vec3 v = normalize(cameraPosition - vW);
    float rim = 1.0 - max(dot(n, v), 0.0);
    float lit = smoothstep(-0.35, 0.45, dot(n, uSun));
    vec3 c = mix(vec3(0.04, 0.08, 0.2), vec3(0.32, 0.62, 1.0), lit);
    gl_FragColor = vec4(c * pow(rim, 4.5) * 1.5 * (0.2 + 0.8 * lit), 1.0);
  }`;
const MOON_FS = /* glsl */`
  uniform sampler2D uTex; uniform vec3 uSun; uniform float uHasTex; varying vec2 vUv; varying vec3 vN;
  void main() {
    float l = max(dot(normalize(vN), uSun), 0.0);
    vec3 alb = mix(vec3(0.6), texture2D(uTex, vUv).rgb, uHasTex);
    gl_FragColor = vec4(alb * (0.015 + 1.15 * l), 1.0);
  }`;
const SPRITE_VS = /* glsl */`
  attribute float size; attribute vec3 color; uniform float uPx; varying vec3 vColor;
  void main() { vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * uPx; }`;
const STAR_FS = /* glsl */`
  varying vec3 vColor;
  void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(vColor, smoothstep(0.5, 0.05, d)); }`;
const SUN_FS = /* glsl */`
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = smoothstep(0.2, 0.1, d); float glow = exp(-d * 5.0) * 0.7;
    gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * (core + glow), 1.0);
  }`;

function makeTex(color = [10, 20, 40]) {
  const t = new THREE.DataTexture(new Uint8Array([...color, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
function bvColor(bv) {
  if (!Number.isFinite(bv)) return [1, 1, 1];
  if (bv < 0) return [0.72, 0.82, 1];
  if (bv < 0.4) return [0.88, 0.92, 1];
  if (bv < 0.8) return [1, 0.97, 0.88];
  if (bv < 1.3) return [1, 0.86, 0.66];
  return [1, 0.74, 0.52];
}

export class SceneView {
  constructor(canvas, app) {
    this.app = app;
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x04060b, 1);
    this.px = r.getPixelRatio();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 30000);
    this.camera.position.set(0, 1.6, 4.4);
    const c = (this.controls = new OrbitControls(this.camera, canvas));
    Object.assign(c, { enableDamping: true, dampingFactor: 0.08, rotateSpeed: 0.5, zoomSpeed: 0.9, minDistance: 1.04, maxDistance: 1800, enablePan: false });
    this.mode = 'orbital';
    this.sky = { az: 180, el: 30, fov: 70 };
    this.follow = null;
    this.flight = null;
    this.earth = new THREE.Group();
    this.scene.add(this.earth);
    this.labelHost = document.getElementById('labels');
    this.labels = new Map();
    this.catVis = new Array(16).fill(1);
    this.sat = null;
    this.neoObjs = [];
    this.events = [];
    this.pointer = { x: -1, y: -1, inside: false, moved: false };
    this._v = new THREE.Vector3();

    this.buildEarth();
    this.buildSunMoon();
    this.buildObserver();
    this.buildLines();
    this.loadStars();
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /* ───────────────────────── construction ───────────────────────── */

  buildEarth() {
    const geo = new THREE.SphereGeometry(1, 192, 96);
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: { uDay: { value: makeTex([18, 38, 70]) }, uNight: { value: makeTex([0, 0, 0]) }, uLive: { value: makeTex([0, 0, 0]) },
        uSun: { value: new THREE.Vector3(1, 0, 0) }, uLiveOn: { value: 1 }, uNightOn: { value: 1 }, uGround: { value: 1 } },
      vertexShader: EARTH_VS, fragmentShader: EARTH_FS,
    });
    this.earthMesh = new THREE.Mesh(geo, this.earthMat);
    this.earth.add(this.earthMesh);
    this.atmoMat = new THREE.ShaderMaterial({ uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } }, vertexShader: EARTH_VS, fragmentShader: ATMO_FS,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(1.028, 128, 64), this.atmoMat);
    this.scene.add(this.atmo);
    // graticule (30°)
    const pts = [];
    const ll = (la, lo) => { const a = la * DEG, b = lo * DEG; return ecefToLocal([Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]).multiplyScalar(1.0015); };
    for (let la = -60; la <= 60; la += 30) for (let lo = -180; lo < 180; lo += 3) pts.push(ll(la, lo), ll(la, lo + 3));
    for (let lo = -180; lo < 180; lo += 30) for (let la = -87; la < 87; la += 3) pts.push(ll(la, lo), ll(la + 3, lo));
    this.grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6b8bb8, transparent: true, opacity: 0.12, depthWrite: false }));
    this.grid.visible = false;
    this.earth.add(this.grid);
  }

  loadEarthTextures({ day, night, live }) {
    const loader = new THREE.TextureLoader();
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    const load = (url, uniform, onDone) => loader.load(url, (t) => {
      t.anisotropy = Math.min(8, aniso); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      this.earthMat.uniforms[uniform].value = t; onDone?.(true);
    }, undefined, () => onDone?.(false));
    return Promise.all([
      new Promise((res) => load(day, 'uDay', res)),
      new Promise((res) => load(night, 'uNight', res)),
      new Promise((res) => (live ? load(live, 'uLive', res) : res(false))),
    ]);
  }

  buildSunMoon() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array([90]), 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 1, 1]), 3));
    this.sun = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPx: { value: this.px } }, vertexShader: SPRITE_VS, fragmentShader: SUN_FS,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.sun.frustumCulled = false;
    this.scene.add(this.sun);
    this.moonMat = new THREE.ShaderMaterial({ uniforms: { uTex: { value: makeTex([150, 150, 150]) }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uHasTex: { value: 0 } },
      vertexShader: EARTH_VS.replace('vW = w.xyz;', 'vW = w.xyz;'), fragmentShader: MOON_FS });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1737.4 / 6378.137, 64, 32), this.moonMat);
    this.scene.add(this.moon);
    new THREE.TextureLoader().load('/vendor/moon.jpg', (t) => { this.moonMat.uniforms.uTex.value = t; this.moonMat.uniforms.uHasTex.value = 1; }, undefined, () => {});
  }

  async loadStars() {
    try {
      const res = await fetch('/vendor/stars.6.json');
      const data = await res.json();
      const feats = data.features || [];
      const pos = new Float32Array(feats.length * 3), col = new Float32Array(feats.length * 3), size = new Float32Array(feats.length);
      const now = Date.now();
      feats.forEach((f, i) => {
        const [ra0, dec0] = f.geometry.coordinates;
        const ra = ra0 * DEG, dec = dec0 * DEG;
        const v = eqjToEqd([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)], now);
        pos.set([v[0] * STAR_R, v[2] * STAR_R, -v[1] * STAR_R], i * 3);
        const m = f.properties.mag;
        const b = clamp(1.25 - 0.14 * m, 0.22, 1);
        const c = bvColor(parseFloat(f.properties.bv));
        col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
        size[i] = clamp(3.6 - 0.48 * m, 0.9, 4.6);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('size', new THREE.BufferAttribute(size, 1));
      this.stars = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPx: { value: this.px } }, vertexShader: SPRITE_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false }));
      this.stars.frustumCulled = false;
      this.stars.renderOrder = -2;
      this.scene.add(this.stars);
    } catch { /* stars are decorative */ }
  }

  buildObserver() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array([11]), 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0.31, 0.66, 1]), 3));
    this.obsPoint = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPx: { value: this.px } }, vertexShader: SPRITE_VS,
      fragmentShader: /* glsl */`varying vec3 vColor; void main(){ float d=length(gl_PointCoord-0.5); if(d>0.5) discard; float a=max(smoothstep(0.5,0.42,d)*smoothstep(0.28,0.36,d), smoothstep(0.2,0.1,d)); gl_FragColor=vec4(vColor,a);} `,
      transparent: true, depthWrite: false }));
    this.earth.add(this.obsPoint);
    // mount boresight + field-of-view cone (Earth-fixed, built in observer ENU)
    this.mountGroup = new THREE.Group();
    this.earth.add(this.mountGroup);
    this.boreLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: 0x4ea8ff, transparent: true, opacity: 0.95 }));
    this.cmdLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: 0xf5b942, transparent: true, opacity: 0.6 }));
    this.cone = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 48, 1, true), new THREE.MeshBasicMaterial({ color: 0x4ea8ff, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }));
    const ring = [];
    for (let k = 0; k <= 96; k++) { const a = (k / 96) * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
    this.fovRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.85, depthTest: false }));
    this.mountGroup.add(this.boreLine, this.cmdLine, this.cone, this.fovRing);
    // sky-view alt/az grid (built in setObserver)
    this.skyGrid = new THREE.Group();
    this.skyGrid.visible = false;
    this.earth.add(this.skyGrid);
  }

  buildLines() {
    const mk = (color, opacity, parent) => {
      const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      l.frustumCulled = false; l.visible = false; parent.add(l); return l;
    };
    this.orbitLine = mk(0x7cc4ff, 0.7, this.scene);
    this.trackLine = mk(0x7cc4ff, 0.55, this.earth);
    this.pairLine = mk(0xff4d5e, 0.95, this.scene);
    this.pairOrbit = mk(0xff8a8a, 0.45, this.scene);
  }

  /* ───────────────────────── catalogue points ───────────────────────── */

  buildSatellites(objects) {
    if (this.sat) { this.scene.remove(this.sat.points); this.sat.points.geometry.dispose(); }
    const n = objects.length;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), st = new Float32Array(n);
    const color = new Float32Array(n * 3), size = new Float32Array(n), cat = new Float32Array(n);
    const rgb = CATEGORIES.map((c) => hexToRgb(c.color));
    objects.forEach((o, i) => { color.set(rgb[o.cat], i * 3); size[i] = CATEGORIES[o.cat].size; cat[i] = o.cat; });
    const g = new THREE.BufferGeometry();
    const dyn = (a, s) => new THREE.BufferAttribute(a, s).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(pos, 3));
    g.setAttribute('velocity', dyn(vel, 3));
    g.setAttribute('state', dyn(st, 1));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('cat', new THREE.BufferAttribute(cat, 1));
    const risk = new Float32Array(n);
    g.setAttribute('risk', new THREE.BufferAttribute(risk, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uDt: { value: 0 }, uPx: { value: this.px }, uVis: { value: this.catVis }, uSel: { value: -1 }, uHov: { value: -1 }, uPair: { value: new THREE.Vector2(-1, -1) },
        uTime: { value: 0 }, uRiskOn: { value: this.riskOn ?? 1 } },
      vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false,
    });
    const points = new THREE.Points(g, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this.sat = { points, n, pos, vel, st, cat, mat, risk, t: 0 };
    if (this.riskIdx) this.setRisk(this.riskIdx);
  }

  /** Highlight objects involved in high-risk encounters (pulsing red). */
  setRisk(indices) {
    this.riskIdx = indices;
    const s = this.sat; if (!s) return;
    s.risk.fill(0);
    for (const i of indices) if (i >= 0 && i < s.n) s.risk[i] = 1;
    s.points.geometry.attributes.risk.needsUpdate = true;
  }
  setRiskVisible(on) { this.riskOn = on ? 1 : 0; if (this.sat) this.sat.mat.uniforms.uRiskOn.value = this.riskOn; }

  /** Swap in a new propagation snapshot from the worker; returns the previous buffers for recycling. */
  applyState(m) {
    const s = this.sat;
    if (!s || m.n !== s.n) return null;
    const old = { pos: s.pos, vel: s.vel, st: s.st };
    const g = s.points.geometry;
    g.attributes.position.array = m.pos; g.attributes.position.needsUpdate = true;
    g.attributes.velocity.array = m.vel; g.attributes.velocity.needsUpdate = true;
    g.attributes.state.array = m.st; g.attributes.state.needsUpdate = true;
    s.pos = m.pos; s.vel = m.vel; s.st = m.st; s.t = m.t;
    return old;
  }

  satWorld(i, dt, out = new THREE.Vector3()) {
    const s = this.sat; const k = i * 3;
    return extrapolate(s.pos[k], s.pos[k + 1], s.pos[k + 2], s.vel[k], s.vel[k + 1], s.vel[k + 2], dt, out);
  }

  setCategoryVisible(idx, on) { this.catVis[idx] = on ? 1 : 0; }
  setSelected(i) { if (this.sat) this.sat.mat.uniforms.uSel.value = i ?? -1; }
  setHover(i) { if (this.sat) this.sat.mat.uniforms.uHov.value = i ?? -1; }
  setPair(a, b) { if (this.sat) this.sat.mat.uniforms.uPair.value.set(a ?? -1, b ?? -1); }

  /* ───────────────────────── NEOs & events ───────────────────────── */

  buildNeos(list) {
    if (this.neoPts) { this.scene.remove(this.neoPts); this.neoPts.geometry.dispose(); }
    this.neoObjs = list;
    const n = Math.max(1, list.length);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array(n * 3), size = new Float32Array(n);
    list.forEach((o, i) => {
      col.set(hexToRgb(o.pha ? PHA_COLOR : NEO_COLOR), i * 3);
      const dm = o.diameterM || 30;
      size[i] = o.el ? clamp(3 + Math.log10(dm) * 1.6, 3.5, 9) : 0;
    });
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    this.neoPts = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPx: { value: this.px } }, vertexShader: SPRITE_VS,
      fragmentShader: /* glsl */`varying vec3 vColor; void main(){ float d=length(gl_PointCoord-0.5); if(d>0.5) discard; float a=max(smoothstep(0.5,0.4,d)*smoothstep(0.24,0.32,d), smoothstep(0.24,0.1,d)); gl_FragColor=vec4(vColor,a);} `,
      transparent: true, depthWrite: false }));
    this.neoPts.frustumCulled = false;
    this.neoPts.visible = this.neoVisible ?? true;
    this.scene.add(this.neoPts);
  }
  updateNeoPositions(arr) {
    if (!this.neoPts) return;
    const a = this.neoPts.geometry.attributes.position;
    for (let i = 0; i < this.neoObjs.length; i++) { const p = arr[i]; if (p) a.array.set(p, i * 3); }
    a.needsUpdate = true;
    const s = this.neoPts.geometry.attributes.size;
    this.neoObjs.forEach((o, i) => { s.array[i] = o.el ? clamp(3 + Math.log10(o.diameterM || 30) * 1.6, 3.5, 9) : 0; });
    s.needsUpdate = true;
  }

  buildEvents(events) {
    if (this.eventPts) { this.earth.remove(this.eventPts); this.eventPts.geometry.dispose(); }
    this.events = events;
    const n = Math.max(1, events.length);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    events.forEach((e, i) => {
      const a = e.lat * DEG, b = e.lon * DEG;
      pos.set(ecefToLocal([Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]).multiplyScalar(1.004).toArray(), i * 3);
      col.set(hexToRgb(EONET_COLORS[e.cat] || '#cccccc'), i * 3);
      size[i] = e.cat === 'severeStorms' || e.cat === 'volcanoes' ? 7 : 5;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.eventPts = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPx: { value: this.px } }, vertexShader: SPRITE_VS,
      fragmentShader: /* glsl */`varying vec3 vColor; void main(){ vec2 c=gl_PointCoord-0.5; if(max(abs(c.x),abs(c.y))>0.5) discard; float d=length(c); float a=smoothstep(0.5,0.3,d)*0.95; gl_FragColor=vec4(vColor,a);} `,
      transparent: true, depthWrite: false }));
    this.eventPts.visible = this.eventsVisible ?? true;
    this.earth.add(this.eventPts);
  }

  /* ───────────────────────── lines ───────────────────────── */

  setOrbit(points, color = 0x7cc4ff) { this.#setLine(this.orbitLine, points, color); }
  setGroundTrack(latlon, color = 0x7cc4ff) {
    if (!latlon) return this.#setLine(this.trackLine, null);
    const pts = latlon.map(([la, lo]) => { const a = la * DEG, b = lo * DEG; return [Math.cos(a) * Math.cos(b) * 1.002, Math.sin(a) * 1.002, -Math.cos(a) * Math.sin(b) * 1.002]; });
    this.#setLine(this.trackLine, pts, color);
  }
  setPairOrbit(points) { this.#setLine(this.pairOrbit, points, 0xff8a8a); }
  setPairLine(a, b) {
    if (!a || !b) { this.pairLine.visible = false; return; }
    this.#setLine(this.pairLine, [a.toArray(), b.toArray()], 0xff4d5e);
  }
  #setLine(line, points, color) {
    if (!points || points.length < 2) { line.visible = false; return; }
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => arr.set(p, i * 3));
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry();
    line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    if (color != null) line.material.color.setHex(color);
    line.visible = true;
  }

  /* ───────────────────────── observer & mount ───────────────────────── */

  setObserver(obs) {
    this.obs = obs;
    const p = ecefToLocal(obs.ecef).normalize().multiplyScalar(1 + Math.max(0, obs.alt) / 6378.137);
    this.obsLocal = p.clone();
    this.obsPoint.geometry.attributes.position.array.set(p.clone().multiplyScalar(1.0008).toArray());
    this.obsPoint.geometry.attributes.position.needsUpdate = true;
    this.enuLocal = { E: ecefToLocal(obs.E), N: ecefToLocal(obs.N), U: ecefToLocal(obs.U) };
    this.mountGroup.position.copy(p).addScaledVector(this.enuLocal.U, 0.0004);
    // alt/az dome for the sky view
    this.skyGrid.clear();
    const R = 0.5, mat = new THREE.LineBasicMaterial({ color: 0x8aa4c8, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false });
    const dirL = (az, el) => this.localDir(az, el).multiplyScalar(R);
    for (const el of [0, 30, 60]) {
      const pts = []; for (let az = 0; az <= 360; az += 2) pts.push(dirL(az, el));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), el === 0 ? new THREE.LineBasicMaterial({ color: 0xa3b6d6, transparent: true, opacity: 0.5, depthTest: false }) : mat);
      l.renderOrder = 5; this.skyGrid.add(l);
    }
    for (let az = 0; az < 360; az += 30) {
      const pts = []; for (let el = 0; el <= 84; el += 2) pts.push(dirL(az, el));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat); l.renderOrder = 5; this.skyGrid.add(l);
    }
    this.skyGrid.position.copy(p).addScaledVector(this.enuLocal.U, 0.0003);
  }

  /** ENU direction → Earth-local unit vector. */
  localDir(az, el) {
    const { E, N, U } = this.enuLocal;
    const a = az * DEG, e = el * DEG;
    return new THREE.Vector3().addScaledVector(E, Math.sin(a) * Math.cos(e)).addScaledVector(N, Math.cos(a) * Math.cos(e)).addScaledVector(U, Math.sin(e)).normalize();
  }

  setMount({ act, cmd, fov, show }) {
    if (!this.enuLocal) return;
    this.mountGroup.visible = show;
    if (!show) return;
    const L = this.mode === 'sky' ? 0.3 : 0.45;
    const d = this.localDir(act.az, act.el);
    const half = Math.max(0.2, fov / 2) * DEG;
    this.boreLine.geometry.attributes.position.array.set([0, 0, 0, d.x * L, d.y * L, d.z * L]);
    this.boreLine.geometry.attributes.position.needsUpdate = true;
    this.boreLine.visible = this.mode !== 'sky';
    const dc = this.localDir(cmd.az, cmd.el);
    this.cmdLine.geometry.attributes.position.array.set([0, 0, 0, dc.x * L, dc.y * L, dc.z * L]);
    this.cmdLine.geometry.attributes.position.needsUpdate = true;
    this.cmdLine.visible = this.mode !== 'sky' && d.angleTo(dc) > 0.004;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
    this.cone.quaternion.copy(q);
    this.cone.scale.set(Math.tan(half) * L, L, Math.tan(half) * L);
    this.cone.position.copy(d).multiplyScalar(L / 2);
    this.cone.visible = this.mode !== 'sky';
    this.fovRing.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
    this.fovRing.scale.setScalar(Math.tan(half) * L);
    this.fovRing.position.copy(d).multiplyScalar(L);
  }

  /* ───────────────────────── labels ───────────────────────── */

  setLabel(key, text, getPos, cls = '', color = null) {
    let l = this.labels.get(key);
    if (!l) {
      const el = document.createElement('div');
      el.className = `label ${cls}`;
      this.labelHost.appendChild(el);
      l = { el, text: null, getPos };
      this.labels.set(key, l);
    }
    l.getPos = getPos;
    if (l.text !== text || l.color !== color) {
      l.el.innerHTML = color ? `<i class="sw" style="background:${color}"></i>${text}` : text;
      l.text = text; l.color = color;
    }
    l.el.className = `label ${cls}`;
  }
  removeLabel(key) { const l = this.labels.get(key); if (l) { l.el.remove(); this.labels.delete(key); } }

  occluded(p) {
    const C = this.camera.position;
    const dx = p.x - C.x, dy = p.y - C.y, dz = p.z - C.z;
    const a = dx * dx + dy * dy + dz * dz, b = 2 * (C.x * dx + C.y * dy + C.z * dz), c = C.lengthSq() - 0.9995;
    const disc = b * b - 4 * a * c;
    if (disc <= 0 || c < 0) return false;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t > 0 && t < 0.999;
  }

  updateLabels() {
    const W = this.width, H = this.height, v = this._v;
    for (const l of this.labels.values()) {
      const p = l.getPos();
      if (!p) { l.el.style.display = 'none'; continue; }
      v.copy(p);
      const occl = l.el.classList.contains('compass') || l.el.classList.contains('alt') ? false : this.occluded(v);
      v.project(this.camera);
      if (occl || v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) { l.el.style.display = 'none'; continue; }
      l.el.style.display = '';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * W}px, ${((1 - v.y) / 2) * H}px) ${l.el.classList.contains('compass') ? 'translate(-50%,-50%)' : 'translate(10px,-50%)'}`;
    }
  }

  /* ───────────────────────── camera & views ───────────────────────── */

  flyTo(getPos, dist = 2.2, { follow = true } = {}) {
    const p = getPos();
    if (!p) return;
    if (this.mode === 'sky') this.setMode('orbital');
    const c = this.controls;
    const dir = this.camera.position.clone().sub(c.target).normalize();
    this.flight = { t0: performance.now(), dur: 1100, fromT: c.target.clone(), fromD: this.camera.position.distanceTo(c.target), dir, getPos, dist };
    this.follow = follow ? getPos : null;
  }
  resetView() {
    this.follow = null;
    if (this.mode === 'sky') { this.sky = { az: 180, el: 30, fov: 70 }; return; }
    const target = this.obsLocal ? this.obsLocal.clone().applyMatrix4(this.earth.matrixWorld).normalize().multiplyScalar(3.4) : new THREE.Vector3(0, 1.5, 3.6);
    this.flight = { t0: performance.now(), dur: 1100, fromT: this.controls.target.clone(), fromD: this.camera.position.length(), dir: target.clone().normalize(), getPos: () => new THREE.Vector3(), dist: 3.4 };
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.controls.enabled = mode === 'orbital';
    this.skyGrid.visible = mode === 'sky';
    this.atmo.visible = mode === 'orbital';
    this.obsPoint.visible = mode === 'orbital';
    this.earthMat.uniforms.uGround.value = mode === 'sky' ? 0.22 : 1;
    if (mode === 'orbital') {
      this.camera.fov = 42;
      this.camera.up.set(0, 1, 0);
      if (this.savedOrbital) { this.camera.position.copy(this.savedOrbital.pos); this.controls.target.copy(this.savedOrbital.target); }
      ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'a30', 'a60'].forEach((k) => this.removeLabel(`compass:${k}`));
    } else {
      this.savedOrbital = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
      this.follow = null; this.flight = null;
      const pts = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
      for (const [k, az] of Object.entries(pts)) this.setLabel(`compass:${k}`, k, () => this.skyWorld(az, 1.5, 0.45), `compass ${k === 'N' ? 'n' : ''}`);
      this.setLabel('compass:a30', '30°', () => this.skyWorld(this.sky.az, 30, 0.45), 'alt');
      this.setLabel('compass:a60', '60°', () => this.skyWorld(this.sky.az, 60, 0.45), 'alt');
    }
    this.camera.updateProjectionMatrix();
    this.app.bus.emit('view', mode);
  }

  skyWorld(az, el, r) {
    if (!this.enuLocal) return null;
    const base = this.skyGrid.position.clone().add(this.localDir(az, el).multiplyScalar(r));
    return base.applyMatrix4(this.earth.matrixWorld);
  }

  /* ───────────────────────── input ───────────────────────── */

  bindInput() {
    const cv = this.canvas;
    let down = null;
    cv.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, az: this.sky.az, el: this.sky.el, t: performance.now() };
      if (this.mode === 'orbital' && this.follow && !this.flight) { /* keep following while orbiting */ }
      if (this.mode === 'sky') cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY, inside: true, moved: true };
      if (down && this.mode === 'sky' && (e.buttons & 1)) {
        const k = this.sky.fov / this.height;
        this.sky.az = (down.az - (e.clientX - down.x) * k + 360) % 360;
        this.sky.el = clamp(down.el + (e.clientY - down.y) * k, -5, 89.9);
        this.app.bus.emit('skylook', this.sky);
      }
    });
    cv.addEventListener('pointerleave', () => { this.pointer.inside = false; });
    cv.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved < 5 && quick) this.app.bus.emit('click', this.pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 18 : 10) || this.pickEarth(e.clientX, e.clientY));
    });
    cv.addEventListener('dblclick', (e) => {
      const hit = this.pick(e.clientX, e.clientY, 12);
      if (hit) this.app.bus.emit('focus', hit);
    });
    cv.addEventListener('wheel', (e) => {
      if (this.mode !== 'sky') return;
      e.preventDefault();
      this.sky.fov = clamp(this.sky.fov * Math.exp(e.deltaY * 0.0012), 4, 110);
    }, { passive: false });
    this.controls.addEventListener('start', () => { if (this.flight) this.flight = null; });
  }

  ndcOf(p) { return this._v.copy(p).project(this.camera); }

  /** Screen-space picking across satellites, NEOs, the Moon and events. */
  pick(x, y, radius = 10) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = x - rect.left, sy = y - rect.top, W = this.width, H = this.height;
    let best = { d2: radius * radius, hit: null };
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const tryPoint = (px, py, pz, hit, bias = 0) => {
      const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (w <= 0) return;
      const cx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w + 1) * 0.5 * W;
      const cy = (1 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w) * 0.5 * H;
      const d2 = (cx - sx) ** 2 + (cy - sy) ** 2 - bias;
      if (d2 < best.d2 && !this.occluded(this._v.set(px, py, pz))) best = { d2, hit };
    };
    const s = this.sat;
    if (s) {
      const dt = s.mat.uniforms.uDt.value, q = new THREE.Vector3();
      for (let i = 0; i < s.n; i++) {
        if (s.st[i] < 0.5 || !this.catVis[s.cat[i]]) continue;
        const k = i * 3;
        extrapolate(s.pos[k], s.pos[k + 1], s.pos[k + 2], s.vel[k], s.vel[k + 1], s.vel[k + 2], dt, q);
        tryPoint(q.x, q.y, q.z, { kind: 'sat', i }, s.cat[i] === 0 ? 40 : 0);
      }
    }
    if (this.neoPts?.visible) {
      const a = this.neoPts.geometry.attributes.position.array;
      this.neoObjs.forEach((o, i) => { if (o.el) tryPoint(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], { kind: 'neo', i }, 30); });
    }
    if (this.moon.visible) tryPoint(this.moon.position.x, this.moon.position.y, this.moon.position.z, { kind: 'moon' }, 60);
    if (this.eventPts?.visible && this.mode === 'orbital') {
      const a = this.eventPts.geometry.attributes.position.array, mw = this.earth.matrixWorld;
      this.events.forEach((e, i) => { this._v.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(mw); const p = this._v.clone(); tryPoint(p.x, p.y, p.z, { kind: 'event', i }); });
    }
    return best.hit;
  }

  pickEarth(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x - rect.left) / this.width) * 2 - 1, -((y - rect.top) / this.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.earthMesh, false)[0];
    if (!hit) return null;
    const p = this.earth.worldToLocal(hit.point.clone()).normalize();
    return { kind: 'earth', lat: Math.asin(p.y) / DEG, lon: Math.atan2(-p.z, p.x) / DEG };
  }

  resize() {
    this.width = window.innerWidth; this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /* ───────────────────────── per-frame ───────────────────────── */

  frame({ gmst, sunDir, moonPos, dtSnap, neoPositions }) {
    this.earth.rotation.y = gmst;
    this.earth.updateMatrixWorld(true);
    const sun = new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize();
    this.earthMat.uniforms.uSun.value.copy(sun);
    this.atmoMat.uniforms.uSun.value.copy(sun);
    this.moonMat.uniforms.uSun.value.copy(sun);
    this.sun.geometry.attributes.position.array.set(sun.clone().multiplyScalar(SUN_R).toArray());
    this.sun.geometry.attributes.position.needsUpdate = true;
    if (moonPos) {
      this.moon.position.set(moonPos[0], moonPos[1], moonPos[2]);
      // tidally locked: texture longitude 0 (+X) faces Earth
      const x = this.moon.position.clone().negate().normalize();
      const y = new THREE.Vector3(0, 1, 0).addScaledVector(x, -x.y).normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      this.moon.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    }
    if (this.sat) { this.sat.mat.uniforms.uDt.value = dtSnap; this.sat.mat.uniforms.uTime.value = performance.now() / 1000; }
    if (neoPositions) this.updateNeoPositions(neoPositions);

    const c = this.controls;
    if (this.mode === 'orbital') {
      if (this.flight) {
        const f = this.flight;
        const k = clamp((performance.now() - f.t0) / f.dur, 0, 1), e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
        const goal = f.getPos();
        if (goal) {
          const tgt = f.fromT.clone().lerp(goal, e);
          const d = f.fromD + (f.dist - f.fromD) * e;
          c.target.copy(tgt);
          this.camera.position.copy(tgt).addScaledVector(f.dir, d);
        }
        if (k >= 1) this.flight = null;
      } else if (this.follow) {
        const goal = this.follow();
        if (goal) { const delta = goal.clone().sub(c.target); c.target.add(delta); this.camera.position.add(delta); }
      }
      c.minDistance = c.target.lengthSq() > 1e-6 ? 0.02 : 1.04;
      c.update();
      const surf = Math.max(1e-4, this.camera.position.length() - 1);
      this.camera.near = clamp(Math.min(surf, this.camera.position.distanceTo(c.target)) * 0.25, 1e-4, 0.5);
    } else if (this.obsLocal) {
      const mw = this.earth.matrixWorld;
      const up = this.enuLocal.U.clone().transformDirection(mw);
      const pos = this.obsLocal.clone().addScaledVector(this.enuLocal.U, 0.0003).applyMatrix4(mw);
      const dir = this.localDir(this.sky.az, this.sky.el).transformDirection(mw);
      this.camera.position.copy(pos);
      this.camera.up.copy(up);
      this.camera.lookAt(pos.clone().add(dir));
      this.camera.fov = this.sky.fov;
      this.camera.near = 1e-5;
    }
    this.camera.updateProjectionMatrix();
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  }
}
