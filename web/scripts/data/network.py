"""Roads / rail (RoadRecord), open areas (AreaRecord) and street trees (TreeRecord) from OSM + DataSF."""
from __future__ import annotations

import json
import math
from collections import Counter

from shapely.geometry import LineString, Point, box
from shapely.geometry.polygon import orient
from shapely.strtree import STRtree

from fetch import CACHE
from geo import CONTEXT_BBOX, bbox_xz, project
from osm import area_geometry, elements, parse_length, parse_levels, polygons_of, tag_layer, way_line

CX = bbox_xz(CONTEXT_BBOX)
CLIP = box(CX[0] - 150, CX[1] - 150, CX[2] + 150, CX[3] + 150)
AREA_CLIP = box(CX[0] - 60, CX[1] - 60, CX[2] + 60, CX[3] + 60)

# ───────────────────────────── roads ─────────────────────────────

KIND = {
    'motorway': 'motorway', 'motorway_link': 'motorway', 'trunk': 'motorway', 'trunk_link': 'motorway',
    'primary': 'primary', 'primary_link': 'primary', 'secondary': 'secondary', 'secondary_link': 'secondary',
    'tertiary': 'tertiary', 'tertiary_link': 'tertiary', 'residential': 'residential', 'unclassified': 'residential',
    'service': 'service', 'busway': 'service', 'living_street': 'living_street', 'pedestrian': 'pedestrian',
    'footway': 'footway', 'path': 'footway', 'track': 'footway', 'bridleway': 'footway', 'steps': 'steps',
    'cycleway': 'cycleway',
}
LANE_W = {'motorway': 3.6, 'primary': 3.3, 'secondary': 3.3, 'tertiary': 3.2, 'residential': 3.1, 'service': 3.0,
          'living_street': 3.0}
DEFAULT_LANES = {'motorway': 3, 'primary': 4, 'secondary': 4, 'tertiary': 2, 'residential': 2, 'service': 1,
                 'living_street': 2}
# Parking / bike lane allowance added to lanes x lane width (two-way, both kerbs).
KERB_EXTRA = {'motorway': 1.5, 'primary': 2.4, 'secondary': 4.4, 'tertiary': 4.4, 'residential': 4.0, 'service': 0.6,
              'living_street': 0.0}
FIXED_W = {'pedestrian': 6.0, 'footway': 2.2, 'steps': 2.4, 'cycleway': 2.2, 'rail': 3.0, 'cable_car': 2.6}
SIDEWALK = {'motorway': 0.0, 'primary': 4.0, 'secondary': 3.6, 'tertiary': 3.4, 'residential': 2.8, 'service': 0.0,
            'living_street': 0.0, 'pedestrian': 0.0, 'footway': 0.0, 'steps': 0.0, 'cycleway': 0.0, 'rail': 0.0,
            'cable_car': 0.0}
ALLEY_WORDS = ('Alley', 'Place', 'Lane', 'Way', 'Court', 'Walk', 'Terrace')


def _lanes(t: dict) -> int | None:
    v = parse_levels(t.get('lanes'))
    return int(v) if v and v >= 1 else None


def road_kind(t: dict) -> str | None:
    rw = t.get('railway')
    if rw == 'tram':
        # SF cable cars: OSM railway=tram with cable_tram=cable and 3'6" (1067 mm) gauge, unelectrified.
        return 'cable_car' if (t.get('cable_tram') == 'cable' or t.get('gauge') == '1067') else 'rail'
    if rw in ('light_rail', 'rail', 'subway', 'narrow_gauge', 'funicular'):
        return 'rail'
    hw = t.get('highway')
    if hw is None or t.get('area') == 'yes':
        return None
    if hw == 'footway' and t.get('footway') in ('sidewalk', 'crossing', 'traffic_island', 'crosswalk'):
        return None  # sidewalks/crossings are drawn by the streets module from the carriageway records
    return KIND.get(hw)


