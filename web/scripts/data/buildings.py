"""OSM building footprints + building:parts -> BuildingRecord dicts (see src/contracts.ts).

Pipeline:  collect -> associate parts with parents -> drop/trim parents -> DataSF assessor + LiDAR joins ->
heights -> resolve plan overlaps between whole buildings -> semantics (use/year/structure/occupancy/site) ->
ids sorted by (x, z)."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from shapely.geometry import Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.strtree import STRtree

import classify as C
import datasf
import districts
from geo import CONTEXT_BBOX, CORE_BBOX, bbox_xz
from osm import area_geometry, elements, parse_length, parse_levels, parse_year, polygons_of, tag_layer

LEVEL_H = 3.4  # m per storey (downtown SF average incl. slabs)
MIN_AREA = 6.0  # m2 — slivers below this are dropped
SKIP_BUILDING = {'no', 'roof', 'canopy', 'carport', 'bridge', 'collapsed', 'demolished', 'razed', 'proposed', 'abandoned'}
FLAT = {None, '', 'flat'}

CORE_XZ = bbox_xz(CORE_BBOX)
CONTEXT_XZ = bbox_xz(CONTEXT_BBOX)


@dataclass
class Rec:
    key: str
    osm_id: str
    tags: dict
    poly: Polygon
    is_part: bool = False
    group: str = ''  # key of the outline this record belongs to (itself for plain buildings)
    height: float = 0.0
    min_height: float = 0.0
    levels: float = 0.0
    h_src: str = 'estimated'
    landmark: str | None = None
    extra: dict = field(default_factory=dict)


# ───────────────────────────── landmarks ─────────────────────────────

LANDMARK_PATTERNS = [
    ('ferry_building', re.compile(r'^(San Francisco )?Ferry Building$', re.I)),
    ('transamerica_pyramid', re.compile(r'^Transamerica Pyramid$', re.I)),
    ('embarcadero_center', re.compile(r'^(Embarcadero Center [1-4]|(One|Two|Three|Four) Embarcadero Center)$', re.I)),
    ('old_st_marys', re.compile(r"^Old (Saint|St\.?) Mary'?s Cathedral", re.I)),
    ('sentinel_building', re.compile(r'^(Sentinel Building|Columbus Tower)$', re.I)),
    ('one_maritime_plaza', re.compile(r'^(One Maritime Plaza|Alcoa Building)$', re.I)),
    ('hyatt_regency', re.compile(r'^Hyatt Regency San Francisco$', re.I)),
    ('customs_house', re.compile(r'^(United States|U\.?S\.?) Customs? House$', re.I)),
    ('coit_tower', re.compile(r'^Coit Tower$', re.I)),
]

# Hand-curated facts for the named landmarks (year completed, HAZUS type, code level after known retrofits).
LANDMARK_FACTS = {
    'ferry_building': dict(year=1898, structure='S5', code='moderate'),  # steel frame + masonry; 2003 seismic retrofit
    'transamerica_pyramid': dict(year=1972, structure='S1', code='moderate'),  # designed well beyond 1972 code
    'old_st_marys': dict(year=1854, structure='URM', code='low'),  # brick; rebuilt 1909, retrofitted
    'sentinel_building': dict(year=1907, structure='C3', code='pre'),  # early reinforced-concrete flatiron
    'one_maritime_plaza': dict(year=1964, structure='S2', code='low'),  # exterior X-braced steel
    'hyatt_regency': dict(year=1973, structure='C2', code='moderate'),
    'customs_house': dict(year=1911, structure='S5', code='pre'),  # steel frame clad in granite
    'coit_tower': dict(year=1933, structure='C2', code='pre'),  # unbraced reinforced-concrete shaft
}
EC_YEARS = {'1': 1971, '2': 1974, '3': 1977, '4': 1982, 'one': 1971, 'two': 1974, 'three': 1977, 'four': 1982}


def landmark_of(tags: dict) -> str | None:
    if tags.get('bridge:support') or (tags.get('man_made') == 'tower' and str(tags.get('ref', '')).startswith('W')):
        return 'bay_bridge'  # San Francisco-Oakland Bay Bridge west-span pylons (W1, W2, ...)
    name = tags.get('name') or ''
    for lid, pat in LANDMARK_PATTERNS:
        if pat.search(name):
            return lid
    return None


# ───────────────────────────── collection ─────────────────────────────


def _inside(poly: Polygon, xz) -> bool:
    c = poly.centroid
    return xz[0] <= c.x <= xz[2] and xz[1] <= c.y <= xz[3]


def collect() -> tuple[list[Rec], list[Rec], dict[str, str]]:
    """-> (buildings, parts, explicit part->outline links from type=building relations)."""
    blds, parts = [], []
    links: dict[str, str] = {}
    for e in elements():
        t = e.get('tags', {})
        oid = f"{e['type']}/{e['id']}"
        if e['type'] == 'relation' and t.get('type') == 'building':
            outline = [f"{m['type']}/{m['ref']}" for m in e.get('members', []) if m.get('role') == 'outline']
            if outline:
                for m in e.get('members', []):
                    if m.get('role') == 'part':
                        links[f"{m['type']}/{m['ref']}"] = outline[0]
            continue
        if e['type'] not in ('way', 'relation'):
            continue
        b, bp = t.get('building'), t.get('building:part')
        is_bld = b is not None and b not in SKIP_BUILDING
        is_part = not is_bld and bp is not None and bp != 'no' and b is None
        if not (is_bld or is_part):
            continue
        if t.get('location') == 'underground' or (tag_layer(t) < 0 and is_bld and t.get('min_height') is None):
            continue
        polys = [p for p in polygons_of(area_geometry(e)) if p.area >= MIN_AREA]
        for k, p in enumerate(polys):
            if not _inside(p, CONTEXT_XZ):
                continue
            r = Rec(key=f'{oid}#{k}', osm_id=oid, tags=t, poly=p, is_part=is_part)
            r.landmark = landmark_of(t)
            (blds if is_bld else parts).append(r)
    return blds, parts, links


def associate_parts(blds: list[Rec], parts: list[Rec], links: dict[str, str]) -> None:
    """Set part.group to its outline's key (explicit relation link first, else the max-overlap outline)."""
    by_osm = defaultdict(list)
    for b in blds:
        by_osm[b.osm_id].append(b)
    tree = STRtree([b.poly for b in blds])
    idx = {id(b.poly): b for b in blds}
    for p in parts:
        cands = by_osm.get(links.get(p.osm_id, ''), [])
        best, best_a = None, 0.0
        for b in cands or [idx[id(g)] for g in tree.query(p.poly)]:
            try:
                a = b.poly.intersection(p.poly).area
            except Exception:  # noqa: BLE001
                continue
            if a > best_a:
                best, best_a = b, a
        if best is not None and (cands or best_a / p.poly.area >= 0.5):
            p.group = best.key
        else:
            p.group = p.key  # orphan part: its own group


