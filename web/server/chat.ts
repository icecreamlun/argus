/**
 * M5 Argus Copilot chat: ChatRequest → (chat cache | gemini-4-argon JSON) → ChatResponse.
 * Server-side only (mounted by server/plugin.ts as POST /api/chat).
 *
 * The model sees: systemInstruction = CHAT_SYSTEM_PROMPT (+ data-format notes), contents = prior turns
 * (user/model) + the last user question, with the compact CopilotSituation JSON attached to the LAST user turn
 * as a separate text part. The returned plan is validated against the FULL situation: assignments whose
 * incidentId / fromFacilityId do not exist (or whose unitType is invalid) are dropped with a note.
 *
 * Cache: data/recon-cache/chat/<hash>.json (hash = model + CHAT_PROMPT_VERSION + messages + compact situation),
 * plus a replay index data/recon-cache/chat/<scenario>_h<quakeHour×10>/turn_<n>.json →
 * { entries: { "<normalised question>": { hash, question, simS } } } (n = 1-based user-turn number).
 * mode 'replay-only': exact hash, else same question (same turn first, then any turn); 404 if none.
 * mode 'auto': exact hash, else Gemini; if Gemini fails, falls back to a same-question replay, else 502.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { ChatRequest, ChatResponse, ChatTurn, CopilotSituation, RescuePlan, UnitType } from '../src/contracts';
import { HttpError, type ReconConfig } from './reconstruct';
import { CHAT_FORMAT_NOTES, CHAT_PROMPT_VERSION, CHAT_SYSTEM_PROMPT, UNIT_TYPES, chatResponseSchema, compactSituation } from './chatPrompt';

export type ServerChatResponse = ChatResponse & {
  hash?: string;
  promptVersion?: string;
  notes?: string[];
  usage?: Record<string, number | undefined>;
  replayOf?: string;
};

const MAX_TURNS = 12;

export function validateChatRequest(body: unknown): ChatRequest {
  const r = body as ChatRequest;
  if (!r || typeof r !== 'object') throw new HttpError(400, 'body must be a JSON object');
  if (!Array.isArray(r.messages) || !r.messages.length) throw new HttpError(400, 'messages[] required');
  const messages: ChatTurn[] = r.messages
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text.trim().slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new HttpError(400, 'last message must be a user question');
  const s = r.situation as CopilotSituation;
  if (!s || typeof s !== 'object') throw new HttpError(400, 'situation{} required');
  s.incidents = Array.isArray(s.incidents) ? s.incidents : [];
  s.roads = Array.isArray(s.roads) ? s.roads : [];
  s.facilities = Array.isArray(s.facilities) ? s.facilities : [];
  s.travelTimes = Array.isArray(s.travelTimes) ? s.travelTimes : [];
  s.scenarioId = String(s.scenarioId ?? 'unknown');
  s.summary ??= { buildingsAssessed: 0, collapsesVerified: 0, peopleSeen: 0, trappedSitesVerified: 0, fires: 0, crowds: 0, areaScannedPct: 0, latestArgonSummary: '' };
  return { messages: messages.slice(-MAX_TURNS), situation: s, mode: r.mode === 'replay-only' ? 'replay-only' : 'auto' };
}

/** Lower-case, strip punctuation / whitespace (EN + CJK) so the same question matches across runs. */
export function normaliseQuestion(q: string): string {
  return q
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 300);
}

