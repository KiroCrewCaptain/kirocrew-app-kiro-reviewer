// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callApi } from '../client/http.js';
import type { GetReviewResponse } from '../client/types.js';
import { TERMINAL_STATUSES } from '../client/types.js';
import {
  apiKeyStatus,
  loadKiroRegion,
  loadServiceConfig,
  loadTransport,
  removeApiKey,
  resolveDataDir,
  saveApiKey,
  saveKiroRegion,
} from '../config.js';
import { AGENT_TOOLS_ROUTE, callAgentTool } from '../tools/agentTools.js';
import { ToolError } from '../errors.js';
import { recordReview } from '../history.js';
import { awaitingContext, displayOutcome } from '../render.js';
import { defaultClock, FINDING_ID_RE, REVIEW_ID_RE, type ToolDeps } from '../tools/common.js';
import { suppressTool } from '../tools/suppress.js';
import { gatewayClientFor } from '../client/gateway.js';
import {
  clearLocalUnsuppress,
  getSent,
  listReviews,
  parseFeedback,
  putFeedback,
  unsuppressFinding,
  withStubFeedback,
  withStubUnsuppress,
} from './serviceApis.js';

/**
 * Backend for the Crew page (read-only review views plus suppress). Binds 127.0.0.1 only; every
 * request except /health must carry the gateway's X-KiroCrew-Proxy HMAC, so a local process that
 * is not the Crew gateway cannot use the user's Kiro credentials through it.
 */

export const MAX_BODY_BYTES = 16 * 1024;
export const PROXY_MAX_SKEW_SECONDS = 60;

