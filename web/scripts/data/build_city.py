"""Build public/data/city.json from the cached raw downloads (run fetch.py first; terrain.py writes the terrain).

    python3 scripts/data/build_city.py            # city.json only (uses the terrain already in public/data)
    python3 scripts/data/build_city.py --terrain  # rebuild terrain.json/.bin first

Output is written atomically (temp file + rename) because the dev server serves it live."""
from __future__ import annotations

import json
import os
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings('ignore', message='.*STRtree.*')
warnings.filterwarnings('ignore', category=DeprecationWarning)

from shapely.geometry import Polygon  # noqa: E402

import buildings  # noqa: E402
import datasf  # noqa: E402
import districts  # noqa: E402
import network  # noqa: E402
import terrain as terrain_mod  # noqa: E402
from geo import CITY_ORIGIN, CONTEXT_BBOX, CORE_BBOX  # noqa: E402

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent.parent / 'public' / 'data'


def main() -> None:
    t0 = time.time()
    if '--terrain' in sys.argv:
        terrain_mod.write(terrain_mod.build())
    terr = terrain_mod.load_written()
    roll_year, _ = datasf.assessor()

    areas, piers = network.build_areas(terr)
    blds, info = buildings.build(terr, piers)
    print(f'[buildings] {len(blds)} records; height provenance {dict(info["heights"])}')
    polys = [Polygon(b['footprint'], b.get('holes') or []) for b in blds if not b.get('minHeight')]
    roads = network.build_roads()
    trees = network.build_trees(terr, [p if p.is_valid else p.buffer(0) for p in polys])

    meta = dict(
        name='San Francisco — Ferry Building to Chinatown',
        bbox=dict(CORE_BBOX),
        contextBBox=dict(CONTEXT_BBOX),
        origin=dict(lat=CITY_ORIGIN['lat'], lon=CITY_ORIGIN['lon']),
        generatedAt=datetime.now(timezone.utc).isoformat(timespec='seconds'),
        sources=[
            '© OpenStreetMap contributors (ODbL) — buildings, building parts, streets, rail, piers, parks, trees',
            'DataSF: Building Footprints (ynuv-fyni) with 2010 LiDAR height statistics',
            f'DataSF: Assessor Historical Secured Property Tax Rolls (wv5m-vpq2), closed roll year {roll_year}',
            'DataSF: Soft-Story Properties (beah-shgi)',
            'DataSF: Street Tree List (tkzw-k3nq)',
            'AWS Terrain Tiles (Terrarium) / USGS 3DEP + NOAA bathymetry',
            'Historic 1849 Yerba Buena Cove shoreline: approximated from published historic maps (see SOURCES.md)',
        ],
        historicShoreline=[list(p) for p in districts.historic_shoreline()],
    )
    city = dict(meta=meta, buildings=blds, roads=roads, areas=areas, trees=trees)
    data = json.dumps(city, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    PUBLIC.mkdir(parents=True, exist_ok=True)
    tmp = PUBLIC / 'city.json.tmp'
    tmp.write_bytes(data)
    os.replace(tmp, PUBLIC / 'city.json')
    print(f'[city] wrote {PUBLIC / "city.json"} ({len(data) / 1e6:.2f} MB) in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
