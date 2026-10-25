"""DataSF joins: Building Footprints with 2010 LiDAR zonal stats (ynuv-fyni), Assessor secured roll (wv5m-vpq2),
Soft-Story program (beah-shgi).  Everything is converted to world metres and indexed with shapely STRtrees."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache

from shapely.geometry import MultiPolygon, Point, Polygon, shape
from shapely.ops import transform
from shapely.strtree import STRtree

import numpy as np

from fetch import CACHE
from geo import CITY_ORIGIN, M_PER_DEG_LAT, M_PER_DEG_LON, project

SQFT = 0.09290304


def _proj(lon, lat, _z=None):
    """shapely.ops.transform callback: (lon, lat) sequences -> (x, z) world metres (project() is affine)."""
    lon, lat = np.asarray(lon, float), np.asarray(lat, float)
    x = (lon - CITY_ORIGIN['lon']) * M_PER_DEG_LON
    z = -(lat - CITY_ORIGIN['lat']) * M_PER_DEG_LAT
    return x, z


def _to_xz(geom):
    return transform(_proj, geom)


def _f(v, scale=1.0):
    try:
        x = float(v)
        return x * scale
    except (TypeError, ValueError):
        return None


# ───────────────────────────── LiDAR footprints ─────────────────────────────

@dataclass
class LidarFootprint:
    geom: Polygon | MultiPolygon
    mblr: str  # 'SF0166004' -> block 0166 lot 004
    hgt_median: float | None  # m above ground (median of the LiDAR height surface in the footprint)
    hgt_max: float | None
    gnd_min: float | None  # NAVD88 m
    area: float = 0.0


@lru_cache(maxsize=1)
def lidar() -> tuple[list[LidarFootprint], STRtree]:
    rows = json.loads((CACHE / 'datasf_footprints.json').read_text())
    out: list[LidarFootprint] = []
    for r in rows:
        if not r.get('shape'):
            continue
        g = _to_xz(shape(r['shape']))
        if not g.is_valid:
            g = g.buffer(0)
        if g.is_empty:
            continue
        out.append(LidarFootprint(
            geom=g,
            mblr=r.get('mblr') or '',
            hgt_median=_f(r.get('hgt_mediancm'), 0.01),
            hgt_max=_f(r.get('hgt_maxcm'), 0.01),
            gnd_min=_f(r.get('gnd_min_m')),
            area=g.area,
        ))
    return out, STRtree([f.geom for f in out])


@dataclass
class LidarMatch:
    height: float | None  # area-weighted median roof height (m)
    peak: float | None
    coverage: float  # fraction of the OSM footprint covered by matched LiDAR footprints
    best: LidarFootprint | None  # footprint with the largest overlap


def lidar_for(poly: Polygon) -> LidarMatch:
    fps, tree = lidar()
    idx = {id(f.geom): f for f in fps}
    hits = []
    for g in tree.query(poly):
        f = idx[id(g)]
        try:
            a = f.geom.intersection(poly).area
        except Exception:  # noqa: BLE001 — topology errors on degenerate inputs
            continue
        if a > 0.5:
            hits.append((a, f))
    if not hits:
        return LidarMatch(None, None, 0.0, None)
    hits.sort(key=lambda t: -t[0])
    best = hits[0][1]
    cov = min(1.0, sum(a for a, _ in hits) / max(poly.area, 1e-6))
    # Only footprints that substantially belong to this OSM polygon vote on the height.
    voters = [(a, f) for a, f in hits if f.hgt_median is not None and (a / f.area >= 0.3 or a / poly.area >= 0.3)]
    if not voters:
        return LidarMatch(None, None, cov, best)
    w = sum(a for a, _ in voters)
    h = sum(a * f.hgt_median for a, f in voters) / w
    peak = max((f.hgt_max or 0) for _, f in voters)
    return LidarMatch(h, peak, cov, best)


# ───────────────────────────── Assessor roll ─────────────────────────────

@dataclass
class Parcel:
    apn: str  # block+lot, e.g. '0166004'
    pt: Point
    year: int | None
    stories: float | None
    units: float
    ctype: str | None  # A/B/C/D/S (+ rare STE/WOO/REI); None when NA
    use_code: str | None  # SRES/MRES/COMM/COMO/COMR/COMH/IND/GOVT/MISC
    class_code: str | None
    area_m2: float  # improvement floor area
    address: str | None


def _addr(loc: str | None) -> str | None:
    """'0000 1040 COLUMBUS            AV0000' -> '1040 Columbus Av'."""
    if not loc:
        return None
    parts = loc.split()
    if len(parts) < 3:
        return None
    try:
        num = int(parts[1])
    except ValueError:
        return None
    if num == 0:
        return None
    street = ' '.join(parts[2:])
    street = street[:-4] if street[-4:].isdigit() else street
    words = street.split()
    if words and len(words[-1]) <= 2 and words[-1].isalpha():  # suffix glued: 'AV', 'ST'
        suf = {'AV': 'Ave', 'ST': 'St', 'BL': 'Blvd', 'WY': 'Way', 'PL': 'Pl', 'AL': 'Alley', 'TR': 'Ter', 'CT': 'Ct'}
        words[-1] = suf.get(words[-1], words[-1].title())
    elif words and words[-1][-2:] in ('AV', 'ST') and len(words[-1]) > 2:
        w = words[-1]
        words[-1] = w[:-2]
        words.append({'AV': 'Ave', 'ST': 'St'}[w[-2:]])
    return f"{num} {' '.join(w.title() if w.isupper() else w for w in words)}"


@lru_cache(maxsize=1)
def assessor() -> tuple[int, list[Parcel]]:
    js = json.loads((CACHE / 'assessor.json').read_text())
    out = []
    for r in js['rows']:
        g = r.get('the_geom')
        if not g:
            continue
        lon, lat = g['coordinates'][:2]
        y = _f(r.get('year_property_built'))
        y = int(y) if y and 1849 <= y <= 2026 else None
        ct = (r.get('construction_type') or 'NA').strip().upper()
        ct = None if ct in ('NA', '') else ct
        out.append(Parcel(
            apn=r.get('parcel_number') or (r.get('block', '') + r.get('lot', '')),
            pt=Point(*project(lat, lon)),
            year=y,
            stories=_f(r.get('number_of_stories')) or None,
            units=_f(r.get('number_of_units')) or 0.0,
            ctype=ct,
            use_code=r.get('use_code'),
            class_code=r.get('property_class_code'),
            area_m2=(_f(r.get('property_area')) or 0.0) * SQFT,
            address=_addr(r.get('property_location')),
        ))
    return int(js['closedRollYear']), out


@lru_cache(maxsize=1)
def soft_story() -> dict[str, dict]:
    rows = json.loads((CACHE / 'softstory.json').read_text())
    out = {}
    for r in rows:
        apn = r.get('parcel_number') or (r.get('block', '') + r.get('lot', ''))
        p = r.get('point')
        out[apn] = dict(status=r.get('status'), tier=r.get('tier'), address=r.get('property_address'),
                        pt=Point(*project(p['coordinates'][1], p['coordinates'][0])) if p else None)
    return out


def mblr_apn(mblr: str) -> str | None:
    """'SF0166004' -> '0166004' (assessor block+lot)."""
    if mblr and mblr.startswith('SF') and len(mblr) >= 9:
        return mblr[2:]
    return None


@dataclass
class AssessorAgg:
    year: int | None = None
    stories: float | None = None
    units: float = 0.0
    ctype: str | None = None
    use_code: str | None = None
    class_codes: Counter = field(default_factory=Counter)
    area_m2: float = 0.0
    address: str | None = None
    apns: list = field(default_factory=list)
    soft_story: bool = False


def aggregate(parcels: list[Parcel]) -> AssessorAgg:
    a = AssessorAgg()
    if not parcels:
        return a
    a.apns = sorted({p.apn for p in parcels})
    w_year = Counter()
    w_ct = Counter()
    w_use = Counter()
    for p in parcels:
        w = max(p.area_m2, 1.0)
        if p.year:
            w_year[p.year] += w
        if p.ctype:
            w_ct[p.ctype] += w
        if p.use_code:
            w_use[p.use_code] += w
        if p.class_code:
            a.class_codes[p.class_code] += w
        a.units += p.units
        a.area_m2 += p.area_m2
        if p.stories:
            a.stories = max(a.stories or 0, p.stories)
    a.year = w_year.most_common(1)[0][0] if w_year else None
    a.ctype = w_ct.most_common(1)[0][0] if w_ct else None
    a.use_code = w_use.most_common(1)[0][0] if w_use else None
    a.address = next((p.address for p in sorted(parcels, key=lambda p: -p.area_m2) if p.address), None)
    return a


def group_parcels_by_building(polys: list[Polygon], keys: list[str], mblr_of: dict[str, str | None]) -> dict[str, list[Parcel]]:
    """Assign every assessor parcel to exactly one building: the footprint containing its centroid point,
    else the building whose LiDAR footprint carries the parcel's block/lot (largest one), else the nearest
    footprint within 15 m.  Returns building key -> parcels."""
    _, parcels = assessor()
    tree = STRtree(polys)
    key_of = {id(p): k for p, k in zip(polys, keys)}
    area_of = {k: p.area for p, k in zip(polys, keys)}
    by_apn = defaultdict(list)
    for k, m in mblr_of.items():
        apn = mblr_apn(m or '')
        if apn:
            by_apn[apn].append(k)
    out: dict[str, list[Parcel]] = defaultdict(list)
    for p in parcels:
        hit = [g for g in tree.query(p.pt) if g.contains(p.pt)]
        if hit:
            k = key_of[id(max(hit, key=lambda g: g.area))]
        elif by_apn.get(p.apn):
            k = max(by_apn[p.apn], key=lambda kk: area_of[kk])
        else:
            near = [g for g in tree.query(p.pt.buffer(15)) if g.distance(p.pt) <= 15]
            if not near:
                continue
            k = key_of[id(min(near, key=lambda g: g.distance(p.pt)))]
        out[k].append(p)
    return out
