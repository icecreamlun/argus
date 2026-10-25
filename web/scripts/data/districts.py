"""Neighbourhood polygons, the ~1849 Yerba Buena Cove shoreline (bay fill) and a Vs30 proxy, all in world metres.

Every polygon corner is a real street intersection computed from the OSM centrelines (streets_index.isect), so the
boundaries follow the actual grid (the north-of-Market grid is rotated ~9 deg from true north)."""
from __future__ import annotations

import math
from functools import lru_cache

from shapely.geometry import LineString, Point, Polygon
from shapely.prepared import prep

from streets_index import isect, street

FAR = 4000.0  # m — used to close polygons well outside the data area


def _extend(a: tuple[float, float], b: tuple[float, float], to: float, axis: int) -> tuple[float, float]:
    """Point on the line a->b (extended) whose coordinate `axis` (0 = x, 1 = z) equals `to`."""
    t = (to - a[axis]) / (b[axis] - a[axis])
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


@lru_cache(maxsize=1)
def corners() -> dict[str, tuple[float, float]]:
    c = {
        'bush_kearny': isect('Bush Street', 'Kearny Street'),
        'bush_powell': isect('Bush Street', 'Powell Street'),
        'broadway_kearny': isect('Broadway', 'Kearny Street'),
        'broadway_powell': isect('Broadway', 'Powell Street'),
        'broadway_sansome': isect('Broadway', 'Sansome Street'),
        'broadway_embarcadero': isect('Broadway', 'The Embarcadero'),
        'washington_kearny': isect('Washington Street', 'Kearny Street'),
        'washington_sansome': isect('Washington Street', 'Sansome Street'),
        'market_kearny': isect('Market Street', 'Kearny Street'),
        # Market St stops at the Embarcadero plaza without touching the roadway; use the brief's surveyed point.
        'market_embarcadero': (273.0, -89.0),
        'lombard_sansome': isect('Lombard Street', 'Sansome Street'),
    }
    return c


@lru_cache(maxsize=1)
def district_polygons() -> dict[str, Polygon]:
    c = corners()
    west = -FAR
    north = -FAR
    bush_w = _extend(c['bush_kearny'], c['bush_powell'], west, 0)
    broadway_w = _extend(c['broadway_kearny'], c['broadway_powell'], west, 0)
    powell_n = _extend(c['bush_powell'], c['broadway_powell'], north, 1)
    sansome_n = _extend(c['broadway_sansome'], c['lombard_sansome'], north, 1)
    polys = {
        # Bush -> Broadway, Kearny -> Powell (the brief's definition of Chinatown).
        'chinatown': [c['bush_kearny'], c['broadway_kearny'], c['broadway_powell'], c['bush_powell']],
        # Jackson Square historic district: Washington -> Broadway, Kearny/Columbus -> Sansome.
        'jackson_square': [c['washington_kearny'], c['broadway_kearny'], c['broadway_sansome'], c['washington_sansome']],
        # Financial District incl. Golden Gateway: Market -> Washington (Kearny..Sansome) / Broadway (east of Sansome).
        'fidi': [c['market_kearny'], c['washington_kearny'], c['washington_sansome'], c['broadway_sansome'],
                 c['broadway_embarcadero'], c['market_embarcadero']],
        # Nob Hill wedge west of Powell between Bush and Broadway.
        'nob_hill': [c['bush_powell'], c['broadway_powell'], broadway_w, bush_w],
        # North Beach + Telegraph Hill: north of Broadway between Powell and Sansome.
        'north_beach': [c['broadway_powell'], c['broadway_kearny'], c['broadway_sansome'], sansome_n, powell_n],
        # North-east waterfront (Levi's Plaza, Pier 9-33 bulkheads): north of Broadway, east of Sansome.
        'embarcadero_ne': [c['broadway_sansome'], c['broadway_embarcadero'], (c['broadway_embarcadero'][0] + FAR, north),
                           sansome_n],
    }
    return {k: Polygon(v).buffer(0) for k, v in polys.items()}


@lru_cache(maxsize=1)
def _prepared():
    return {k: prep(p) for k, p in district_polygons().items()}


@lru_cache(maxsize=1)
def _embarcadero_line():
    return street('The Embarcadero')


def _south_of_market(x: float, z: float) -> bool:
    c = corners()
    (x0, z0), (x1, z1) = c['market_embarcadero'], c['market_kearny']
    dx, dz = x1 - x0, z1 - z0
    return dx * (z - z0) - dz * (x - x0) < 0


