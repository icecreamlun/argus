/**
 * Off-screen capture of the AIR 1 gimbal camera with a police-helicopter style AR mapping overlay:
 * building address tags with leader lines, street names along visible centrelines, and a FLIR-like HUD.
 * Never touches the main view: renders into a private render target, restores the previous target.
 */
import * as THREE from 'three';
import type { AppContext, BuildingRecord, BuildingsHandle, Engine, HeliPose, RoadKind, XZ } from '../../contracts';
import { unproject } from '../../geo';
import { centroid, polygonArea, type GridRect } from './grid';
import { RoofGrid } from './occlusion';

export const FRAME_W = 960;
export const FRAME_H = 540;
const TAG_RANGE = 700;
const STREET_RANGE = 850;
const MAX_TAGS = 30;
const MAX_STREETS = 8;
const STREET_KINDS = new Set<RoadKind>(['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'pedestrian', 'service']);

/** Short tag shown in the AR overlay and sent to Argon: "B1234 · 455 GRANT AVE". */
export function buildingLabel(r: BuildingRecord): string {
  const where = r.address ? shortAddress(r.address) : (r.name ?? `${r.levels}F ${r.use}`).toUpperCase();
  return `${r.id} · ${where.length > 28 ? where.slice(0, 27) + '…' : where}`;
}

/** "318;320;322 Kearny Street" → "318 KEARNY ST". */
export function shortAddress(a: string): string {
  let s = a.trim();
  const m = s.match(/^([0-9][0-9A-Za-z-]*)(?:\s*[;,]\s*[0-9A-Za-z-]+)*\s+(.*)$/);
  if (m) s = `${m[1]} ${m[2]}`;
  s = s
    .replace(/\bStreet\b/i, 'St')
    .replace(/\bAvenue\b/i, 'Ave')
    .replace(/\bBoulevard\b/i, 'Blvd')
    .replace(/\bPlace\b/i, 'Pl')
    .replace(/\bAlley\b/i, 'Aly');
  return s.toUpperCase();
}

interface TagCand {
  i: number;
  x: number;
  z: number;
  area: number;
  label: string;
}

interface RoadSamples {
  name: string;
  pts: Float32Array; // x, y, z triples every ~8 m
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export interface CaptureOutput {
  jpegBase64: string;
  taggedBuildingIds: string[];
  ms: number;
}

export class FrameCapture {
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly cam = new THREE.PerspectiveCamera(30, FRAME_W / FRAME_H, 3, 9000);
  private readonly pixels = new Uint8Array(FRAME_W * FRAME_H * 4);
  private readonly canvas: HTMLCanvasElement;
  private readonly g2: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private roof: RoofGrid | null = null;
  private readonly tags: TagCand[] = [];
  private readonly roads: RoadSamples[] = [];
  private readonly widthCache = new Map<string, number>();
  private readonly v = new THREE.Vector3();
  /** Debug counters of the last capture. */
  debug = { tagCands: 0, tagOccluded: 0, streetCands: 0, streetOccluded: 0, streetOverlap: 0 };
  /** USGS origin time (ms epoch) of the running scenario, for the HUD clock. */
  originMs: number | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly engine: Engine,
    private readonly buildings: BuildingsHandle,
    private readonly grid: GridRect,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = FRAME_W;
    this.canvas.height = FRAME_H;
    this.g2 = this.canvas.getContext('2d', { willReadFrequently: false })!;
    this.image = this.g2.createImageData(FRAME_W, FRAME_H);
    const recs = ctx.city.buildings;
    recs.forEach((r, i) => {
      if (r.isPart || r.footprint.length < 3) return;
      const [x, z] = centroid(r.footprint);
      this.tags.push({ i, x, z, area: polygonArea(r.footprint), label: buildingLabel(r) });
    });
    const th = ctx.terrain;
    for (const road of ctx.city.roads) {
      if (!road.name || !STREET_KINDS.has(road.kind) || road.tunnel || road.points.length < 2) continue;
      const out: number[] = [];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      const push = (p: XZ) => {
        out.push(p[0], Math.max(th.heightAt(p[0], p[1]), 0) + 1, p[1]);
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]);
        maxZ = Math.max(maxZ, p[1]);
      };
      for (let k = 0; k + 1 < road.points.length; k++) {
        const a = road.points[k];
        const b = road.points[k + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 8));
        for (let s = 0; s < n; s++) push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
      }
      push(road.points[road.points.length - 1]);
      this.roads.push({ name: road.name.toUpperCase(), pts: Float32Array.from(out), minX, maxX, minZ, maxZ });
    }
  }

  /** Pre-build the occlusion raster (otherwise built on the first capture, ~50 ms). */
  warm(): void {
    this.roofGrid();
  }

  private roofGrid(): RoofGrid {
    if (!this.roof) this.roof = new RoofGrid(this.grid, this.ctx.city.buildings, (id) => this.buildings.indexOf(id));
    return this.roof;
  }

  /** Project world point → frame pixels; null if behind / outside (with margin). */
  private toScreen(x: number, y: number, z: number, margin = 0): [number, number] | null {
    const v = this.v.set(x, y, z).project(this.cam);
    if (v.z <= -1 || v.z >= 1) return null;
    const sx = (v.x + 1) * 0.5 * FRAME_W;
    const sy = (1 - v.y) * 0.5 * FRAME_H;
    if (sx < margin || sy < margin || sx > FRAME_W - margin || sy > FRAME_H - margin) return null;
    return [sx, sy];
  }

  private textW(font: string, s: string): number {
    const key = font + '|' + s;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      this.g2.font = font;
      w = this.g2.measureText(s).width;
      this.widthCache.set(key, w);
    }
    return w;
  }

  capture(pose: HeliPose, simS: number, frameIndex: number, hide: (THREE.Object3D | null | undefined)[]): CaptureOutput {
    const t0 = performance.now();
    this.renderPhase(pose, hide);
    this.ctx.renderer.readRenderTargetPixels(this.rt!, 0, 0, FRAME_W, FRAME_H, this.pixels);
    return this.finishPhase(pose, simS, frameIndex, t0);
  }

  /**
   * Integration: same as capture() but reads the pixels back asynchronously (PBO + fence), so the main thread
   * never drains the GPU queue (the sync readback cost ~150 ms in a busy quake scene). The scene is rendered
   * synchronously now; overlay + JPEG run once the pixels arrive. One capture at a time (shared target).
   */
  async captureAsync(pose: HeliPose, simS: number, frameIndex: number, hide: (THREE.Object3D | null | undefined)[]): Promise<CaptureOutput> {
    const t0 = performance.now();
    this.renderPhase(pose, hide);
    const renderMs = performance.now() - t0;
    await this.ctx.renderer.readRenderTargetPixelsAsync(this.rt!, 0, 0, FRAME_W, FRAME_H, this.pixels);
    const out = this.finishPhase(pose, simS, frameIndex, performance.now());
    out.ms += renderMs; // main-thread cost (excludes the GPU wait)
    return out;
  }

  private setCam(pose: HeliPose) {
    const cam = this.cam;
    cam.fov = pose.fovDeg;
    cam.aspect = FRAME_W / FRAME_H;
    cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(pose.cameraTarget[0], pose.cameraTarget[1], pose.cameraTarget[2]);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  private renderPhase(pose: HeliPose, hide: (THREE.Object3D | null | undefined)[]) {
    const r = this.ctx.renderer;
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(FRAME_W, FRAME_H, { type: THREE.UnsignedByteType, depthBuffer: true });
    }
    const cam = this.cam;
    this.setCam(pose);
    // ── Render (hide the helicopter itself and the veil/trail overlays) ──
    const vis: boolean[] = [];
    hide.forEach((o, k) => {
      vis[k] = o ? o.visible : false;
      if (o) o.visible = false;
    });
    const prev = r.getRenderTarget();
    try {
      if (this.engine.renderView) this.engine.renderView(cam, this.rt);
      else {
        r.setRenderTarget(this.rt);
        r.clear();
        r.render(this.ctx.scene, cam);
      }
    } finally {
      r.setRenderTarget(prev);
      hide.forEach((o, k) => {
        if (o) o.visible = vis[k];
      });
    }
  }

  private finishPhase(pose: HeliPose, simS: number, frameIndex: number, t0: number): CaptureOutput {
    this.setCam(pose);
    // GL rows are bottom-up.
    const dst = this.image.data;
    const row = FRAME_W * 4;
    for (let y = 0; y < FRAME_H; y++) dst.set(this.pixels.subarray((FRAME_H - 1 - y) * row, (FRAME_H - y) * row), y * row);
    const g = this.g2;
    g.putImageData(this.image, 0, 0);

    // ── AR overlay ──
    const roof = this.roofGrid();
    roof.refresh(this.buildings);
    const boxes: Box[] = [
      { x0: 0, y0: 0, x1: FRAME_W, y1: 52 },
      { x0: 0, y0: FRAME_H - 58, x1: FRAME_W, y1: FRAME_H },
      { x0: FRAME_W / 2 - 46, y0: FRAME_H / 2 - 46, x1: FRAME_W / 2 + 46, y1: FRAME_H / 2 + 46 },
    ];
    // Streets first (thin, few), then building tags fill the remaining space.
    this.drawStreets(pose, roof, boxes);
    const tagged = this.drawTags(pose, roof, boxes);
    this.drawHud(pose, simS, frameIndex);

    const url = this.canvas.toDataURL('image/jpeg', 0.8);
    const jpegBase64 = url.slice(url.indexOf(',') + 1);
    return { jpegBase64, taggedBuildingIds: tagged, ms: performance.now() - t0 };
  }

  private drawTags(pose: HeliPose, roof: RoofGrid, boxes: Box[]): string[] {
    const [cx, cy, cz] = pose.position;
    const recs = this.ctx.city.buildings;
    const cands: { t: TagCand; sx: number; sy: number; score: number; tier: number }[] = [];
    for (const t of this.tags) {
      const dx = t.x - cx;
      const dz = t.z - cz;
      const dh = dx * dx + dz * dz;
      if (dh > TAG_RANGE * TAG_RANGE) continue;
      const top = roof.roofTop(t.i) + 0.5;
      const d = Math.sqrt(dh + (top - cy) * (top - cy));
      if (d > TAG_RANGE) continue;
      const s = this.toScreen(t.x, top, t.z, 8);
      if (!s) continue;
      cands.push({ t, sx: s[0], sy: s[1], score: Math.sqrt(t.area) * (1 + recs[t.i].height / 40) / (d + 60), tier: roof.damageTier(t.i) });
    }
    // Declutter: collapsed / heavily damaged buildings keep their tags first (else their rubble gets blamed on neighbours).
    cands.sort((a, b) => b.tier - a.tier || b.score - a.score);
    const g = this.g2;
    const font = 'bold 10px ui-monospace, Menlo, Consolas, monospace';
    const out: string[] = [];
    const offsets: [number, number][] = [
      [12, -30],
      [-12, -30],
      [12, -50],
      [-12, -50],
      [16, -14],
      [-16, -14],
      [12, -70],
    ];
    const farOffsets: [number, number][] = [
      [24, -90],
      [-24, -90],
      [30, 6],
      [-30, 6],
      [12, -110],
      [-12, -110],
    ];
    let tested = 0;
    for (const c of cands) {
      if (out.length >= MAX_TAGS || (tested > 160 && c.tier === 0)) break;
      tested++;
      const top = roof.roofTop(c.t.i) + 0.5;
      if (roof.occluded(cx, cy, cz, c.t.x, top, c.t.z, roof.group[c.t.i], 3)) continue;
      const w = this.textW(font, c.t.label) + 12;
      const h = 15;
      let placed: Box | null = null;
      let dir = 1;
      for (const [ox, oy] of c.tier > 0 ? [...offsets, ...farOffsets] : offsets) {
        const x0 = ox >= 0 ? c.sx + ox : c.sx + ox - w;
        const y0 = c.sy + oy - h / 2;
        const b = { x0, y0, x1: x0 + w, y1: y0 + h };
        if (b.x0 < 4 || b.x1 > FRAME_W - 4 || b.y0 < 4 || b.y1 > FRAME_H - 4) continue;
        if (boxes.some((q) => overlaps(q, b))) continue;
        placed = b;
        dir = ox >= 0 ? 1 : -1;
        break;
      }
      if (!placed) continue;
      boxes.push(placed);
      out.push(recs[c.t.i].id);
      // Leader line + anchor dot.
      const lx = dir > 0 ? placed.x0 : placed.x1;
      const ly = (placed.y0 + placed.y1) / 2;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(c.sx, c.sy);
      g.lineTo(lx, ly);
      g.stroke();
      g.strokeStyle = 'rgba(120,235,255,0.95)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(c.sx, c.sy);
      g.lineTo(lx, ly);
      g.stroke();
      g.fillStyle = 'rgba(120,235,255,1)';
      g.beginPath();
      g.arc(c.sx, c.sy, 2.6, 0, Math.PI * 2);
      g.fill();
      // Pill.
      g.fillStyle = 'rgba(8,14,20,0.72)';
      roundRect(g, placed.x0, placed.y0, w, h, 7);
      g.fill();
      g.strokeStyle = 'rgba(120,235,255,0.55)';
      g.lineWidth = 1;
      g.stroke();
      g.font = font;
      g.fillStyle = '#ffffff';
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(c.t.label, placed.x0 + 6, ly + 0.5);
    }
    return out;
  }

  private drawStreets(pose: HeliPose, roof: RoofGrid, boxes: Box[]): void {
    const [cx, cy, cz] = pose.position;
    const font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
    const R = STREET_RANGE;
    type Cand = { name: string; len: number; mx: number; my: number; ang: number; wx: number; wy: number; wz: number };
    const best = new Map<string, Cand>();
    const sxs: number[] = [];
    const sys: number[] = [];
    const idx: number[] = [];
    for (const road of this.roads) {
      if (road.maxX < cx - R || road.minX > cx + R || road.maxZ < cz - R || road.minZ > cz + R) continue;
      const tw = this.textW(font, road.name);
      const p = road.pts;
      const n = p.length / 3;
      // Longest run of consecutive on-screen, in-range samples.
      let runStart = -1;
      const flush = (endExcl: number) => {
        if (runStart < 0) return;
        sxs.length = 0;
        sys.length = 0;
        idx.length = 0;
        for (let k = runStart; k < endExcl; k++) {
          const s = this.toScreen(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], 0);
          if (!s) continue;
          sxs.push(s[0]);
          sys.push(s[1]);
          idx.push(k);
        }
        runStart = -1;
        if (sxs.length < 2) return;
        let len = 0;
        const cum = [0];
        for (let k = 1; k < sxs.length; k++) {
          len += Math.hypot(sxs[k] - sxs[k - 1], sys[k] - sys[k - 1]);
          cum.push(len);
        }
        if (len < tw + 24) return;
        const prevBest = best.get(road.name);
        if (prevBest && prevBest.len >= len) return;
        const at = (s: number): [number, number, number] => {
          let k = 1;
          while (k < cum.length - 1 && cum[k] < s) k++;
          const f = (s - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]);
          return [sxs[k - 1] + (sxs[k] - sxs[k - 1]) * f, sys[k - 1] + (sys[k] - sys[k - 1]) * f, k - 1];
        };
        const mid = at(len / 2);
        const a = at(len / 2 - tw / 2);
        const b = at(len / 2 + tw / 2);
        let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        const wk = idx[mid[2]];
        best.set(road.name, { name: road.name, len, mx: mid[0], my: mid[1], ang, wx: p[wk * 3], wy: p[wk * 3 + 1], wz: p[wk * 3 + 2] });
      };
      for (let k = 0; k < n; k++) {
        const x = p[k * 3];
        const z = p[k * 3 + 2];
        const inRange = (x - cx) * (x - cx) + (z - cz) * (z - cz) < R * R;
        const on = inRange && this.toScreen(x, p[k * 3 + 1], z, 6) !== null;
        if (on) {
          if (runStart < 0) runStart = k;
        } else flush(k);
      }
      flush(n);
    }
    const list = [...best.values()].sort((a, b) => b.len - a.len);
    const g = this.g2;
    let drawn = 0;
    this.debug.streetCands = list.length;
    this.debug.streetOccluded = 0;
    this.debug.streetOverlap = 0;
    for (const c of list) {
      if (drawn >= MAX_STREETS) break;
      if (roof.occluded(cx, cy, cz, c.wx, c.wy + 25, c.wz, -1, 15)) {
        this.debug.streetOccluded++;
        continue;
      }
      const tw = this.textW(font, c.name);
      const hw = tw / 2 + 4;
      const hh = 8;
      const cosA = Math.abs(Math.cos(c.ang));
      const sinA = Math.abs(Math.sin(c.ang));
      const ex = hw * cosA + hh * sinA;
      const ey = hw * sinA + hh * cosA;
      const b = { x0: c.mx - ex, y0: c.my - ey, x1: c.mx + ex, y1: c.my + ey };
      if (boxes.some((q) => overlaps(q, b))) {
        this.debug.streetOverlap++;
        continue;
      }
      boxes.push(b);
      drawn++;
      g.save();
      g.translate(c.mx, c.my);
      g.rotate(c.ang);
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = 3.5;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.strokeText(c.name, 0, 0);
      g.fillStyle = '#ffd84a';
      g.fillText(c.name, 0, 0);
      g.restore();
    }
  }

  private drawHud(pose: HeliPose, simS: number, frameIndex: number): void {
    const g = this.g2;
    const W = FRAME_W;
    const H = FRAME_H;
    const font = (px: number) => `bold ${px}px ui-monospace, Menlo, Consolas, monospace`;
    const text = (s: string, x: number, y: number, align: CanvasTextAlign = 'left', px = 13, color = '#f2f6f8') => {
      g.font = font(px);
      g.textAlign = align;
      g.textBaseline = 'alphabetic';
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.strokeText(s, x, y);
      g.fillStyle = color;
      g.fillText(s, x, y);
    };
    const [px, py, pz] = pose.position;
    const [tx, ty, tz] = pose.cameraTarget;
    const [lat, lon] = unproject(px, pz);
    const [tlat, tlon] = unproject(tx, tz);
    const fmtLL = (la: number, lo: number) => `${Math.abs(la).toFixed(5)}${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(5)}${lo >= 0 ? 'E' : 'W'}`;
    const hdg = ((((pose.heading * 180) / Math.PI) % 360) + 360) % 360;
    const slant = Math.hypot(tx - px, ty - py, tz - pz);
    const zoom = 60 / Math.max(1, pose.fovDeg);

    text('AIR 1  SFPD', 16, 26, 'left', 16);
    text(`EO  ${pose.fovDeg > 25 ? 'WFOV' : 'NFOV'}  ${zoom.toFixed(1)}X   AR MAP ON`, 16, 44, 'left', 11, '#b8f3ff');

    // Clock.
    let l1 = `T+${simS.toFixed(1)}S`;
    let l2 = '';
    if (this.originMs !== null) {
      const d = new Date(this.originMs + simS * 1000);
      l1 = d.toISOString().replace('T', '  ').slice(0, 20) + 'Z';
      try {
        l2 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(d);
      } catch {
        l2 = '';
      }
    }
    text(l1, W - 16, 26, 'right', 13);
    if (l2) text(`${l2}  T+${simS.toFixed(0)}S`, W - 16, 44, 'right', 11, '#b8f3ff');

    // REC + frame index.
    g.fillStyle = Math.floor(simS * 2) % 2 === 0 ? '#ff3b30' : 'rgba(255,59,48,0.45)';
    g.beginPath();
    g.arc(W / 2 - 62, 21, 5, 0, Math.PI * 2);
    g.fill();
    text('REC', W / 2 - 52, 26, 'left', 13);
    text(`FRM ${String(frameIndex).padStart(5, '0')}`, W / 2 + 4, 26, 'left', 13);

    // Bottom-left: aircraft.
    text(`ALT ${Math.round(py * 3.28084)
      .toString()
      .padStart(4, ' ')} FT MSL   HDG ${Math.round(hdg).toString().padStart(3, '0')}°`, 16, H - 34, 'left', 13);
    text(`ACFT ${fmtLL(lat, lon)}`, 16, H - 15, 'left', 12, '#b8f3ff');
    // Bottom-right: target.
    text(`TGT ${fmtLL(tlat, tlon)}`, W - 16, H - 34, 'right', 13);
    text(`SLR ${(slant / 1852).toFixed(2)} NM   FOV ${pose.fovDeg.toFixed(1)}°   T+${pose.flightS.toFixed(0)}S FLT`, W - 16, H - 15, 'right', 12, '#b8f3ff');

    // Centre reticle.
    const cxs = W / 2;
    const cys = H / 2;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 3;
    const reticle = () => {
      g.beginPath();
      g.moveTo(cxs - 34, cys);
      g.lineTo(cxs - 10, cys);
      g.moveTo(cxs + 10, cys);
      g.lineTo(cxs + 34, cys);
      g.moveTo(cxs, cys - 34);
      g.lineTo(cxs, cys - 10);
      g.moveTo(cxs, cys + 10);
      g.lineTo(cxs, cys + 34);
      // Corner brackets.
      const b = 44;
      const l = 10;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        g.moveTo(cxs + sx * b, cys + sy * (b - l));
        g.lineTo(cxs + sx * b, cys + sy * b);
        g.lineTo(cxs + sx * (b - l), cys + sy * b);
      }
      g.stroke();
    };
    reticle();
    g.strokeStyle = 'rgba(240,250,255,0.9)';
    g.lineWidth = 1.3;
    reticle();
    // Frame corner marks.
    g.strokeStyle = 'rgba(240,250,255,0.6)';
    g.lineWidth = 1.5;
    g.beginPath();
    const m = 8;
    const L = 26;
    g.moveTo(m, m + L);
    g.lineTo(m, m);
    g.lineTo(m + L, m);
    g.moveTo(W - m - L, m);
    g.lineTo(W - m, m);
    g.lineTo(W - m, m + L);
    g.moveTo(m, H - m - L);
    g.lineTo(m, H - m);
    g.lineTo(m + L, H - m);
    g.moveTo(W - m - L, H - m);
    g.lineTo(W - m, H - m);
    g.lineTo(W - m, H - m - L);
    g.stroke();
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(x + r, y + h);
  g.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
  g.closePath();
}
