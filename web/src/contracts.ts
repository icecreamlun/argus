/**
 * Shared contracts between modules. Every module codes against these types.
 * Change only when a contract is genuinely wrong, and keep changes backward compatible.
 *
 * Coordinate system (world space, metres):
 *   origin = CITY_ORIGIN (see geo.ts), +X = east, -Z = north (+Z = south), +Y = up.
 *   Y is elevation above mean sea level in metres (no vertical exaggeration).
 *   2D footprints/polylines are stored as [x, z] pairs in this frame.
 */
import type * as THREE from 'three';

// ───────────────────────────── City data (public/data/city.json) ─────────────────────────────

export type XZ = [number, number];

/** HAZUS-style model building types. */
export type StructureType =
  | 'W1' // light wood frame, small residential
  | 'W1_SOFT' // wood frame with soft/weak first storey (SF soft-story program)
  | 'W2' // large wood frame (commercial)
  | 'URM' // unreinforced masonry
  | 'RM' // reinforced masonry
  | 'C1' // concrete moment frame
  | 'C2' // concrete shear wall
  | 'C3' // concrete frame with URM infill
  | 'PC' // precast / tilt-up
  | 'S1' // steel moment frame
  | 'S2' // steel braced frame
  | 'S5'; // steel frame with URM infill

/** Seismic design code era. */
export type CodeLevel = 'pre' | 'low' | 'moderate' | 'high';

export type BuildingUse =
  | 'residential'
  | 'mixed'
  | 'commercial'
  | 'office'
  | 'retail'
  | 'hotel'
  | 'civic'
  | 'religious'
  | 'school'
  | 'industrial'
  | 'transport'
  | 'parking'
  | 'other';

export type District =
  | 'chinatown'
  | 'fidi'
  | 'embarcadero'
  | 'jackson_square'
  | 'nob_hill'
  | 'north_beach'
  | 'soma'
  | 'other';

export interface BuildingRecord {
  id: string; // stable, e.g. "B0001"
  osmId: string; // "way/123" | "relation/456"
  name?: string;
  address?: string; // "455 Grant Ave"
  /** Outer ring, local metres, counter-clockwise when viewed from above (+Y), not closed (first != last). */
  footprint: XZ[];
  holes?: XZ[][];
  /** Terrain elevation (m) at the lowest point of the footprint. Geometry starts here. */
  baseElevation: number;
  /** Height above baseElevation to the roof top (m). */
  height: number;
  /** For building:part pieces that start above ground (m above baseElevation). */
  minHeight?: number;
  levels: number;
  use: BuildingUse;
  structure: StructureType;
  yearBuilt: number;
  codeLevel: CodeLevel;
  occupantsDay: number;
  occupantsNight: number;
  softStory: boolean;
  district: District;
  /** On historic bay fill (east of the ~1850 shoreline) — liquefaction-susceptible. */
  onFill: boolean;
  /** Time-averaged shear-wave velocity to 30 m depth (m/s), site class proxy. */
  vs30: number;
  roofShape?: string; // OSM roof:shape
  colour?: string; // OSM building:colour or estimated, CSS colour
  roofColour?: string;
  material?: string; // OSM building:material (brick, glass, concrete, stone, wood, plaster…)
  /** Set when a hand-built landmark model replaces/augments this footprint. */
  landmark?: LandmarkId;
  /**
   * True if this record is a piece of a bigger building (OSM building:part, outline remainder, podium mapped
   * separately) that is NOT its structural record. Each building has exactly one record without isPart/parentId
   * (its anchor = tallest ground-standing piece), which carries ALL the building's occupants; pieces carry 0 and
   * share the anchor's structure/yearBuilt/codeLevel/softStory. So `!isPart` enumerates buildings exactly once.
   */
  isPart?: boolean;
  /** Outside the core study area (context ring): rendered for realism, still simulated, may use cheaper LOD. */
  context?: boolean;
  /**
   * Stands over the bay rather than on terrain: a pier shed / wharf building (baseElevation = pier deck, ~2.4-3.6 m)
   * or a moored vessel (baseElevation ≈ -1, hull below the waterline). Terrain under it is bay floor; don't drape
   * foundations onto it.
   */
  overWater?: boolean;
  /** Id of the building's anchor record (set on every isPart piece, never on the anchor): group key = parentId ?? id. */
  parentId?: string;
  provenance: {
    height: 'osm_height' | 'datasf_lidar' | 'osm_levels' | 'estimated';
    year: 'assessor' | 'osm' | 'estimated';
    structure: 'assessor' | 'estimated';
  };
}