def trim_parents(blds: list[Rec], parts: list[Rec]) -> tuple[list[Rec], dict[str, Rec]]:
    """Drop outlines covered >= 80 % by their parts; otherwise keep only the outline area not covered by parts
    (no coincident volumes -> no z-fighting).  Returns (kept outline pieces, original outline by key)."""
    by_group = defaultdict(list)
    for p in parts:
        by_group[p.group].append(p)
    kept: list[Rec] = []
    outlines = {b.key: b for b in blds}
    for b in blds:
        b.group = b.key
        ps = by_group.get(b.key)
        if not ps:
            kept.append(b)
            continue
        cover_geom = unary_union([p.poly for p in ps])
        cover = cover_geom.intersection(b.poly).area / b.poly.area
        # Parts inherit the outline's identity tags when they have none of their own.
        for p in ps:
            for k in ('name', 'addr:housenumber', 'addr:street', 'start_date', 'building', 'amenity', 'tourism',
                      'building:colour', 'building:material'):
                if k in b.tags and k not in p.tags:
                    p.tags = {**p.tags, k: b.tags[k]}
            p.landmark = p.landmark or b.landmark
        if cover >= 0.8:
            b.extra['dropped'] = True
            continue
        rest = b.poly.difference(cover_geom.buffer(0.01))
        for k, piece in enumerate(polygons_of(rest)):
            if piece.area >= MIN_AREA:
                kept.append(Rec(key=f'{b.key}r{k}', osm_id=b.osm_id, tags=b.tags, poly=piece, group=b.key,
                                landmark=b.landmark))
    return kept, outlines


