/**
 * Vite plugin: serves the Argon reconstruction API from the dev (and preview) server.
 *   GET  /api/health       → { model, hasKey, promptVersion }
 *   POST /api/reconstruct  → ReconstructionResult (ReconstructionRequest body, up to ~64 MB)
 *   GET  /api/replay?scenario=&hour= → { chunks: [{ result, chunk }] } cached run (deterministic air=replay)
 * The API key stays server-side (read via loadEnv without a VITE_ prefix; never sent to the client).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { HttpError, listReplay, reconstruct, validateRequest, type ReconConfig } from './reconstruct';
import { PROMPT_VERSION } from './prompt';

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
      sendJson(res, 200, { model: cfg.model, hasKey: !!cfg.apiKey, promptVersion: PROMPT_VERSION });
      return;
    }
    if (url === '/api/replay' && req.method === 'GET') {
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      listReplay(cfg, q.get('scenario') ?? '', Number(q.get('hour') ?? 12))
        .then((chunks) => sendJson(res, 200, { chunks }))
        .catch((err: unknown) => sendJson(res, 500, { error: String((err as Error)?.message ?? err) }));
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
          `[argon] chunk ${r.chunkIndex}: ${result.mode} ${r.frames.length} frames, ${result.buildings.length}/${r.buildings.length} bldgs, ${result.roads.length} roads, ${result.crowds.length} crowds in ${Date.now() - t0} ms` +
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