export type LandmarkId =
  | 'ferry_building'
  | 'transamerica_pyramid'
  | 'chinatown_gate'
  | 'embarcadero_center'
  | 'old_st_marys'
  | 'sentinel_building'
  | 'one_maritime_plaza'
  | 'hyatt_regency'
  | 'customs_house'
  | 'coit_tower'
  | 'bay_bridge'
  | 'other';

export type RoadKind =
  | 'motorway'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'living_street'
  | 'pedestrian'
  | 'footway'
  | 'steps'
  | 'cycleway'
  | 'rail' // heavy/light rail, streetcar (F-line)
  | 'cable_car';

export interface RoadRecord {
  id: string; // "R0001"
  osmId: string;
  name?: string;
  kind: RoadKind;
  /** Centreline polyline, local metres. */
  points: XZ[];
  /** Carriageway width (m), kerb to kerb. Sidewalks are drawn by the streets module outside this. */
  width: number;
  lanes?: number;
  oneway?: boolean;
  bridge?: boolean;
  tunnel?: boolean;
  layer?: number;
  /** Sidewalk width each side (m), 0 if none. */
  sidewalk?: number;
}

export type AreaKind = 'park' | 'plaza' | 'pier' | 'water' | 'parking' | 'grass' | 'pitch' | 'construction';

export interface AreaRecord {
  id: string;
  osmId?: string;
  kind: AreaKind;
  name?: string;
  polygon: XZ[];
  holes?: XZ[][];
  /** Deck elevation for piers (m). */
  elevation?: number;
}

export interface TreeRecord {
  x: number;
  z: number;
  species?: string;
  /** Diameter at breast height (inches), from DataSF street-tree list when available. */
  dbh?: number;
  source: 'datasf' | 'osm' | 'estimated';
}

export interface CityMeta {
  name: string;
  /** Core study area (Ferry Building → Chinatown). */
  bbox: { south: number; west: number; north: number; east: number };
  /** Larger area that buildings/terrain were fetched for (context ring around the core). */
  contextBBox: { south: number; west: number; north: number; east: number };
  origin: { lat: number; lon: number };
  generatedAt: string;
  sources: string[]; // human-readable attributions
  /** Approximate ~1850 shoreline polyline (local metres). Land west of it is native ground; east is fill. */
  historicShoreline?: XZ[];
}

export interface CityData {
  meta: CityMeta;
  buildings: BuildingRecord[];
  roads: RoadRecord[];
  areas: AreaRecord[];
  trees: TreeRecord[];
}

/** public/data/terrain.json (+ terrain.bin Float32 little-endian, row-major, rows = north→south). */
export interface TerrainMeta {
  /** World X of column 0 and world Z of row 0 (north-west corner sample). */
  minX: number;
  minZ: number;
  /** Sample spacing (m). */
  cellSize: number;
  cols: number;
  rows: number;
  /** Min/max elevation present (m). Bay bathymetry is negative. */
  minElevation: number;
  maxElevation: number;
  source: string;
}

/** Bilinear sampler over the terrain grid (src/terrain/heightfield.ts). */
export interface Heightfield {
  meta: TerrainMeta;
  data: Float32Array;
  /** Elevation (m) at world x,z; clamps outside the grid. */
  heightAt(x: number, z: number): number;
  /** Unit surface normal at world x,z. */
  normalAt(x: number, z: number, target?: THREE.Vector3): THREE.Vector3;
}

// ───────────────────────────── Runtime context ─────────────────────────────

export interface EnvironmentState {
  /** Local solar time in hours, 0..24. */
  timeOfDay: number;
  /** World-space unit vector pointing from the scene towards the sun. */
  sunDirection: THREE.Vector3;
  /** 0 = full day, 1 = full night (smooth through dusk/dawn). Drives window lights & street lamps. */
  nightFactor: number;
  /** 0..1 extra atmospheric dust/haze (raised after collapses). */
  haze: number;
}

export type AppEvent =
  | { type: 'environment-changed'; env: EnvironmentState }
  | { type: 'building-selected'; id: string | null }
  | { type: 'quake-started'; event: UsgsEvent }
  | { type: 'quake-tick'; simSeconds: number }
  | { type: 'quake-finished' }
  | { type: 'quake-reset' }
  | { type: 'overlay-changed'; overlay: OverlayMode };

