"""Validate public/data/city.json + terrain against src/contracts.ts and real-world spot checks.

    python3 scripts/data/validate.py        # exit code 1 on any hard failure
"""
from __future__ import annotations

import json
import math
import sys
import warnings
from collections import Counter
from pathlib import Path

warnings.filterwarnings('ignore')

import numpy as np  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

from classify import LOW_RISE_ONLY, SANE_MAX_HEIGHT, year_plausible  # noqa: E402
from geo import CONTEXT_BBOX, CORE_BBOX, bbox_xz, project, unproject  # noqa: E402
from terrain import load_written  # noqa: E402

PUBLIC = Path(__file__).resolve().parent.parent.parent / 'public' / 'data'

STRUCT = {'W1', 'W1_SOFT', 'W2', 'URM', 'RM', 'C1', 'C2', 'C3', 'PC', 'S1', 'S2', 'S5'}
CODE = {'pre', 'low', 'moderate', 'high'}
USE = {'residential', 'mixed', 'commercial', 'office', 'retail', 'hotel', 'civic', 'religious', 'school', 'industrial',
       'transport', 'parking', 'other'}
DISTRICT = {'chinatown', 'fidi', 'embarcadero', 'jackson_square', 'nob_hill', 'north_beach', 'soma', 'other'}
LANDMARK = {'ferry_building', 'transamerica_pyramid', 'chinatown_gate', 'embarcadero_center', 'old_st_marys',
            'sentinel_building', 'one_maritime_plaza', 'hyatt_regency', 'customs_house', 'coit_tower', 'bay_bridge', 'other'}
ROAD_KIND = {'motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'pedestrian',
             'footway', 'steps', 'cycleway', 'rail', 'cable_car'}
AREA_KIND = {'park', 'plaza', 'pier', 'water', 'parking', 'grass', 'pitch', 'construction'}
H_SRC = {'osm_height', 'datasf_lidar', 'osm_levels', 'estimated'}
Y_SRC = {'assessor', 'osm', 'estimated'}
S_SRC = {'assessor', 'estimated'}

errors: list[str] = []
warns: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def fin(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def shoelace(ring) -> float:
    return sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))


def check_ring(ring, where: str, outer: bool) -> None:
    if not isinstance(ring, list) or len(ring) < 3:
        err(f'{where}: ring has < 3 points')
        return
    for p in ring:
        if not (isinstance(p, list) and len(p) == 2 and fin(p[0]) and fin(p[1])):
            err(f'{where}: bad point {p}')
            return
    if ring[0] == ring[-1]:
        err(f'{where}: ring is closed (first == last)')
    s = shoelace(ring)
    if outer and s >= 0:
        err(f'{where}: outer ring orientation wrong (shoelace {s:.1f} >= 0)')
    if not outer and s <= 0:
        err(f'{where}: hole orientation wrong')


def check_structural_records(B: list[dict], by_id: dict, terr) -> None:
    """One structural record per building (see SOURCES.md 'Structural records') + size/era sanity."""
    groups: dict[str, list[dict]] = {}
    for b in B:
        groups.setdefault(b.get('parentId') or b['id'], []).append(b)
    for key, ms in groups.items():
        anchors = [m for m in ms if not m.get('parentId')]
        if len(anchors) != 1 or anchors[0]['id'] != key or anchors[0].get('isPart'):
            err(f'group {key}: needs exactly one anchor (no parentId, not isPart)')
            continue
        for m in ms:
            if m is anchors[0]:
                continue
            if not m.get('isPart'):
                err(f'{m["id"]}: has parentId but isPart unset')
            if m['occupantsDay'] or m['occupantsNight']:
                err(f'{m["id"]}: non-anchor piece carries occupants (they belong to {key})')
        if len({(m['structure'], m['yearBuilt'], m['codeLevel'], m['softStory']) for m in ms}) > 1:
            err(f'group {key}: pieces disagree on structure/year/code/softStory')
    for b in B:
        w = b['id']
        if b['height'] > SANE_MAX_HEIGHT and b['structure'] in LOW_RISE_ONLY:
            err(f'{w}: {b["structure"]} at {b["height"]:.0f} m (light frame / bearing wall above {SANE_MAX_HEIGHT:.0f} m)')
        if b.get('parentId'):
            continue
        h = max(m['height'] for m in groups[w])
        if b['provenance']['year'] != 'osm' and not b.get('landmark') and not year_plausible(b['yearBuilt'], h, b['levels']):
            err(f'{w}: built {b["yearBuilt"]} but {h:.0f} m / {b["levels"]:.0f} storeys (outside the era envelope)')
    # Every piece (not only anchors) stands on or below the terrain under its own footprint.
    for b in B:
        if b.get('overWater') or not b.get('parentId'):
            continue  # anchors are checked in main()
        xs = [q[0] for q in b['footprint']]
        zs = [q[1] for q in b['footprint']]
        m = float(min(terr.height_at(xs, zs)))
        if b['baseElevation'] > m + 0.05:
            err(f'{b["id"]}: piece base {b["baseElevation"]} above terrain min {m:.2f} (floating)')
    n_tall = sum(1 for k, ms in groups.items() if max(m['height'] for m in ms) >= 60)
    print(f'structural records {len(groups)} (records {len(B)}); >= 60 m: {n_tall} buildings / '
          f'{sum(1 for b in B if b["height"] >= 60)} records')


