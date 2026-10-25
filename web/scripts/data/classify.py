"""Building semantics: use, year, HAZUS structure type, code level, occupancy.  Every heuristic is documented in
public/data/SOURCES.md; numbers here are the single source of truth for that document."""
from __future__ import annotations

import hashlib

from datasf import AssessorAgg

# ───────────────────────────── deterministic jitter ─────────────────────────────


def rnd(key: str, salt: str = '') -> float:
    """Stable pseudo-random in [0, 1) from a string key (so re-runs produce identical output)."""
    h = hashlib.blake2b((key + '|' + salt).encode(), digest_size=8).digest()
    return int.from_bytes(h, 'little') / 2**64


# ───────────────────────────── use ─────────────────────────────

_OSM_USE = {
    'office': 'office', 'commercial': 'commercial', 'retail': 'retail', 'supermarket': 'retail', 'kiosk': 'retail',
    'hotel': 'hotel', 'apartments': 'residential', 'residential': 'residential', 'house': 'residential',
    'terrace': 'residential', 'detached': 'residential', 'semidetached_house': 'residential', 'dormitory': 'residential',
    'church': 'religious', 'cathedral': 'religious', 'chapel': 'religious', 'temple': 'religious',
    'religious': 'religious', 'mosque': 'religious', 'synagogue': 'religious',
    'school': 'school', 'university': 'school', 'college': 'school', 'kindergarten': 'school',
    'civic': 'civic', 'government': 'civic', 'public': 'civic', 'fire_station': 'civic', 'hospital': 'civic',
    'museum': 'civic', 'library': 'civic', 'courthouse': 'civic', 'post_office': 'civic',
    'industrial': 'industrial', 'warehouse': 'industrial', 'service': 'industrial', 'shed': 'industrial',
    'garage': 'parking', 'garages': 'parking', 'parking': 'parking', 'carport': 'parking',
    'train_station': 'transport', 'transportation': 'transport', 'ferry_terminal': 'transport',
    'boathouse': 'transport', 'hangar': 'transport',
}
_AMENITY_USE = {
    'place_of_worship': 'religious', 'school': 'school', 'college': 'school', 'university': 'school',
    'townhall': 'civic', 'courthouse': 'civic', 'police': 'civic', 'fire_station': 'civic', 'library': 'civic',
    'hospital': 'civic', 'clinic': 'civic', 'post_office': 'civic', 'community_centre': 'civic',
    'parking': 'parking', 'ferry_terminal': 'transport', 'bus_station': 'transport',
    'restaurant': 'retail', 'cafe': 'retail', 'bank': 'commercial', 'theatre': 'civic', 'cinema': 'retail',
}
_ASSESSOR_USE = {'SRES': 'residential', 'MRES': 'residential', 'COMO': 'office', 'COMR': 'retail',
                 'COMH': 'hotel', 'COMM': 'commercial', 'IND': 'industrial', 'GOVT': 'civic', 'MISC': 'other'}
_DISTRICT_USE = {'chinatown': 'mixed', 'fidi': 'office', 'embarcadero': 'commercial', 'jackson_square': 'commercial',
                 'nob_hill': 'residential', 'north_beach': 'residential', 'soma': 'office', 'other': 'mixed'}


def classify_use(tags: dict, agg: AssessorAgg, district: str, height: float) -> str:
    b = tags.get('building', tags.get('building:part', 'yes'))
    if tags.get('tourism') == 'hotel' or b == 'hotel':
        return 'hotel'
    if tags.get('amenity') in _AMENITY_USE and tags.get('amenity') not in ('restaurant', 'cafe', 'bank', 'cinema'):
        return _AMENITY_USE[tags['amenity']]
    if b in _OSM_USE and b not in ('residential', 'commercial', 'house', 'apartments'):
        return _OSM_USE[b]
    a = _ASSESSOR_USE.get(agg.use_code or '')
    res_units = agg.units >= 2 and agg.use_code in ('COMM', 'COMR', 'MRES')
    if a == 'residential' and district == 'chinatown':
        return 'mixed'  # Chinatown: flats above street-level shops is the norm
    if a in ('retail', 'commercial') and res_units and agg.units >= 3:
        return 'mixed'
    if a:
        return a
    if b in _OSM_USE:
        return _OSM_USE[b]
    if tags.get('shop') or tags.get('amenity') in _AMENITY_USE:
        return _AMENITY_USE.get(tags.get('amenity'), 'retail')
    if district in ('fidi', 'soma') and height > 30:
        return 'office'
    return _DISTRICT_USE.get(district, 'other')


