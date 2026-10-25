"""Terrarium tile mosaic + vectorised bilinear sampler (lat/lon -> metres, NAVD88 per USGS 3DEP)."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from fetch import CACHE, TERRAIN_ZOOM, terrain_tile_range

TILE = 256


class TerrariumMosaic:
    def __init__(self, zoom: int = TERRAIN_ZOOM):
        self.z = zoom
        x0, y0, x1, y1 = terrain_tile_range(zoom)
        self.x0, self.y0 = x0, y0
        w, h = (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE
        self.elev = np.zeros((h, w), dtype=np.float64)
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                p = CACHE / 'terrarium' / str(zoom) / str(tx) / f'{ty}.png'
                if not p.exists():
                    raise FileNotFoundError(f'{p} missing — run fetch.py terrain')
                rgb = np.asarray(Image.open(p).convert('RGB'), dtype=np.float64)
                e = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
                oy, ox = (ty - y0) * TILE, (tx - x0) * TILE
                self.elev[oy:oy + TILE, ox:ox + TILE] = e
        assert np.isfinite(self.elev).all()

    def pixel(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Global Web-Mercator pixel coords at this zoom, relative to the mosaic's top-left; pixel centres at +0.5."""
        n = TILE * 2**self.z
        px = (lon + 180.0) / 360.0 * n
        latr = np.radians(lat)
        py = (1.0 - np.log(np.tan(latr) + 1.0 / np.cos(latr)) / math.pi) / 2.0 * n
        return px - self.x0 * TILE - 0.5, py - self.y0 * TILE - 0.5

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        px, py = self.pixel(np.asarray(lat, float), np.asarray(lon, float))
        h, w = self.elev.shape
        c0 = np.clip(np.floor(px).astype(int), 0, w - 2)
        r0 = np.clip(np.floor(py).astype(int), 0, h - 2)
        tx = np.clip(px - c0, 0, 1)
        ty = np.clip(py - r0, 0, 1)
        e = self.elev
        top = e[r0, c0] * (1 - tx) + e[r0, c0 + 1] * tx
        bot = e[r0 + 1, c0] * (1 - tx) + e[r0 + 1, c0 + 1] * tx
        return top * (1 - ty) + bot * ty
