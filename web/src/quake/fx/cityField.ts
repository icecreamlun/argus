/**
 * City distance field for soft particles (this single-pass renderer has no scene depth texture to fade against):
 * a 4 m grid over the city storing, per cell, the horizontal distance to the nearest building footprint (m, < 0
 * inside one) and that building's roof elevation. A billboard fragment then knows roughly how far it is from the
 * nearest wall or roof and fades out before it cuts through one — no hard intersection lines.
 *
 * Footprints are rasterised once; the nearest-building map comes from a two-pass 8-neighbour vector
 * propagation (dead-reckoning EDT). Roof elevations can be updated cheaply (collapsed buildings are lower).
 */
import * as THREE from 'three';
import type { CityData, XZ } from '../../contracts';

const CELL = 4;
const MAX_D = 60;

export class CityField {
  readonly tex: THREE.DataTexture;
  /** minX, minZ, 1/sizeX, 1/sizeZ (texel-centre convention, like the height texture). */
  readonly rect: THREE.Vector4;
  private readonly w: number;
  private readonly h: number;
  /** Nearest building index per cell (−1: none in range) and distance (m, negative inside). */
  private readonly nearest: Int32Array;
  private readonly dist: Float32Array;
  private readonly data: Uint16Array;
  private readonly roof0: Float32Array;

  constructor(city: CityData, bounds: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    const w = Math.ceil((bounds.maxX - bounds.minX) / CELL) + 1;
    const h = Math.ceil((bounds.maxZ - bounds.minZ) / CELL) + 1;
    this.w = w;
    this.h = h;
    const n = w * h;
    const owner = new Int32Array(n).fill(-1);
    const B = city.buildings;
    this.roof0 = new Float32Array(B.length);
    const ox = bounds.minX;
    const oz = bounds.minZ;
    // ── Rasterise footprints (cell centres inside the ring; tallest wins) ──
    for (let b = 0; b < B.length; b++) {
      const rec = B[b];
      if ((rec.minHeight ?? 0) > 6) continue; // floating parts: not a wall at street level
      const ring = rec.footprint as XZ[];
      const top = rec.baseElevation + rec.height;
      this.roof0[b] = top;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const p of ring) {
        z0 = Math.min(z0, p[1]);
        z1 = Math.max(z1, p[1]);
      }
      const j0 = Math.max(0, Math.ceil((z0 - oz) / CELL - 0.5));
      const j1 = Math.min(h - 1, Math.floor((z1 - oz) / CELL - 0.5));
      const xs: number[] = [];
      for (let j = j0; j <= j1; j++) {
        const z = oz + (j + 0.5) * CELL;
        xs.length = 0;
        for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
          const za = ring[k][1];
          const zb = ring[i][1];
          if (za > z !== zb > z) xs.push(ring[k][0] + ((z - za) / (zb - za)) * (ring[i][0] - ring[k][0]));
        }
        xs.sort((a, c) => a - c);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil((xs[q] - ox) / CELL - 0.5));
          const i1 = Math.min(w - 1, Math.floor((xs[q + 1] - ox) / CELL - 0.5));
          for (let i = i0; i <= i1; i++) {
            const c = j * w + i;
            const o = owner[c];
            if (o < 0 || this.roof0[o] < top) owner[c] = b;
          }
        }
      }
    }
    // ── Vector-propagation EDT to the nearest occupied cell ──
    const sx = new Int32Array(n).fill(-1);
    const sz = new Int32Array(n).fill(-1);
    const d2 = new Float32Array(n).fill(Infinity);
    for (let c = 0; c < n; c++)
      if (owner[c] >= 0) {
        sx[c] = c % w;
        sz[c] = (c / w) | 0;
        d2[c] = 0;
      }
    const relax = (x: number, z: number, nxp: number, nzp: number) => {
      if (nxp < 0 || nzp < 0 || nxp >= w || nzp >= h) return;
      const nc = nzp * w + nxp;
      if (sx[nc] < 0) return;
      const c = z * w + x;
      const dx = x - sx[nc];
      const dz = z - sz[nc];
      const dd = dx * dx + dz * dz;
      if (dd < d2[c]) {
        d2[c] = dd;
        sx[c] = sx[nc];
        sz[c] = sz[nc];
      }
    };
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        relax(x, z, x - 1, z);
        relax(x, z, x - 1, z - 1);
        relax(x, z, x, z - 1);
        relax(x, z, x + 1, z - 1);
      }
      for (let x = w - 1; x >= 0; x--) relax(x, z, x + 1, z);
    }
    for (let z = h - 1; z >= 0; z--) {
      for (let x = w - 1; x >= 0; x--) {
        relax(x, z, x + 1, z);
        relax(x, z, x + 1, z + 1);
        relax(x, z, x, z + 1);
        relax(x, z, x - 1, z + 1);
      }
      for (let x = 0; x < w; x++) relax(x, z, x - 1, z);
    }
    this.nearest = new Int32Array(n).fill(-1);
    this.dist = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      if (owner[c] >= 0) {
        this.nearest[c] = owner[c];
        this.dist[c] = -CELL * 0.5;
      } else if (sx[c] >= 0) {
        this.nearest[c] = owner[sz[c] * w + sx[c]];
        this.dist[c] = Math.min(MAX_D, Math.sqrt(d2[c]) * CELL - CELL * 0.5);
      } else this.dist[c] = MAX_D;
    }
    this.data = new Uint16Array(n * 2);
    const tex = new THREE.DataTexture(this.data, w, h, THREE.RGFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex = tex;
    this.rect = new THREE.Vector4(ox, oz, 1 / (w * CELL), 1 / (h * CELL));
    this.setRoofs(null);
  }

  /** Roof elevation per building (null = original heights); collapsed buildings pass their rubble top. */
  setRoofs(roof: Float32Array | null): void {
    const half = THREE.DataUtils.toHalfFloat;
    const R = roof ?? this.roof0;
    for (let c = 0; c < this.nearest.length; c++) {
      const b = this.nearest[c];
      this.data[c * 2] = half(this.dist[c]);
      this.data[c * 2 + 1] = half(b >= 0 ? R[b] : -100);
    }
    this.tex.needsUpdate = true;
  }

  get originalRoofs(): Float32Array {
    return this.roof0;
  }
}

/** GLSL: uniform uCityTex / uCityRect → vec2(horizontal distance to nearest footprint, its roof elevation). */
export const CITY_FIELD_GLSL = /* glsl */ `
uniform sampler2D uCityTex;
uniform vec4 uCityRect;
/** Approximate distance (m) from a world point to the nearest building volume. */
float cityClearance( vec3 p ) {
	vec2 f = texture2D( uCityTex, ( p.xz - uCityRect.xy ) * uCityRect.zw ).rg;
	float dV = p.y - f.g;
	if ( f.r <= 0.0 ) return max( dV, 0.0 );
	return dV > 0.0 ? length( vec2( f.r, dV ) ) : f.r;
}
`;
