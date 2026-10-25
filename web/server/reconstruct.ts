/**
 * Argon reconstruction: ReconstructionRequest → (replay cache | ffmpeg mp4 → Gemini) → ReconstructionResult.
 * Server-side only (runs inside the Vite dev server via server/plugin.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { GoogleGenAI, MediaResolution, type Part } from '@google/genai';
import type {
  ObservedBuilding,
  ObservedCrowd,
  ObservedDamage,
  ObservedRoad,
  ReconstructionRequest,
  ReconstructionResult,
} from '../src/contracts';
import { PROMPT_VERSION, buildPrompt, responseSchema } from './prompt';

export interface ReconConfig {
  apiKey: string;
  model: string;
  /** web/ root */
  root: string;
  ffmpeg?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ReconUsage {
  promptTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  totalTokens?: number;
}

/** Extra debug fields the server adds on top of ReconstructionResult (clients may ignore them). */
export type ServerReconResult = ReconstructionResult & { hash?: string; usage?: ReconUsage; notes?: string[]; promptVersion?: string };

const DAMAGES: ObservedDamage[] = ['none', 'slight', 'moderate', 'extensive', 'collapsed'];

export function validateRequest(body: unknown): ReconstructionRequest {
  const r = body as ReconstructionRequest;
  if (!r || typeof r !== 'object') throw new HttpError(400, 'body must be a JSON object');
  if (!Array.isArray(r.frames) || r.frames.length === 0) throw new HttpError(400, 'frames[] required');
  if (r.frames.length > 120) throw new HttpError(400, 'too many frames (max 120)');
  if (!Array.isArray(r.buildings)) throw new HttpError(400, 'buildings[] required');
  for (const f of r.frames) {
    if (typeof f.jpegBase64 !== 'string' || f.jpegBase64.length < 100) throw new HttpError(400, 'frame jpegBase64 missing');
    if (f.jpegBase64.startsWith('data:')) f.jpegBase64 = f.jpegBase64.slice(f.jpegBase64.indexOf(',') + 1);
    f.taggedBuildingIds ??= [];
    f.position ??= [0, 0, 0];
    f.heading ??= 0;
  }
  r.chunkIndex = Number(r.chunkIndex) || 0;
  r.localHour = Number.isFinite(r.localHour) ? r.localHour : 12;
  return r;
}

