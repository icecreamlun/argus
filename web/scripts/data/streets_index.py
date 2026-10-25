"""Named-street lookup over the OSM highway network: centrelines by name and street-street intersections in world
metres.  Used to anchor the hand-made district polygons and the historic shoreline on real street geometry."""
from __future__ import annotations

from functools import lru_cache

from shapely.geometry import MultiLineString, Point
from shapely.ops import nearest_points, unary_union

from osm import elements, way_line

_CAR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
        'pedestrian', 'service', 'busway', 'primary_link', 'secondary_link', 'tertiary_link'}


@lru_cache(maxsize=None)
def street(name: str):
    """Union of all non-footway centrelines carrying this exact name (e.g. 'Kearny Street')."""
    lines = []
    for e in elements():
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('name') == name and t.get('highway') in _CAR:
            ln = way_line(e)
            if ln is not None:
                lines.append(ln)
    if not lines:
        raise KeyError(f'street not found: {name}')
    return unary_union(MultiLineString(lines)) if len(lines) > 1 else lines[0]


@lru_cache(maxsize=None)
def isect(a: str, b: str) -> tuple[float, float]:
    """Intersection of two named streets (centroid of crossing points; nearest approach if they never touch)."""
    sa, sb = street(a), street(b)
    x = sa.intersection(sb)
    if not x.is_empty:
        c = x.centroid
        return (round(c.x, 1), round(c.y, 1))
    pa, pb = nearest_points(sa, sb)
    if pa.distance(pb) > 60:
        raise ValueError(f'{a} and {b} do not meet (gap {pa.distance(pb):.0f} m)')
    return (round((pa.x + pb.x) / 2, 1), round((pa.y + pb.y) / 2, 1))


def dist_to(name: str, x: float, z: float) -> float:
    return street(name).distance(Point(x, z))


if __name__ == '__main__':
    for a, b in [('Bush Street', 'Kearny Street'), ('Broadway', 'Kearny Street'), ('Broadway', 'Powell Street'),
                 ('Bush Street', 'Powell Street'), ('Washington Street', 'Kearny Street'),
                 ('Washington Street', 'Sansome Street'), ('Broadway', 'Sansome Street'),
                 ('Market Street', 'Kearny Street'), ('Market Street', 'The Embarcadero'),
                 ('Broadway', 'The Embarcadero'), ('Broadway', 'Battery Street'), ('Jackson Street', 'Montgomery Street'),
                 ('Bush Street', 'Montgomery Street'), ('Market Street', '2nd Street'), ('Mission Street', '1st Street'),
                 ('Harrison Street', 'Spear Street'), ('Folsom Street', 'Fremont Street'), ('Washington Street', 'Grant Avenue'),
                 ('Vallejo Street', 'Battery Street'), ('Green Street', 'Sansome Street'), ('Lombard Street', 'Sansome Street'),
                 ('Bryant Street', '2nd Street'), ('Market Street', 'Montgomery Street')]:
        try:
            print(f'{a:20s} & {b:20s} {isect(a, b)}')
        except Exception as ex:  # noqa: BLE001
            print(a, b, 'ERR', ex)