/** Mirrors kiro_crew/apps/proxy_auth.py: `<ts>:<hmac_sha256(secret, "<ts>:<method>:<target>:<sha256(body)>")>`. */
export function verifyProxySignature(
  header: string | undefined,
  method: string,
  target: string,
  body: Buffer,
  secret: string,
  nowSeconds: number,
): boolean {
  if (!secret || !header) return false;
  const sep = header.indexOf(':');
  if (sep < 1) return false;
  const ts = header.slice(0, sep);
  const sig = header.slice(sep + 1);
  if (!/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(nowSeconds - Number(ts)) > PROXY_MAX_SKEW_SECONDS) return false;
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const expected = createHmac('sha256', secret).update(`${ts}:${method}:${target}:${bodyHash}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function statusFor(err: ToolError): number {
  switch (err.code) {
    case 'VALIDATION_ERROR':
    case 'LIMIT_EXCEEDED':
      return 400;
    case 'SERVICE_ERROR': {
      const s = err.details.httpStatus;
      return s === 404 || s === 400 || s === 409 ? s : 502;
    }
    case 'CONFIG_INVALID':
    case 'CONFIG_INVALID_ENDPOINT':
    case 'KIRO_SIGN_IN_REQUIRED':
    case 'KIRO_SIGN_IN_REFUSED':
      return 409;
    default:
      return 502;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonObject(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
}

async function fetchReview(deps: ToolDeps, reviewId: string, iteration?: number): Promise<GetReviewResponse> {
  const config = loadServiceConfig(deps.env);
  const res = await callApi<GetReviewResponse>(
    config,
    {
      method: 'GET',
      path: `/reviews/${reviewId}`,
      ...(iteration !== undefined ? { query: { iteration: String(iteration) } } : {}),
    },
    deps.http,
  );
  return res.body;
}

function reviewView(r: GetReviewResponse): Record<string, unknown> {
  return {
    ...r,
    iteration: { ...r.iteration, outcome: displayOutcome(r.iteration.status, r.iteration.counts.active) },
    terminal: TERMINAL_STATUSES.includes(r.iteration.status),
    awaitingContext: awaitingContext(r),
  };
}

function parseIteration(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'VALIDATION_ERROR', 'iteration must be 1..5.');
  return n;
}

/** A key from KIRO_API_KEY wins over the file, so saving or removing the file would have no effect. */
function refuseEnvKey(deps: ToolDeps): void {
  if (deps.env.KIRO_API_KEY?.trim()) {
    throw new HttpError(409, 'API_KEY_FROM_ENV', 'KIRO_API_KEY is set in the environment and overrides a saved key.');
  }
}

async function route(
  method: string,
  url: URL,
  body: Buffer,
  deps: ToolDeps,
): Promise<{ status: number; body: unknown }> {
  const dataDir = resolveDataDir(deps.env);
  const p = url.pathname;

  if (method === 'GET' && p === '/api/status') {
    try {
      if (loadTransport(deps.env) === 'kiro') {
        // The gateway holds the Kiro sign-in, so "configured" means signed in there.
        const kiro = await gatewayClientFor(deps.env, deps.http.fetch).signInStatus();
        return {
          status: 200,
          body: {
            configured: kiro.signedIn,
            transport: 'kiro',
            kiroRegion: loadKiroRegion(deps.env),
            ...(kiro.idp ? { idp: kiro.idp } : {}),
            ...(kiro.signedIn ? {} : { code: 'KIRO_SIGN_IN_REQUIRED', message: kiro.hint ?? 'Not signed in to Kiro.' }),
          },
        };
      }
      loadServiceConfig(deps.env);
      return {
        status: 200,
        body: { configured: true, kiroRegion: loadKiroRegion(deps.env) },
      };
    } catch (err) {
      if (err instanceof ToolError)
        return { status: 200, body: { configured: false, code: err.code, message: err.message } };
      throw err;
    }
  }

  if (method === 'POST' && p === `/api/${AGENT_TOOLS_ROUTE}`) {
    return { status: 200, body: await callAgentTool(jsonObject(body), deps) };
  }

  if (method === 'POST' && p === '/api/kiro-region') {
    const region = jsonObject(body).region;
    if (typeof region !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'region must be a string.');
    saveKiroRegion(region, deps.env);
    return { status: 200, body: { kiroRegion: region } };
  }

  if (method === 'GET' && p === '/api/api-key') {
    try {
      return { status: 200, body: apiKeyStatus(deps.env) };
    } catch (err) {
      if (err instanceof ToolError) return { status: 200, body: { set: false, code: err.code, message: err.message } };
      throw err;
    }
  }

  if (method === 'POST' && p === '/api/api-key') {
    const key = jsonObject(body).key;
    if (typeof key !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'key must be a string.');
    refuseEnvKey(deps);
    saveApiKey(key, deps.env);
    return { status: 200, body: apiKeyStatus(deps.env) };
  }

  if (method === 'POST' && p === '/api/api-key/remove') {
    refuseEnvKey(deps);
    removeApiKey(deps.env);
    return { status: 200, body: apiKeyStatus(deps.env) };
  }

  if (method === 'GET' && p === '/api/reviews') {
    const token = url.searchParams.get('nextToken');
    return { status: 200, body: await listReviews(deps, token ?? undefined) };
  }

  if (method === 'POST' && p === '/api/reviews/track') {
    const id = jsonObject(body).reviewId;
    if (typeof id !== 'string' || !REVIEW_ID_RE.test(id)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'reviewId must look like rev-<24 hex>.');
    }
    // Only a review the service returns is recorded.
    await fetchReview(deps, id);
    recordReview(dataDir, { reviewId: id, trackedAt: new Date(deps.clock.now()).toISOString() });
    return { status: 200, body: await listReviews(deps) };
  }

  const reviewMatch = /^\/api\/reviews\/(rev-[0-9a-f]{24})$/.exec(p);
  if (method === 'GET' && reviewMatch) {
    const review = await fetchReview(deps, reviewMatch[1], parseIteration(url.searchParams.get('iteration')));
    return { status: 200, body: reviewView(withStubUnsuppress(deps, withStubFeedback(deps, review))) };
  }

  const sentMatch = /^\/api\/reviews\/(rev-[0-9a-f]{24})\/iterations\/([1-9][0-9]{0,3})\/sent$/.exec(p);
  if (method === 'GET' && sentMatch) {
    return { status: 200, body: await getSent(deps, sentMatch[1], Number(sentMatch[2])) };
  }

  const feedbackMatch = /^\/api\/reviews\/(rev-[0-9a-f]{24})\/findings\/(f-[0-9a-f]{16})\/feedback$/.exec(p);
  if (method === 'POST' && feedbackMatch) {
    const input = parseFeedback(jsonObject(body));
    return { status: 200, body: await putFeedback(deps, feedbackMatch[1], feedbackMatch[2], input) };
  }

  const suppressMatch = /^\/api\/reviews\/(rev-[0-9a-f]{24})\/findings\/(f-[0-9a-f]{16})\/suppress$/.exec(p);
  if (method === 'POST' && suppressMatch) {
    if (!REVIEW_ID_RE.test(suppressMatch[1]) || !FINDING_ID_RE.test(suppressMatch[2])) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid review or finding id.');
    }
    const reason = jsonObject(body).reason;
    if (reason !== undefined && typeof reason !== 'string') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'reason must be a string.');
    }
    const result = (
      await suppressTool(
        { reviewId: suppressMatch[1], findingId: suppressMatch[2], ...(reason ? { reason } : {}) },
        deps,
      )
    ).structuredContent;
    clearLocalUnsuppress(deps, suppressMatch[1], suppressMatch[2]);
    return { status: 200, body: result };
  }

  const unsuppressMatch = /^\/api\/reviews\/(rev-[0-9a-f]{24})\/findings\/(f-[0-9a-f]{16})\/unsuppress$/.exec(p);
  if (method === 'POST' && unsuppressMatch) {
    return { status: 200, body: await unsuppressFinding(deps, unsuppressMatch[1], unsuppressMatch[2]) };
  }

  throw new HttpError(404, 'NOT_FOUND', 'No such route.');
}

export function createUiServer(
  deps: ToolDeps,
  secret: string,
  nowSeconds: () => number = () => Date.now() / 1000,
): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const target = req.url ?? '/';
        const method = req.method ?? 'GET';
        const url = new URL(target, 'http://127.0.0.1');
        if (method === 'GET' && url.pathname === '/health') {
          send(res, 200, { status: 'ok', app: 'kiro-code-reviewer' });
          return;
        }
        const body = await readBody(req);
        const header = req.headers['x-kirocrew-proxy'];
        if (
          !verifyProxySignature(
            typeof header === 'string' ? header : undefined,
            method,
            target,
            body,
            secret,
            nowSeconds(),
          )
        ) {
          send(res, 401, {
            error: { code: 'INVALID_PROXY_SIGNATURE', message: 'Missing or invalid gateway signature.' },
          });
          return;
        }
        const out = await route(method, url, body, deps);
        send(res, out.status, out.body);
      } catch (err) {
        if (err instanceof HttpError) {
          send(res, err.status, { error: { code: err.code, message: err.message } });
        } else if (err instanceof ToolError) {
          deps.log(`ui: ${err.code}`);
          send(res, statusFor(err), { error: { code: err.code, message: err.message, ...err.details } });
        } else {
          deps.log('ui: INTERNAL_ERROR');
          send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' } });
        }
      }
    })();
  });
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const log = (msg: string): void => {
    process.stderr.write(`[kiro-code-reviewer-ui] ${msg}\n`);
  };
  const secret = process.env.KIROCREW_PROXY_SECRET ?? '';
  const port = Number(process.env.PORT);
  if (!secret || !Number.isInteger(port) || port < 1 || port > 65535) {
    log('KIROCREW_PROXY_SECRET and PORT are required; exiting.');
    process.exit(1);
  }
  const deps: ToolDeps = { env: process.env, http: { fetch: globalThis.fetch }, clock: defaultClock, log };
  createUiServer(deps, secret).listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));
}
