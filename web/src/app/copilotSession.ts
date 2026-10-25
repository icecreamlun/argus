/**
 * M5 Argus Copilot session: chat drawer ⇄ situation builder ⇄ /api/chat (gemini-4-argon) ⇄ road router ⇄ 3D rescue layer.
 *
 * ask(text): echo the user message → thinking → buildSituation() at the current sim time (Argon-verified +
 * blind model risk, never truth) → POST /api/chat (mode from ?chat= / ?air=: replay → 'replay-only', mock →
 * offline heuristic, else 'auto') → on any failure createMockChatResponse → assistant message → if a plan:
 * route every assignment on the road graph (helicopters by air) and auto-show it on the map (planState 'shown').
 * Units move only after dispatch(messageId).
 */
import type {
  AppContext,
  CameraPresetId,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CopilotSituation,
  QuakeResult,
  ReconHandle,
  RescueLayerHandle,
  RoutedAssignment,
  RouterHandle,
  ScanHandle,
  UiHandle,
} from '../contracts';
import { buildSituation } from '../rescue/situation';
import { routePlan } from '../rescue/routePlan';
import { createMockChatResponse } from '../rescue/chatMock';

export type CopilotMode = 'auto' | 'replay-only' | 'mock';

export interface CopilotLogEntry {
  question: string;
  turn: number;
  mode: ChatResponse['mode'];
  requestedMode: CopilotMode;
  model: string;
  latencyMs: number;
  /** Client-measured wall time from ask to answer (ms). */
  wallMs: number;
  replyChars: number;
  priorities: number;
  assignments: number;
  units: number;
  routes: number;
  unreachable: number;
  /** Plan ids that do not exist in the situation (should be 0: the server validates). */
  invalidIds: string[];
  notes: string[];
  error?: string;
}

export interface CopilotSessionDeps {
  ctx: AppContext;
  ui: UiHandle;
  recon: ReconHandle;
  scan: ScanHandle;
  router: RouterHandle;
  rescue: RescueLayerHandle;
  flyTo(pose: CameraPresetId | { position: [number, number, number]; target: [number, number, number] }, duration?: number): void;
  result(): QuakeResult | null;
  simNow(): number;
}

export interface CopilotSession {
  readonly mode: CopilotMode;
  readonly messages: readonly ChatMessage[];
  readonly busy: boolean;
  readonly log: readonly CopilotLogEntry[];
  /** Routed assignments of the plan currently on the map. */
  readonly routed: readonly RoutedAssignment[];
  /** id of the message whose plan is on the map (null = none). */
  readonly shownId: string | null;
  ask(text: string): Promise<ChatMessage | null>;
  showPlan(messageId: string, opts?: { fly?: boolean }): boolean;
  dispatch(messageId: string): boolean;
  highlight(incidentId: string | null): void;
  /** Drawer opened/closed: refresh the header strip with a fresh situation. */
  toggled(open: boolean): void;
  /** Fresh situation at the current sim time (null without a quake). Also used by server/test-chat.mjs. */
  situation(): CopilotSituation | null;
  reset(): void;
}

const MAX_TURNS = 8;
const TIMEOUT_MS = 75_000;

interface Entry {
  situation: CopilotSituation | null;
  routed?: RoutedAssignment[];
}

