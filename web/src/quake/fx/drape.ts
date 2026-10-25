/**
 * Terrain-draped surfaces shared by the wave fronts and the ShakeMap field, plus a half-float terrain
 * height texture for shader-side ground fades.
 *
 * The drape is a tensor-product grid: 10 m spacing over the city (context box + margin), growing
 * geometrically toward the edge of the terrain data so it still reaches ~3 km out over the bay without
 * a huge vertex count. Vertices sit `lift` metres above max(terrain, sea level); materials also use a
 * polygon offset, so the overlay never z-fights the ground and never cuts through hills.
 */
import * as THREE from 'three';
import type { Heightfield } from '../../contracts';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function axis(min: number, max: number, fineMin: number, fineMax: number, fine: number, coarse: number): number[] {
  const out: number[] = [];
  const f0 = Math.max(min, fineMin);
  const f1 = Math.min(max, fineMax);
  const n = Math.max(1, Math.round((f1 - f0) / fine));
  for (let i = 0; i <= n; i++) out.push(f0 + ((f1 - f0) * i) / n);
  // Grow outward.
  let s = fine;
  let x = f0;
  const left: number[] = [];
  while (x > min + 1e-3) {
    s = Math.min(coarse, s * 1.22);
    x = Math.max(min, x - s);
    left.push(x);
  }
  s = fine;
  x = f1;
  const right: number[] = [];
  while (x < max - 1e-3) {
    s = Math.min(coarse, s * 1.22);
    x = Math.min(max, x + s);
    right.push(x);
  }
  return [...left.reverse(), ...out, ...right];
}

export function terrainRect(t: Heightfield): Rect {
  const m = t.meta;
  return { minX: m.minX, minZ: m.minZ, maxX: m.minX + (m.cols - 1) * m.cellSize, maxZ: m.minZ + (m.rows - 1) * m.cellSize };
}

/** Draped grid geometry (positions in world space; uv = normalised position in `rect`). */
export function buildDrapeGeometry(terrain: Heightfield, rect: Rect, liftLand = 1.1, liftWater = 0.45): THREE.BufferGeometry {
  const xs = axis(rect.minX, rect.maxX, -1850, 1850, 10, 90);
  const zs = axis(rect.minZ, rect.maxZ, -1450, 1400, 10, 90);
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  let k = 0;
  let u = 0;
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      // Take the max of a few nearby samples so the plane stays above sharp terrain features between vertices.
      const h = Math.max(
        terrain.heightAt(x, z),
        terrain.heightAt(x + 3, z),
        terrain.heightAt(x - 3, z),
        terrain.heightAt(x, z + 3),
        terrain.heightAt(x, z - 3),
      );
      const y = h > 0.2 ? h + liftLand : Math.max(h, 0) + liftWater;
      pos[k++] = x;
      pos[k++] = y;
      pos[k++] = z;
      uv[u++] = (x - rect.minX) / (rect.maxX - rect.minX);
      uv[u++] = (z - rect.minZ) / (rect.maxZ - rect.minZ);
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[q++] = a;
      idx[q++] = c;
      idx[q++] = b;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export interface HeightTexture {
  tex: THREE.DataTexture;
  /** minX, minZ, 1/sizeX, 1/sizeZ in texel-centre convention (for uHeightRect). */
  rect: THREE.Vector4;
}

/** Half-float height texture (max(terrain, 0)) at `cell` metres over `rect`, linear filtered. */
export function buildHeightTexture(terrain: Heightfield, rect: Rect, cell = 8): HeightTexture {
  const w = Math.ceil((rect.maxX - rect.minX) / cell) + 1;
  const h = Math.ceil((rect.maxZ - rect.minZ) / cell) + 1;
  const data = new Uint16Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const y = terrain.heightAt(rect.minX + i * cell, rect.minZ + j * cell);
      data[j * w + i] = THREE.DataUtils.toHalfFloat(Math.max(y, 0));
    }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, rect: new THREE.Vector4(rect.minX - cell / 2, rect.minZ - cell / 2, 1 / (w * cell), 1 / (h * cell)) };
}

/** GLSL helpers matching buildHeightTexture (uniform uHeightTex + uHeightRect = minX, minZ, 1/sizeX, 1/sizeZ). */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightRect;
float groundAt( vec2 xz ) {
	vec2 uv = ( xz - uHeightRect.xy ) * uHeightRect.zw;
	return texture2D( uHeightTex, uv ).r;
}
`;