const str = (v: unknown, max = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Coerce Gemini's plan JSON against the FULL situation. Returns null for "no plan". */
export function coerceChatPlan(raw: any, s: CopilotSituation): { plan: RescuePlan | null; notes: string[] } {
  const notes: string[] = [];
  if (!raw || typeof raw !== 'object') return { plan: null, notes };
  const inc = new Map(s.incidents.map((i) => [i.id.toUpperCase(), i.id]));
  const fac = new Map(s.facilities.map((f) => [f.id.toUpperCase(), f.id]));
  const roadNames = [...new Set(s.roads.map((r) => r.name?.trim()).filter((n): n is string => !!n))];
  const incId = (v: unknown) => inc.get(String(v ?? '').trim().toUpperCase());
  const facId = (v: unknown) => fac.get(String(v ?? '').trim().toUpperCase());
  const unit = (v: unknown) => {
    const u = String(v ?? '').trim().toLowerCase() as UnitType;
    return UNIT_TYPES.includes(u) ? u : undefined;
  };

  const priorities: RescuePlan['priorities'] = [];
  const seenP = new Set<string>();
  const plist = Array.isArray(raw.priorities) ? [...raw.priorities] : [];
  plist.sort((a, b) => (Number(a?.rank) || 99) - (Number(b?.rank) || 99));
  for (const p of plist) {
    const id = incId(p?.incidentId);
    if (!id) {
      notes.push(`dropped priority for unknown incident ${p?.incidentId}`);
      continue;
    }
    if (seenP.has(id)) continue;
    seenP.add(id);
    priorities.push({ rank: priorities.length + 1, incidentId: id, reason: str(p?.reason) ?? '' });
  }

  const assignments: RescuePlan['assignments'] = [];
  const merged = new Map<string, RescuePlan['assignments'][number]>();
  for (const a of Array.isArray(raw.assignments) ? raw.assignments : []) {
    const u = unit(a?.unitType);
    const i = incId(a?.incidentId);
    const f = facId(a?.fromFacilityId);
    if (!u || !i || !f) {
      notes.push(
        `dropped assignment ${a?.count ?? '?'}× ${a?.unitType} ${a?.fromFacilityId} → ${a?.incidentId}: ${!u ? 'invalid unit type' : !i ? 'unknown incident' : 'unknown facility'}`,
      );
      continue;
    }
    const count = Math.max(1, Math.min(50, Math.round(Number(a?.count) || 1)));
    const key = `${u}|${f}|${i}`;
    const prev = merged.get(key);
    if (prev) {
      prev.count += count;
      continue;
    }
    const row = { unitType: u, count, fromFacilityId: f, incidentId: i, task: str(a?.task, 200) ?? '' };
    merged.set(key, row);
    assignments.push(row);
  }

  const routeClearing: RescuePlan['routeClearing'] = [];
  for (const rc of Array.isArray(raw.routeClearing) ? raw.routeClearing : []) {
    const u = unit(rc?.unitType);
    let name = str(rc?.roadName, 80);
    if (!u || !name) {
      notes.push(`dropped route clearing ${rc?.roadName}/${rc?.unitType}`);
      continue;
    }
    // Snap to a known street name if it is a near match ("Pine St" ↔ "Pine Street").
    const key = name.toLowerCase().replace(/\b(street|st|avenue|ave|boulevard|blvd)\b\.?/g, '').trim();
    const hit = roadNames.find((n) => n.toLowerCase().replace(/\b(street|st|avenue|ave|boulevard|blvd)\b\.?/g, '').trim() === key);
    if (hit) name = hit;
    else notes.push(`route clearing road "${name}" not in situation.roads`);
    routeClearing.push({ roadName: name, unitType: u, reason: str(rc?.reason, 200) ?? '' });
  }

  const reassess = Math.round(Number(raw.reassessInMinutes));
  const assumptions = (Array.isArray(raw.assumptions) ? raw.assumptions : []).map((x: unknown) => str(x, 200)).filter((x: unknown): x is string => !!x);
  if (!priorities.length && !assignments.length && !routeClearing.length) return { plan: null, notes };
  return {
    plan: {
      priorities,
      assignments,
      routeClearing,
      reassessInMinutes: Number.isFinite(reassess) && reassess > 0 ? Math.min(120, reassess) : 15,
      assumptions,
    },
    notes,
  };
}

let client: { key: string; ai: GoogleGenAI } | null = null;
const getAi = (key: string) => {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
};

const chatDir = (cfg: ReconConfig) => join(cfg.root, 'data', 'recon-cache', 'chat');

/** Quake hour (×10) from localTime "15:12 PDT" − minutesSinceQuake, matching the heli/plan run dirs (h150). */
function quakeHourKey(s: CopilotSituation): number {
  const m = /(\d{1,2}):(\d{2})/.exec(s.localTime ?? '');
  if (!m) return 150;
  let h = Number(m[1]) + Number(m[2]) / 60 - (Number(s.minutesSinceQuake) || 0) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 10);
}
const indexDir = (cfg: ReconConfig, s: CopilotSituation) => join(chatDir(cfg), `${s.scenarioId.replace(/[^\w-]/g, '_')}_h${quakeHourKey(s)}`);
const turnNumber = (msgs: ChatTurn[]) => msgs.filter((m) => m.role === 'user').length;

type TurnIndex = { entries: Record<string, { hash: string; question: string; simS: number }> };