def road_width(kind: str, t: dict, lanes: int | None, oneway: bool) -> float:
    name = t.get('name') or ''
    w = parse_length(t.get('width'))
    if w and 1.0 <= w <= 40 and kind not in ('rail', 'cable_car'):
        return w
    if kind in FIXED_W:
        if kind == 'pedestrian' and name:
            return 7.0
        return FIXED_W[kind]
    # Named SF downtown realism (carriageway kerb to kerb).
    if name == 'Market Street':
        return 11.5 if oneway else 23.0
    if name == 'The Embarcadero':
        return (lanes or 2) * 3.4 + 2.0 if oneway else 30.0  # dual halves; the F-line median is separate rail
    if name == 'Grant Avenue':
        return 8.5
    if kind in ('service', 'residential', 'living_street') and name.endswith(ALLEY_WORDS):
        return 5.0 if kind == 'service' else 6.0  # Chinatown alleys (Ross Alley, Waverly Place, Spofford...)
    if kind == 'service':
        return 4.0 if t.get('service') in ('driveway', 'parking_aisle', 'drive-through') else 5.5
    n = lanes or (max(1, DEFAULT_LANES[kind] // 2) if oneway else DEFAULT_LANES[kind])
    extra = KERB_EXTRA[kind] * (0.6 if oneway else 1.0)
    return round(min(n * LANE_W[kind] + extra, 26.0), 1)


def sidewalk_width(kind: str, t: dict) -> float:
    s = t.get('sidewalk') or t.get('sidewalk:both')
    name = t.get('name') or ''
    if s == 'no':
        return 0.0
    if name == 'Market Street':
        return 6.0
    if name == 'The Embarcadero':
        return 5.0
    if name.endswith(ALLEY_WORDS) and kind in ('service', 'residential', 'living_street'):
        return 1.0
    return SIDEWALK.get(kind, 0.0)


def build_roads() -> list[dict]:
    out = []
    skipped = Counter()
    for e in elements():
        if e['type'] != 'way':
            continue
        t = e.get('tags', {})
        kind = road_kind(t)
        if kind is None:
            continue
        tun = t.get('tunnel') not in (None, 'no')
        if kind == 'rail' and (tun or tag_layer(t) < 0):
            skipped['underground_rail'] += 1
            continue  # BART / Muni Metro / Central Subway tunnels
        if t.get('railway') and t.get('service') in ('crossover', 'siding', 'spur') and kind == 'rail' and tun:
            continue
        if t.get('indoor') == 'yes' or t.get('level', '0').startswith('-'):
            skipped['indoor'] += 1
            continue
        ln = way_line(e)
        if ln is None or ln.length < 1.0:
            continue
        clipped = ln.intersection(CLIP)
        lines = [clipped] if isinstance(clipped, LineString) else list(getattr(clipped, 'geoms', []))
        lanes = _lanes(t)
        oneway = t.get('oneway') in ('yes', '1', 'true') or (t.get('junction') == 'roundabout')
        width = road_width(kind, t, lanes, oneway)
        for k, l in enumerate(lines):
            if not isinstance(l, LineString) or l.length < 1.0:
                continue
            l = l.simplify(0.15)
            pts = [[round(x, 1), round(z, 1)] for x, z in l.coords]
            pts = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
            if len(pts) < 2:
                continue
            r = dict(osmId=f"way/{e['id']}", kind=kind, points=pts, width=round(width, 1))
            if t.get('name'):
                r['name'] = t['name']
            if lanes and kind not in FIXED_W:
                r['lanes'] = lanes
            if oneway and kind not in ('footway', 'steps', 'rail', 'cable_car'):
                r['oneway'] = True
            if t.get('bridge') not in (None, 'no'):
                r['bridge'] = True
            if tun:
                r['tunnel'] = True
            lay = tag_layer(t)
            if lay:
                r['layer'] = lay
            sw = sidewalk_width(kind, t)
            if kind not in FIXED_W or kind == 'pedestrian':
                r['sidewalk'] = sw
            out.append(r)
    out.sort(key=lambda r: (r['points'][0][0], r['points'][0][1], r['osmId']))
    out = [{'id': f'R{i + 1:04d}', **r} for i, r in enumerate(out)]
    print(f'[roads] {len(out)} records; skipped {dict(skipped)}; by kind {dict(Counter(r["kind"] for r in out))}')
    return out


# ───────────────────────────── areas ─────────────────────────────


# Named open spaces whose OSM tagging does not say so (Maritime Plaza is mapped as landuse=commercial).
NAMED_PLAZAS = {'Maritime Plaza'}


def area_kind(t: dict) -> str | None:
    if t.get('name') in NAMED_PLAZAS:
        return 'plaza'
    if t.get('man_made') == 'pier':
        return 'pier'
    if t.get('leisure') in ('park', 'garden', 'playground', 'dog_park'):
        return 'park'
    if t.get('leisure') == 'pitch':
        return 'pitch'
    if t.get('place') == 'square' or (t.get('highway') == 'pedestrian' and t.get('area') == 'yes') \
            or t.get('area:highway') == 'pedestrian':
        return 'plaza'
    if t.get('amenity') == 'parking' and 'building' not in t and t.get('parking') in (None, 'surface', 'street_side'):
        return 'parking'
    if t.get('landuse') in ('grass', 'village_green', 'recreation_ground') or t.get('natural') == 'grassland':
        return 'grass'
    if t.get('landuse') == 'construction':
        return 'construction'
    if t.get('natural') == 'water' or t.get('amenity') == 'fountain':
        return 'water'
    return None


def _ring(coords, outer: bool) -> list[list[float]]:
    pts = [[round(x, 1), round(z, 1)] for x, z in list(coords)[:-1]]
    return [p for i, p in enumerate(pts) if p != pts[i - 1]]


def build_areas(terrain) -> tuple[list[dict], list]:
    """-> (area records, pier polygons for building classification)."""
    import numpy as np

    out, piers = [], []
    for e in elements():
        t = e.get('tags', {})
        if e['type'] not in ('way', 'relation') or 'building' in t:
            continue
        kind = area_kind(t)
        if kind is None:
            continue
        g = area_geometry(e)
        if g is None:
            continue
        for k, p in enumerate(polygons_of(g.intersection(AREA_CLIP) if not AREA_CLIP.contains(g) else g)):
            p = p.simplify(0.1, preserve_topology=True)
            if p.area < (4 if kind == 'water' else 20):
                continue
            p = orient(p, sign=-1.0)
            rec = dict(osmId=f"{e['type']}/{e['id']}", kind=kind, polygon=_ring(p.exterior.coords, True))
            holes = [_ring(h.coords, False) for h in p.interiors if abs(_signed(h.coords)) >= 4]
            if holes:
                rec['holes'] = holes
            if t.get('name'):
                rec['name'] = t['name']
            if kind == 'pier':
                # Deck height: piers burned into the heightfield keep the terrain's deck value; the rest sit at 3 m.
                # Sampled on interior points (edge samples blend into the seawall drop).
                x0, z0, x1, z1 = p.bounds
                gx, gz = np.meshgrid(np.arange(x0 + 1, x1, 3.0), np.arange(z0 + 1, z1, 3.0))
                pts = [(x, z) for x, z in zip(gx.ravel(), gz.ravel()) if p.contains(Point(x, z))]
                if not pts:
                    pts = [tuple(p.representative_point().coords[0])]
                xs, zs = np.array(pts).T
                h = float(np.median(terrain.height_at(xs, zs)))
                rec['elevation'] = round(float(np.clip(h, 2.4, 3.6)) if h > 1.5 else 3.0, 2)
                piers.append((p, rec['elevation']))
            out.append(rec)
    out.sort(key=lambda r: (r['kind'], r['polygon'][0][0], r['polygon'][0][1]))
    out = [{'id': f'A{i + 1:04d}', **r} for i, r in enumerate(out)]
    print(f'[areas] {len(out)} records by kind {dict(Counter(r["kind"] for r in out))}')
    return out, piers


def _signed(coords) -> float:
    c = list(coords)
    return sum(c[i][0] * c[i + 1][1] - c[i + 1][0] * c[i][1] for i in range(len(c) - 1)) / 2


# ───────────────────────────── trees ─────────────────────────────


def build_trees(terrain, building_polys) -> list[dict]:
    rows = json.loads((CACHE / 'trees.json').read_text())
    cand = []
    for r in rows:
        try:
            lat, lon = float(r['latitude']), float(r['longitude'])
        except (KeyError, TypeError, ValueError):
            continue
        if not (CONTEXT_BBOX['south'] <= lat <= CONTEXT_BBOX['north'] and CONTEXT_BBOX['west'] <= lon <= CONTEXT_BBOX['east']):
            continue
        if r.get('planttype') not in (None, 'Tree'):
            continue
        x, z = project(lat, lon)
        sp = (r.get('species') or '').strip()
        if sp.startswith('Tree(s) ::') or sp in ('', '::'):
            sp = None
        try:
            dbh = float(r.get('mapdbh'))
            dbh = dbh if 0 < dbh <= 80 else None
        except (TypeError, ValueError):
            dbh = None
        cand.append(dict(x=x, z=z, species=sp, dbh=dbh, source='datasf'))
    n_ds = len(cand)
    for e in elements():
        t = e.get('tags', {})
        if e['type'] == 'node' and t.get('natural') == 'tree':
            lat, lon = e['lat'], e['lon']
            if not (CONTEXT_BBOX['south'] <= lat <= CONTEXT_BBOX['north'] and CONTEXT_BBOX['west'] <= lon <= CONTEXT_BBOX['east']):
                continue
            x, z = project(lat, lon)
            sp = t.get('species') or t.get('genus') or t.get('species:en')
            dbh = None
            circ = parse_length(t.get('circumference'))
            if circ:
                dbh = round(circ / math.pi / 0.0254, 1)
            cand.append(dict(x=x, z=z, species=sp, dbh=dbh, source='osm'))
    # Dedupe within 1.5 m (DataSF first, so it wins), drop trees in buildings or in the bay.
    tree_idx = STRtree(building_polys)
    seen: dict[tuple[int, int], list] = {}
    out = []
    drop = Counter()
    for c in cand:
        gx, gz = int(c['x'] // 1.5), int(c['z'] // 1.5)
        dup = False
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for o in seen.get((gx + dx, gz + dz), []):
                    if (o['x'] - c['x']) ** 2 + (o['z'] - c['z']) ** 2 < 1.5 ** 2:
                        dup = True
        if dup:
            drop['dup'] += 1
            continue
        pt = Point(c['x'], c['z'])
        if any(g.contains(pt) for g in tree_idx.query(pt)):
            drop['in_building'] += 1
            continue
        if float(terrain.height_at(c['x'], c['z'])) < 0.3:
            drop['in_water'] += 1
            continue
        seen.setdefault((gx, gz), []).append(c)
        rec = dict(x=round(c['x'], 2), z=round(c['z'], 2))
        if c['species']:
            rec['species'] = c['species']
        if c['dbh']:
            rec['dbh'] = c['dbh']
        rec['source'] = c['source']
        out.append(rec)
    out.sort(key=lambda r: (r['x'], r['z']))
    print(f'[trees] datasf {n_ds}, osm {len(cand) - n_ds} -> {len(out)} kept; dropped {dict(drop)}')
    return out
