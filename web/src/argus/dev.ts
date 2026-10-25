/**
 * Dev harness for the recon layer (?recon=mock): builds the recon, fakes helicopter chunks over the core area
 * from the quake result, applies mock Argon results and drives the AIR panel. Lets the recon/UI be tested before
 * the helicopter / scan / people modules are wired. Not used in the integrated app.
 *
 * Console: __argus.reconMock() → applies all chunks; __argus.handles.recon → ReconHandle.
 */
import type { AppContext, BuildingsHandle, LandmarksHandle, PeopleTruth, QuakeResult, ScanChunk, UiHandle } from '../contracts';
import { createRecon } from './index';
import { createMockReconstruction } from './mock';

const LAUNCH = 50;
const DURATION = 120;
const CHUNK_S = 15;

/** Stand-in people truth: visible trapped people on heavily damaged buildings, a few crowds in open spaces. */
function fakePeople(ctx: AppContext, result: QuakeResult): PeopleTruth {
  const byBuilding: PeopleTruth['byBuilding'] = {};
  ctx.city.buildings.forEach((b, i) => {
    const d = result.damage[i];
    if (d.trappedEstimate <= 0 || d.state < 3) return;
    const total = Math.max(1, Math.round(d.trappedEstimate));
    const visible = Math.round(total * (d.collapsed ? 0.35 : 0.2));
    byBuilding[b.id] = { visible, hidden: total - visible };
  });
  const crowds = [
    { id: 'C1', name: 'Portsmouth Square', lat: 37.7948, lon: -122.4056, count: 220 },
    { id: 'C2', name: 'Justin Herman Plaza', lat: 37.7951, lon: -122.3955, count: 340 },
    { id: 'C3', name: 'Union Square', lat: 37.788, lon: -122.4075, count: 180 },
  ].map((c) => {
    const x = (c.lon - ctx.city.meta.origin.lon) * 88000;
    const z = -(c.lat - ctx.city.meta.origin.lat) * 111000;
    return { id: c.id, name: c.name, x, z, radius: 30, count: c.count, appearS: 40 };
  });
  return { persons: [], crowds, byBuilding };
}

/** Fake chunks: west-to-east sweeps; each chunk tags the core buildings inside a moving 260 m window. */
function fakeChunks(ctx: AppContext): ScanChunk[] {
  const bs = ctx.city.buildings;
  const chunks: ScanChunk[] = [];
  const n = Math.ceil(DURATION / CHUNK_S);
  for (let c = 0; c < n; c++) {
    const t0 = c * CHUNK_S;
    const t1 = Math.min(DURATION, t0 + CHUNK_S);
    // Route: start over Chinatown (x≈-900), sweep east toward the Ferry Building (x≈+900), zig-zag in z.
    const cx = -900 + (1500 * (c + 0.5)) / n;
    const cz = (c % 2 ? -1 : 1) * 120 - 60;
    const ids: string[] = [];
    bs.forEach((b) => {
      if (b.isPart || b.context) return;
      const [x, z] = b.footprint[0];
      if (Math.abs(x - cx) < 130 && Math.abs(z - cz) < 230) ids.push(b.id);
    });
    const frames = [] as ScanChunk['frames'];
    for (let k = 0; k <= t1 - t0; k++) {
      const flightS = t0 + k;
      frames.push({
        index: flightS,
        flightS,
        simS: LAUNCH + flightS,
        pose: { flightS, position: [cx, 300, cz], heading: Math.PI / 2, cameraTarget: [cx, 0, cz], fovDeg: 40, footprint: [] },
        jpegBase64: '',
        taggedBuildingIds: ids.filter((_, j) => j % (t1 - t0 + 1) === k || j % 3 === k % 3),
      });
    }
    chunks.push({ chunkIndex: c, frames, buildingIds: ids, startFlightS: t0, endFlightS: t1 });
  }
  return chunks;
}

export function installReconDev(ctx: AppContext, deps: { buildings: BuildingsHandle; landmarks: LandmarksHandle; ui: UiHandle }) {
  const recon = createRecon(ctx, deps);
  ctx.scene.add(recon.object);
  const A = window.__argus as typeof window.__argus & { reconMock?: () => void; recon?: unknown };
  A.handles = { ...(A.handles ?? {}), recon };
  A.recon = recon;
  let chunks: ScanChunk[] = [];
  let people: PeopleTruth | null = null;
  let lastResult: QuakeResult | null = null;

  const ensure = () => {
    const r = window.__argus.result;
    if (!r) return false;
    if (r !== lastResult) {
      lastResult = r;
      people = fakePeople(ctx, r);
      recon.begin(r, people);
      chunks = fakeChunks(ctx);
    }
    return true;
  };

  const push = (simS: number) => {
    if (!lastResult) return;
    const flightS = Math.max(0, Math.min(DURATION, simS - LAUNCH));
    const status = simS < LAUNCH ? 'standby' : flightS >= DURATION ? 'complete' : flightS < 8 ? 'en route' : flightS > DURATION - 8 ? 'returning' : 'scanning';
    const st = recon.stats();
    const done = chunks.filter((c) => LAUNCH + c.endFlightS <= simS).length;
    deps.ui.showAir?.({
      callsign: 'AIR 1 · SFPD',
      status,
      flightS,
      durationS: DURATION,
      scannedFraction: Math.min(1, (flightS / DURATION) * 0.82),
      stats: st,
      pending: Math.max(0, Math.min(1, Math.ceil(flightS / CHUNK_S) - done)),
      mode: st.mode,
    });
    const sel = window.__argus.selected;
    deps.ui.showComparison?.(sel ? recon.compare(sel) : null);
  };

  A.reconMock = () => {
    if (!ensure()) return;
    chunks.forEach((c, k) => {
      recon.markSent?.(c.chunkIndex);
      recon.apply(createMockReconstruction(c, lastResult!, people, 7 + k, { city: ctx.city }), c);
    });
    const t = (window.__argus.handles!.fx as { simSeconds: number }).simSeconds;
    recon.update?.(t);
    push(t);
  };

  ctx.events.on('quake-started', () => {
    lastResult = null;
    recon.reset();
  });
  ctx.events.on('quake-reset', () => {
    lastResult = null;
    recon.reset();
    deps.ui.showAir?.(null);
  });
  ctx.events.on('quake-tick', ({ simSeconds }) => {
    if (!ensure()) return;
    recon.update?.(simSeconds);
    push(simSeconds);
  });
  ctx.events.on('building-selected', ({ id }) => deps.ui.showComparison?.(id ? recon.compare(id) : null));
  return recon;
}