function hashRequest(model: string, prompt: string, req: ReconstructionRequest): string {
  const h = createHash('sha256');
  h.update(model + '\n' + PROMPT_VERSION + '\n' + prompt + '\n');
  for (const f of req.frames) h.update(f.jpegBase64);
  h.update(JSON.stringify(req.buildings));
  return h.digest('hex').slice(0, 32);
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${String(stderr).slice(-800)}`));
      else resolve();
    });
  });
}

async function encodeMp4(cfg: ReconConfig, hash: string, req: ReconstructionRequest): Promise<Buffer> {
  const dir = join(cfg.root, '.cache', 'air', hash);
  await mkdir(dir, { recursive: true });
  await Promise.all(req.frames.map((f, k) => writeFile(join(dir, `f_${String(k).padStart(3, '0')}.jpg`), Buffer.from(f.jpegBase64, 'base64'))));
  writeFile(join(dir, 'prompt.txt'), buildPrompt(req, { asImages: false })).catch(() => {});
  const out = join(dir, 'chunk.mp4');
  await run(
    cfg.ffmpeg ?? '/opt/homebrew/bin/ffmpeg',
    ['-y', '-loglevel', 'error', '-framerate', '1', '-i', 'f_%03d.jpg', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', '1', out],
    dir,
  );
  return readFile(out);
}

let client: { key: string; ai: GoogleGenAI } | null = null;
const getAi = (key: string) => {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);

/** Coerce Gemini's JSON into ReconstructionResult fields (ids restricted to the request's list). */
export function coerce(raw: any, req: ReconstructionRequest) {
  const n = req.frames.length;
  const idOf = new Map<string, string>();
  for (const b of req.buildings) {
    idOf.set(b.id.toUpperCase(), b.id);
    if (b.tag) idOf.set(b.tag.toUpperCase(), b.id);
  }
  const resolveId = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toUpperCase();
    if (idOf.has(s)) return idOf.get(s);
    const m = s.match(/B\d{2,6}/);
    return m ? idOf.get(m[0]) : undefined;
  };
  const evid = (v: unknown) => clamp(Math.round(num(v, 0)), 0, Math.max(0, n - 1));

  const byId = new Map<string, ObservedBuilding>();
  for (const b of Array.isArray(raw?.buildings) ? raw.buildings : []) {
    const id = resolveId(b?.id);
    if (!id) continue;
    let damage = String(b?.damage ?? '').toLowerCase() as ObservedDamage;
    if ((damage as string) === 'complete') damage = 'collapsed';
    if (!DAMAGES.includes(damage)) continue;
    const ob: ObservedBuilding = {
      id,
      damage,
      confidence: clamp(num(b.confidence, 0.5), 0, 1),
      peopleVisible: Math.max(0, Math.round(num(b.peopleVisible, 0))),
      trappedSigns: b.trappedSigns === true,
      fire: b.fire === true,
      smoke: b.smoke === true,
      evidenceS: evid(b.evidenceS),
      notes: str(b.notes),
    };
    const prev = byId.get(id);
    if (!prev || ob.confidence > prev.confidence) byId.set(id, ob);
  }

  // Compact "intact" list → full ObservedBuilding entries (damage none).
  const firstTagged = new Map<string, number>();
  req.frames.forEach((f, k) => f.taggedBuildingIds.forEach((id) => firstTagged.has(id) || firstTagged.set(id, k)));
  for (const v of Array.isArray(raw?.intact) ? raw.intact : []) {
    const id = resolveId(v);
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, damage: 'none', confidence: 0.7, peopleVisible: 0, trappedSigns: false, fire: false, smoke: false, evidenceS: firstTagged.get(id) ?? 0, notes: 'intact' });
  }

  const roads: ObservedRoad[] = [];
  for (const r of Array.isArray(raw?.roads) ? raw.roads : []) {
    const street = str(r?.street);
    const status = String(r?.status ?? '').toLowerCase();
    if (!street || !['blocked', 'partial', 'clear'].includes(status)) continue;
    roads.push({ street, status: status as ObservedRoad['status'], evidenceS: evid(r.evidenceS), nearBuildingId: resolveId(r.nearBuildingId), notes: str(r.notes) });
  }

  const crowds: ObservedCrowd[] = [];
  for (const c of Array.isArray(raw?.crowds) ? raw.crowds : []) {
    const approxCount = Math.max(0, Math.round(num(c?.approxCount, 0)));
    if (!approxCount) continue;
    crowds.push({ approxCount, evidenceS: evid(c.evidenceS), place: str(c.place), nearBuildingId: resolveId(c.nearBuildingId) });
  }

  return { buildings: [...byId.values()], roads, crowds, summary: str(raw?.summary) ?? '' };
}

class BadJson extends Error {}

function isInvalidArgument(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 400 || /\b400\b|INVALID_ARGUMENT|unsupported|not supported/i.test(String(e?.message ?? ''));
}

async function callGemini(cfg: ReconConfig, req: ReconstructionRequest, mp4: Buffer | null, notes: string[]) {
  const ai = getAi(cfg.apiKey);
  // JSON mode without responseSchema is ~2x faster on gemini-4-argon (the prompt spells out the shape);
  // the schema-constrained call is the fallback when the free JSON doesn't parse.
  const call = async (parts: Part[], mediaRes: boolean, schema: boolean) =>
    ai.models.generateContent({
      model: cfg.model,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        ...(schema ? { responseSchema } : {}),
        temperature: 0.2,
        ...(mediaRes ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH } : {}),
        httpOptions: { timeout: 150_000 },
      },
    });

  type Attempt = { label: string; asImages: boolean; mediaRes: boolean; schema: boolean };
  const attempts: Attempt[] = [];
  if (mp4)
    attempts.push(
      { label: 'video+hires', asImages: false, mediaRes: true, schema: false },
      { label: 'video+hires+schema', asImages: false, mediaRes: true, schema: true },
      { label: 'video', asImages: false, mediaRes: false, schema: true },
    );
  attempts.push({ label: 'images', asImages: true, mediaRes: false, schema: true });

  let lastErr: unknown;
  for (const a of attempts) {
    const prompt = buildPrompt(req, { asImages: a.asImages });
    const parts: Part[] = a.asImages
      ? req.frames.flatMap((f, k) => [{ text: `second ${k}:` }, { inlineData: { mimeType: 'image/jpeg', data: f.jpegBase64 } }])
      : [{ inlineData: { mimeType: 'video/mp4', data: mp4!.toString('base64') } }];
    parts.push({ text: prompt });
    try {
      const res = await call(parts, a.mediaRes, a.schema);
      const text = res.text ?? '';
      if (!text.trim()) throw new Error(`empty response (finishReason=${res.candidates?.[0]?.finishReason ?? '?'})`);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new BadJson('response is not JSON');
        try {
          raw = JSON.parse(m[0]);
        } catch {
          throw new BadJson('response JSON did not parse');
        }
      }
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { buildings?: unknown }).buildings)) throw new BadJson('response JSON has no buildings[]');
      notes.push(`input: ${a.label}`);
      const u = res.usageMetadata;
      return {
        raw,
        usage: { promptTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thoughtsTokens: u?.thoughtsTokenCount, totalTokens: u?.totalTokenCount } as ReconUsage,
      };
    } catch (err) {
      lastErr = err;
      notes.push(`${a.label} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      if (!(err instanceof BadJson) && !isInvalidArgument(err)) break; // network / quota / timeout: don't burn more attempts
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const inflight = new Map<string, Promise<ServerReconResult>>();

export async function reconstruct(cfg: ReconConfig, req: ReconstructionRequest, opts: { fresh?: boolean } = {}): Promise<ServerReconResult> {
  if (req.mode === 'mock') throw new HttpError(409, 'mode "mock" is handled client-side');
  const prompt = buildPrompt(req, { asImages: false });
  const hash = hashRequest(cfg.model, prompt, req);
  const cacheFile = join(cfg.root, 'data', 'recon-cache', `${hash}.json`);

  if (!opts.fresh && existsSync(cacheFile)) {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as ServerReconResult;
    return { ...cached, chunkIndex: req.chunkIndex, mode: 'replay' };
  }
  if (req.mode === 'replay-only') {
    // Frames differ byte-wise between runs (wall-clock animation): fall back to the run index (scenario/hour/chunk).
    const idx = runIndexFile(cfg, req.scenarioId, req.localHour, req.chunkIndex);
    if (existsSync(idx)) {
      const { hash: h } = JSON.parse(await readFile(idx, 'utf8')) as { hash: string };
      const f = join(cfg.root, 'data', 'recon-cache', `${h}.json`);
      if (existsSync(f)) return { ...(JSON.parse(await readFile(f, 'utf8')) as ServerReconResult), chunkIndex: req.chunkIndex, mode: 'replay' };
    }
    throw new HttpError(404, `no cached reconstruction for ${hash}`);
  }
  if (!cfg.apiKey) throw new HttpError(502, 'GEMINI_API_KEY not configured');

  const existing = inflight.get(hash);
  if (existing) return existing;

  const job = (async (): Promise<ServerReconResult> => {
    const t0 = Date.now();
    const notes: string[] = [];
    let mp4: Buffer | null = null;
    try {
      mp4 = await encodeMp4(cfg, hash, req);
      notes.push(`ffmpeg ${Date.now() - t0} ms`);
    } catch (err) {
      notes.push(`ffmpeg failed, sending frames as images: ${String((err as Error).message).slice(0, 200)}`);
    }
    const tg = Date.now();
    const { raw, usage } = await callGemini(cfg, req, mp4, notes);
    notes.push(`gemini ${Date.now() - tg} ms`);
    const fields = coerce(raw, req);
    const result: ServerReconResult = {
      chunkIndex: req.chunkIndex,
      model: cfg.model,
      mode: 'gemini',
      latencyMs: Date.now() - t0,
      ...fields,
      hash,
      usage,
      notes,
      promptVersion: PROMPT_VERSION,
    };
    await mkdir(join(cfg.root, 'data', 'recon-cache'), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(result, null, 1));
    await writeRunIndex(cfg, req, hash).catch(() => {});
    // .cache/air/<hash>/ (frames + chunk.mp4) is kept for debugging; it is gitignored.
    return result;
  })();
  inflight.set(hash, job);
  try {
    return await job;
  } finally {
    inflight.delete(hash);
  }
}

// ── Run index (integration): scenario/hour/chunk → cached result + chunk geometry, for deterministic replay ──
const runDir = (cfg: ReconConfig, scenarioId: string, localHour: number) =>
  join(cfg.root, 'data', 'recon-cache', 'runs', `${scenarioId.replace(/[^\w-]/g, '_')}_h${Math.round(localHour * 10)}`);
const runIndexFile = (cfg: ReconConfig, scenarioId: string, localHour: number, chunkIndex: number) =>
  join(runDir(cfg, scenarioId, localHour), `chunk_${String(chunkIndex).padStart(3, '0')}.json`);

async function writeRunIndex(cfg: ReconConfig, req: ReconstructionRequest, hash: string) {
  const dir = runDir(cfg, req.scenarioId, req.localHour);
  // Chunk 0 starts a new run: drop the previous run's chunks so a replay never mixes two flights.
  if (req.chunkIndex === 0 && existsSync(dir)) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const frames = req.frames.map((f) => ({ index: f.index, flightS: f.flightS, simS: f.simS, position: f.position, heading: f.heading, taggedBuildingIds: f.taggedBuildingIds }));
  const chunk = {
    chunkIndex: req.chunkIndex,
    startFlightS: frames[0]?.flightS ?? 0,
    endFlightS: frames[frames.length - 1]?.flightS ?? 0,
    buildingIds: req.buildings.map((b) => b.id),
    frames,
  };
  await writeFile(runIndexFile(cfg, req.scenarioId, req.localHour, req.chunkIndex), JSON.stringify({ hash, chunk }));
}

/** GET /api/replay?scenario=&hour= → every cached chunk of the latest run for that scenario/hour. */
export async function listReplay(cfg: ReconConfig, scenarioId: string, localHour: number) {
  const dir = runDir(cfg, scenarioId, localHour);
  if (!existsSync(dir)) return [];
  const out: { result: ServerReconResult; chunk: unknown }[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const { hash, chunk } = JSON.parse(await readFile(join(dir, f), 'utf8')) as { hash: string; chunk: { chunkIndex: number } };
      const rf = join(cfg.root, 'data', 'recon-cache', `${hash}.json`);
      if (!existsSync(rf)) continue;
      const result = JSON.parse(await readFile(rf, 'utf8')) as ServerReconResult;
      if (result.promptVersion && result.promptVersion !== PROMPT_VERSION) continue; // stale prompt
      out.push({ result: { ...result, chunkIndex: chunk.chunkIndex, mode: 'replay' }, chunk });
    } catch {
      /* skip corrupt entry */
    }
  }
  return out;
}
