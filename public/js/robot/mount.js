/**
 * Pointing controller for the ESP32-S3 alt-az mount.
 *
 * Transports: built-in simulator, USB (Web Serial, Chrome/Edge) or Wi-Fi (WebSocket).
 * Wire protocol (ASCII lines, '\n' terminated) — see firmware/argus_mount/README.md:
 *   host → mount   AZEL <az> <el> <azRate> <elRate>     degrees, true-north azimuth (+offset), deg/s
 *                  PARK | STOP | PING
 *   mount → host   POS <az> <el>  |  PONG  |  HELLO <text>  |  ERR <text>
 */
import { store, clamp } from '../lib/util.js';
import { angularSep } from '../lib/astro.js';

const DEFAULTS = {
  transport: 'sim', wsUrl: 'ws://argus-mount.local:81/', baud: 115200, rateHz: 10,
  minEl: 0, maxEl: 90, azOffset: 0, sunGuard: 15, fov: 30, slewAz: 45, slewEl: 30,
  parkAz: 0, parkEl: 90, mode: 'track', exposure: 60,
};
const wrap360 = (a) => ((a % 360) + 360) % 360;
const dAz = (a, b) => ((b - a + 540) % 360) - 180;

export class Mount {
  constructor(app) {
    this.app = app;
    this.cfg = { ...DEFAULTS, ...store.get('mount', {}) };
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (typeof v === 'number' && (!Number.isFinite(Number(this.cfg[k])) || (k === 'rateHz' && Number(this.cfg[k]) <= 0) || (k === 'fov' && Number(this.cfg[k]) <= 0))) this.cfg[k] = v;
      else if (typeof v === 'number') this.cfg[k] = Number(this.cfg[k]);
    }
    this.cmd = { az: 0, el: 45 };
    this.act = { az: 0, el: 45 };
    this.rate = { az: 0, el: 0 };
    this.manual = { az: 180, el: 45 };
    this.status = 'sim';        // sim | connecting | serial | ws
    this.link = null;
    this.telemetry = null;
    this.flags = [];
    this.goalLabel = '';
    this.lastSend = 0;
    this.log = [];
    this.sent = 0;
  }

  save() { store.set('mount', this.cfg); }
  setMode(mode) { this.cfg.mode = mode; this.save(); this.app.bus.emit('mount:change'); }
  get connected() { return this.status === 'serial' || this.status === 'ws'; }

  pushLog(dir, line) {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${dir} ${line.trim()}`);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    this.app.bus.emit('mount:log');
  }

  onLine(line) {
    const s = line.trim();
    if (!s) return;
    const m = /^POS\s+(-?[\d.]+)\s+(-?[\d.]+)/i.exec(s);
    if (m) { this.telemetry = { az: wrap360(+m[1] - this.cfg.azOffset), el: +m[2], t: performance.now() }; return; }
    this.pushLog('←', s);
  }

  async connect(kind) {
    if (this.status === 'connecting') return;
    await this.disconnect();
    this.status = 'connecting'; this.app.bus.emit('mount:change');
    try {
      if (kind === 'serial') await this.#serial();
      else if (kind === 'ws') await this.#ws();
      else { this.status = 'sim'; this.app.bus.emit('mount:change'); return; }
      this.send('PING');
    } catch (e) {
      this.status = 'sim';
      this.pushLog('!', e.message || String(e));
      this.app.bus.emit('mount:change');
      throw e;
    }
  }

  async #serial() {
    if (!('serial' in navigator)) throw new Error('Web Serial is not available in this browser — use Chrome or Edge on desktop.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: Number(this.cfg.baud) || 115200 });
    const enc = new TextEncoderStream();
    const wDone = enc.readable.pipeTo(port.writable).catch(() => {});
    const writer = enc.writable.getWriter();
    const dec = new TextDecoderStream();
    const rDone = port.readable.pipeTo(dec.writable).catch(() => {});
    const reader = dec.readable.getReader();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { this.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
        }
      } catch { /* port closed */ }
      if (this.link?.kind === 'serial') { this.link = null; this.status = 'sim'; this.pushLog('!', 'serial port closed'); this.app.bus.emit('mount:change'); }
    })();
    this.link = {
      kind: 'serial',
      send: (s) => writer.write(s),
      close: async () => {
        try { await reader.cancel(); } catch { /* ignore */ }
        await rDone;
        try { await writer.close(); } catch { /* ignore */ }
        await wDone;
        try { await port.close(); } catch { /* ignore */ }
      },
    };
    this.status = 'serial';
    this.pushLog('•', `USB serial open @ ${this.cfg.baud} baud`);
    this.app.bus.emit('mount:change');
  }

  #ws() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.cfg.wsUrl); } catch (e) { reject(e); return; }
      this.pendingWs = ws;
      const link = { kind: 'ws', ws, send: (s) => ws.readyState === 1 && ws.send(s), close: () => ws.close() };
      const timer = setTimeout(() => { if (this.pendingWs === ws) this.pendingWs = null; ws.close(); reject(new Error(`no answer from ${this.cfg.wsUrl}`)); }, 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        if (this.pendingWs !== ws) { ws.close(); return; }
        this.pendingWs = null;
        this.link = link;
        this.status = 'ws';
        this.pushLog('•', `WebSocket open ${this.cfg.wsUrl}`);
        this.app.bus.emit('mount:change');
        resolve();
      };
      ws.onmessage = (e) => { if (this.link === link) String(e.data).split('\n').forEach((l) => this.onLine(l)); };
      ws.onerror = () => { clearTimeout(timer); if (this.pendingWs === ws) { this.pendingWs = null; reject(new Error(`cannot reach ${this.cfg.wsUrl}`)); } };
      ws.onclose = () => {
        if (this.link === link) { this.link = null; this.status = 'sim'; this.telemetry = null; this.pushLog('!', 'WebSocket closed'); this.app.bus.emit('mount:change'); }
      };
    });
  }

  async disconnect() {
    this.pendingWs?.close();
    this.pendingWs = null;
    const l = this.link;
    this.link = null;
    this.telemetry = null;
    if (l) { try { await l.close(); } catch { /* ignore */ } this.pushLog('•', 'link closed'); }
    this.status = 'sim';
    this.app.bus.emit('mount:change');
  }

  send(cmd) {
    if (!this.link) return;
    try { this.link.send(`${cmd}\n`); this.sent++; if (!cmd.startsWith('AZEL')) this.pushLog('→', cmd); } catch (e) { this.pushLog('!', e.message); }
  }

  /**
   * ctx: { target: {az, el, label} | null, view: {az, el} | null, sun: {az, el} }
   * Applies limits + Sun exclusion, simulates slewing, and streams commands at cfg.rateHz.
   */
  update(dt, ctx) {
    const c = this.cfg;
    this.flags = [];
    let goal = null;
    if (c.mode === 'track') { goal = ctx.target; this.goalLabel = ctx.target?.label || 'No target selected'; }
    else if (c.mode === 'view') { goal = ctx.view; this.goalLabel = ctx.view ? 'Following sky view' : 'Open Sky view to steer'; }
    else if (c.mode === 'manual') { goal = this.manual; this.goalLabel = 'Manual'; }
    else if (c.mode === 'park') { goal = { az: c.parkAz, el: c.parkEl }; this.goalLabel = 'Parked'; }
    else this.goalLabel = 'Idle';

    if (goal && Number.isFinite(goal.az) && Number.isFinite(goal.el)) {
      let az = wrap360(goal.az), el = goal.el;
      if (el < c.minEl) { this.flags.push('below'); el = c.minEl; }
      if (el > c.maxEl) { this.flags.push('limit'); el = c.maxEl; }
      if (c.mode !== 'park' && ctx.sun && ctx.sun.el > -1 && angularSep(az, el, ctx.sun.az, ctx.sun.el) < c.sunGuard) {
        this.flags.push('sun');
        if (angularSep(this.cmd.az, this.cmd.el, ctx.sun.az, ctx.sun.el) >= c.sunGuard) { az = this.cmd.az; el = this.cmd.el; }
        else { el = Math.max(c.minEl, ctx.sun.el - c.sunGuard - 1); az = this.cmd.az; }
      }
      if (dt > 0) { this.rate = { az: dAz(this.cmd.az, az) / dt, el: (el - this.cmd.el) / dt }; }
      this.cmd = { az, el };
    }

    if (this.telemetry && performance.now() - this.telemetry.t < 2000) this.act = { az: this.telemetry.az, el: this.telemetry.el };
    else {
      const stepAz = clamp(dAz(this.act.az, this.cmd.az), -c.slewAz * dt, c.slewAz * dt);
      const stepEl = clamp(this.cmd.el - this.act.el, -c.slewEl * dt, c.slewEl * dt);
      this.act = { az: wrap360(this.act.az + stepAz), el: this.act.el + stepEl };
    }

    const now = performance.now();
    const hz = c.rateHz > 0 ? c.rateHz : DEFAULTS.rateHz;
    if (this.link && now - this.lastSend >= 1000 / hz) {
      this.lastSend = now;
      if (c.mode === 'park') this.send(`AZEL ${wrap360(c.parkAz + c.azOffset).toFixed(3)} ${c.parkEl.toFixed(3)} 0 0`);
      else if (goal) {
        const r = (x) => (Number.isFinite(x) ? clamp(x, -30, 30) : 0).toFixed(4);
        this.send(`AZEL ${wrap360(this.cmd.az + c.azOffset).toFixed(3)} ${this.cmd.el.toFixed(3)} ${r(this.rate.az)} ${r(this.rate.el)}`);
      }
    }
  }

  get pointingError() { return angularSep(this.act.az, this.act.el, this.cmd.az, this.cmd.el); }
}
