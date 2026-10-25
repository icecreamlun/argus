/**
 * Argon drone plan: PlanRequest → (plan cache | gemini-4-argon text-only JSON) → DronePlan.
 * Server-side only (mounted by server/plugin.ts as POST /api/plan).
 *
 * Candidate ids → building ids are mapped HERE (area candidates "A-<n>" expand to their buildingIds; a
 * building id that belongs to an area is accepted too), so DroneMission.targetBuildingIds are real building
 * ids. Drone ids are validated against dronesAvailable (one mission per drone), targets are deduplicated
 * across missions, capped at 4 buildings per mission and trimmed to the sortie endurance.
 *
 * Cache: data/recon-cache/plans/<hash>.json (hash = model + PLAN_PROMPT_VERSION + prompt), plus a replay index
 * data/recon-cache/plans/<scenario>_h<hour×10>/wave_<n>.json → { hash } (latest Gemini plan for that wave).
 * mode 'replay-only' reads the hash, then the index; 404 if neither exists.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { DroneId, DroneMission, DronePlan, PlanRequest } from '../src/contracts';
import { HttpError, type ReconConfig } from './reconstruct';
import { PLAN_PROMPT_VERSION, buildPlanPrompt, planResponseSchema } from './planPrompt';

export type ServerDronePlan = DronePlan & { hash?: string; promptVersion?: string; usage?: Record<string, number | undefined>; notes?: string[] };

const DRONES: DroneId[] = ['D1', 'D2', 'D3'];

export function validatePlanRequest(body: unknown): PlanRequest {
  const r = body as PlanRequest;
  if (!r || typeof r !== 'object') throw new HttpError(400, 'body must be a JSON object');
  if (!Array.isArray(r.candidates)) throw new HttpError(400, 'candidates[] required');
  if (r.candidates.length > 80) throw new HttpError(400, 'too many candidates (max 80)');
  if (!r.drone || !Array.isArray(r.drone.base)) throw new HttpError(400, 'drone{} required');
  r.wave = r.wave === 2 ? 2 : 1;
  r.dronesAvailable = (Array.isArray(r.dronesAvailable) ? r.dronesAvailable : []).filter((d): d is DroneId => DRONES.includes(d));
  r.simS = Number(r.simS) || 0;
  r.localHour = Number.isFinite(r.localHour) ? r.localHour : 15;
  r.scenarioId = String(r.scenarioId ?? 'unknown');
  r.coverage ??= { scannedFraction: 0, heliStatus: 'unknown', chunksDone: 0, chunksTotal: 0 };
  r.situation ??= { collapsesObserved: [], peopleSeen: 0, crowds: [], fires: [], blockedRoads: [], latestSummary: '' };
  return r;
}

const str = (v: unknown, max = 600) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Coerce Gemini's JSON into DronePlan fields (candidate ids → building ids, drone / endurance validation). */
export function coercePlan(raw: any, req: PlanRequest): Pick<DronePlan, 'dispatch' | 'rationale' | 'holdReason' | 'missions'> & { dropped: string[] } {
  const dropped: string[] = [];
  const byId = new Map(req.candidates.map((c) => [c.id.toUpperCase(), c]));
  const areaOf = new Map<string, (typeof req.candidates)[number]>();
  for (const c of req.candidates) for (const b of c.buildingIds ?? []) areaOf.set(b.toUpperCase(), c);
  const pos = new Map<string, [number, number]>();
  for (const c of req.candidates) {
    if (c.buildingId) pos.set(c.buildingId, [c.x, c.z]);
    for (const b of c.buildingIds ?? []) pos.set(b, [c.x, c.z]);
  }
  const used = new Set<string>();
  const usedDrones = new Set<DroneId>();
  const missions: DroneMission[] = [];
  const list = Array.isArray(raw?.missions) ? [...raw.missions] : [];
  list.sort((a, b) => (Number(a?.priority) || 9) - (Number(b?.priority) || 9));
  for (const m of list) {
    const droneId = String(m?.droneId ?? '').toUpperCase() as DroneId;
    if (!req.dronesAvailable.includes(droneId) || usedDrones.has(droneId)) {
      dropped.push(`mission for unavailable/duplicate drone ${droneId}`);
      continue;
    }
    const targets: string[] = [];
    const centres: [number, number][] = [];
    let area = false;
    for (const t of Array.isArray(m?.targetIds) ? m.targetIds : []) {
      const key = String(t).trim().toUpperCase();
      const c = byId.get(key);
      let ids: string[];
      if (c) {
        ids = c.buildingIds ?? (c.buildingId ? [c.buildingId] : []);
        if (c.buildingIds) area = true;
        centres.push([c.x, c.z]);
      } else if (areaOf.has(key)) {
        const a = areaOf.get(key)!;
        ids = [a.buildingIds!.find((b) => b.toUpperCase() === key)!];
        centres.push([a.x, a.z]);
      } else {
        dropped.push(`unknown target ${t}`);
        continue;
      }
      for (const id of ids) if (!used.has(id) && !targets.includes(id) && targets.length < 4) targets.push(id);
    }
    // Endurance: transit base → targets → base + orbit per target.
    const d = req.drone;
    while (targets.length > 1) {
      let dist = 0;
      let p = d.base;
      for (const id of targets) {
        const q = pos.get(id) ?? p;
        dist += Math.hypot(q[0] - p[0], q[1] - p[1]);
        p = q;
      }
      dist += Math.hypot(d.base[0] - p[0], d.base[1] - p[1]);
      if (dist / d.speedMs + targets.length * d.orbitS <= d.enduranceS) break;
      dropped.push(`target ${targets.pop()} beyond endurance`);
    }
    if (!targets.length) continue;
    targets.forEach((id) => used.add(id));
    usedDrones.add(droneId);
    const kind = m?.kind === 'survey_area' || (area && m?.kind !== 'verify_building') ? 'survey_area' : 'verify_building';
    missions.push({
      id: `W${req.wave}-${droneId}`,
      wave: req.wave,
      droneId,
      kind,
      targetBuildingIds: targets,
      areaCentre:
        kind === 'survey_area' && centres.length
          ? [Math.round(centres.reduce((a, c) => a + c[0], 0) / centres.length), Math.round(centres.reduce((a, c) => a + c[1], 0) / centres.length)]
          : undefined,
      purpose: str(m?.purpose, 200) ?? 'Close-up damage verification',
      priority: missions.length + 1,
    });
  }
  let dispatch = raw?.dispatch === true && missions.length > 0;
  let holdReason = str(raw?.holdReason);
  if (raw?.dispatch === true && !missions.length) holdReason = holdReason ?? 'No valid missions in the proposed plan.';
  if (!dispatch) holdReason = holdReason ?? str(raw?.rationale) ?? 'Holding for now.';
  return { dispatch, rationale: str(raw?.rationale, 800) ?? '', holdReason: dispatch ? undefined : holdReason, missions: dispatch ? missions : [], dropped };
}