# ───────────────────────────── year ─────────────────────────────

# Size envelope of SF buildings by completion era: (last year of the era, max storeys, max height m incl. crowns).
# From the city's skyline record: before 1890 nothing much above 8 storeys; the post-1906 steel frames reach 21
# (Hobart 1914, the 1898 Call Building / Central Tower); the 1920s boom ~31 (Russ 1927, 133 m); the quiet
# 1932-58 period ~30; 1959-68 ~43 (Wells Fargo 1966, 171 m); 200 m+ only from 1969 (555 California).
ERA_LIMITS = [(1889, 8, 40.0), (1920, 21, 100.0), (1931, 32, 150.0), (1958, 30, 130.0), (1968, 45, 195.0)]
# Assessor "year built" spikes (1900, 1906, 1907 hold 3-4x their neighbours): partly real post-fire rebuilding,
# partly a default for "old".  On tall buildings an OSM start_date wins over these values.
SUSPECT_ASSESSOR_YEARS = {1900, 1906, 1907, 1908, 1909}
MASONRY = {'brick', 'stone', 'sandstone', 'granite', 'limestone', 'terracotta', 'terra_cotta', 'marble'}
MODERN_SKIN = {'glass', 'metal', 'steel', 'aluminium', 'aluminum'}


def year_plausible(year: int, height: float, storeys: float) -> bool:
    """False when a building this tall could not have been completed in `year` (see ERA_LIMITS)."""
    for last, max_storeys, max_h in ERA_LIMITS:
        if year <= last:
            return storeys <= max_storeys and height <= max_h
    return True


def pick_year(assessor_year: int | None, osm_year: int | None, height: float, storeys: float) -> tuple[int, str] | None:
    """(year, provenance) from the recorded sources, or None when the caller must estimate.

    Assessor first (it covers 84 %), except when it is implausible for the building's size, or is one of the spike
    years on a > 40 m building whose OSM start_date says otherwise; then OSM start_date (mapper-curated, trusted
    even beyond the era envelope: renovations and towers on old bases are real)."""
    a, o = assessor_year, osm_year
    if a and o and a != o and height > 40 and a in SUSPECT_ASSESSOR_YEARS:
        return o, 'osm'
    if a and year_plausible(a, height, storeys):
        return a, 'assessor'
    if o:
        return o, 'osm'
    return None


def estimate_year(key: str, district: str, height: float, use: str, material: str | None = None,
                  storeys: float | None = None) -> int:
    """Construction-era guess when neither the assessor nor OSM give one (or theirs is implausible): district and
    height, nudged by the OSM facade material, then lifted into the first era that could build something this tall."""
    year = _estimate_year(key, district, height, use, (material or '').lower())
    st = storeys if storeys else height / 3.6
    if not year_plausible(year, height, st):
        r = rnd(key, 'year-lift')
        year = int(1960 + r * 30) if year_plausible(1960, height, st) else int(1969 + r * 21)
    return year