async function readJson<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Same-question replay: this turn's index first, then any turn in the scenario/hour dir. */
async function findReplay(cfg: ReconConfig, req: ChatRequest): Promise<ServerChatResponse | null> {
  const dir = indexDir(cfg, req.situation);
  if (!existsSync(dir)) return null;
  const q = normaliseQuestion(req.messages[req.messages.length - 1].text);
  const n = turnNumber(req.messages);
  const files = [`turn_${n}.json`, ...(await readdir(dir)).filter((f) => /^turn_\d+\.json$/.test(f) && f !== `turn_${n}.json`)];
  for (const f of files) {
    const idx = await readJson<TurnIndex>(join(dir, f));
    const e = idx?.entries?.[q];
    if (!e) continue;
    const hit = await readJson<ServerChatResponse>(join(chatDir(cfg), `${e.hash}.json`));
    if (!hit) continue;
    // The cached plan was validated against an older situation: re-validate ids against the current one.
    const { plan, notes } = coerceChatPlan(hit.plan, req.situation);
    return { ...hit, plan, notes: [...(hit.notes ?? []), ...notes], mode: 'replay', latencyMs: 0, replayOf: e.hash };
  }
  return null;
}

const inflight = new Map<string, Promise<ServerChatResponse>>();

export async function chat(cfg: ReconConfig, req: ChatRequest, opts: { fresh?: boolean } = {}): Promise<ServerChatResponse> {
  const t0 = Date.now();
  const compact = compactSituation(req.situation);
  const situationText = `SITUATION (JSON):\n${JSON.stringify(compact)}`;
  const hash = createHash('sha256')
    .update(`${cfg.model}\n${CHAT_PROMPT_VERSION}\n${JSON.stringify(req.messages)}\n${situationText}`)
    .digest('hex')
    .slice(0, 32);
  const file = join(chatDir(cfg), `${hash}.json`);

  if (!opts.fresh && existsSync(file)) {
    const hit = await readJson<ServerChatResponse>(file);
    if (hit) return { ...hit, mode: 'replay', latencyMs: Date.now() - t0 };
  }
  if (req.mode === 'replay-only') {
    const r = await findReplay(cfg, req);
    if (r) return r;
    throw new HttpError(404, `no cached chat answer for "${req.messages[req.messages.length - 1].text.slice(0, 80)}"`);
  }
  if (!cfg.apiKey) {
    const r = await findReplay(cfg, req);
    if (r) return r;
    throw new HttpError(502, 'GEMINI_API_KEY not configured');
  }

  const existing = inflight.get(hash);
  if (existing) return existing;
  const job = (async (): Promise<ServerChatResponse> => {
    // Merge consecutive same-role turns; situation goes on the LAST user turn as a separate part.
    const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
    for (const m of req.messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push({ text: m.text });
      else contents.push({ role, parts: [{ text: m.text }] });
    }
    if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(conversation start)' }] });
    contents[contents.length - 1].parts.push({ text: situationText });

    const tg = Date.now();
    const res = await getAi(cfg.apiKey).models.generateContent({
      model: cfg.model,
      contents,
      config: {
        systemInstruction: CHAT_SYSTEM_PROMPT + '\n' + CHAT_FORMAT_NOTES,
        responseMimeType: 'application/json',
        responseSchema: chatResponseSchema,
        temperature: 0.3,
        httpOptions: { timeout: 90_000 },
      },
    });
    const text = res.text ?? '';
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`chat response is not JSON (finishReason=${res.candidates?.[0]?.finishReason ?? '?'})`);
      raw = JSON.parse(m[0]);
    }
    const reply = str(raw?.reply, 6000);
    if (!reply) throw new Error('chat response has no reply');
    const { plan, notes } = coerceChatPlan(raw?.plan, req.situation);
    const u = res.usageMetadata;
    const out: ServerChatResponse = {
      reply,
      plan,
      model: cfg.model,
      mode: 'gemini',
      latencyMs: Date.now() - tg,
      hash,
      promptVersion: CHAT_PROMPT_VERSION,
      notes,
      usage: { promptTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thoughtsTokens: u?.thoughtsTokenCount },
    };
    await mkdir(chatDir(cfg), { recursive: true });
    await writeFile(file, JSON.stringify(out, null, 1));
    // Replay index (keyed by the normalised question, per user-turn number).
    const dir = indexDir(cfg, req.situation);
    const idxFile = join(dir, `turn_${turnNumber(req.messages)}.json`);
    await mkdir(dir, { recursive: true });
    const idx = (await readJson<TurnIndex>(idxFile)) ?? { entries: {} };
    const question = req.messages[req.messages.length - 1].text;
    idx.entries[normaliseQuestion(question)] = { hash, question, simS: Math.round(req.situation.simS ?? 0) };
    await writeFile(idxFile, JSON.stringify(idx, null, 1)).catch(() => {});
    return out;
  })();
  inflight.set(hash, job);
  try {
    return await job;
  } catch (e) {
    // Demo safety: the same question answered before (offline replay) beats an error.
    const r = await findReplay(cfg, req).catch(() => null);
    if (r) return { ...r, error: `gemini failed, replayed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    throw e;
  } finally {
    inflight.delete(hash);
  }
}
