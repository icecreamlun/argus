"""Projection constants — an exact replica of src/geo.ts. Keep the two in sync.

World frame (metres): +X east, -Z north (+Z south), +Y up, origin = centre of CORE_BBOX.
"""
import math

CORE_BBOX = dict(south=37.788, west=-122.41, north=37.799, east=-122.386)
CONTEXT_BBOX = dict(south=37.7835, west=-122.416, north=37.804, east=-122.38)

CITY_ORIGIN = dict(
    lat=(CORE_BBOX['south'] + CORE_BBOX['north']) / 2,
    lon=(CORE_BBOX['west'] + CORE_BBOX['east']) / 2,
)

_phi = CITY_ORIGIN['lat'] * math.pi / 180
M_PER_DEG_LAT = 111132.92 - 559.82 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
M_PER_DEG_LON = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)


def project(lat: float, lon: float) -> tuple[float, float]:
    """lat/lon -> world (x, z) metres."""
    return ((lon - CITY_ORIGIN['lon']) * M_PER_DEG_LON, -(lat - CITY_ORIGIN['lat']) * M_PER_DEG_LAT)


def unproject(x: float, z: float) -> tuple[float, float]:
    """world (x, z) metres -> (lat, lon)."""
    return (CITY_ORIGIN['lat'] - z / M_PER_DEG_LAT, CITY_ORIGIN['lon'] + x / M_PER_DEG_LON)


def bbox_xz(b: dict) -> tuple[float, float, float, float]:
    """bbox dict -> (minX, minZ, maxX, maxZ) in world metres."""
    x0, z1 = project(b['south'], b['west'])
    x1, z0 = project(b['north'], b['east'])
    return (min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1))


def _self_test() -> None:
    # Origin maps to (0, 0); round trips are exact to < 1 mm; known landmarks land where the brief says.
    assert abs(project(CITY_ORIGIN['lat'], CITY_ORIGIN['lon'])[0]) < 1e-9
    for lat, lon in [(37.7955, -122.3937), (37.7952, -122.4028), (37.8024, -122.4058), (37.784, -122.415)]:
        x, z = project(lat, lon)
        la, lo = unproject(x, z)
        assert abs(la - lat) < 1e-10 and abs(lo - lon) < 1e-10, (lat, lon, la, lo)
    # Ferry Building clock tower ~ (401, -224) per the shared brief.
    fx, fz = project(37.79554, -122.39345)
    assert abs(fx - 401) < 15 and abs(fz + 224) < 15, (fx, fz)
    # Transamerica Pyramid ~ (-421, -186).
    tx, tz = project(37.79518, -122.40278)
    assert abs(tx + 421) < 15 and abs(tz + 186) < 15, (tx, tz)
    # Core bbox spans x -1057..1057, z -610..610.
    b = bbox_xz(CORE_BBOX)
    assert abs(b[0] + 1057) < 2 and abs(b[2] - 1057) < 2 and abs(b[1] + 610) < 2 and abs(b[3] - 610) < 2, b


_self_test()

if __name__ == '__main__':
    print('M_PER_DEG_LAT', M_PER_DEG_LAT, 'M_PER_DEG_LON', M_PER_DEG_LON)
    print('core', bbox_xz(CORE_BBOX))
    print('context', bbox_xz(CONTEXT_BBOX))
