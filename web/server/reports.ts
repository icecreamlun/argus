/**
 * Argon resident-report triage: ReportsRequest → (reports cache | gemini-4-argon text-only JSON) → ReportsResponse.
 * Server-side only (mounted by server/plugin.ts as POST /api/reports).
 *
 * Validation: every analysis must name a report of the batch (unknown ids dropped, missing reports filled with an
 * "unread" analysis); buildingId must be one of THAT report's candidates (else null); damage ∈ ObservedDamage or
 * null; peopleTrapped integer 0..200; hazards ≤ 6 short strings; credibility clamped 0..1; duplicateOf must be
 * another report id of the batch; note ≤ 12 words.
 *
 * Cache: data/recon-cache/reports/<hash>.json (hash = model + REPORTS_PROMPT_VERSION + prompt), plus a replay index
 * data/recon-cache/reports/<scenario>_h<hour×10>/batch_<n>.json → { hash, reportIds } (latest Gemini answer for
 * that batch). mode 'replay-only' reads the hash, then the index entry for batchIndex if its reportIds match the
 * request, then any index entry with the same reportIds; 404 if none.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { ObservedDamage, ReportAnalysis, ReportsRequest, ReportsResponse } from '../src/contracts';
import { HttpError, type ReconConfig } from './reconstruct';
import { REPORTS_PROMPT_VERSION, buildReportsPrompt, reportsResponseSchema } from './reportsPrompt';

export type ServerReportsResponse = ReportsResponse & { hash?: string; promptVersion?: string; usage?: Record<string, number | undefined>; notes?: string[] };

const DAMAGE: ObservedDamage[] = ['none', 'slight', 'moderate', 'extensive', 'collapsed'];
const LANGS = ['en', 'zh', 'es'] as const;

export function validateReportsRequest(body: unknown): ReportsRequest {
  const r = body as ReportsRequest;
  if (!r || typeof r !== 'object') throw new HttpError(400, 'body must be a JSON object');
  if (!Array.isArray(r.reports) || !r.reports.length) throw new HttpError(400, 'reports[] required');
  if (r.reports.length > 60) throw new HttpError(400, 'too many reports (max 60)');
  r.batchIndex = Math.max(0, Math.floor(Number(r.batchIndex) || 0));
  r.scenarioId = String(r.scenarioId ?? 'unknown');
  r.localHour = Number.isFinite(r.localHour) ? r.localHour : 15;
  r.mode = r.mode === 'replay-only' ? 'replay-only' : 'auto';
  const ids = new Set<string>();
  r.reports = r.reports.map((x, k) => {
    const id = String(x?.id ?? `R-${k}`).slice(0, 24);
    if (ids.has(id)) throw new HttpError(400, `duplicate report id ${id}`);
    ids.add(id);
    return {
      id,
      simS: Number(x?.simS) || 0,
      text: String(x?.text ?? '').slice(0, 800),
      lang: LANGS.includes(x?.lang as never) ? x.lang : 'en',
      x: Number(x?.x) || 0,
      z: Number(x?.z) || 0,
      accuracyM: Number(x?.accuracyM) || 20,
      candidates: (Array.isArray(x?.candidates) ? x.candidates : []).slice(0, 12).map((c) => ({
        id: String(c?.id ?? ''),
        label: String(c?.label ?? '').slice(0, 120),
        distanceM: Math.round(Number(c?.distanceM) || 0),
        use: String(c?.use ?? 'other'),
        levels: Math.round(Number(c?.levels) || 1),
      })),
    };
  });
  return r;
}

const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(' ');

/** Coerce Gemini's JSON into validated analyses (one per request report, in request order). */
export function coerceAnalyses(raw: any, req: ReportsRequest): { analyses: ReportAnalysis[]; summary: string; dropped: string[] } {
  const dropped: string[] = [];
  const byId = new Map(req.reports.map((r) => [r.id.toUpperCase(), r]));
  const got = new Map<string, ReportAnalysis>();
  for (const a of Array.isArray(raw?.analyses) ? raw.analyses : []) {
    const rep = byId.get(String(a?.reportId ?? '').trim().toUpperCase());
    if (!rep) {
      dropped.push(`unknown report ${a?.reportId}`);
      continue;
    }
    if (got.has(rep.id)) continue;
    let buildingId: string | null = null;
    if (a?.buildingId != null && String(a.buildingId).trim() && !/^null$/i.test(String(a.buildingId))) {
      const want = String(a.buildingId).trim().toUpperCase();
      const c = rep.candidates.find((c) => c.id.toUpperCase() === want);
      if (c) buildingId = c.id;
      else dropped.push(`${rep.id}: building ${a.buildingId} not a candidate`);
    }
    const dmg = typeof a?.damage === 'string' ? (a.damage.toLowerCase() as ObservedDamage) : null;
    const damage = dmg && DAMAGE.includes(dmg) ? dmg : null;
    const dupId = typeof a?.duplicateOf === 'string' ? byId.get(a.duplicateOf.trim().toUpperCase())?.id : undefined;
    got.set(rep.id, {
      reportId: rep.id,
      buildingId,
      damage,
      peopleTrapped: Math.max(0, Math.min(200, Math.round(Number(a?.peopleTrapped) || 0))),
      hazards: (Array.isArray(a?.hazards) ? a.hazards : [])
        .map((h: unknown) => String(h).trim().toLowerCase().slice(0, 24))
        .filter(Boolean)
        .slice(0, 6),
      credibility: Math.round(Math.max(0, Math.min(1, Number(a?.credibility) || 0)) * 100) / 100,
      ...(dupId && dupId !== rep.id ? { duplicateOf: dupId } : {}),
      note: typeof a?.note === 'string' && a.note.trim() ? words(a.note, 12) : undefined,
    });
  }
  const analyses = req.reports.map(
    (r) =>
      got.get(r.id) ?? (dropped.push(`${r.id}: missing analysis`), { reportId: r.id, buildingId: null, damage: null, peopleTrapped: 0, hazards: [], credibility: 0, note: 'not read by Argon' }),
  );
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 600) : '';
  return { analyses, summary, dropped };
}

