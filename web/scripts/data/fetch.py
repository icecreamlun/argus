"""Download & cache every raw source used by the pipeline (idempotent; delete .cache/ to refresh).

    python3 scripts/data/fetch.py [osm|terrain|datasf|all]

Sources (all open data):
  * OpenStreetMap via Overpass API             -> .cache/osm.json
  * AWS Terrain Tiles (Terrarium PNG, z15)      -> .cache/terrarium/15/{x}/{y}.png
  * DataSF Building Footprints + LiDAR (ynuv-fyni)          -> .cache/datasf_footprints.json
  * DataSF Assessor Historical Secured Property Tax Rolls (wv5m-vpq2), latest closed roll -> .cache/assessor.json
  * DataSF Soft-Story Properties (beah-shgi)                -> .cache/softstory.json
  * DataSF Street Tree Inventory (tkzw-k3nq)                -> .cache/trees.json
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from geo import CONTEXT_BBOX

HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache'
CACHE.mkdir(exist_ok=True)
UA = {'User-Agent': 'argus-hackathon/0.1 (Gemini Argon SF hackathon; earthquake situational awareness)'}

# Fetch DataSF / OSM a little beyond the context bbox so footprints straddling the edge are complete.
PAD = 0.0008  # deg (~70-90 m)
FETCH_BBOX = dict(
    south=CONTEXT_BBOX['south'] - PAD,
    west=CONTEXT_BBOX['west'] - PAD,
    north=CONTEXT_BBOX['north'] + PAD,
    east=CONTEXT_BBOX['east'] + PAD,
)

# Terrain grid covers the context bbox plus generous margins (see terrain.py for the exact grid).
TERRAIN_BBOX = dict(south=37.7685, west=-122.4325, north=37.8250, east=-122.3450)
TERRAIN_ZOOM = 15


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _get(url: str, params: dict | None = None, tries: int = 5, timeout: int = 180) -> requests.Response:
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            last = f'HTTP {r.status_code}: {r.text[:200]}'
        except requests.RequestException as e:  # network hiccup -> retry
            last = str(e)
        time.sleep(2 + 3 * i)
    raise RuntimeError(f'GET {url} failed: {last}')


# ───────────────────────────── OpenStreetMap ─────────────────────────────

OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]


def fetch_osm(force: bool = False) -> Path:
    out = CACHE / 'osm.json'
    if out.exists() and not force:
        return out
    b = FETCH_BBOX
    bb = f"{b['south']},{b['west']},{b['north']},{b['east']}"
    q = f"""
[out:json][timeout:300][maxsize:536870912];
(
  way["building"]({bb});
  relation["building"]({bb});
  way["building:part"]({bb});
  relation["building:part"]({bb});
  way["highway"]({bb});
  way["railway"]({bb});
  way["man_made"~"^(pier|breakwater|quay)$"]({bb});
  relation["man_made"="pier"]({bb});
  way["leisure"~"^(park|garden|pitch|playground|dog_park)$"]({bb});
  relation["leisure"~"^(park|garden|pitch)$"]({bb});
  way["place"="square"]({bb});
  relation["place"="square"]({bb});
  way["area:highway"]({bb});
  way["landuse"]({bb});
  relation["landuse"]({bb});
  way["amenity"~"^(parking|fountain)$"]({bb});
  relation["amenity"="parking"]({bb});
  node["natural"="tree"]({bb});
  way["natural"~"^(coastline|water|wood|scrub|grassland)$"]({bb});
  relation["natural"="water"]({bb});
  way["waterway"]({bb});
);
out geom;
"""
    last = None
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                print(f'[osm] POST {url} (attempt {attempt + 1})', flush=True)
                r = requests.post(
                    url,
                    data={'data': q},
                    headers={**UA, 'Accept': 'application/json'},
                    timeout=400,
                )
                if r.status_code == 200 and r.text.lstrip().startswith('{'):
                    js = r.json()
                    if js.get('remark') and 'error' in js['remark'].lower():
                        raise RuntimeError(js['remark'])
                    _atomic_write(out, r.content)
                    print(f"[osm] {len(js['elements'])} elements, {len(r.content) / 1e6:.1f} MB")
                    return out
                last = f'HTTP {r.status_code}: {r.text[:300]}'
            except Exception as e:  # noqa: BLE001
                last = str(e)
            print('[osm] retry:', last, flush=True)
            time.sleep(5 + 10 * attempt)
    raise RuntimeError(f'Overpass failed: {last}')


def _overpass(q: str) -> bytes:
    last = None
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                r = requests.post(url, data={'data': q}, headers={**UA, 'Accept': 'application/json'}, timeout=400)
                if r.status_code == 200 and r.text.lstrip().startswith('{'):
                    return r.content
                last = f'HTTP {r.status_code}: {r.text[:300]}'
            except Exception as e:  # noqa: BLE001
                last = str(e)
            time.sleep(5 + 10 * attempt)
    raise RuntimeError(f'Overpass failed: {last}')


def fetch_coast(force: bool = False) -> Path:
    """Coastline + piers over the (bigger) terrain bbox -> land/water mask for the heightfield."""
    out = CACHE / 'osm_coast.json'
    if out.exists() and not force:
        return out
    b = TERRAIN_BBOX
    bb = f"{b['south']},{b['west']},{b['north']},{b['east']}"
    q = f"""