let client: { key: string; ai: GoogleGenAI } | null = null;
const getAi = (key: string) => {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
};

const plansDir = (cfg: ReconConfig) => join(cfg.root, 'data', 'recon-cache', 'plans');
const planIndexFile = (cfg: ReconConfig, req: PlanRequest) =>
  join(plansDir(cfg), `${req.scenarioId.replace(/[^\w-]/g, '_')}_h${Math.round(req.localHour * 10)}`, `wave_${req.wave}.json`);

const inflight = new Map<string, Promise<ServerDronePlan>>();

export async function plan(cfg: ReconConfig, req: PlanRequest, opts: { fresh?: boolean } = {}): Promise<ServerDronePlan> {
  const prompt = buildPlanPrompt(req);
  const hash = createHash('sha256').update(`${cfg.model}\n${PLAN_PROMPT_VERSION}\n${prompt}`).digest('hex').slice(0, 32);
  const file = join(plansDir(cfg), `${hash}.json`);
  const asReplay = (p: ServerDronePlan): ServerDronePlan => ({ ...p, mode: 'replay', createdAtSimS: req.simS });

  if (!opts.fresh && existsSync(file)) return asReplay(JSON.parse(await readFile(file, 'utf8')));
  if (req.mode === 'replay-only') {
    const idx = planIndexFile(cfg, req);
    if (existsSync(idx)) {
      const { hash: h } = JSON.parse(await readFile(idx, 'utf8')) as { hash: string };
      const f = join(plansDir(cfg), `${h}.json`);
      if (existsSync(f)) return asReplay(JSON.parse(await readFile(f, 'utf8')));
    }
    throw new HttpError(404, `no cached plan for ${req.scenarioId} h${req.localHour} wave ${req.wave}`);
  }
  if (!cfg.apiKey) throw new HttpError(502, 'GEMINI_API_KEY not configured');
  if (!req.dronesAvailable.length) throw new HttpError(400, 'no drones available');

  const existing = inflight.get(hash);
  if (existing) return existing;
  const job = (async (): Promise<ServerDronePlan> => {
    const t0 = Date.now();
    const res = await getAi(cfg.apiKey).models.generateContent({
      model: cfg.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', responseSchema: planResponseSchema, temperature: 0.2, httpOptions: { timeout: 90_000 } },
    });
    const text = res.text ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`plan response is not JSON (finishReason=${res.candidates?.[0]?.finishReason ?? '?'})`);
      raw = JSON.parse(m[0]);
    }
    const { dropped, ...fields } = coercePlan(raw, req);
    const u = res.usageMetadata;
    const out: ServerDronePlan = {
      wave: req.wave,
      ...fields,
      model: cfg.model,
      mode: 'gemini',
      latencyMs: Date.now() - t0,
      createdAtSimS: req.simS,
      hash,
      promptVersion: PLAN_PROMPT_VERSION,
      usage: { promptTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thoughtsTokens: u?.thoughtsTokenCount },
      notes: dropped,
    };
    await mkdir(plansDir(cfg), { recursive: true });
    await writeFile(file, JSON.stringify(out, null, 1));
    const idx = planIndexFile(cfg, req);
    await mkdir(join(idx, '..'), { recursive: true });
    await writeFile(idx, JSON.stringify({ hash, simS: req.simS, wave: req.wave })).catch(() => {});
    return out;
  })();
  inflight.set(hash, job);
  try {
    return await job;
  } finally {
    inflight.delete(hash);
  }
}