export function createCopilotSession(deps: CopilotSessionDeps, opts: { mode: CopilotMode }): CopilotSession {
  const { ctx, ui, recon, scan, router, rescue } = deps;
  const mode = opts.mode;
  let messages: ChatMessage[] = [];
  const entries = new Map<string, Entry>();
  const log: CopilotLogEntry[] = [];
  let busy = false;
  let gen = 0;
  let seq = 0;
  let shownId: string | null = null;
  let routed: RoutedAssignment[] = [];
  let headerSit: CopilotSituation | null = null;
  let abort: AbortController | null = null;

  const newId = (p: string) => `${p}${Date.now().toString(36)}-${++seq}`;
  const push = () => ui.copilotSetMessages?.(messages.slice(), headerSit);

  function situation(): CopilotSituation | null {
    const result = deps.result();
    if (!result) return null;
    try {
      return buildSituation({
        city: ctx.city,
        result,
        recon,
        simS: deps.simNow(),
        router,
        scannedFraction: scan.scannedFraction(),
        scanned: (i) => scan.isScanned(i),
      });
    } catch (e) {
      console.warn('[copilot] situation failed', e);
      return null;
    }
  }

  async function fetchChat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse & { notes?: string[] }> {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg += `: ${j.error}`;
      } catch {
        /* not json */
      }
      const err = new Error(msg) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function setPlanState(id: string, state: ChatMessage['planState']) {
    messages = messages.map((m) => {
      if (m.id === id) return { ...m, planState: state };
      // Only one plan is on the map at a time: a previously shown (not dispatched) plan goes back to 'none'.
      if (state !== 'none' && m.planState === 'shown' && m.id !== id) return { ...m, planState: 'none' };
      return m;
    });
  }

  function frame(bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null | undefined) {
    if (!bounds) return;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const ext = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    const d = Math.min(2400, Math.max(520, ext * 1.15));
    const gy = ctx.terrain.heightAt(cx, cz);
    // Oblique from the south-east (like the overview preset, steeper); the target is nudged east so the plan
    // sits in the part of the screen the drawer leaves free.
    const tx = cx + d * 0.12;
    deps.flyTo({ position: [tx + d * 0.36, gy + d * 0.86, cz + d * 0.55], target: [tx, gy, cz] }, 2.2);
  }

  function routedFor(id: string): RoutedAssignment[] | null {
    const m = messages.find((x) => x.id === id);
    const e = entries.get(id);
    if (!m?.plan || !e?.situation) return null;
    if (!e.routed) {
      router.setRoadStatus(e.situation.roads);
      e.routed = routePlan(m.plan, e.situation, router);
    }
    return e.routed;
  }

  function showPlan(id: string, o: { fly?: boolean } = {}): boolean {
    const m = messages.find((x) => x.id === id);
    const e = entries.get(id);
    const r = routedFor(id);
    if (!m?.plan || !e?.situation || !r) return false;
    if (shownId !== id || !rescue.object.visible) {
      rescue.show(m.plan, e.situation, r);
      shownId = id;
      routed = r;
      document.documentElement.classList.add('ag-has-rescue');
    }
    if (o.fly !== false) frame(rescue.object.userData.bounds);
    if (m.planState !== 'dispatched') setPlanState(id, 'shown');
    push();
    return true;
  }

  function dispatch(id: string): boolean {
    if (shownId !== id && !showPlan(id, { fly: false })) return false;
    rescue.dispatch();
    setPlanState(id, 'dispatched');
    push();
    return true;
  }

  function validate(plan: ChatResponse['plan'], sit: CopilotSituation): string[] {
    if (!plan) return [];
    const inc = new Set(sit.incidents.map((i) => i.id));
    const fac = new Set(sit.facilities.map((f) => f.id));
    const bad: string[] = [];
    for (const p of plan.priorities) if (!inc.has(p.incidentId)) bad.push(p.incidentId);
    for (const a of plan.assignments) {
      if (!inc.has(a.incidentId)) bad.push(a.incidentId);
      if (!fac.has(a.fromFacilityId)) bad.push(a.fromFacilityId);
    }
    return [...new Set(bad)];
  }

  async function ask(text: string): Promise<ChatMessage | null> {
    const q = text.trim();
    if (!q || busy) return null;
    const myGen = ++gen;
    busy = true;
    const t0 = performance.now();
    const simS = Math.round(deps.simNow());
    const userMsg: ChatMessage = { id: newId('u'), role: 'user', text: q, at: simS };
    messages = [...messages, userMsg];
    push();
    ui.copilotSetThinking?.(true);
    // Let the echo + thinking bubble paint before the (synchronous, ~20-40 ms) situation build.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (myGen !== gen) return null;

    const sit = situation();
    headerSit = sit ?? headerSit;
    let resp: ChatResponse & { notes?: string[] };
    let usedMode: CopilotMode = mode;
    if (!sit) {
      resp = {
        reply: 'No earthquake is active yet — trigger a scenario (or load one) and let AIR 1 scan the area, then ask again.',
        plan: null,
        model: 'argus',
        mode: 'mock',
        latencyMs: 0,
      };
    } else {
      const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, text: m.text }));
      const req: ChatRequest = { messages: turns.slice(-MAX_TURNS), situation: sit, mode: mode === 'replay-only' ? 'replay-only' : 'auto' };
      if (mode === 'mock') {
        resp = createMockChatResponse(req);
        // A short, visible "thinking" beat so the UI flow matches the live one.
        await new Promise((r) => setTimeout(r, 600));
      } else {
        abort = new AbortController();
        const timer = window.setTimeout(() => abort?.abort(), TIMEOUT_MS);
        try {
          resp = await fetchChat(req, abort.signal);
        } catch (e) {
          const status = (e as { status?: number }).status;
          let fallbackErr = String((e as Error)?.message ?? e);
          resp = null as unknown as ChatResponse;
          // Replay miss (new question in an offline demo) → try live once before the heuristic.
          if (mode === 'replay-only' && status === 404 && myGen === gen) {
            try {
              usedMode = 'auto';
              resp = await fetchChat({ ...req, mode: 'auto' }, abort.signal);
            } catch (e2) {
              fallbackErr = String((e2 as Error)?.message ?? e2);
            }
          }
          if (!resp) {
            console.warn('[copilot] /api/chat failed → mock:', fallbackErr);
            resp = { ...createMockChatResponse(req), error: fallbackErr };
          }
        } finally {
          window.clearTimeout(timer);
          abort = null;
        }
      }
    }
    if (myGen !== gen) return null;

    const wallMs = Math.round(performance.now() - t0);
    const aMsg: ChatMessage = {
      id: newId('a'),
      role: 'assistant',
      text: resp.reply || '(empty reply)',
      at: Math.round(deps.simNow()),
      plan: resp.plan ?? null,
      mode: resp.mode,
      latencyMs: resp.mode === 'replay' ? resp.latencyMs : resp.mode === 'mock' ? wallMs : resp.latencyMs || wallMs,
      planState: 'none',
    };
    entries.set(aMsg.id, { situation: sit });
    messages = [...messages, aMsg];
    busy = false;
    ui.copilotSetThinking?.(false);

    let r: RoutedAssignment[] = [];
    if (aMsg.plan && sit) {
      try {
        r = routedFor(aMsg.id) ?? [];
      } catch (e) {
        console.warn('[copilot] routing failed', e);
      }
    }
    // Groups as the layer draws them (facility, incident, mode, unit type).
    const groups = new Map<string, RoutedAssignment>();
    for (const x of r) groups.set(`${x.fromFacilityId}|${x.incidentId}|${x.route.mode}|${x.unitType}`, x);
    log.push({
      question: q,
      turn: messages.filter((m) => m.role === 'user').length,
      mode: resp.mode,
      requestedMode: usedMode,
      model: resp.model,
      latencyMs: aMsg.latencyMs ?? 0,
      wallMs,
      replyChars: aMsg.text.length,
      priorities: aMsg.plan?.priorities.length ?? 0,
      assignments: aMsg.plan?.assignments.length ?? 0,
      units: aMsg.plan?.assignments.reduce((s, a) => s + a.count, 0) ?? 0,
      routes: groups.size,
      unreachable: [...groups.values()].filter((x) => !x.route.reachable).length,
      invalidIds: sit ? validate(aMsg.plan ?? null, sit) : [],
      notes: resp.notes ?? [],
      error: resp.error,
    });

    if (aMsg.plan && r.length) showPlan(aMsg.id);
    else push();
    return messages.find((m) => m.id === aMsg.id) ?? aMsg;
  }

  function reset() {
    gen++;
    abort?.abort();
    abort = null;
    busy = false;
    messages = [];
    entries.clear();
    shownId = null;
    routed = [];
    headerSit = null;
    rescue.clear();
    document.documentElement.classList.remove('ag-has-rescue');
    ui.copilotSetThinking?.(false);
    ui.copilotSetMessages?.([], null);
  }

  return {
    mode,
    get messages() {
      return messages;
    },
    get busy() {
      return busy;
    },
    log,
    get routed() {
      return routed;
    },
    get shownId() {
      return shownId;
    },
    ask,
    showPlan,
    dispatch,
    highlight(id) {
      rescue.setHighlight(id);
    },
    toggled(open) {
      if (!open || busy) return;
      const s = situation();
      if (s) {
        headerSit = s;
        push();
      }
    },
    situation,
    reset,
  };
}