# ───────────────────────────── structural groups ─────────────────────────────

TOUCH = 0.3  # m — outlines closer than this are physically joined


def _ident(t: dict) -> tuple[str | None, str | None]:
    """(OSM address, OSM name), normalised; assessor addresses are not used (one parcel often spans buildings)."""
    addr = None
    if t.get('addr:housenumber') and t.get('addr:street'):
        addr = f"{t['addr:housenumber'].strip().lower()} {t['addr:street'].strip().lower()}"
    return addr, (t.get('name') or '').strip().lower() or None


def structural_groups(groups: dict[str, Polygon], tags: dict[str, dict], landmark: dict[str, str | None],
                      orphans: set[str]) -> dict[str, str]:
    """Geometry group (an OSM outline with its parts, or an orphan part) -> structural group, by union-find.

    A geometry group already is one structure (parts are linked to their outline by relation or overlap).  On top of
    that, touching groups are merged when they are pieces of one building mapped separately: orphan parts touching
    each other (buildings mapped only as parts, e.g. the Salesforce Transit Center), and groups sharing an OSM
    address or name (a tower and its podium drawn as two outlines).  Different landmarks are never merged."""
    keys = list(groups)
    parent = {k: k for k in keys}

    def find(k: str) -> str:
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    tree = STRtree([groups[k] for k in keys])
    key_of = {id(groups[k]): k for k in keys}
    ident = {k: _ident(tags[k]) for k in keys}
    for a in keys:
        ga = groups[a]
        for g in tree.query(ga.buffer(TOUCH)):
            b = key_of[id(g)]
            if b <= a or g.distance(ga) > TOUCH:
                continue
            la, lb = landmark[a], landmark[b]
            if la and lb and la != lb:
                continue
            (aa, na), (ab, nb) = ident[a], ident[b]
            if (a in orphans and b in orphans) or (aa and aa == ab) or (na and na == nb):
                parent[find(a)] = find(b)
    return {k: find(k) for k in keys}


# ───────────────────────────── heights ─────────────────────────────


def _roof_extra(t: dict) -> float:
    rh = parse_length(t.get('roof:height'))
    if rh is not None:
        return rh
    rl = parse_levels(t.get('roof:levels'))
    if rl:
        return rl * 2.8
    return 2.5 if t.get('roof:shape') not in FLAT else 0.8  # pitched roof / parapet