[out:json][timeout:180];
(
  way["natural"="coastline"]({bb});
  way["man_made"~"^(pier|breakwater)$"]({bb});
  relation["man_made"="pier"]({bb});
  way["bridge:support"]({bb});
  way["natural"="water"]({bb});
);
out geom;
"""
    data = _overpass(q)
    _atomic_write(out, data)
    print(f"[coast] {len(json.loads(data)['elements'])} elements")
    return out


# ───────────────────────────── Terrain tiles ─────────────────────────────


def tile_xy(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def terrain_tile_range(z: int = TERRAIN_ZOOM) -> tuple[int, int, int, int]:
    b = TERRAIN_BBOX
    x0, y0 = tile_xy(b['north'], b['west'], z)
    x1, y1 = tile_xy(b['south'], b['east'], z)
    return x0, y0, x1, y1


def fetch_terrain() -> Path:
    z = TERRAIN_ZOOM
    x0, y0, x1, y1 = terrain_tile_range(z)
    jobs = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            p = CACHE / 'terrarium' / str(z) / str(x) / f'{y}.png'
            if not p.exists():
                jobs.append((x, y, p))

    def dl(job):
        x, y, p = job
        p.parent.mkdir(parents=True, exist_ok=True)
        r = _get(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png')
        _atomic_write(p, r.content)

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(dl, jobs))
    print(f'[terrain] tiles x {x0}..{x1}, y {y0}..{y1} ({(x1 - x0 + 1) * (y1 - y0 + 1)} tiles, {len(jobs)} downloaded)')
    return CACHE / 'terrarium'


# ───────────────────────────── DataSF (Socrata SODA) ─────────────────────────────

SODA = 'https://data.sfgov.org/resource/{id}.json'


def _soda_all(dataset: str, where: str, select: str | None = None, order: str = ':id', page: int = 20000) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        params = {'$where': where, '$limit': page, '$offset': offset, '$order': order}
        if select:
            params['$select'] = select
        r = _get(SODA.format(id=dataset), params=params)
        batch = r.json()
        rows.extend(batch)
        print(f'[datasf] {dataset}: {len(rows)} rows', flush=True)
        if len(batch) < page:
            return rows
        offset += page


def _box(col: str) -> str:
    b = FETCH_BBOX
    # within_box(col, top-left lat, top-left lon, bottom-right lat, bottom-right lon)
    return f"within_box({col}, {b['north']}, {b['west']}, {b['south']}, {b['east']})"


def _cache_json(name: str, fn, force: bool = False) -> Path:
    out = CACHE / name
    if out.exists() and not force:
        return out
    rows = fn()
    _atomic_write(out, json.dumps(rows).encode())
    return out


def latest_roll_year() -> int:
    r = _get(SODA.format(id='wv5m-vpq2'), params={'$select': 'max(closed_roll_year) AS y'})
    return int(float(r.json()[0]['y']))


def fetch_datasf(force: bool = False) -> None:
    jobs = {
        'datasf_footprints.json': lambda: _soda_all('ynuv-fyni', _box('shape')),
        'softstory.json': lambda: _soda_all('beah-shgi', _box('point')),
        'trees.json': lambda: _soda_all(
            'tkzw-k3nq',
            f"latitude between {FETCH_BBOX['south']} and {FETCH_BBOX['north']} and "
            f"longitude between {FETCH_BBOX['west']} and {FETCH_BBOX['east']}",
            select='treeid,species,mapdbh,latitude,longitude,legalstatus,siteinfo,planttype,dbhrange',
        ),
    }

    def assessor():
        y = latest_roll_year()
        print('[datasf] latest closed roll year', y)
        rows = _soda_all('wv5m-vpq2', f'closed_roll_year = {y} AND ' + _box('the_geom'))
        return {'closedRollYear': y, 'rows': rows}

    jobs['assessor.json'] = assessor
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(lambda kv: _cache_json(kv[0], kv[1], force), jobs.items()))


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    force = '--force' in sys.argv
    if what in ('osm', 'all'):
        fetch_osm(force)
    if what in ('terrain', 'all'):
        fetch_terrain()
    if what in ('datasf', 'all'):
        fetch_datasf(force)
