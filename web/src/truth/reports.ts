/**
 * M6 resident reports — simulated community-app posts generated from the TRUTH world (pure, deterministic, no three.js).
 *
 * Like the helicopter footage is rendered from the truth, residents describe what really happened around them, with
 * realistic noise:
 *   - who reports: core buildings, probability ∝ damage state × occupants at the hour (× trapped people, fires);
 *     undamaged / slightly damaged buildings post "we're OK" check-ins (they inform the 'none' class);
 *   - ~18 % describe a NEIGHBOUR ("the building across the street collapsed") while the GPS fix is at their own building;
 *   - ~6 % false alarms / exaggeration (claims collapse on a moderately damaged building, inflated trapped counts);
 *   - GPS error 8-40 m (vague reports up to ~60 m), ~10 % vague text ("near Grant and Pine");
 *   - duplicates (2-4 reports) for big damaged buildings; road reports at debris-blocked streets (no building);
 *   - 40+ English templates (urgent, terse, misspelled), simple Chinese in Chinatown (~15 %), Spanish (~5 %).
 * truthRef is the hidden answer key (evaluation only) — strip it before sending anything to Argon
 * (buildReportsRequest does).
 *
 * Also exported (no truth inside): reportCandidates (nearest core buildings to a GPS fix) and buildReportsRequest.
 */
import type { BuildingRecord, CitizenReport, CityData, District, PeopleTruth, QuakeResult, ReportCategory, ReportsRequest, XZ } from '../contracts';
import { unproject } from '../geo';
import { hashStr, mulberry32 } from '../quake/fx/rng';
import { occupantsAt } from '../quake/model/damage';

type Rng = () => number;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

// ───────────── geometry / city indexes (cached per CityData) ─────────────

interface CoreB {
  i: number;
  b: BuildingRecord;
  cx: number;
  cz: number;
}

interface CityIdx {
  core: CoreB[];
  byId: Map<string, CoreB>;
  /** 50 m grid over core building centroids. */
  grid: Map<string, CoreB[]>;
  /** Named drivable street segments in a 60 m grid. */
  segGrid: Map<string, { name: string; ax: number; az: number; bx: number; bz: number }[]>;
}

const G = 50;
const SG = 60;
const key = (gx: number, gz: number) => `${gx},${gz}`;
const idxCache = new WeakMap<CityData, CityIdx>();