def classify(x: float, z: float, on_pier: bool = False) -> str:
    """District for a building centroid.  Waterfront strip first (within 100 m of The Embarcadero, or on a pier)."""
    p = Point(x, z)
    if on_pier or _embarcadero_line().distance(p) <= 100:
        return 'embarcadero'
    pr = _prepared()
    for k in ('chinatown', 'jackson_square', 'fidi', 'nob_hill', 'north_beach', 'embarcadero_ne'):
        if pr[k].contains(p):
            return 'embarcadero' if k == 'embarcadero_ne' else k
    if _south_of_market(x, z):
        return 'soma'
    return 'other'


# ───────────────────────────── historic shoreline / fill ─────────────────────────────

@lru_cache(maxsize=1)
def historic_shoreline() -> list[tuple[float, float]]:
    """~1849 Yerba Buena Cove shoreline, north -> south (see SOURCES.md).  Telegraph Hill's east foot (Sansome),
    Clark's Point (Battery & Broadway), along Montgomery St to Bush, south-east past 2nd/1st & Market to
    Fremont & Folsom, Rincon Point (Harrison & Spear), then south-west along the Mission Bay shore past 2nd & Bryant."""
    pts = [
        isect('Lombard Street', 'Sansome Street'),
        isect('Green Street', 'Sansome Street'),
        isect('Vallejo Street', 'Battery Street'),
        isect('Broadway', 'Battery Street'),  # Clark's Point
        isect('Jackson Street', 'Montgomery Street'),
        isect('Bush Street', 'Montgomery Street'),
        isect('Market Street', '2nd Street'),
        isect('Mission Street', '1st Street'),
        isect('Folsom Street', 'Fremont Street'),
        isect('Harrison Street', 'Spear Street'),  # Rincon Point
        isect('Bryant Street', '2nd Street'),
    ]
    # Extend both ends straight on so the fill polygon closes well outside the study area.
    n0, n1 = pts[0], pts[1]
    north_end = _extend(n1, n0, -1500.0, 1)
    s0, s1 = pts[-2], pts[-1]
    south_end = (s1[0] - 250.0, s1[1] + 250.0)
    out = [north_end] + pts + [south_end]
    return [(round(x, 1), round(z, 1)) for x, z in out]


@lru_cache(maxsize=1)
def fill_polygon() -> Polygon:
    line = historic_shoreline()
    (nx, nz), (sx, sz) = line[0], line[-1]
    ring = line + [(sx, sz + FAR), (FAR * 2, sz + FAR), (FAR * 2, -FAR * 2), (nx, -FAR * 2)]
    return Polygon(ring).buffer(0)


@lru_cache(maxsize=1)
def _fill_prepared():
    return prep(fill_polygon())


@lru_cache(maxsize=1)
def _shore_line() -> LineString:
    return LineString(historic_shoreline())


def on_fill(x: float, z: float) -> bool:
    return _fill_prepared().contains(Point(x, z))


COIT = (-689.0, -987.0)


def vs30(x: float, z: float, ground: float, filled: bool) -> float:
    """Vs30 proxy (m/s), loosely following the Wills et al. (2015) California site-condition map:
       * artificial fill over Young Bay Mud: 230 m/s at the old shoreline falling to ~180 m/s offshore of it
         (thicker fill and mud further out in the cove);
       * native dune sand / Colma Fm. near sea level ≈ 330 m/s, stiffening with elevation as the Franciscan
         sandstone/shale of Nob Hill and Telegraph Hill comes closer to the surface (~4.6 m/s per metre);
       * Telegraph Hill rock outcrop (≤ 450 m from the summit, above 35 m): ≥ 700 m/s."""
    if filled:
        d = _shore_line().distance(Point(x, z))
        return round(180.0 + 50.0 * math.exp(-d / 120.0), 0)
    v = 330.0 + 4.6 * max(0.0, ground - 6.0)
    if math.hypot(x - COIT[0], z - COIT[1]) < 450 and ground > 35:
        v = max(v, 700.0 + 2.0 * (ground - 35.0))
    return round(min(max(v, 300.0), 800.0), 0)


if __name__ == '__main__':
    for k, (x, z) in {'ferry': (401, -224), 'transamerica': (-421, -186), 'sentinel': (-573, -322),
                      'portsmouth': (-673, -150), 'grant_wash': (-762, -230), 'old_st_marys': (-682, 83),
                      'dragon_gate': (-675, 319), 'coit': (-689, -987), 'ec4': (70, -166), 'bay_bridge': (846, 910),
                      'union_sq': (-800, 600), 'nob': (-1300, 100)}.items():
        f = on_fill(x, z)
        print(f'{k:14s} {classify(x, z):15s} fill={f}')
    print(historic_shoreline())
