"""OpenStreetMap helpers: load the cached Overpass dump and turn ways / multipolygon relations into shapely
geometries in world metres (see geo.py).  Only geometry plumbing lives here; semantics live in the builders."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import linemerge, polygonize, unary_union

from fetch import CACHE
from geo import project


@dataclass
class Feature:
    osm_id: str  # "way/123" | "relation/456" | "node/789"
    tags: dict
    geom: object  # shapely geometry in world metres
    extra: dict = field(default_factory=dict)


@lru_cache(maxsize=1)
def elements() -> list[dict]:
    return json.loads((CACHE / 'osm.json').read_text())['elements']


def _xy(geom: list[dict]) -> list[tuple[float, float]]:
    return [project(p['lat'], p['lon']) for p in geom if p is not None]


def is_closed(geom: list[dict]) -> bool:
    return len(geom) >= 4 and geom[0]['lat'] == geom[-1]['lat'] and geom[0]['lon'] == geom[-1]['lon']


def way_polygon(e: dict) -> Polygon | None:
    g = e.get('geometry') or []
    if not is_closed(g):
        return None
    p = Polygon(_xy(g))
    if not p.is_valid:
        p = p.buffer(0)
    return p if not p.is_empty else None


def way_line(e: dict) -> LineString | None:
    g = [p for p in (e.get('geometry') or []) if p is not None]
    if len(g) < 2:
        return None
    return LineString(_xy(g))


def relation_polygon(e: dict) -> Polygon | MultiPolygon | None:
    """Assemble an OSM multipolygon relation from member ways (outer/inner roles; members may be split)."""
    outers, inners = [], []
    for m in e.get('members', []):
        if m.get('type') != 'way' or not m.get('geometry'):
            continue
        g = [p for p in m['geometry'] if p is not None]
        if len(g) < 2:
            continue
        (inners if m.get('role') == 'inner' else outers).append(LineString(_xy(g)))
    if not outers:
        return None

    def rings(lines):
        merged = linemerge(lines) if len(lines) > 1 else lines[0]
        return list(polygonize(merged))

    outer = unary_union(rings(outers))
    if inners:
        hole = unary_union(rings(inners))
        outer = outer.difference(hole)
    if not outer.is_valid:
        outer = outer.buffer(0)
    return outer if not outer.is_empty else None


def area_geometry(e: dict):
    if e['type'] == 'way':
        return way_polygon(e)
    if e['type'] == 'relation':
        return relation_polygon(e)
    return None


def polygons_of(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if hasattr(geom, 'geoms'):
        out = []
        for g in geom.geoms:
            out.extend(polygons_of(g))
        return out
    return []


# ───────────────────────────── tag parsing ─────────────────────────────

_NUM = re.compile(r'[-+]?\d+(?:[.,]\d+)?')


def parse_length(v: str | None) -> float | None:
    """'45', '45 m', '120\'', '120 ft', "12'6\"" -> metres.  None when unparseable."""
    if not v:
        return None
    s = v.strip().lower().replace(',', '.')
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)\s*\"?\s*$", s)  # feet'inches"
    if m:
        return float(m.group(1)) * 0.3048 + float(m.group(2)) * 0.0254
    n = _NUM.search(s)
    if not n:
        return None
    x = float(n.group(0))
    if "'" in s or 'ft' in s or 'feet' in s:
        x *= 0.3048
    elif 'mi' in s and 'mm' not in s:
        return None
    return x


def parse_levels(v: str | None) -> float | None:
    if not v:
        return None
    n = _NUM.search(v.replace(',', '.'))
    if not n:
        return None
    x = float(n.group(0))
    return x if 0 <= x < 200 else None


def parse_year(v: str | None) -> int | None:
    if not v:
        return None
    m = re.search(r'(1[89]\d\d|20[0-2]\d)', v)
    return int(m.group(1)) if m else None


def tag_layer(tags: dict) -> int:
    try:
        return int(float(tags.get('layer', '0').split(';')[0]))
    except ValueError:
        return 0