def _estimate_year(key: str, district: str, height: float, use: str, material: str) -> int:
    r = rnd(key, 'year')
    if height >= 100:
        return int(1968 + r * 22)  # downtown high-rise boom 1968-1990
    if height >= 40:
        # Mid-rise towers: brick/stone/terracotta skins are the 1920s boom, glass/metal the post-war one; unknown
        # skins lean post-war (most of today's 40-100 m stock).  Tall buildings no longer inherit a district's
        # low-rise era (a 90 m Chinatown-edge office is not a 1907 rebuild).
        if material in MASONRY:
            return int(1921 + r * 10)
        if material in MODERN_SKIN or district in ('fidi', 'soma', 'embarcadero') or height >= 60:
            return int(1960 + r * 30)
        return int(1921 + r * 10) if r < 0.3 else int(1960 + (r - 0.3) / 0.7 * 30)
    if district == 'chinatown':
        return int(1907 + r * 18)  # post-1906 rebuild
    if district == 'jackson_square':
        return int(1855 + r * 12) if height <= 14 else int(1907 + r * 15)
    if district == 'embarcadero':
        return int(1912 + r * 20) if height <= 20 else int(1975 + r * 15)
    if district in ('fidi', 'soma'):
        return int(1907 + r * 23)
    if use == 'parking':
        return int(1955 + r * 25)
    return int(1907 + r * 23)  # North Beach / Nob Hill / Union Sq.: post-quake fabric


# ───────────────────────────── structure ─────────────────────────────


def code_level(year: int) -> str:
    if year < 1940:
        return 'pre'
    if year < 1973:
        return 'low'
    if year <= 1994:
        return 'moderate'
    return 'high'


def structure_from_assessor(ctype: str, year: int, levels: float, use: str, footprint: float, height: float) -> str | None:
    """Assessor 'Class of construction' (Marshall & Swift A/B/C/D/S) -> HAZUS model building type."""
    if ctype in ('A', 'STE'):  # fireproofed structural steel frame
        return 'S5' if year < 1935 else 'S1'
    if ctype in ('B', 'REI'):  # reinforced concrete frame
        if year < 1935:
            return 'C3'  # early concrete frames with brick/hollow-tile infill
        if 1945 <= year < 1976 and use in ('office', 'commercial', 'retail', 'parking'):
            return 'C1'  # non-ductile concrete moment frames of the post-war office boom
        return 'C2'
    if ctype == 'C':  # masonry / concrete bearing walls
        if year < 1935:
            # Post-1906 bearing-wall buildings of 7+ storeys were mostly reinforced-concrete frames with brick or
            # hollow-tile infill; the low ones are the classic brick URM stock.
            return 'C3' if height >= 22 else 'URM'
        if levels <= 2 and footprint > 900 and use in ('industrial', 'retail', 'commercial', 'parking'):
            return 'PC'  # tilt-up / precast boxes
        return 'RM'
    if ctype in ('D', 'WOO'):  # wood (or light steel) studs, combustible
        if footprint > 1000 or (use not in ('residential', 'mixed') and levels >= 3) or levels >= 5:
            return 'W2'
        return 'W1'
    if ctype == 'S':  # light metal / pre-engineered steel
        return 'S2'
    return None


def estimate_structure(key: str, district: str, year: int, height: float, levels: float, use: str,
                       footprint: float, on_pier: bool) -> str:
    r = rnd(key, 'struct')
    if on_pier:
        return 'S2' if r < 0.7 else 'PC'  # 1910s-30s pier sheds: steel trusses on concrete decks
    if height >= 60:
        if year < 1935:
            return 'S5'
        if use in ('residential', 'hotel'):
            return 'C2'
        return 'S1' if r < 0.65 else 'C2'
    if district == 'jackson_square' and year < 1906:
        return 'URM'
    if year < 1935:
        if district == 'chinatown':
            return 'URM' if r < 0.75 else ('W1' if levels <= 3 else 'C3')
        if height >= 25:
            return 'S5' if r < 0.55 else 'C3'
        if use in ('residential', 'mixed') and levels <= 4:
            return 'W1' if r < 0.7 else 'URM'
        return 'URM' if r < 0.6 else 'W2'
    if height >= 20:
        return 'C2' if r < 0.6 else ('C1' if year < 1976 else 'S1')
    if use in ('residential', 'mixed'):
        return 'W1' if levels <= 4 else 'C2'
    if use == 'parking':
        return 'C1' if year < 1976 else 'PC'
    return 'RM' if r < 0.5 else 'W2'


