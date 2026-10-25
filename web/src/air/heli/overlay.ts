/**
 * Main-view-only overlays for AIR 1: route line (solid behind, dashed ahead), gimbal frustum lines and the
 * current camera footprint draped on the terrain. All on HELI_LAYER so the gimbal camera never sees them.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Heightfield, XZ } from '../../contracts';
import { groundAt, type RouteSamples } from './route';

const ACCENT = new THREE.Color(0.22, 0.82, 1.0);

const EDGE_SUB = 8; // subdivisions per footprint edge for draping
const FILL_RINGS = 4;

function lineMat(opts: { color: THREE.Color; width: number; opacity: number; dashed?: boolean; depthTest?: boolean }) {
  const m = new LineMaterial({
    color: opts.color.getHex(),
    linewidth: opts.width,
    transparent: true,
    opacity: opts.opacity,
    dashed: !!opts.dashed,
    dashSize: 14,
    gapSize: 10,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
  });
  m.fog = false;
  m.toneMapped = false;
  // Slight HDR boost so it glows with bloom without blowing out.
  m.color.copy(opts.color).multiplyScalar(1.25);
  return m;
}

/** Direct write into a LineSegmentsGeometry's interleaved instance buffer (start/end pairs). */
function writeSegments(geo: LineSegmentsGeometry, pts: ArrayLike<number>, count: number) {
  const attr = geo.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
  const arr = attr.data.array as Float32Array;
  for (let i = 0; i < count * 6 && i < arr.length; i++) arr[i] = pts[i];
  attr.data.needsUpdate = true;
  geo.instanceCount = count;
}

export interface HeliOverlay {
  object: THREE.Group;
  update(routeIdx: number, camPos: THREE.Vector3, footprint: XZ[], visible: boolean): void;
}