def assign_height(r: Rec, agg: datasf.AssessorAgg, outline_h: float | None) -> None:
    t = r.tags
    osm_h = parse_length(t.get('height')) or parse_length(t.get('est_height'))
    lv = parse_levels(t.get('building:levels'))
    min_lv = parse_levels(t.get('building:min_level'))
    r.min_height = parse_length(t.get('min_height')) or ((min_lv or 0) * LEVEL_H)
    year = agg.year
    lid = None if r.is_part else datasf.lidar_for(r.poly)
    lid_ok = lid is not None and lid.height is not None and lid.coverage >= 0.5 and lid.height >= 2.5
    pre_lidar = year is None or year < 2009  # DataSF heights come from the 2010 LiDAR flight

    if osm_h is not None and osm_h >= 2.0:
        r.height, r.h_src = osm_h, 'osm_height'
        if lid_ok and pre_lidar and not (0.4 * lid.height <= osm_h <= 2.5 * lid.height) and lid.height > 4:
            r.height, r.h_src = lid.height, 'datasf_lidar'  # OSM value clearly wrong
    elif lv is not None and lv > 0:
        lv_h = (lv - (min_lv or 0)) * LEVEL_H + r.min_height + _roof_extra(t)
        r.height, r.h_src = lv_h, 'osm_levels'
        if lid_ok and pre_lidar and 0.5 <= lid.height / lv_h <= 2.0:
            r.height, r.h_src = lid.height, 'datasf_lidar'  # measured roof beats levels x storey height
    elif lid_ok and (pre_lidar or lid.height > 6):
        r.height, r.h_src = lid.height, 'datasf_lidar'
    elif r.is_part and outline_h:
        r.height, r.h_src = outline_h, 'estimated'
    elif agg.stories:
        r.height, r.h_src = agg.stories * LEVEL_H + 0.8, 'estimated'
    else:
        r.height, r.h_src = None, 'estimated'  # filled once the district is known
    if lv:
        r.levels = lv
    elif agg.stories and not r.is_part:
        r.levels = agg.stories
    r.extra['lidar'] = lid


def default_height(r: Rec, district: str) -> float:
    base = {'chinatown': 4.5, 'jackson_square': 3, 'fidi': 6, 'embarcadero': 2, 'nob_hill': 5, 'north_beach': 3.5,
            'soma': 4, 'other': 4}[district]
    lv = max(1, round(base + (C.rnd(r.key, 'lv') - 0.5) * 2))
    if r.poly.area < 40:
        lv = 1
    return lv * LEVEL_H + 0.8


# ───────────────────────────── overlaps ─────────────────────────────


def resolve_overlaps(recs: list[Rec]) -> list[Rec]:
    """Whole buildings must not overlap in plan (coincident volumes z-fight).  For each overlapping pair the
    taller keeps the shared area.  Parts are left untouched (their stacking is authored), but a whole building
    loses any area covered by a ground-level part of a different outline."""
    solid = [r for r in recs if not r.is_part]
    tree = STRtree([r.poly for r in recs])
    idx = {id(r.poly): r for r in recs}
    cut = defaultdict(list)
    for a in solid:
        for g in tree.query(a.poly):
            b = idx[id(g)]
            if b is a or b.group == a.group:
                continue
            if b.is_part and b.min_height > 0.5:
                continue
            if not b.is_part and (b.height, b.poly.area, b.key) <= (a.height, a.poly.area, a.key):
                continue  # a is the taller (or tie-break winner) — b gets cut instead
            try:
                inter = a.poly.intersection(b.poly).area
            except Exception:  # noqa: BLE001
                continue
            if inter > 0.5:
                cut[a.key].append(b.poly)
    out = []
    for r in recs:
        if r.key not in cut:
            out.append(r)
            continue
        rest = r.poly.difference(unary_union(cut[r.key]).buffer(0.01))
        for k, piece in enumerate(polygons_of(rest)):
            if piece.area >= MIN_AREA and piece.area / max(piece.length, 1e-6) > 0.35:  # no hair-thin strips
                out.append(Rec(**{**r.__dict__, 'key': f'{r.key}c{k}', 'poly': piece, 'extra': dict(r.extra)}))
    return out


# ───────────────────────────── geometry output ─────────────────────────────


def ring_out(coords, outer: bool) -> list[list[float]]:
    pts = [[round(x, 2), round(z, 2)] for x, z in list(coords)[:-1]]
    dedup = [p for i, p in enumerate(pts) if p != pts[i - 1]]
    s = sum(dedup[i][0] * dedup[(i + 1) % len(dedup)][1] - dedup[(i + 1) % len(dedup)][0] * dedup[i][1]
            for i in range(len(dedup)))
    if (s > 0) == outer:  # outer must be negative (CCW seen from +Y in our x/z frame), holes positive
        dedup.reverse()
    return dedup