LOW_RISE_ONLY = {'W1', 'W1_SOFT', 'W2', 'RM', 'URM'}  # light-frame / bearing-wall systems
SANE_MAX_HEIGHT = 25.0  # m — above ~7 storeys these systems are essentially absent from SF's stock


def sanitize_structure(structure: str, year: int, height: float, use: str) -> str | None:
    """Replacement HAZUS type when `structure` is implausible for the building's size, else None.

    The assessor's construction class describes the parcel's improvements, and on high-rise parcels it is often the
    class of a podium, a garage or a pre-existing building (e.g. 808 Kearny 65 m 'D' wood, 505 Montgomery 100 m 'C'
    masonry).  Wood frames, reinforced and unreinforced masonry bearing walls above 25 m are reassigned by era and
    use: pre-1935 -> steel frame with masonry infill (S5) for tall commercial blocks, else infilled concrete frame (C3);
    later -> steel moment frame (S1) for >= 50 m office/commercial towers, else concrete shear wall (C2)."""
    if structure not in LOW_RISE_ONLY or height <= SANE_MAX_HEIGHT:
        return None
    commercial = use in ('office', 'commercial', 'retail')
    if year < 1935:
        return 'S5' if height >= 45 and (commercial or use == 'hotel') else 'C3'
    return 'S1' if height >= 50 and commercial else 'C2'


def resolve_code_level(structure: str, year: int, district: str) -> str:
    lvl = code_level(year)
    if structure == 'URM':
        # SF's UMB ordinance (1992) required retrofit of almost all URMs by ~2006; Chinatown's brick stock was
        # largely retrofitted -> 'low'.  Jackson Square's 1850s-60s survivors are left 'pre' (brief).
        return 'pre' if district == 'jackson_square' else 'low'
    return lvl


# ───────────────────────────── occupancy ─────────────────────────────

PERSONS_PER_UNIT = 2.3


def occupants(use: str, gfa: float, units: float, levels: float, footprint: float) -> tuple[int, int]:
    """(day, night) occupants.  gfa = gross floor area (m2).  See SOURCES.md for the table."""
    gfa = max(gfa, 1.0)
    if use == 'residential':
        u = units if units >= 1 else max(1.0, gfa / 85.0)
        night = u * PERSONS_PER_UNIT
        return round(night * 0.4), round(night)
    if use == 'mixed':
        ground = min(footprint, gfa)
        upper = max(gfa - ground, 0.0)
        u = units if units >= 1 else max(1.0, upper / 75.0)
        night = u * PERSONS_PER_UNIT
        return round(night * 0.4 + ground / 35.0), round(night + ground / 400.0)
    if use == 'office':
        # design density ~1 / 25 m2 gross x ~83 % weekday-2pm attendance
        return round(gfa / 30.0), round(gfa / 30.0 * 0.03)
    if use in ('commercial', 'retail'):
        day = gfa / 40.0
        return round(day), round(day * 0.03)
    if use == 'hotel':
        rooms = gfa / 50.0
        guests = rooms * 0.8 * 1.6  # 80 % occupancy, 1.6 guests/room
        staff = rooms * 0.5
        return round(guests * 0.35 + staff), round(guests + staff * 0.25)
    if use == 'school':
        return round(gfa / 12.0), round(gfa / 2000.0)
    if use == 'religious':
        return round(gfa / 60.0), round(gfa / 1000.0)
    if use == 'civic':
        return round(gfa / 30.0), round(gfa / 400.0)
    if use == 'transport':
        return round(gfa / 20.0), round(gfa / 300.0)
    if use == 'industrial':
        return round(gfa / 90.0), round(gfa / 900.0)
    if use == 'parking':
        return round(gfa / 400.0), round(gfa / 3000.0)
    return round(gfa / 120.0), round(gfa / 1000.0)
