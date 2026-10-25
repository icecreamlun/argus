"""Build public/data/terrain.json + terrain.bin from AWS Terrain Tiles (Terrarium, z15 ≈ 3.8 m/px).

Grid: cellSize 4 m, row 0 = north edge (minZ), columns west -> east, Float32 LE, row-major.
Elevations are metres NAVD88 (as delivered by USGS 3DEP); local MSL ≈ NAVD88 + 0.9 m at the SF tide gauge,
so the engine's y = 0 water plane sits near mean lower-low water.

Cleanup (all documented in SOURCES.md):
  * land mask = OSM mainland coastline polygon ∪ closed island rings ∪ wide, non-floating OSM piers
  * land: light Gaussian smoothing (σ = 0.75 cell) to kill tile/pixel noise while keeping real slopes; clamped ≥ 1.6 m
  * piers: flattened to one deck elevation per pier (median DEM, clamped 2.4–3.6 m)
  * water: stronger smoothing (σ = 2.5 cells) to remove coarse bathymetry blocks; clamped ≤ −1.5 m,
    ≤ −3 m for the first water ring next to land (crisp seawall edge, no smeared shoreline)
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from matplotlib.path import Path as MplPath
from scipy import ndimage

from fetch import CACHE
from geo import project, unproject
from terrarium import TerrariumMosaic

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent.parent / 'public' / 'data'

# Grid extent (world metres). Context bbox is x -1585..1585, z -1165..1110; margins ≥ 1.2 km on every side,
# ~2 km to the east / north-east so the bay (and Yerba Buena Island) extend under the camera.
CELL = 4.0
MIN_X, MAX_X = -2800.0, 3600.0
MIN_Z, MAX_Z = -2800.0, 2400.0

PIER_MIN_WIDTH = 18.0  # m — narrower piers (e.g. Pier 7, fishing piers) stay over water, rendered as decks


@dataclass
class Terrain:
    minX: float
    minZ: float
    cell: float
    cols: int
    rows: int
    data: np.ndarray  # (rows, cols) float32

    def height_at(self, x, z):
        """Exact replica of src/terrain/heightfield.ts heightAt (clamped bilinear)."""
        x = np.asarray(x, float)
        z = np.asarray(z, float)
        fc = (x - self.minX) / self.cell
        fr = (z - self.minZ) / self.cell
        c0 = np.floor(fc).astype(int)
        r0 = np.floor(fr).astype(int)
        tx = fc - c0
        tz = fr - r0
        d = self.data

        def s(c, r):
            return d[np.clip(r, 0, self.rows - 1), np.clip(c, 0, self.cols - 1)].astype(float)

        h00, h10, h01, h11 = s(c0, r0), s(c0 + 1, r0), s(c0, r0 + 1), s(c0 + 1, r0 + 1)
        return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz


def _ring_xz(geom: list[dict]) -> np.ndarray:
    return np.array([project(p['lat'], p['lon']) for p in geom])


def _mainland_polygon(coast_ways: list[dict]) -> np.ndarray:
    """Chain open coastline ways end-to-start into one line (land on the left), close it through the far
    south-west so the polygon encloses the San Francisco peninsula."""
    open_ways = [w for w in coast_ways if (w['geometry'][0]['lat'], w['geometry'][0]['lon']) != (w['geometry'][-1]['lat'], w['geometry'][-1]['lon'])]
    by_start = {(w['geometry'][0]['lat'], w['geometry'][0]['lon']): w for w in open_ways}
    ends = {(w['geometry'][-1]['lat'], w['geometry'][-1]['lon']) for w in open_ways}
    heads = [w for k, w in by_start.items() if k not in ends]
    assert len(heads) == 1, f'expected one chain head, got {len(heads)}'
    chain: list[dict] = []
    w = heads[0]
    seen = set()
    while w is not None and w['id'] not in seen:
        seen.add(w['id'])
        chain.extend(w['geometry'] if not chain else w['geometry'][1:])
        w = by_start.get((w['geometry'][-1]['lat'], w['geometry'][-1]['lon']))
    assert len(seen) == len(open_ways), 'coastline chain is broken'
    pts = [project(p['lat'], p['lon']) for p in chain]
    end, start = pts[-1], pts[0]
    # Walk the chain: south (Mission Bay) -> north along the Embarcadero -> west along the north shore.
    # Close through points well outside the grid on the land side.
    pts += [(end[0] - 5000, end[1]), (end[0] - 5000, start[1] + 8000), (start[0], start[1] + 8000)]
    return np.array(pts)


def _mean_width(ring: np.ndarray, area: float) -> float:
    """Characteristic width 2A/P — equals the width of a long thin strip, robust to T-heads and kinks."""
    perim = float(np.hypot(*np.diff(ring, axis=0).T).sum())
    return 2 * area / max(perim, 1e-6)


def load_piers() -> list[dict]:
    """Closed OSM pier polygons over the terrain bbox: {id, name, ring(xz), floating, area, width}."""
    js = json.loads((CACHE / 'osm_coast.json').read_text())
    out = []
    for e in js['elements']:
        t = e.get('tags', {})
        if e['type'] != 'way' or t.get('man_made') != 'pier':
            continue
        g = e['geometry']
        if (g[0]['lat'], g[0]['lon']) != (g[-1]['lat'], g[-1]['lon']) or len(g) < 4:
            continue
        ring = _ring_xz(g)
        area = 0.5 * abs(np.dot(ring[:-1, 0], ring[1:, 1]) - np.dot(ring[1:, 0], ring[:-1, 1]))
        out.append(dict(id=e['id'], name=t.get('name'), ring=ring, floating=t.get('floating') == 'yes', area=area,
                        width=_mean_width(ring, area)))
    return out


# Structures that leaked into the bare-earth DEM: (x, z, inner radius, outer radius) in world metres.
# Inside the inner radius the DEM is replaced by the median of the surrounding ring, blended out to the outer radius.
DEM_ARTIFACTS = [
    (-688.8, -986.7, 20.0, 34.0),  # Coit Tower base (+4.5 m bump over the Pioneer Park summit, ~86.7 m NAVD88)
]


def flatten_artifacts(out: np.ndarray, X: np.ndarray, Z: np.ndarray) -> None:
    for x, z, r0, r1 in DEM_ARTIFACTS:
        d = np.hypot(X - x, Z - z)
        ring = (d >= r1) & (d < r1 + 10)
        level = float(np.median(out[ring]))
        w = np.clip((r1 - d) / (r1 - r0), 0, 1)  # 1 inside r0, 0 beyond r1
        m = d < r1
        out[m] = np.minimum(out[m], level * w[m] + out[m] * (1 - w[m]))
        print(f'[terrain] flattened DEM artifact at ({x:.0f}, {z:.0f}) to {level:.1f} m')


def build() -> Terrain:
    cols = int(round((MAX_X - MIN_X) / CELL)) + 1
    rows = int(round((MAX_Z - MIN_Z) / CELL)) + 1
    xs = MIN_X + np.arange(cols) * CELL
    zs = MIN_Z + np.arange(rows) * CELL
    X, Z = np.meshgrid(xs, zs)  # (rows, cols); row 0 = north (minZ)
    lat, lon = unproject(X, Z)
    dem = TerrariumMosaic().sample(lat, lon)
    print(f'[terrain] grid {cols}x{rows} @ {CELL} m, raw DEM {dem.min():.1f}..{dem.max():.1f}')

    # ── land / water mask
    js = json.loads((CACHE / 'osm_coast.json').read_text())
    coast = [e for e in js['elements'] if e['type'] == 'way' and e.get('tags', {}).get('natural') == 'coastline']
    pts = np.column_stack([X.ravel(), Z.ravel()])
    land = MplPath(_mainland_polygon(coast)).contains_points(pts).reshape(X.shape)
    for w in coast:
        g = w['geometry']
        if (g[0]['lat'], g[0]['lon']) == (g[-1]['lat'], g[-1]['lon']):
            ring = _ring_xz(g)
            land |= MplPath(ring).contains_points(pts).reshape(X.shape)

    # ── piers: wide, fixed piers become flat land decks
    pier_mask = np.zeros_like(land)
    decks: list[tuple[np.ndarray, float]] = []
    for p in load_piers():
        if p['floating'] or p['width'] < PIER_MIN_WIDTH or p['area'] < 150:
            continue
        m = MplPath(p['ring']).contains_points(pts).reshape(X.shape)
        if not m.any():
            continue
        vals = dem[m]
        deck = float(np.clip(np.median(vals[vals > 0.5]) if (vals > 0.5).any() else 3.0, 2.4, 3.6))
        decks.append((m, deck))
        pier_mask |= m
    land |= pier_mask

    # ── smoothing (separately for land and water so the shoreline is not smeared)
    def masked_gauss(a: np.ndarray, mask: np.ndarray, sigma: float) -> np.ndarray:
        w = ndimage.gaussian_filter(mask.astype(float), sigma, mode='nearest')
        v = ndimage.gaussian_filter(np.where(mask, a, 0.0), sigma, mode='nearest')
        out = a.copy()
        ok = w > 1e-3
        out[ok & mask] = (v[ok & mask] / w[ok & mask])
        return out

    land_s = masked_gauss(dem, land, 0.75)
    water_s = masked_gauss(dem, ~land, 2.5)
    out = np.where(land, np.maximum(land_s, 1.6), np.minimum(water_s, -1.5))
    # First ring of water cells next to land: crisp seawall drop.
    ring = (~land) & ndimage.binary_dilation(land, iterations=1)
    out[ring] = np.minimum(out[ring], -3.0)
    for m, deck in decks:
        out[m] = deck
    flatten_artifacts(out, X, Z)
    out = out.astype(np.float32)
    assert np.isfinite(out).all()
    print(f'[terrain] land {land.mean() * 100:.1f}%  piers burned {len(decks)}  final {out.min():.1f}..{out.max():.1f}')
    return Terrain(MIN_X, MIN_Z, CELL, cols, rows, out)


def write(t: Terrain) -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    meta = dict(
        minX=t.minX, minZ=t.minZ, cellSize=t.cell, cols=t.cols, rows=t.rows,
        minElevation=round(float(t.data.min()), 3), maxElevation=round(float(t.data.max()), 3),
        source='AWS Terrain Tiles (Terrarium z15; USGS 3DEP / NOAA bathymetry), metres NAVD88; '
               'OSM coastline land mask; piers flattened to deck level',
    )
    binp, jsp = PUBLIC / 'terrain.bin', PUBLIC / 'terrain.json'
    # Write both temps first, then swap in the bin before the json (readers fetch json then bin).
    (PUBLIC / 'terrain.bin.tmp').write_bytes(t.data.astype('<f4').tobytes())
    (PUBLIC / 'terrain.json.tmp').write_text(json.dumps(meta, indent=1))
    os.replace(PUBLIC / 'terrain.bin.tmp', binp)
    os.replace(PUBLIC / 'terrain.json.tmp', jsp)
    print(f'[terrain] wrote {binp} ({binp.stat().st_size / 1e6:.1f} MB) + {jsp.name}')


def load_written() -> Terrain:
    meta = json.loads((PUBLIC / 'terrain.json').read_text())
    data = np.frombuffer((PUBLIC / 'terrain.bin').read_bytes(), dtype='<f4').reshape(meta['rows'], meta['cols'])
    return Terrain(meta['minX'], meta['minZ'], meta['cellSize'], meta['cols'], meta['rows'], data)


if __name__ == '__main__':
    write(build())