def main() -> int:
    city = json.loads((PUBLIC / 'city.json').read_text())
    terr = load_written()
    size_mb = (PUBLIC / 'city.json').stat().st_size / 1e6
    print(f'city.json {size_mb:.2f} MB; terrain {terr.cols}x{terr.rows} @ {terr.cell} m, '
          f'{terr.data.min():.1f}..{terr.data.max():.1f} m')
    if size_mb > 15:
        err(f'city.json too large ({size_mb:.1f} MB)')
    if not np.isfinite(terr.data).all():
        err('terrain has non-finite samples')

    # ── projection round trips (same constants as src/geo.ts)
    for lat, lon in [(37.79554, -122.39345), (37.80239, -122.40582), (37.7835, -122.416)]:
        x, z = project(lat, lon)
        la, lo = unproject(x, z)
        if abs(la - lat) > 1e-9 or abs(lo - lon) > 1e-9:
            err('projection round trip failed')

    meta = city['meta']
    for k in ('name', 'bbox', 'contextBBox', 'origin', 'generatedAt', 'sources'):
        if k not in meta:
            err(f'meta.{k} missing')
    if meta['bbox'] != dict(CORE_BBOX) or meta['contextBBox'] != dict(CONTEXT_BBOX):
        err('meta bbox mismatch with geo.ts')

    B = city['buildings']
    ids = set()
    by_id = {}
    cx_core = bbox_xz(CORE_BBOX)
    base_dev = []
    for b in B:
        w = b.get('id', '?')
        if b['id'] in ids:
            err(f'duplicate id {w}')
        ids.add(b['id'])
        by_id[b['id']] = b
        for k in ('osmId', 'footprint', 'baseElevation', 'height', 'levels', 'use', 'structure', 'yearBuilt',
                  'codeLevel', 'occupantsDay', 'occupantsNight', 'softStory', 'district', 'onFill', 'vs30', 'provenance'):
            if k not in b:
                err(f'{w}: missing {k}')
        for k in ('baseElevation', 'height', 'levels', 'yearBuilt', 'occupantsDay', 'occupantsNight', 'vs30'):
            if not fin(b.get(k)):
                err(f'{w}: {k} not finite')
        check_ring(b['footprint'], w, True)
        for i, h in enumerate(b.get('holes') or []):
            check_ring(h, f'{w} hole {i}', False)
        poly = Polygon(b['footprint'], b.get('holes') or [])
        if not poly.is_valid:
            err(f'{w}: invalid polygon')
        if poly.area < 6:
            err(f'{w}: sliver {poly.area:.1f} m2')
        if not (2.0 <= b['height'] <= 340):
            err(f'{w}: height {b["height"]} out of range')
        if b.get('minHeight') is not None and not (0 <= b['minHeight'] < b['height']):
            err(f'{w}: minHeight {b["minHeight"]} >= height')
        if not (1 <= b['levels'] <= 120):
            err(f'{w}: levels {b["levels"]}')
        if not (1849 <= b['yearBuilt'] <= 2026):
            err(f'{w}: yearBuilt {b["yearBuilt"]}')
        if b['structure'] not in STRUCT or b['codeLevel'] not in CODE or b['use'] not in USE or b['district'] not in DISTRICT:
            err(f'{w}: enum value out of contract')
        if b.get('landmark') and b['landmark'] not in LANDMARK:
            err(f'{w}: bad landmark')
        if not (150 <= b['vs30'] <= 900):
            err(f'{w}: vs30 {b["vs30"]}')
        if b['occupantsDay'] < 0 or b['occupantsNight'] < 0:
            err(f'{w}: negative occupants')
        p = b['provenance']
        if p.get('height') not in H_SRC or p.get('year') not in Y_SRC or p.get('structure') not in S_SRC:
            err(f'{w}: bad provenance {p}')
        # baseElevation == min of the app's bilinear sampler over the outline (parts use their parent's outline)
        if b.get('overWater'):
            if not (-1.5 <= b['baseElevation'] <= 3.7):
                err(f'{w}: overWater base {b["baseElevation"]} outside waterline..deck range')
        elif not b.get('isPart') and not b.get('parentId'):
            xs = [q[0] for q in b['footprint']]
            zs = [q[1] for q in b['footprint']]
            m = float(min(terr.height_at(xs, zs)))
            base_dev.append(b['baseElevation'] - m)
            if b['baseElevation'] > m + 0.05:
                err(f'{w}: baseElevation {b["baseElevation"]} above terrain min {m:.2f} (floating)')
        c = poly.centroid
        in_core = cx_core[0] <= c.x <= cx_core[2] and cx_core[1] <= c.y <= cx_core[3]
        if bool(b.get('context')) == in_core:
            err(f'{w}: context flag inconsistent')
        if b.get('parentId') and b['parentId'] not in ids and b['parentId'] not in {x['id'] for x in B}:
            err(f'{w}: parentId {b["parentId"]} not found')
    check_structural_records(B, by_id, terr)
    base_dev = np.array(base_dev)
    print(f'baseElevation - min(terrain over outline): min {base_dev.min():.2f} max {base_dev.max():.2f} '
          f'(negative = sampled at a lower centroid / parent outline)')

    for r in city['roads']:
        if r['kind'] not in ROAD_KIND or len(r['points']) < 2 or not fin(r['width']) or r['width'] <= 0:
            err(f'road {r["id"]} invalid')
        for p in r['points']:
            if not (fin(p[0]) and fin(p[1])):
                err(f'road {r["id"]} non-finite point')
    for a in city['areas']:
        if a['kind'] not in AREA_KIND:
            err(f'area {a["id"]} bad kind')
        check_ring(a['polygon'], a['id'], True)
    for t in city['trees']:
        if not (fin(t['x']) and fin(t['z'])) or t['source'] not in ('datasf', 'osm', 'estimated'):
            err('bad tree')

    # ── summary stats
    n = len(B)
    print(f'\nbuildings {n} (parts {sum(1 for b in B if b.get("isPart"))}, context {sum(1 for b in B if b.get("context"))}), '
          f'roads {len(city["roads"])}, areas {len(city["areas"])}, trees {len(city["trees"])}')

    def tab(title, key):
        c = Counter(key(b) for b in B)
        print(f'{title}: ' + ', '.join(f'{k} {v} ({100 * v / n:.0f}%)' for k, v in c.most_common()))

    tab('district', lambda b: b['district'])
    tab('structure', lambda b: b['structure'])
    tab('code', lambda b: b['codeLevel'])
    tab('use', lambda b: b['use'])
    tab('era', lambda b: 'pre-1906' if b['yearBuilt'] < 1906 else '1906-39' if b['yearBuilt'] < 1940 else
        '1940-72' if b['yearBuilt'] < 1973 else '1973-94' if b['yearBuilt'] <= 1994 else 'post-1994')
    tab('prov.height', lambda b: b['provenance']['height'])
    tab('prov.year', lambda b: b['provenance']['year'])
    tab('prov.structure', lambda b: b['provenance']['structure'])
    print(f'overWater {sum(1 for b in B if b.get("overWater"))}  onFill {sum(b["onFill"] for b in B)}  softStory {sum(b["softStory"] for b in B)}  '
          f'named {sum(1 for b in B if b.get("name"))}  address {sum(1 for b in B if b.get("address"))}  '
          f'colour {sum(1 for b in B if b.get("colour"))}  material {sum(1 for b in B if b.get("material"))}  '
          f'roofShape {sum(1 for b in B if b.get("roofShape"))}')
    print(f'occupants day {sum(b["occupantsDay"] for b in B):,}  night {sum(b["occupantsNight"] for b in B):,}  '
          f'(core only: day {sum(b["occupantsDay"] for b in B if not b.get("context")):,} '
          f'night {sum(b["occupantsNight"] for b in B if not b.get("context")):,})')
    hs = np.array([b['height'] for b in B])
    print(f'height pct 10/50/90/99/max: {np.percentile(hs, [10, 50, 90, 99]).round(1)} {hs.max():.1f}')

    # ── spot checks
    print('\nSPOT CHECKS')
    ok_all = True

    def check(label, cond, detail):
        nonlocal ok_all
        print(f'  [{"PASS" if cond else "FAIL"}] {label}: {detail}')
        if not cond:
            ok_all = False
            err(f'spot check failed: {label}')

    def lm(name):
        return [b for b in B if b.get('landmark') == name]

    def top(b):
        return b['baseElevation'] + (b.get('minHeight') or 0) + (b['height'] - (b.get('minHeight') or 0))

    def cen(b):
        c = Polygon(b['footprint']).centroid
        return c.x, c.y

    for name in ('ferry_building', 'transamerica_pyramid', 'embarcadero_center', 'old_st_marys', 'sentinel_building',
                 'one_maritime_plaza', 'hyatt_regency', 'customs_house', 'coit_tower'):
        bs = lm(name)
        ids_ = ', '.join(f'{b["id"]}{"(part)" if b.get("isPart") else ""} h={b["height"]:.0f}' for b in bs[:8])
        check(f'landmark {name}', len(bs) > 0, f'{len(bs)} records: {ids_}' + (' …' if len(bs) > 8 else ''))

    t = lm('transamerica_pyramid')
    if t:
        h = max(b['height'] for b in t)
        x, z = cen(max(t, key=lambda b: b['height']))
        check('Transamerica height ≈ 260 m', 245 <= h <= 265, f'{h:.1f} m at ({x:.0f}, {z:.0f}) [expected (-421, -186)]')
        check('Transamerica position', math.hypot(x + 421, z + 186) < 30, f'({x:.0f}, {z:.0f})')
    ec = lm('embarcadero_center')
    if ec:
        per = {}
        for b in ec:  # each tower is a stack of setback parts; its height is the tallest piece
            per[b.get('name', '?')] = max(per.get(b.get('name', '?'), 0), b['height'])
        check('Embarcadero Center 1-4 towers 125-178 m (EC2/3 126 m, EC1/4 173-174 m)',
              len(per) >= 4 and all(122 <= h <= 178 for h in per.values()),
              ', '.join(f'{k}: {v:.0f} m' for k, v in sorted(per.items())))
    fb = lm('ferry_building')
    if fb:
        hmax = max(b['height'] for b in fb)
        x, z = cen(max(fb, key=lambda b: b['height']))
        check('Ferry Building tower ≈ 75 m', 65 <= hmax <= 80, f'max {hmax:.1f} m')
        gb = min(b['baseElevation'] for b in fb)
        check('Ferry Building ground 2-4 m', 1.5 <= gb <= 4.5, f'{gb:.2f} m')
        check('Ferry Building position (on shoreline)', math.hypot(x - 401, z + 224) < 60, f'tallest piece at ({x:.0f}, {z:.0f})')
    ct = lm('coit_tower')
    if ct:
        b = max(ct, key=lambda b: b['height'])
        check('Coit Tower ≈ 64 m tall', 55 <= b['height'] <= 70, f'{b["height"]:.1f} m')
        check('Coit Tower base on hill top 80-90 m', 78 <= b['baseElevation'] <= 90, f'{b["baseElevation"]:.1f} m')
    gw = float(terr.height_at(-748, -183))
    kw = float(terr.height_at(-614, -203))
    check('Grant&Washington higher than Kearny&Washington', gw > kw + 4, f'{gw:.1f} m vs {kw:.1f} m')
    th = float(terr.data[(np.abs(terr.minZ + np.arange(terr.rows) * terr.cell + 987) < 150)][:, (np.abs(terr.minX + np.arange(terr.cols) * terr.cell + 689) < 150)].max())
    check('Telegraph Hill summit ≈ 84 m (DEM incl. tower plinth)', 80 <= th <= 95, f'{th:.1f} m')
    fg = float(terr.height_at(401, -224))
    check('Ferry Building terrain 2-4 m', 1.5 <= fg <= 4.5, f'{fg:.2f} m')
    bay = float(terr.height_at(1500, 0))
    check('Bay east of the piers is below sea level', bay < -5, f'{bay:.1f} m')

    print(f'\n{len(errors)} errors, {len(warns)} warnings')
    for e in errors[:40]:
        print('  ERROR', e)
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