def clean_poly(p: Polygon) -> Polygon | None:
    p = p.simplify(0.05, preserve_topology=True)
    if not p.is_valid:
        p = p.buffer(0)
    ps = polygons_of(p)
    if not ps:
        return None
    p = max(ps, key=lambda q: q.area)
    holes = [h for h in p.interiors if Polygon(h).area >= MIN_AREA]
    p = Polygon(p.exterior, holes)
    return orient(p, sign=-1.0) if p.area >= MIN_AREA else None


# ───────────────────────────── group semantics ─────────────────────────────


def _osm_year(t: dict) -> int | None:
    return parse_year(t.get('start_date') or t.get('building:start_date') or t.get('construction_date'))


def group_semantics(sg: str, anchor: dict, ds: list[dict], aggs: dict, groups: dict[str, Polygon]) -> dict:
    """Year / HAZUS structure / code level / soft-story of one structural group, decided once from its anchor with
    group-wide height, storeys and plan area (so a 17 m podium slice of Salesforce Tower is not 'wood frame')."""
    ctx = anchor['_ctx']
    by_h = sorted(ds, key=lambda d: -d['height'])
    height = by_h[0]['height']
    levels = ctx['levels']
    use, district, on_pier = anchor['use'], ctx['district'], ctx['on_pier']
    gkeys = sorted({d['_ctx']['group'] for d in ds}, key=lambda k: (k != ctx['group'], -groups[k].area))
    plan_area = sum(groups[k].area for k in gkeys)
    # Assessor record: the anchor's outline, else the largest outline of the group that matched a parcel.
    agg = next((aggs[k] for k in gkeys if aggs[k].year or aggs[k].ctype), aggs[gkeys[0]])
    soft = any(aggs[k].soft_story for k in gkeys)
    lm = anchor.get('landmark') or next((d['landmark'] for d in by_h if d.get('landmark')), None)
    tags = [anchor['_ctx']['tags']] + [d['_ctx']['tags'] for d in by_h]
    osm_year = next((y for t in tags if (y := _osm_year(t))), None)
    material = next((t['building:material'] for t in tags if t.get('building:material')), None)

    facts = LANDMARK_FACTS.get(lm or '', {})
    if lm == 'embarcadero_center':
        m = re.search(r'(\d|One|Two|Three|Four)', anchor.get('name') or '', re.I)
        facts = dict(year=EC_YEARS.get(m.group(1).lower(), 1977)) if m else {}
    if facts.get('year'):
        year = facts['year']
        ysrc = 'assessor' if agg.year == year else 'osm' if osm_year == year else 'estimated'
    else:
        picked = C.pick_year(agg.year, osm_year, height, levels)
        year, ysrc = picked or (C.estimate_year(sg, district, height, use, material, levels), 'estimated')

    structure, ssrc = None, 'estimated'
    if agg.ctype:
        structure = C.structure_from_assessor(agg.ctype, year, levels, use, plan_area, height)
        ssrc = 'assessor' if structure else 'estimated'
    if facts.get('structure'):
        structure, ssrc = facts['structure'], ssrc if structure == facts['structure'] else 'estimated'
    if structure is None:
        structure = C.estimate_structure(sg, district, year, height, levels, use, plan_area, on_pier)
    fix = None if facts.get('structure') else C.sanitize_structure(structure, year, height, use)
    if fix:
        structure, ssrc = fix, 'estimated'
    # The soft-story list covers wood frames of 2-5 storeys; a match on a taller building is a parcel-join artefact.
    soft = soft and height <= C.SANE_MAX_HEIGHT
    if soft and structure in ('W1', 'W2'):
        structure = 'W1_SOFT'
    code = facts.get('code') or C.resolve_code_level(structure, year, district)
    return dict(year=int(year), ysrc=ysrc, structure=structure, ssrc=ssrc, code=code, soft=bool(soft))