function centroid(ring: XZ[]): XZ {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0;
    let sz = 0;
    for (const p of ring) {
      sx += p[0];
      sz += p[1];
    }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function inRing(ring: XZ[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (m) from a point to a footprint (0 inside). */
function footprintDist(b: BuildingRecord, x: number, z: number): number {
  const r = b.footprint;
  if (inRing(r, x, z)) return 0;
  let d = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, segDist(x, z, r[j][0], r[j][1], r[i][0], r[i][1]));
  return d;
}

const STREET_KINDS = new Set(['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'pedestrian', 'service']);

function cityIdx(city: CityData): CityIdx {
  const hit = idxCache.get(city);
  if (hit) return hit;
  const core: CoreB[] = [];
  const grid = new Map<string, CoreB[]>();
  city.buildings.forEach((b, i) => {
    if (b.context || b.isPart || b.footprint.length < 3) return;
    const [cx, cz] = centroid(b.footprint);
    const e = { i, b, cx, cz };
    core.push(e);
    const k = key(Math.floor(cx / G), Math.floor(cz / G));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
  });
  const segGrid: CityIdx['segGrid'] = new Map();
  for (const r of city.roads) {
    if (!r.name || !STREET_KINDS.has(r.kind) || r.tunnel) continue;
    for (let s = 0; s + 1 < r.points.length; s++) {
      const [ax, az] = r.points[s];
      const [bx, bz] = r.points[s + 1];
      const seg = { name: r.name, ax, az, bx, bz };
      const x0 = Math.floor(Math.min(ax, bx) / SG);
      const x1 = Math.floor(Math.max(ax, bx) / SG);
      const z0 = Math.floor(Math.min(az, bz) / SG);
      const z1 = Math.floor(Math.max(az, bz) / SG);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) (segGrid.get(key(gx, gz)) ?? segGrid.set(key(gx, gz), []).get(key(gx, gz))!).push(seg);
    }
  }
  const idx: CityIdx = { core, byId: new Map(core.map((e) => [e.b.id, e])), grid, segGrid };
  idxCache.set(city, idx);
  return idx;
}

function nearCore(idx: CityIdx, x: number, z: number, radius: number): CoreB[] {
  const out: CoreB[] = [];
  const r = Math.ceil(radius / G);
  const gx = Math.floor(x / G);
  const gz = Math.floor(z / G);
  for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (const e of idx.grid.get(key(gx + i, gz + j)) ?? []) out.push(e);
  return out;
}

/** Nearest distinct street names to a point (full names, e.g. "Grant Avenue"). */
function nearestStreets(idx: CityIdx, x: number, z: number, k = 3): string[] {
  const best = new Map<string, number>();
  const gx = Math.floor(x / SG);
  const gz = Math.floor(z / SG);
  for (let i = -2; i <= 2; i++)
    for (let j = -2; j <= 2; j++)
      for (const s of idx.segGrid.get(key(gx + i, gz + j)) ?? []) {
        const d = segDist(x, z, s.ax, s.az, s.bx, s.bz);
        if (d < (best.get(s.name) ?? Infinity)) best.set(s.name, d);
      }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).slice(0, k).map((e) => e[0]);
}

/** "Sacramento Street" → "Sacramento St". */
const shortStreet = (s: string) =>
  s
    .replace(/\bStreet\b/, 'St')
    .replace(/\bAvenue\b/, 'Ave')
    .replace(/\bBoulevard\b/, 'Blvd')
    .replace(/\bPlace\b/, 'Pl')
    .replace(/\bAlley\b/, 'Alley')
    .replace(/\bLane\b/, 'Ln');
/** "Sacramento Street" → "Sacramento" (how people say intersections). */
const bareStreet = (s: string) => s.replace(/\s+(Street|Avenue|Boulevard|Place|Alley|Lane|Court|Way|Road|Terrace)$/i, '').replace(/^The\s+/i, '');

/** "318;320 Kearny Street" → "318 Kearny St". */
export function shortAddress(a: string): string {
  let s = a.trim();
  const m = s.match(/^([0-9][0-9A-Za-z-]*)(?:\s*[;,]\s*[0-9A-Za-z-]+)*\s+(.*)$/);
  if (m) s = `${m[1]} ${m[2]}`;
  return shortStreet(s);
}

/** Candidate label: name and/or short address (identity only). */
export function reportBuildingLabel(b: BuildingRecord): string {
  const addr = b.address ? shortAddress(b.address) : '';
  if (b.name && addr) return `${b.name}, ${addr}`;
  return b.name ?? (addr || `${b.levels}-storey ${b.use} building`);
}

/**
 * Nearest core buildings to a GPS fix (footprint distance, 0 = inside), identity only — no damage info.
 * Default: up to 6 within 120 m.
 */
export function reportCandidates(city: CityData, x: number, z: number, max = 6, radiusM = 120): ReportsRequest['reports'][number]['candidates'] {
  const idx = cityIdx(city);
  return nearCore(idx, x, z, radiusM + 60)
    .map((e) => ({ e, d: footprintDist(e.b, x, z) }))
    .filter((c) => c.d <= radiusM)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map(({ e, d }) => ({ id: e.b.id, label: reportBuildingLabel(e.b), distanceM: Math.round(d), use: e.b.use, levels: e.b.levels }));
}

/** POST /api/reports body for a batch (truthRef stripped; candidates = nearest core buildings to each GPS fix). */
export function buildReportsRequest(
  city: CityData,
  reports: CitizenReport[],
  batchIndex: number,
  scenarioId: string,
  localHour: number,
  mode?: ReportsRequest['mode'],
): ReportsRequest {
  return {
    batchIndex,
    scenarioId,
    localHour,
    reports: reports.map((r) => ({
      id: r.id,
      simS: Math.round(r.simS),
      text: r.text,
      lang: r.lang,
      x: Math.round(r.x),
      z: Math.round(r.z),
      accuracyM: Math.round(r.accuracyM),
      candidates: reportCandidates(city, r.x, r.z),
    })),
    ...(mode ? { mode } : {}),
  };
}

// ───────────── text templates ─────────────

interface Ctx {
  /** Subject, sentence-initial ("The building at 820 Sacramento St", "The building across the street"). */
  S: string;
  /** Subject mid-sentence. */
  s: string;
  /** Location phrase ("at 820 Sacramento St", "near Grant and Pine", "across the street from us"). */
  loc: string;
  street: string;
  cross: string;
  n: number;
  floor: string;
  levels: number;
}
type T = (c: Ctx) => string;
const pick = <X>(r: Rng, a: readonly X[]): X => a[Math.floor(r() * a.length) % a.length];

const EN: Record<'none' | 'slight' | 'moderate' | 'extensive' | 'collapsed' | 'trapped' | 'trapped1' | 'fire' | 'gas' | 'road', T[]> = {
  none: [
    (c) => `We're OK ${c.loc}. No damage that we can see, just shaken up.`,
    (c) => `All good here ${c.loc} — everyone got out, building looks fine.`,
    (c) => `Checked our building ${c.loc}: no cracks, nothing broken. We're safe.`,
    (c) => `safe. no damage ${c.loc}`,
    (c) => `Everyone in our unit is fine, building undamaged ${c.loc}. Power is out though.`,
    (c) => `No damage ${c.loc}, we are fine. Lots of people outside on ${c.street}.`,
    (c) => `Just checking in — family is safe ${c.loc}, the building held up fine.`,
  ],
  slight: [
    (c) => `Some plaster cracks and stuff fell off the shelves ${c.loc}, everyone is ok.`,
    (c) => `Minor cracks in the walls ${c.loc}. Broke some dishes, nobody hurt.`,
    (c) => `Hairline cracks and a few pictures fell ${c.loc} — building seems fine overall.`,
    (c) => `small cracks ${c.loc}, ceiling tiles down in the lobby, we're fine`,
    (c) => `Light damage ${c.loc}: cracked plaster, one window cracked. All ok.`,
  ],
  moderate: [
    (c) => `${c.S} has big cracks in the walls and several windows blew out. We evacuated.`,
    (c) => `Part of the parapet fell off ${c.s} onto the sidewalk, bricks everywhere. Big cracks in the facade.`,
    (c) => `Large diagonal cracks in the stairwell ${c.loc}, broken windows. Not safe to go back in.`,
    (c) => `Bricks fell from the front of ${c.s}, glass all over ${c.street}.`,
    (c) => `Facade damage ${c.loc} - chunks of the cornice fell, cracks over the doors.`,
    (c) => `${c.S}: windows shattered on every floor and a big crack down the side wall.`,
  ],
  extensive: [
    (c) => `${c.S} is leaning badly toward ${c.street}, huge cracks through the walls.`,
    (c) => `Part of ${c.s} came down — a corner of the top floor fell off. It's tilting.`,
    (c) => `The back wall of ${c.s} partially collapsed. Everyone got out but it looks like it could go.`,
    (c) => `${c.S} is tilted and the ground floor is buckled. Walls bulging out.`,
    (c) => `Serious damage ${c.loc}: building leaning, a wall section fell into the alley.`,
    (c) => `${c.S} partly collapsed on the ${c.street} side, the rest is leaning. Stay away.`,
  ],
  collapsed: [
    (c) => `${c.S} COLLAPSED. Completely pancaked. Pile of rubble on ${c.street}!!`,
    (c) => `${c.S} just came down, it's gone — the floors pancaked.`,
    (c) => `Total collapse ${c.loc}. Nothing left standing, dust everywhere.`,
    (c) => `The upper floors of ${c.s} caved in, the building is destroyed.`,
    (c) => `Building collapse ${c.loc}!!! send help now`,
    (c) => `${c.S} fell down completely. It was ${c.levels} storeys, now it's a pile of bricks.`,
  ],
  trapped: [
    (c) => `${c.n} people trapped inside, we can hear them calling for help.`,
    (c) => `My neighbors are stuck on the ${c.floor} floor, the stairs are gone. ${c.n} of them.`,
    (c) => `At least ${c.n} people still inside, someone is banging on a pipe.`,
    (c) => `There are people under the rubble!! maybe ${c.n}`,
    (c) => `${c.n} people can't get out, the doors are jammed and the stairwell collapsed.`,
  ],
  trapped1: [
    (c) => `Someone is trapped inside, we can hear them.`,
    (c) => `An old man on the ${c.floor} floor can't get out, his door is jammed.`,
    (c) => `One person still inside, not answering the phone.`,
  ],
  fire: [
    (c) => `Fire ${c.loc}! Heavy black smoke from the upper windows.`,
    (c) => `Flames coming out of ${c.s} on ${c.street}, no fire trucks yet.`,
    (c) => `${c.S} is on fire, smoke filling the street, might spread to the next building.`,
    (c) => `FIRE ${c.loc}. smoke everywhere, we can't get close`,
  ],
  gas: [
    (c) => `Strong smell of gas ${c.loc}. Everyone get away from ${c.street}.`,
    (c) => `Gas leak ${c.loc}, hissing from the meter by the door. Cracks in the walls too.`,
    (c) => `smell gas near ${c.street} and ${c.cross}, the building is damaged`,
  ],
  road: [
    (c) => `${c.street} is blocked by debris near ${c.cross}, cars can't get through.`,
    (c) => `Bricks and rubble all over ${c.street} at ${c.cross}. Impassable.`,
    (c) => `${c.street} closed — a facade came down across both lanes by ${c.cross}.`,
    (c) => `Can't drive down ${c.street} near ${c.cross}, totally blocked`,
    (c) => `Debris blocking ${c.street} near ${c.cross}. An ambulance had to turn back.`,
  ],
};

const ES: Record<keyof typeof EN, T[]> = {
  none: [(c) => `Estamos bien ${c.loc}, el edificio no tiene daños.`, (c) => `Todo bien aquí ${c.loc}, sin daños. Todos a salvo.`],
  slight: [(c) => `Grietas pequeñas en las paredes ${c.loc}, se cayeron cosas pero todos bien.`],
  moderate: [(c) => `Grietas grandes y ventanas rotas ${c.loc}. Cayeron ladrillos de la fachada.`, (c) => `${c.S} tiene grietas enormes, salimos todos.`],
  extensive: [(c) => `${c.S} está inclinado, parte de la pared se cayó. Muy peligroso.`],
  collapsed: [(c) => `¡${c.S} se derrumbó por completo! Solo quedan escombros en ${c.street}.`, (c) => `Derrumbe total ${c.loc}!! ayuda por favor`],
  trapped: [(c) => `Hay ${c.n} personas atrapadas adentro, las escuchamos gritar.`],
  trapped1: [(c) => `Hay una persona atrapada adentro, la escuchamos.`],
  fire: [(c) => `¡Incendio ${c.loc}! Mucho humo negro.`],
  gas: [(c) => `Huele mucho a gas ${c.loc}.`],
  road: [(c) => `${c.street} está bloqueada por escombros cerca de ${c.cross}.`],
};

const ZH: Record<keyof typeof EN, T[]> = {
  none: [(c) => `我们这里没事，楼没有损坏。${c.loc}`, (c) => `大家都平安，房子没事 ${c.loc}`],
  slight: [(c) => `墙上有些小裂缝，东西掉下来了，人都没事。${c.loc}`],
  moderate: [(c) => `墙壁大裂缝，窗户都碎了，外墙的砖掉下来 ${c.loc}`, (c) => `${c.S}裂得很厉害，我们都跑出来了`],
  extensive: [(c) => `${c.S}歪了，一部分墙倒塌了，很危险！`],
  collapsed: [(c) => `${c.S}全塌了！！变成一堆瓦砾`, (c) => `${c.loc}有楼倒塌了！快来救人`],
  trapped: [(c) => `里面还有${c.n}个人被困，听到有人喊救命`],
  trapped1: [(c) => `还有一个人困在里面，听到他在叫`],
  fire: [(c) => `${c.S}着火了！浓烟很大`],
  gas: [(c) => `${c.loc}很大煤气味，大家快离开`],
  road: [(c) => `${c.street}被瓦砾堵住了，在${c.cross}附近，车过不去`],
};

const CLOSERS_EN = [' Please send help.', ' Nobody has come yet.', ' Hurry!!', ' We need an ambulance.', ' Please check on it.', ' pls help', ''];
const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

function typo(r: Rng, s: string): string {
  let t = s
    .replace(/\bbuilding\b/g, () => (r() < 0.5 ? 'bldg' : 'buidling'))
    .replace(/\bpeople\b/g, () => (r() < 0.5 ? 'ppl' : 'poeple'))
    .replace(/\bplease\b/gi, 'pls')
    .replace(/\bbecause\b/g, 'bc');
  if (r() < 0.6) t = t.toLowerCase();
  if (r() < 0.5) t = t.replace(/[.,—:]/g, '');
  // swap two letters in one longer word
  const words = t.split(' ');
  const w = words.findIndex((x, k) => x.length > 5 && /^[a-z]+$/.test(x) && (k + Math.floor(r() * 3)) % 3 === 0);
  if (w >= 0) {
    const x = words[w];
    const p = 1 + Math.floor(r() * (x.length - 3));
    words[w] = x.slice(0, p) + x[p + 1] + x[p] + x.slice(p + 2);
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

const DISTRICT: Record<District, string> = {
  chinatown: 'Chinatown',
  fidi: 'FiDi',
  embarcadero: 'Embarcadero',
  jackson_square: 'Jackson Square',
  nob_hill: 'Nob Hill',
  north_beach: 'North Beach',
  soma: 'SoMa',
  other: 'Downtown',
};

function reporterOf(r: Rng, b: BuildingRecord | null, district: District): string {
  const place = DISTRICT[district] ?? 'Downtown';
  const use = b?.use ?? 'other';
  const roles =
    use === 'office' ? ['Office worker', 'Office worker', 'Building manager'] :
    use === 'retail' || use === 'commercial' ? ['Shop owner', 'Resident', 'Store clerk'] :
    use === 'hotel' ? ['Hotel guest', 'Hotel staff'] :
    use === 'residential' || use === 'mixed' ? ['Resident', 'Resident', 'Resident', 'Neighbor'] :
    ['Resident', 'Neighbor', 'Passer-by'];
  return `${pick(r, roles)} · ${place}`;
}

// ───────────── generator ─────────────

type Claim = 0 | 1 | 2 | 3 | 4;
const CLAIM_KEY = ['none', 'slight', 'moderate', 'extensive', 'collapsed'] as const;

interface Draft {
  simS: number;
  category: ReportCategory;
  target: CoreB | null;
  anchor: XZ; // GPS anchor (reporter's own building centroid / the road spot)
  reporterB: CoreB | null;
  kind: 'self' | 'neighbor' | 'false_alarm' | 'street';
  claim: Claim;
  trapped: number;
  vague: boolean;
  lang: CitizenReport['lang'];
  roadName?: string;
  district: District;
}

/** Target counts (expected) for damage (DS ≥ 2) and check-in (DS ≤ 1) reports from the building pass. */
const TARGET_DAMAGE = 124;
const TARGET_OK = 36;
const MAX_DUPES = 22;
const ROAD_REPORTS = 12;

export function generateReports(city: CityData, result: QuakeResult, people: PeopleTruth | null, seed = 1906): CitizenReport[] {
  const idx = cityIdx(city);
  const hour = result.scenario.localHour;
  const r = mulberry32((hashStr(`reports:${result.scenario.id}`) ^ seed) >>> 0);
  const BASE = [0.06, 0.06, 0.13, 0.24, 0.42];
  const trappedOf = (id: string) => {
    const t = people?.byBuilding[id];
    return t ? t.visible + t.hidden : 0;
  };

  // Raw reporting propensity per core building.
  const raw = idx.core.map((e) => {
    const d = result.damage[e.i];
    if (!d) return 0;
    let p = d.collapsed ? 0.6 : BASE[d.state];
    const occ = occupantsAt(e.b, hour);
    p *= clamp(0.35 + 0.3 * Math.log2(1 + occ / 8), 0.25, 1.7);
    if (trappedOf(e.b.id) > 0) p *= 1.35;
    if (d.fire) p = Math.max(p, 0.8);
    return p;
  });
  let sumD = 0;
  let sumOk = 0;
  idx.core.forEach((e, k) => ((result.damage[e.i]?.state ?? 0) >= 2 ? (sumD += raw[k]) : (sumOk += raw[k])));
  const kD = sumD > 0 ? TARGET_DAMAGE / sumD : 0;
  const kOk = sumOk > 0 ? TARGET_OK / sumOk : 0;

  const drafts: Draft[] = [];
  let dupes = 0;

  const neighbourOf = (e: CoreB): CoreB | null => {
    const near = nearCore(idx, e.cx, e.cz, 90)
      .filter((o) => o !== e)
      .map((o) => ({ o, d: Math.hypot(o.cx - e.cx, o.cz - e.cz) }))
      .filter((x) => x.d >= 18 && x.d <= 75)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    return near.length ? near[Math.floor(r() * near.length)].o : null;
  };

  const langFor = (district: District): CitizenReport['lang'] => {
    const u = r();
    if (district === 'chinatown' && u < 0.15) return 'zh';
    if (u > 0.95) return 'es';
    return 'en';
  };

  const makeDraft = (e: CoreB, dup: boolean) => {
    const d = result.damage[e.i];
    const st = d.state;
    const trapped = trappedOf(e.b.id);
    const minS = Math.max(55, d.failTimeS + 25);
    let simS = st <= 1 ? 70 + 620 * Math.pow(r(), 1.4) : 55 + 645 * Math.pow(r(), 2.1);
    if (dup) simS = 60 + 640 * Math.pow(r(), 1.6);
    simS = clamp(Math.max(simS, minS + r() * 20), 55, 700);

    let category: ReportCategory;
    const u = r();
    if (d.fire && u < 0.7) category = 'fire';
    else if (trapped > 0 && st >= 3 && u < 0.5) category = 'trapped';
    else if (st === 0) category = 'ok';
    else if (st === 1) category = u < 0.55 ? 'ok' : 'damage';
    else if (st >= 2 && /^(W|URM)/.test(e.b.structure) && u > 0.94) category = 'gas';
    else category = 'damage';

    let kind: Draft['kind'] = 'self';
    let reporterB: CoreB = e;
    let claim: Claim = (d.collapsed ? 4 : st) as Claim;
    let tr = category === 'trapped' || (trapped > 0 && r() < 0.3) ? trapped : 0;
    const v = r();
    if (v < 0.18) {
      const nb = st >= 2 && category !== 'ok' ? neighbourOf(e) : null;
      if (nb) {
        kind = 'neighbor';
        reporterB = nb;
      }
    } else if (v < 0.25 && st >= 1 && st <= 3) {
      kind = 'false_alarm';
      if (tr > 0) tr = Math.round(tr * (1.5 + r() * 1.5));
      else {
        claim = (st <= 1 ? 3 + (r() < 0.4 ? 1 : 0) : 4) as Claim;
        if (category === 'ok') category = 'damage';
        if (claim === 4 && r() < 0.5) tr = 2 + Math.floor(r() * 5); // "people inside!!" — not true
      }
    }
    const vague = r() < 0.1;
    drafts.push({
      simS,
      category,
      target: e,
      anchor: [reporterB.cx, reporterB.cz],
      reporterB,
      kind,
      claim,
      trapped: tr,
      vague,
      lang: langFor(reporterB.b.district),
      district: reporterB.b.district,
    });
  };

  idx.core.forEach((e, k) => {
    const d = result.damage[e.i];
    if (!d) return;
    const p = d.state >= 2 ? Math.min(0.97, kD * raw[k]) : Math.min(0.6, kOk * raw[k]);
    if (r() >= p) return;
    makeDraft(e, false);
    const occ = occupantsAt(e.b, hour);
    if (d.state >= 3 && (d.collapsed || occ > 60 || trappedOf(e.b.id) > 0 || d.fire) && dupes < MAX_DUPES) {
      const extra = d.collapsed || trappedOf(e.b.id) >= 3 ? 1 + Math.floor(r() * 3) : r() < 0.55 ? 1 : 0;
      for (let j = 0; j < extra && dupes < MAX_DUPES; j++, dupes++) makeDraft(e, true);
    }
  });

  // Road reports at debris-blocked street segments inside the core.
  const roadById = new Map(city.roads.map((rd) => [rd.id, rd]));
  const blocked = result.roads
    .filter((b) => b.coverage >= 0.6 && idx.byId.has(b.causeBuildingId) && roadById.get(b.roadId)?.name)
    .map((b) => ({ b, h: hashStr(`${b.roadId}:${b.segment}:${seed}`) }))
    .sort((a, b) => a.h - b.h);
  const usedRoads = new Set<string>();
  for (const { b } of blocked) {
    if (usedRoads.size >= ROAD_REPORTS) break;
    const name = roadById.get(b.roadId)!.name!;
    if (usedRoads.has(name)) continue;
    usedRoads.add(name);
    const cause = idx.byId.get(b.causeBuildingId)!;
    drafts.push({
      simS: clamp(Math.max(70 + 600 * Math.pow(r(), 1.5), result.damage[cause.i].failTimeS + 40), 55, 700),
      category: 'road',
      target: null,
      anchor: [b.at[0], b.at[1]],
      reporterB: null,
      kind: 'street',
      claim: 0,
      trapped: 0,
      vague: false,
      lang: langFor(cause.b.district),
      roadName: name,
      district: cause.b.district,
    });
  }

  drafts.sort((a, b) => a.simS - b.simS);
  return drafts.map((d, k) => realise(d, k, idx, r));
}

function realise(d: Draft, k: number, idx: CityIdx, r: Rng): CitizenReport {
  // GPS fix around the anchor.
  const accuracyM = d.vague ? 30 + 30 * r() : 8 + 32 * r() * r();
  const ang = r() * Math.PI * 2;
  const off = accuracyM * (0.25 + 0.75 * r());
  const x = d.anchor[0] + Math.cos(ang) * off;
  const z = d.anchor[1] + Math.sin(ang) * off;
  const [lat, lon] = unproject(x, z);

  const tb = d.target?.b ?? null;
  const streetsAtTarget = nearestStreets(idx, d.target ? d.target.cx : d.anchor[0], d.target ? d.target.cz : d.anchor[1], 3);
  const street = d.roadName ?? streetsAtTarget[0] ?? 'the street';
  const cross = streetsAtTarget.find((s) => s !== street) ?? 'the corner';
  const streetsAtGps = nearestStreets(idx, x, z, 3);
  const A = streetsAtGps[0] ?? street;
  const B = streetsAtGps.find((s) => s !== A) ?? cross;

  const lang = d.lang;
  const addr = tb?.address ? shortAddress(tb.address) : '';
  let S = '';
  let loc = '';
  let properS = false;
  if (d.kind === 'street') {
    S = shortStreet(street);
    loc = `on ${shortStreet(street)}`;
  } else if (d.kind === 'neighbor') {
    const withAddr = addr && r() < 0.3 ? ` (${addr})` : '';
    const forms =
      lang === 'zh' ? [['对面那栋楼', '对面那栋楼'], ['隔壁的楼', '隔壁']] :
      lang === 'es' ? [['El edificio de enfrente', 'enfrente'], ['El edificio de al lado', 'al lado']] :
      [
        [`The building across the street${withAddr}`, `across the street from us${withAddr}`],
        [`The building next door${withAddr}`, `next door to us${withAddr}`],
        [`The building across ${shortStreet(street)} from us${withAddr}`, `across ${shortStreet(street)} from us${withAddr}`],
        [`The old building opposite ours${withAddr}`, `in the building opposite ours${withAddr}`],
      ];
    [S, loc] = pick(r, forms);
  } else if (d.vague) {
    const a = bareStreet(A);
    const b = bareStreet(B);
    if (lang === 'zh') [S, loc] = [`${a}和${b}附近的楼`, `${a}和${b}附近`];
    else if (lang === 'es') [S, loc] = [`Un edificio cerca de ${a} y ${b}`, `cerca de ${a} y ${b}`];
    else [S, loc] = pick(r, [[`A building near ${a} and ${b}`, `near ${a} and ${b}`], [`Some building around ${a}/${b}`, `around ${a}/${b}`], [`A building on ${a} near ${b}`, `on ${a} near ${b}`]]);
  } else if (tb?.name && r() < 0.55) {
    properS = true;
    S = tb.name;
    loc = lang === 'zh' ? `在${tb.name}` : lang === 'es' ? `en ${tb.name}` : `at ${tb.name}`;
  } else if (addr) {
    if (lang === 'zh') [S, loc] = [`${addr}的楼`, `在${addr}`];
    else if (lang === 'es') [S, loc] = [`El edificio en ${addr}`, `en ${addr}`];
    else {
      const f = pick(r, [[`The building at ${addr}`, `at ${addr}`], [`Our building (${addr})`, `at ${addr}`], [addr, `at ${addr}`], [`My building at ${addr}`, `here at ${addr}`]]);
      [S, loc] = f;
      properS = /^\d/.test(S);
    }
  } else {
    const st = shortStreet(street);
    const cr = shortStreet(cross);
    if (lang === 'zh') [S, loc] = [`${st}上我们的楼`, `在${st}和${cr}`];
    else if (lang === 'es') [S, loc] = [`Nuestro edificio en ${st}`, `en ${st} y ${cr}`];
    else [S, loc] = pick(r, [[`Our building on ${st}`, `on ${st} near ${cr}`], [`The ${tb?.levels ?? 3}-storey building at ${st} & ${cr}`, `at ${st} & ${cr}`]]);
  }
  const s = properS || lang !== 'en' ? S : S[0].toLowerCase() + S.slice(1);
  const levels = tb?.levels ?? 3;
  const c: Ctx = {
    S,
    s,
    loc,
    street: shortStreet(street),
    cross: shortStreet(cross),
    n: Math.max(1, d.trapped),
    floor: ordinal(1 + Math.floor(r() * Math.max(1, Math.min(levels, 6)))),
    levels,
  };
  const L = lang === 'zh' ? ZH : lang === 'es' ? ES : EN;
  const claimKey = CLAIM_KEY[d.claim];
  const parts: string[] = [];
  const trappedLine = () => (d.trapped > 1 ? pick(r, L.trapped)(c) : pick(r, L.trapped1)(c));
  switch (d.category) {
    case 'ok':
      parts.push(pick(r, d.claim === 1 ? L.slight : L.none)(c));
      break;
    case 'road':
      parts.push(pick(r, L.road)(c));
      break;
    case 'fire':
      parts.push(pick(r, L.fire)(c));
      if (d.claim >= 2 && r() < 0.6) parts.push(pick(r, L[claimKey])(c));
      if (d.trapped > 0) parts.push(trappedLine());
      break;
    case 'gas':
      parts.push(pick(r, L.gas)(c));
      if (r() < 0.5) parts.push(pick(r, L[claimKey])(c));
      break;
    case 'trapped':
      if (r() < 0.5) {
        parts.push(pick(r, L[claimKey])(c));
        parts.push(trappedLine());
      } else {
        parts.push(trappedLine());
        parts.push(pick(r, L[claimKey])(c));
      }
      break;
    default:
      parts.push(pick(r, L[claimKey])(c));
      if (d.trapped > 0) parts.push(trappedLine());
  }
  let text = parts.reduce((acc, p) => (!acc ? p : lang === 'zh' ? acc + (/[！!。，？]$/.test(acc) ? '' : '，') + p : `${acc} ${p}`), '');
  if (lang === 'en') {
    if (d.category !== 'ok' && d.claim >= 3 && r() < 0.45) text += pick(r, CLOSERS_EN);
    if (r() < 0.12) text = typo(r, text);
  }
  const truthRef: CitizenReport['truthRef'] =
    d.kind === 'street' ? { buildingId: null, kind: 'street' } : { buildingId: d.target!.b.id, kind: d.kind };
  return {
    id: `R-${String(k + 1).padStart(4, '0')}`,
    simS: Math.round(d.simS * 10) / 10,
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    x: Math.round(x * 10) / 10,
    z: Math.round(z * 10) / 10,
    accuracyM: Math.round(accuracyM),
    text,
    lang,
    category: d.category,
    reporter: reporterOf(r, d.reporterB?.b ?? null, d.district),
    truthRef,
  };
}