export type OverlayMode = 'none' | 'shakemap' | 'damage';

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent['type']>(type: T, fn: (e: Extract<AppEvent, { type: T }>) => void): () => void;
}

export type UpdateFn = (dt: number, elapsed: number) => void;

export interface AppContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Parent group for everything that belongs to the city (ground, streets, buildings, landmarks, props). */
  cityRoot: THREE.Group;
  city: CityData;
  terrain: Heightfield;
  env: EnvironmentState;
  events: EventBus;
  /** Register a per-frame callback; returns an unsubscribe function. */
  onUpdate(fn: UpdateFn): () => void;
}

// ───────────────────────────── Engine (src/engine) ─────────────────────────────

export type CameraPresetId = 'overview' | 'ferry' | 'chinatown' | 'street' | 'transamerica' | 'embarcadero' | 'aerial_east';

export interface CameraPreset {
  id: CameraPresetId;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

export interface Engine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  env: EnvironmentState;
  /** Set local solar time (hours). Updates sun, sky, lights, fog, env map, then emits 'environment-changed' via the bus given in start(). */
  setTimeOfDay(hours: number): void;
  setHaze(amount: number): void;
  /** Adds screen-space camera shake (metres of camera jitter); decays automatically unless re-set each frame. */
  setCameraShake(amplitude: number): void;
  /** Smoothly fly camera to a preset or explicit pose. duration in seconds (0 = instant). */
  flyTo(pose: CameraPresetId | { position: [number, number, number]; target: [number, number, number] }, duration?: number): void;
  cameraPresets: CameraPreset[];
  /** Begin the render loop. update callbacks run before render each frame. */
  start(bus: EventBus, onFrame: UpdateFn): void;
  /** Render one frame synchronously (used by screenshot harness). */
  renderOnce(): void;
  /** Expose the shadow-casting sun so modules can tune shadow camera bounds if needed. */
  sun: THREE.DirectionalLight;
  /** Optional: terrain sampler so camera controls/presets never go below ground. Wired by main.ts. */
  setGroundHeightSampler?(fn: (x: number, z: number) => number): void;
  /**
   * Optional: render the scene from another camera (e.g. a drone feed) into a render target,
   * display-ready (exposure + tone mapping + sRGB; no AO/bloom). Shares sky, lights, fog and the
   * main view's shadow map. `target` null renders to the canvas.
   */
  renderView?(camera: THREE.Camera, target: THREE.WebGLRenderTarget | null): void;
}

// ───────────────────────────── Buildings (src/city/buildings) ─────────────────────────────

/**
 * Per-building dynamic state, written by quake FX, read by the building material's vertex/fragment shaders.
 * Stored in a float DataTexture, 3 texels per building (index i → texels 3i, 3i+1, 3i+2):
 *   texel 0 (dynamic A): shakeX (m), shakeZ (m), tiltX (rad, rotation about world X), tiltZ (rad, about world Z)
 *   texel 1 (dynamic B): crush 0..1 (vertical squash toward base; 1 = flattened),
 *                        damage 0..4 (HAZUS state, float for smooth tinting), lightsOut 0..1, hidden 0/1
 *   texel 2 (static):    centreX, centreZ, baseElevation, height
 * Deformation (vertex shader), for a vertex with world position p and h = p.y - base:
 *   1. crush:  p.y = base + h * (1 - crush)
 *   2. tilt:   rotate (p - [cx, base, cz]) by tiltX about X then tiltZ about Z, add back
 *   3. shake:  p.xz += [shakeX, shakeZ] * (h / height)   (cantilever: top moves most)
 *   4. hidden: collapse vertex to degenerate (or discard in fragment) when hidden > 0.5
 */
export interface BuildingDynamicState {
  shakeX?: number;
  shakeZ?: number;
  tiltX?: number;
  tiltZ?: number;
  crush?: number;
  damage?: number;
  lightsOut?: number;
  hidden?: number;
}

export interface BuildingsHandle {
  object: THREE.Object3D;
  count: number;
  /** Index of building id in the state buffer, or -1. Index order == city.buildings order. */
  indexOf(id: string): number;
  /** Merge-update dynamic state for one building (by index). Call commit() once per frame after updates. */
  setState(index: number, s: BuildingDynamicState): void;
  getState(index: number): Required<BuildingDynamicState>;
  /** Reset every building to the undamaged state. */
  resetAll(): void;
  commit(): void;
  /** Damage-colour overlay on/off (tints by damage value; colour ramp owned by buildings module). */
  setDamageOverlay(on: boolean): void;
  /** Optional per-building tint for overlays such as ShakeMap MMI (null clears). RGB 0..1. */
  setOverlayColor(index: number, rgb: [number, number, number] | null): void;
  /** Highlight one building (selection outline / glow). */
  setHighlight(id: string | null): void;
  /** Raycast pick → building id or null. */
  pick(raycaster: THREE.Raycaster): string | null;
}