let client: { key: string; ai: GoogleGenAI } | null = null;
const getAi = (key: string) => {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
};

const reportsDir = (cfg: ReconConfig) => join(cfg.root, 'data', 'recon-cache', 'reports');
const runDir = (cfg: ReconConfig, req: ReportsRequest) => join(reportsDir(cfg), `${req.scenarioId.replace(/[^\w-]/g, '_')}_h${Math.round(req.localHour * 10)}`);
const sameIds = (a: string[] | undefined, req: ReportsRequest) => !!a && a.length === req.reports.length && req.reports.every((r, k) => a[k] === r.id);

const inflight = new Map<string, Promise<ServerReportsResponse>>();

async function findReplay(cfg: ReconConfig, req: ReportsRequest): Promise<ServerReportsResponse | null> {
  const dir = runDir(cfg, req);
  if (!existsSync(dir)) return null;
  const files = [`batch_${req.batchIndex}.json`, ...(await readdir(dir)).filter((f) => /^batch_\d+\.json$/.test(f) && f !== `batch_${req.batchIndex}.json`)];
  for (const f of files) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const idx = JSON.parse(await readFile(p, 'utf8')) as { hash: string; reportIds?: string[] };
    if (!sameIds(idx.reportIds, req)) continue;
    const hf = join(reportsDir(cfg), `${idx.hash}.json`);
    if (existsSync(hf)) return JSON.parse(await readFile(hf, 'utf8'));
  }
  return null;
}

export async function analyseReports(cfg: ReconConfig, req: ReportsRequest, opts: { fresh?: boolean } = {}): Promise<ServerReportsResponse> {
  const prompt = buildReportsPrompt(req);
  const hash = createHash('sha256').update(`${cfg.model}\n${REPORTS_PROMPT_VERSION}\n${prompt}`).digest('hex').slice(0, 32);
  const file = join(reportsDir(cfg), `${hash}.json`);
  const asReplay = (p: ServerReportsResponse): ServerReportsResponse => ({ ...p, batchIndex: req.batchIndex, mode: 'replay' });

  if (!opts.fresh && existsSync(file)) return asReplay(JSON.parse(await readFile(file, 'utf8')));
  if (req.mode === 'replay-only') {
    const hit = await findReplay(cfg, req);
    if (hit) return asReplay(hit);
    throw new HttpError(404, `no cached report analysis for ${req.scenarioId} h${req.localHour} batch ${req.batchIndex}`);
  }
  if (!cfg.apiKey) throw new HttpError(502, 'GEMINI_API_KEY not configured');

  const existing = inflight.get(hash);
  if (existing) return existing;
  const job = (async (): Promise<ServerReportsResponse> => {
    const t0 = Date.now();
    const res = await getAi(cfg.apiKey).models.generateContent({
      model: cfg.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', responseSchema: reportsResponseSchema, temperature: 0.2, httpOptions: { timeout: 90_000 } },
    });
    const text = res.text ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`reports response is not JSON (finishReason=${res.candidates?.[0]?.finishReason ?? '?'})`);
      raw = JSON.parse(m[0]);
    }
    const { analyses, summary, dropped } = coerceAnalyses(raw, req);
    if (!analyses.some((a) => a.note !== 'not read by Argon')) throw new Error('Argon returned no usable analyses');
    const u = res.usageMetadata;
    const out: ServerReportsResponse = {
      batchIndex: req.batchIndex,
      analyses,
      summary,
      model: cfg.model,
      mode: 'gemini',
      latencyMs: Date.now() - t0,
      hash,
      promptVersion: REPORTS_PROMPT_VERSION,
      usage: { promptTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thoughtsTokens: u?.thoughtsTokenCount },
      notes: dropped,
    };
    await mkdir(reportsDir(cfg), { recursive: true });
    await writeFile(file, JSON.stringify(out, null, 1));
    const dir = runDir(cfg, req);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `batch_${req.batchIndex}.json`), JSON.stringify({ hash, batchIndex: req.batchIndex, reportIds: req.reports.map((r) => r.id) })).catch(() => {});
    return out;
  })();
  inflight.set(hash, job);
  try {
    return await job;
  } finally {
    inflight.delete(hash);
  }
}