export function createOverlay(terrain: Heightfield, route: RouteSamples): HeliOverlay {
  const object = new THREE.Group();
  object.name = 'heli-overlay';

  // ── Route line at flight altitude (decimated to ~8 m). ──
  const dec = 4;
  const pts: number[] = [];
  for (let i = 0; i < route.n; i += dec) pts.push(route.x[i], route.y[i], route.z[i]);
  const last = route.n - 1;
  if (last % dec) pts.push(route.x[last], route.y[last], route.z[last]);
  const nPts = pts.length / 3;
  const rev: number[] = [];
  for (let i = nPts - 1; i >= 0; i--) rev.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);

  const behindGeo = new LineGeometry();
  behindGeo.setPositions(pts);
  const behind = new Line2(behindGeo, lineMat({ color: ACCENT, width: 2.2, opacity: 0.85 }));
  behind.frustumCulled = false;
  behind.renderOrder = 10;
  const aheadGeo = new LineGeometry();
  aheadGeo.setPositions(rev);
  const ahead = new Line2(aheadGeo, lineMat({ color: ACCENT, width: 1.6, opacity: 0.55, dashed: true }));
  ahead.computeLineDistances();
  ahead.frustumCulled = false;
  ahead.renderOrder = 10;
  object.add(behind, ahead);

  // ── Frustum: 4 lines camera → footprint corners. ──
  const frGeo = new LineSegmentsGeometry();
  frGeo.setPositions(new Float32Array(4 * 6));
  const frustum = new LineSegments2(frGeo, lineMat({ color: ACCENT, width: 1.1, opacity: 0.35 }));
  frustum.frustumCulled = false;
  frustum.renderOrder = 11;
  object.add(frustum);

  // ── Footprint outline (closed loop), draped. Two copies: depth-tested bright + see-through faint. ──
  const ringN = 8 * EDGE_SUB;
  const outGeo = new LineSegmentsGeometry();
  outGeo.setPositions(new Float32Array(ringN * 6));
  const outline = new LineSegments2(outGeo, lineMat({ color: ACCENT, width: 2.6, opacity: 0.95 }));
  const outlineXray = new LineSegments2(outGeo, lineMat({ color: ACCENT, width: 1.4, opacity: 0.3, depthTest: false }));
  for (const o of [outline, outlineXray]) {
    o.frustumCulled = false;
    o.renderOrder = 12;
    object.add(o);
  }

  // ── Footprint fill: concentric rings (centre → edge), draped. ──
  const vCount = 1 + FILL_RINGS * ringN;
  const fillPos = new Float32Array(vCount * 3);
  const fillAlpha = new Float32Array(vCount);
  const idx: number[] = [];
  for (let k = 0; k < ringN; k++) {
    const a = 1 + k;
    const b = 1 + ((k + 1) % ringN);
    idx.push(0, b, a);
  }
  for (let r = 1; r < FILL_RINGS; r++) {
    for (let k = 0; k < ringN; k++) {
      const k2 = (k + 1) % ringN;
      const a = 1 + (r - 1) * ringN + k;
      const b = 1 + (r - 1) * ringN + k2;
      const c = 1 + r * ringN + k;
      const d = 1 + r * ringN + k2;
      idx.push(a, b, c, b, d, c);
    }
  }
  for (let r = 0; r <= FILL_RINGS; r++) {
    const f = r / FILL_RINGS;
    const alpha = 0.35 + 0.65 * f * f; // brighter towards the edge
    if (r === 0) fillAlpha[0] = alpha;
    else for (let k = 0; k < ringN; k++) fillAlpha[1 + (r - 1) * ringN + k] = alpha;
  }
  const fillGeo = new THREE.BufferGeometry();
  fillGeo.setAttribute('position', new THREE.BufferAttribute(fillPos, 3));
  fillGeo.setAttribute('alpha', new THREE.BufferAttribute(fillAlpha, 1));
  fillGeo.setIndex(idx);
  const fillMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: ACCENT.clone().multiplyScalar(1.2) }, uOpacity: { value: 0.1 } },
    vertexShader: /* glsl */ `
      attribute float alpha; varying float vA;
      void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity; varying float vA;
      void main() { gl_FragColor = vec4(uColor, uOpacity * vA); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.frustumCulled = false;
  fill.renderOrder = 9;
  object.add(fill);

  // Scratch.
  const ring = new Float64Array(ringN * 2);
  const ringY = new Float64Array(ringN);
  const seg = new Float32Array(ringN * 6);
  const fr = new Float32Array(4 * 6);

  function update(routeIdx: number, camPos: THREE.Vector3, footprint: XZ[], visible: boolean) {
    object.visible = visible;
    if (!visible) return;
    const fi = routeIdx / dec;
    const k = Math.max(0, Math.min(nPts - 1, Math.floor(fi)));
    behindGeo.instanceCount = Math.max(0, k);
    aheadGeo.instanceCount = Math.max(0, nPts - 1 - k);

    // Subdivided, draped ring.
    const m = footprint.length;
    let p = 0;
    for (let e = 0; e < m; e++) {
      const [ax, az] = footprint[e];
      const [bx, bz] = footprint[(e + 1) % m];
      for (let s = 0; s < EDGE_SUB; s++) {
        const u = s / EDGE_SUB;
        const x = ax + (bx - ax) * u;
        const z = az + (bz - az) * u;
        ring[p * 2] = x;
        ring[p * 2 + 1] = z;
        ringY[p] = groundAt(terrain, x, z) + 2.5;
        p++;
      }
    }
    const n = p;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      seg.set([ring[i * 2], ringY[i], ring[i * 2 + 1], ring[j * 2], ringY[j], ring[j * 2 + 1]], i * 6);
    }
    writeSegments(outGeo, seg, n);

    // Frustum lines to the 4 corners (footprint indices 0, 2, 4, 6 when 8 points are given).
    const step = Math.max(1, Math.floor(m / 4));
    for (let c = 0; c < 4; c++) {
      const [x, z] = footprint[(c * step) % m];
      fr.set([camPos.x, camPos.y, camPos.z, x, groundAt(terrain, x, z) + 2.5, z], c * 6);
    }
    writeSegments(frGeo, fr, 4);

    // Fill: centroid + rings.
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2];
      cz += ring[i * 2 + 1];
    }
    cx /= n;
    cz /= n;
    fillPos[0] = cx;
    fillPos[1] = groundAt(terrain, cx, cz) + 1.5;
    fillPos[2] = cz;
    for (let r = 1; r <= FILL_RINGS; r++) {
      const f = r / FILL_RINGS;
      for (let i = 0; i < n; i++) {
        const x = cx + (ring[i * 2] - cx) * f;
        const z = cz + (ring[i * 2 + 1] - cz) * f;
        const v = 1 + (r - 1) * ringN + i;
        fillPos[v * 3] = x;
        fillPos[v * 3 + 1] = groundAt(terrain, x, z) + 1.5;
        fillPos[v * 3 + 2] = z;
      }
    }
    (fillGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  return { object, update };
}