// ───────────────────────────── Streets & ground (src/city/streets) ─────────────────────────────

export interface StreetsHandle {
  object: THREE.Object3D;
  /** Street lamps & traffic lights follow env.nightFactor; quake FX can cut power. 0 = on, 1 = all off. */
  setPowerOut(amount: number): void;
}

// ───────────────────────────── Landmarks (src/city/landmarks) ─────────────────────────────

export interface LandmarksHandle {
  object: THREE.Object3D;
  /** Landmark object that replaces a building footprint, for quake FX to shake/tilt via its transform. */
  objectForBuilding(buildingId: string): THREE.Object3D | null;
  /** Building ids whose generic extrusion was hidden because a landmark model replaces it. */
  replacedBuildingIds: string[];
  /** Optional (landmarks): cut landmark night lighting (floodlights, windows, Bay Lights…). 0 = on, 1 = all off. */
  setPowerOut?(amount: number): void;
  /**
   * Optional (landmarks): overlay tint for the landmark replacing building `index` (same semantics as
   * BuildingsHandle.setOverlayColor). Landmarks already mirror the calls made on the buildings handle, so
   * callers do not need to invoke this; it exists for explicit control.
   */
  setOverlayColor?(index: number, rgb: [number, number, number] | null): void;
  /** Optional (landmarks): damage-state colour overlay on/off (mirrors BuildingsHandle.setDamageOverlay). */
  setDamageOverlay?(on: boolean): void;
}

// ───────────────────────────── Earthquake model (src/quake/model) — pure TS, no three.js ─────────────────────────────

/** Exactly the USGS earthquake GeoJSON Feature format (earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). */
export interface UsgsEvent {
  type: 'Feature';
  id: string;
  properties: {
    mag: number;
    place: string;
    time: number; // ms since epoch (origin time)
    updated: number;
    tz: number | null;
    url: string;
    detail: string;
    felt: number | null;
    cdi: number | null;
    mmi: number | null;
    alert: 'green' | 'yellow' | 'orange' | 'red' | null;
    status: 'automatic' | 'reviewed';
    tsunami: 0 | 1;
    sig: number;
    net: string;
    code: string;
    ids: string;
    sources: string;
    types: string;
    nst: number | null;
    dmin: number | null;
    rms: number | null;
    gap: number | null;
    magType: string;
    type: 'earthquake';
    title: string;
  };
  geometry: { type: 'Point'; coordinates: [number, number, number] }; // [lon, lat, depthKm]
}

export interface QuakeScenario {
  id: string;
  name: string; // "San Andreas M7.8 — 1906 repeat"
  description: string;
  event: UsgsEvent;
  /** Surface trace of the rupture as [lon, lat] — used for finite-fault distance. Omit for point source. */
  ruptureTrace?: [number, number][];
  /** Fault dip info for Rrup: top-of-rupture depth (km). */
  ztorKm?: number;
  /** Local solar time (hours) the scenario happens at, drives occupancy (day/night). */
  localHour: number;
}

export interface BuildingShaking {
  /** Rupture distance (km). */
  distanceKm: number;
  pgaG: number; // peak ground acceleration (g)
  pgvCms: number; // peak ground velocity (cm/s)
  mmi: number; // Modified Mercalli Intensity (float)
  /** Seconds after origin time the P and S waves arrive at this building. */
  pArrivalS: number;
  sArrivalS: number;
  /** Strong-shaking duration at this site (s). */
  durationS: number;
  /** Optional (quake model): the ground under this building liquefied (sand boils, settlement, lateral spreading). */
  liquefaction?: boolean;
  /** Optional (quake model): site Vs30 used (m/s). */
  vs30?: number;
}

export type DamageState = 0 | 1 | 2 | 3 | 4; // none, slight, moderate, extensive, complete

