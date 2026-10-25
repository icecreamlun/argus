/**
 * Vite plugin: serves the Argon reconstruction API from the dev (and preview) server.
 *   GET  /api/health       → { model, hasKey, promptVersion }
 *   POST /api/reconstruct  → ReconstructionResult (ReconstructionRequest body, up to ~64 MB)
 *   GET  /api/replay?scenario=&hour=[&source=drone] → { chunks: [{ result, chunk }] } cached run (deterministic air=replay)
 *   POST /api/plan         → DronePlan (PlanRequest body; M4 Argon drone planner, text-only; 502 {error} on failure)
 *   POST /api/chat         → ChatResponse (ChatRequest body; M5 Argus Copilot; 404 replay miss, 502 {error} on failure)
 *   GET|POST /api/m4run?scenario=&hour= → M4 run record (plans + commander decisions + sim times) for air=replay.
 *          Stored next to the heli run index (runs/<scenario>_h<h×10>/m4.json), so a new heli run (chunk 0) clears it.
 * The API key stays server-side (read via loadEnv without a VITE_ prefix; never sent to the client).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { HttpError, listReplay, reconstruct, validateRequest, type ReconConfig } from './reconstruct';
import { DRONE_PROMPT_VERSION, PROMPT_VERSION } from './prompt';
import { plan, validatePlanRequest } from './plan';
import { PLAN_PROMPT_VERSION } from './planPrompt';
import { chat, validateChatRequest } from './chat';
import { CHAT_PROMPT_VERSION } from './chatPrompt';

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new HttpError(413, `body too large (> ${MAX_BODY} bytes)`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(s);
}

export function argusReconPlugin(cfg: ReconConfig): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { model: cfg.model, hasKey: !!cfg.apiKey, promptVersion: PROMPT_VERSION, dronePromptVersion: DRONE_PROMPT_VERSION, planPromptVersion: PLAN_PROMPT_VERSION, chatPromptVersion: CHAT_PROMPT_VERSION });
      return;
    }
    if (url === '/api/replay' && req.method === 'GET') {
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      listReplay(cfg, q.get('scenario') ?? '', Number(q.get('hour') ?? 12), q.get('source') === 'drone' ? 'drone' : 'heli')
        .then((chunks) => sendJson(res, 200, { chunks }))
        .catch((err: unknown) => sendJson(res, 500, { error: String((err as Error)?.message ?? err) }));
      return;
    }
    if (url === '/api/m4run') {
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const sc = (q.get('scenario') ?? '').replace(/[^\w-]/g, '_');
      const file = join(cfg.root, 'data', 'recon-cache', 'runs', `${sc}_h${Math.round(Number(q.get('hour') ?? 12) * 10)}`, 'm4.json');
      (async () => {
        if (req.method === 'GET') {
          sendJson(res, 200, existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { waves: [] });
          return;
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET/POST only' });
        const body = JSON.parse(await readBody(req)) as unknown;
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, JSON.stringify(body, null, 1));
        sendJson(res, 200, { ok: true });
      })().catch((err: unknown) => sendJson(res, 500, { error: String((err as Error)?.message ?? err) }));
      return;
    }
    if (url === '/api/chat') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      const t0 = Date.now();
      (async () => {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, 'invalid JSON body');
        }
        const r = validateChatRequest(body);
        const out = await chat(cfg, r, { fresh: /[?&]fresh=1\b/.test(req.url ?? '') });
        console.log(
          `[argon] chat turn ${r.messages.filter((m) => m.role === 'user').length}: ${out.mode} ${out.plan ? `${out.plan.assignments.length} assignments` : 'no plan'} in ${Date.now() - t0} ms` +
            (out.notes?.length ? ` [${out.notes.join('; ')}]` : ''),
        );
        sendJson(res, 200, out);
      })().catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 502;
        const msg = String((err as Error)?.message ?? err).slice(0, 1000);
        console.warn(`[argon] /api/chat ${status}: ${msg}`);
        if (!res.headersSent) sendJson(res, status, { error: msg });
      });
      return;
    }
    if (url === '/api/plan') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      const t0 = Date.now();
      (async () => {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, 'invalid JSON body');
        }
        const r = validatePlanRequest(body);
        const p = await plan(cfg, r, { fresh: /[?&]fresh=1\b/.test(req.url ?? '') });
        console.log(
          `[argon] plan wave ${r.wave}: ${p.mode} dispatch=${p.dispatch} ${p.missions.map((m) => `${m.droneId}→${m.targetBuildingIds.join('+')}`).join(' ')} (${r.candidates.length} cands) in ${Date.now() - t0} ms` +
            (p.notes?.length ? ` [${p.notes.join('; ')}]` : ''),
        );
        sendJson(res, 200, p);
      })().catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 502;
        const msg = String((err as Error)?.message ?? err).slice(0, 1000);
        console.warn(`[argon] /api/plan ${status}: ${msg}`);
        if (!res.headersSent) sendJson(res, status, { error: msg });
      });
      return;
    }
    if (url === '/api/reconstruct') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      const t0 = Date.now();
      (async () => {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, 'invalid JSON body');
        }
        const r = validateRequest(body);
        // ?fresh=1 (debug): skip the replay-cache read, always call Gemini (result still cached).
        const result = await reconstruct(cfg, r, { fresh: /[?&]fresh=1\b/.test(req.url ?? '') });
        console.log(
          `[argon] ${r.source === 'drone' ? `drone ${r.droneId ?? '?'} ${r.missionId ?? ''} ` : ''}chunk ${r.chunkIndex}: ${result.mode} ${r.frames.length} frames, ${result.buildings.length}/${r.buildings.length} bldgs, ${result.roads.length} roads, ${result.crowds.length} crowds in ${Date.now() - t0} ms` +
            (result.usage ? ` (tokens in ${result.usage.promptTokens} out ${result.usage.outputTokens})` : ''),
        );
        sendJson(res, 200, result);
      })().catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 502;
        const msg = String((err as Error)?.message ?? err).slice(0, 1000);
        console.warn(`[argon] /api/reconstruct ${status}: ${msg}`);
        if (!res.headersSent) sendJson(res, status, { error: msg });
      });
      return;
    }
    next();
  };
  return {
    name: 'argus-recon-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