# ───────────────────────────── main ─────────────────────────────


def build(terrain, piers: list[Polygon]) -> tuple[list[dict], dict]:
    blds, parts, links = collect()
    print(f'[buildings] OSM outlines {len(blds)}, parts {len(parts)}, relation links {len(links)}')
    associate_parts(blds, parts, links)
    kept, outlines = trim_parents(blds, parts)
    dropped = sum(1 for b in blds if b.extra.get('dropped'))
    print(f'[buildings] outlines dropped (parts cover >= 80 %): {dropped}; outline pieces kept {len(kept)}')

    # Assessor parcels -> outline groups (whole original outlines, so parts share their building's record).
    # Orphan parts (no outline) form their own group.
    groups = {b.key: b.poly for b in blds}
    g_tags = {b.key: b.tags for b in blds}
    g_lm = {b.key: b.landmark for b in blds}
    for p in parts:
        if p.group not in groups:  # orphan part: its own geometry group
            groups[p.group], g_tags[p.group], g_lm[p.group] = p.poly, p.tags, p.landmark
    orphans = {p.group for p in parts if p.group == p.key}
    sgroup_of = structural_groups(groups, g_tags, g_lm, orphans)
    n_sg = len(set(sgroup_of.values()))
    print(f'[buildings] geometry groups {len(groups)} -> structural groups {n_sg} '
          f'({len(groups) - n_sg} merged: touching orphan parts / shared OSM address or name)')
    gkeys = list(groups)
    mblr_of = {}
    for k in gkeys:
        m = datasf.lidar_for(groups[k])
        mblr_of[k] = m.best.mblr if m.best is not None and m.best.geom.intersection(groups[k]).area > 0.3 * groups[k].area else None
    parcels = datasf.group_parcels_by_building([groups[k] for k in gkeys], gkeys, mblr_of)
    aggs = {k: datasf.aggregate(parcels.get(k, [])) for k in gkeys}
    # Soft-story parcels -> group via APN (parcel assignment) or point containment.
    ss = datasf.soft_story()
    apn_group = {apn: k for k, a in aggs.items() for apn in a.apns}
    g_tree = STRtree([groups[k] for k in gkeys])
    g_idx = {id(groups[k]): k for k in gkeys}
    ss_hits = 0
    for apn, s in ss.items():
        k = apn_group.get(apn)
        if k is None and s['pt'] is not None:
            hit = [g for g in g_tree.query(s['pt']) if g.contains(s['pt'])]
            k = g_idx[id(hit[0])] if hit else None
        if k is not None:
            aggs[k].soft_story = True
            ss_hits += 1
    print(f'[buildings] assessor parcels matched to {sum(1 for a in aggs.values() if a.apns)} groups; '
          f'soft-story {ss_hits}/{len(ss)}')

    recs = kept + parts
    outline_h = {}
    for r in sorted(recs, key=lambda r: r.is_part):  # outlines first so parts can fall back to them
        assign_height(r, aggs[r.group], outline_h.get(r.group))
        if not r.is_part and r.height:
            outline_h[r.group] = max(outline_h.get(r.group, 0), r.height)
    # Dropped outlines may still carry the authoritative height for parts without one.
    parts_by_group = defaultdict(list)
    for p in parts:
        parts_by_group[p.group].append(p)
    for b in blds:
        if not b.extra.get('dropped'):
            continue
        h = parse_length(b.tags.get('height'))
        if not h:
            continue
        outline_h.setdefault(b.key, h)
        # Mappers often put the true roof height on the outline and stop the tallest part at the last setback
        # (e.g. Embarcadero Center 4: outline 174 m, parts to 154 m).  Lift the main tower part to the outline.
        ps = [p for p in parts_by_group[b.key] if p.height]
        top = max((p.height for p in ps), default=0)
        if ps and h > top + 3 and top >= 0.8 * h:
            for p in ps:
                if p.height >= top - 0.5:
                    p.height = h

    pier_polys = [pp for pp, _ in piers]
    pier_deck = {id(pp): d for pp, d in piers}
    pier_tree = STRtree(pier_polys) if pier_polys else None

    def deck_at(pt) -> float | None:
        if pier_tree is None:
            return None
        for g in pier_tree.query(pt):
            if g.contains(pt):
                return pier_deck[id(g)]
        return None

    out_rows: list[dict] = []
    stats = Counter()
    pre = []
    for r in recs:
        c = r.poly.representative_point()
        on_pier = deck_at(c) is not None
        district = districts.classify(c.x, c.y, on_pier)
        if r.height is None:
            r.height = outline_h.get(r.group) if r.is_part and outline_h.get(r.group) else default_height(r, district)
        r.height = float(min(max(r.height, 2.5), 330.0))
        if r.min_height >= r.height - 1.0:
            r.min_height = max(0.0, r.height - 3.0) if r.is_part else 0.0
        if not r.is_part:
            r.min_height = 0.0
        r.extra.update(district=district, on_pier=on_pier)
        pre.append(r)
    recs = resolve_overlaps(pre)

    for r in recs:
        p = clean_poly(r.poly)
        if p is None:
            continue
        g = groups[r.group]
        agg = aggs[r.group]
        district, on_pier = r.extra['district'], r.extra['on_pier']
        t = r.tags
        area = p.area
        levels = r.levels or max(1.0, round((r.height - r.min_height) / 3.6))
        levels = float(min(max(levels, 1), 120))

        # semantics: use is per piece (podium retail under an office tower); year / structure / code are decided once
        # per structural group in group_semantics() below.
        use = C.classify_use(t, agg, district, r.height)
        lm = r.landmark

        # occupancy: units split across the group's records by floor area
        gfa = area * levels
        units = agg.units * min(1.0, area / max(g.area, 1.0)) if agg.units else 0.0
        day, night = C.occupants(use, gfa, units, levels, area)

        # site
        filled = districts.on_fill(c.x, c.y) if (c := p.representative_point()) else False
        filled = filled or on_pier
        # Parts (and an outline's remainder around them) share the whole outline's base so stacked pieces line up;
        # every other building uses its own footprint.
        shared_base = r.is_part or r.group in parts_by_group
        bp = g if shared_base else p
        inner = bp.centroid if bp.contains(bp.centroid) else bp.representative_point()  # concave: centroid may lie outside
        samples = list(bp.exterior.coords) + [tuple(inner.coords[0])]
        if shared_base:
            samples += list(p.exterior.coords)  # parts may poke out of their outline onto lower ground
        hs = terrain.height_at([s[0] for s in samples], [s[1] for s in samples])
        base = float(min(hs))
        # Over the bay: moored vessels float at the waterline; pier sheds / wharf buildings stand on the deck.
        over_water = False
        deck = deck_at(bp.representative_point())
        if t.get('building') == 'ship':
            base, over_water = -1.0, True
        elif lm == 'bay_bridge':
            base, over_water = 0.0, True  # bridge pylon rising out of the bay (height is above the waterline)
        elif deck is not None:
            base, over_water = deck, True
        elif (hs < 0.3).mean() >= 0.5:
            # Over water with no mapped pier under it (floating fireboat station, wharf annexes): walls reach into
            # the water instead of hovering at deck height over nothing.
            base, over_water = -0.5, True
        ground_c = float(terrain.height_at(c.x, c.y))
        v30 = districts.vs30(c.x, c.y, ground_c, filled)
        cen = p.centroid
        core = CORE_XZ[0] <= cen.x <= CORE_XZ[2] and CORE_XZ[1] <= cen.y <= CORE_XZ[3]

        addr = None
        if t.get('addr:housenumber') and t.get('addr:street'):
            addr = f"{t['addr:housenumber']} {t['addr:street']}"
        elif agg.address:
            addr = agg.address

        row = dict(
            _key=r.key, _group=r.group, _cx=cen.x, _cz=cen.y,
            osmId=r.osm_id,
            name=t.get('name'),
            address=addr,
            footprint=ring_out(p.exterior.coords, True),
            holes=[ring_out(h.coords, False) for h in p.interiors] or None,
            baseElevation=round(base, 2),
            height=round(r.height, 2),
            minHeight=round(r.min_height, 2) if r.is_part and r.min_height > 0 else None,
            levels=levels,
            use=use,
            structure=None,  # ┐
            yearBuilt=None,  # │ filled per structural group (group_semantics)
            codeLevel=None,  # │
            occupantsDay=int(day),
            occupantsNight=int(night),
            softStory=None,  # ┘
            district=district,
            onFill=bool(filled),
            vs30=float(v30),
            roofShape=t.get('roof:shape'),
            colour=t.get('building:colour') or t.get('colour'),
            roofColour=t.get('roof:colour'),
            material=t.get('building:material'),
            landmark=lm,
            isPart=None,  # set with the parent links below
            context=None if core else True,
            overWater=True if over_water else None,
            provenance=dict(height=r.h_src),
            _sg=sgroup_of[r.group], _area=area, _shared_base=shared_base and not over_water,
            _ctx=dict(agg=agg, tags=t, levels=levels, district=district, on_pier=on_pier, group=r.group,
                      ground=r.min_height <= 0.5),
        )
        out_rows.append(row)
        stats[r.h_src] += 1

    # Stacked pieces of one outline share the lowest base of the outline and all its pieces.
    gbase: dict[str, float] = {}
    for d in out_rows:
        if d['_shared_base']:
            gbase[d['_group']] = min(gbase.get(d['_group'], 1e9), d['baseElevation'])
    for d in out_rows:
        if d['_shared_base']:
            d['baseElevation'] = gbase[d['_group']]

    # Stable ids by (x, z).
    out_rows.sort(key=lambda d: (round(d['_cx'], 2), round(d['_cz'], 2), d['_key']))
    for i, d in enumerate(out_rows):
        d['id'] = f'B{i + 1:04d}'
    # One structural record per building: the anchor (tallest ground-standing piece) carries the building's
    # semantics and all its occupants; every other piece (building:part, outline remainder around parts, piece cut by
    # an overlap, separately mapped podium) is render geometry: isPart, parentId -> anchor, same structure / year /
    # code, no occupants of its own.  So `!isPart` (equivalently `!parentId`) enumerates buildings exactly once.
    by_sg = defaultdict(list)
    for d in out_rows:
        by_sg[d['_sg']].append(d)
    for sg, ds in by_sg.items():
        anchor = max(ds, key=lambda d: (d['_ctx']['ground'], d['height'], d['_area'], d['id']))
        sem = group_semantics(sg, anchor, ds, aggs, groups)
        day = sum(d['occupantsDay'] for d in ds)
        night = sum(d['occupantsNight'] for d in ds)
        for d in ds:
            prov = {**d['provenance'], 'year': sem['ysrc'], 'structure': sem['ssrc']}
            d.update(structure=sem['structure'], yearBuilt=sem['year'], codeLevel=sem['code'],
                     softStory=sem['soft'], provenance=prov)
            if d is anchor:
                d.update(occupantsDay=day, occupantsNight=night)
            else:
                d.update(isPart=True, parentId=anchor['id'], occupantsDay=0, occupantsNight=0)
    final = []
    for d in out_rows:
        rec = {'id': d['id']}
        for k, v in d.items():
            if k.startswith('_') or k == 'id' or v is None:
                continue
            rec[k] = v
        final.append(rec)
    info = dict(heights=stats, dropped_outlines=dropped, soft_story_matched=ss_hits)
    return final, info


def _area(ring) -> float:
    return abs(sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1]
                   for i in range(len(ring)))) / 2