export interface BuildingDamage {
  state: DamageState;
  /** P(state >= ds) for ds = 1..4 */
  exceedance: [number, number, number, number];
  collapsed: boolean; // a subset of complete damage
  /** Fraction of the building's height lost (0..1) for collapse visuals. */
  collapseFraction: number;
  /** Lean direction (radians, world XZ) and magnitude for extensive/complete damage visuals.
   *  The roof moves along (cos leanDirection, sin leanDirection) in world (x, z); leanAngle is in radians. */
  leanDirection: number;
  leanAngle: number;
  /** Debris spill radius beyond footprint (m). */
  debrisRadius: number;
  fire: boolean;
  /** Seconds after origin when the damage manifests (≥ sArrival). */
  failTimeS: number;
  /** Expected casualties by HAZUS severity 1..4 and trapped estimate. */
  trappedEstimate: number;
  casualties: [number, number, number, number];
}

export interface RoadBlockage {
  roadId: string;
  /** Segment index i means the segment points[i] → points[i+1]. */
  segment: number;
  /** Fraction of carriageway width covered by debris (0..1). >= 0.6 ⇒ impassable. */
  coverage: number;
  causeBuildingId: string;
  /** Debris pile centre (world x,z). */
  at: XZ;
}

export interface QuakeResult {
  scenario: QuakeScenario;
  shaking: BuildingShaking[]; // aligned with city.buildings
  damage: BuildingDamage[]; // aligned with city.buildings
  roads: RoadBlockage[];
  stats: {
    buildings: number;
    byState: [number, number, number, number, number];
    collapsed: number;
    fires: number;
    trappedEstimate: number;
    blockedSegments: number;
    maxMmi: number;
    occupantsAtTime: number;
  };
  /** ShakeAlert: seconds between alert issuance and S-wave arrival at the city centre (can be ≤ 0 = blind zone). */
  shakeAlert: { issuedAtS: number; warningSecondsAtCentre: number; expectedMmi: number };
  /** Simulated time span of the event visualization (s after origin). */
  durationS: number;
}

export interface QuakeModel {
  scenarios: QuakeScenario[];
  /** Deterministic for a given seed. */
  run(city: CityData, scenario: QuakeScenario, seed?: number): QuakeResult;
  /** Build a custom scenario from an epicentre & magnitude. */
  customScenario(lat: number, lon: number, depthKm: number, mag: number, localHour: number): QuakeScenario;
  /** Ground-motion field for overlays: MMI at an arbitrary world x,z (uses vs30 heuristic from nearest building or default). */
  mmiAt(city: CityData, scenario: QuakeScenario, x: number, z: number): number;
}

// ───────────────────────────── Earthquake FX (src/quake/fx) ─────────────────────────────

export interface QuakeFxHandle {
  object: THREE.Object3D;
  /** Start playing a computed quake result. timeScale = sim seconds per real second. */
  play(result: QuakeResult, opts?: { timeScale?: number }): void;
  /** Jump the playback to t sim-seconds after origin (deterministic, used by screenshot harness). */
  seek(simSeconds: number): void;
  pause(): void;
  resume(): void;
  reset(): void;
  readonly playing: boolean;
  readonly simSeconds: number;
  setOverlay(mode: OverlayMode): void;
}

// ───────────────────────────── UI (src/ui) ─────────────────────────────

export interface UiHandlers {
  onTriggerScenario(scenarioId: string): void;
  onTriggerCustom(lat: number, lon: number, depthKm: number, mag: number): void;
  onReset(): void;
  onTimeOfDay(hours: number): void;
  onOverlay(mode: OverlayMode): void;
  onCameraPreset(id: CameraPresetId): void;
  onTimeScale(scale: number): void;
  onPauseToggle(): void;
}

export interface BuildingInfo {
  record: BuildingRecord;
  shaking?: BuildingShaking;
  damage?: BuildingDamage;
}

export interface UiHandle {
  /** Show the incoming USGS event card (as if received from the USGS feed). */
  showEvent(event: UsgsEvent, scenario: QuakeScenario): void;
  /** ShakeAlert banner: countdown seconds until strong shaking (≤0 hides countdown), expected MMI. */
  showShakeAlert(secondsToShaking: number, expectedMmi: number): void;
  hideShakeAlert(): void;
  updateStats(stats: QuakeResult['stats'] | null, simSeconds: number): void;
  showBuilding(info: BuildingInfo | null): void;
  setTimeOfDay(hours: number): void;
  setPlaying(playing: boolean): void;
  setScenarios(scenarios: QuakeScenario[]): void;
  setCameraPresets(presets: CameraPreset[]): void;
  setCityStats(city: CityData): void;
}
