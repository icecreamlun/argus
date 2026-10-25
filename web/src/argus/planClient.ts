/**
 * M4: POST /api/plan (gemini-4-argon) with the heuristic mock as fallback (server 502 / network / timeout).
 * The returned plan's missions already carry BUILDING ids (the server expands area candidates).
 */
import type { DronePlan, PlanRequest } from '../contracts';
import { createMockPlan } from './planMock';

export async function requestPlan(req: PlanRequest, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DronePlan> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
  opts.signal?.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: ctl.signal });
    const body = (await r.json().catch(() => ({}))) as DronePlan & { error?: string };
    if (!r.ok || !Array.isArray(body.missions)) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    console.warn(`[plan] /api/plan failed (${msg}); using heuristic mock plan`);
    return { ...createMockPlan(req), error: msg };
  } finally {
    clearTimeout(timer);
  }
}
