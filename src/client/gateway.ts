// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../errors.js';

/**
 * Client for the in-gateway Kiro BFF routes (`backend/routes.py`), used by the page backend.
 * It signs in to the gateway with the app secret the gateway gave this process, then posts the
 * operation. The Kiro sign-in itself never reaches this process: the gateway attaches it.
 * Secrets, tokens and request bodies are never logged or put in an error message.
 */

export const GATEWAY_TIMEOUT_MS = 30_000;
const DEFAULT_GATEWAY_PORT = '5476';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPERATION_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

type Env = Record<string, string | undefined>;

export interface GatewayTarget {
  name: string;
  origin: string;
  port: string;
  secret: string;
}

const unavailable = (why: string): ToolError =>
  new ToolError('KIRO_GATEWAY_UNAVAILABLE', `The Kiro Crew gateway is not reachable for Kiro calls: ${why}.`);

/** The gateway's port: `KIROCREW_PORT`, else the port of `dashboard.url` in Crew's config.json, else 5476. */
function gatewayPort(env: Env): string {
  if (env.KIROCREW_PORT && /^\d{1,5}$/.test(env.KIROCREW_PORT)) return env.KIROCREW_PORT;
  const home = env.KIROCREW_HOME || path.join(os.homedir(), '.kiro', 'crew');
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as { dashboard?: { url?: unknown } };
    const url = raw.dashboard?.url;
    if (typeof url === 'string' && url) {
      const port = new URL(url.includes('://') ? url : `http://${url}`).port;
      if (port) return port;
    }
  } catch {
    // No config, or no dashboard.url: Crew uses its default port.
  }
  return DEFAULT_GATEWAY_PORT;
}

/**
 * The gateway this page backend runs under. Crew gives the backend its app secret and name; the
 * gateway is on loopback at its dashboard port. A gateway that injects `KIROCREW_GATEWAY_ORIGIN`
 * must also inject `KIROCREW_GATEWAY_ORIGIN_PROOF` (`HMAC-SHA256(app secret, origin)` in hex), and
 * the origin must be a plain loopback http origin, so a spoofed value cannot send the secret away.
 */
export function gatewayTarget(env: Env): GatewayTarget {
  const name = env.KIROCREW_APP_NAME ?? '';
  const injected = env.KIROCREW_GATEWAY_ORIGIN ?? '';
  const origin = injected || `http://127.0.0.1:${gatewayPort(env)}`;
  const proof = env.KIROCREW_GATEWAY_ORIGIN_PROOF ?? '';
  const secret = env.KIROCREW_PROXY_SECRET ?? '';
  if (!NAME_RE.test(name)) throw unavailable('KIROCREW_APP_NAME is missing');
  if (!secret) throw unavailable('the app secret was not provided');
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw unavailable('the gateway origin is not a URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || !url.port || url.pathname !== '/' || url.search || url.hash) {
    throw unavailable('the gateway origin is not a loopback http origin');
  }
  if (injected) {
    const expected = Buffer.from(createHmac('sha256', secret).update(injected).digest('hex'));
    const given = Buffer.from(proof);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw unavailable('the gateway origin proof does not match');
    }
  }
  return { name, origin: url.origin, port: url.port, secret };
}

/** The gateway's own `{"error": "..."}` refusals; the hook's errors are `{"error": {code, message}}`. */
function isGatewayRefusal(status: number, body: unknown): boolean {
  if (status !== 401 && status !== 403) return false;
  const e = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return !(e !== null && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string');
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (text.length > MAX_REPLY_BYTES) return null;
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

export class GatewayClient {
  private token: string | undefined;

  constructor(
    private readonly target: GatewayTarget,
    private readonly doFetch: typeof fetch,
  ) {}

  private async exchange(): Promise<string> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.target.origin}/api/apps/${this.target.name}/token`, {
        method: 'POST',
        headers: { 'X-App-Secret': this.target.secret },
        redirect: 'error',
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw unavailable('the gateway could not be reached');
    }
    const body = (await readJson(res)) as { token?: unknown } | null;
    if (!res.ok || typeof body?.token !== 'string' || body.token === '') {
      throw unavailable(`the gateway refused the app sign-in (HTTP ${res.status})`);
    }
    return body.token;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const token = (this.token ??= await this.exchange());
    let res: Response;
    try {
      res = await this.doFetch(`${this.target.origin}/api/apps/${this.target.name}${path}`, {
        method,
        headers: {
          Cookie: `mc_token_${this.target.port}=${token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw unavailable('the gateway could not be reached');
    }
    return { status: res.status, body: await readJson(res) };
  }

  /** Sends one request; a gateway-level 401/403 means the app token expired, so exchange once more. */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let out = await this.send(method, path, payload);
    if (isGatewayRefusal(out.status, out.body)) {
      this.token = undefined;
      out = await this.send(method, path, payload);
    }
    return out;
  }

  /** Calls one BFF operation through the hook and returns its output. */
  async call<T = unknown>(operation: string, payload: Record<string, unknown>): Promise<T> {
    if (!OPERATION_RE.test(operation)) throw new ToolError('VALIDATION_ERROR', 'Invalid Kiro operation name.');
    const { status, body } = await this.request('POST', `/kiro/${operation}`, payload);
    if (status >= 200 && status < 300) return body as T;
    const e = (body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined) as
      { code?: unknown; message?: unknown } | undefined;
    const code = typeof e?.code === 'string' ? e.code : 'UNKNOWN';
    const message = typeof e?.message === 'string' ? e.message.slice(0, 300) : `HTTP ${status}`;
    if (code.startsWith('KIRO_SIGN_IN_')) throw new ToolError(code, message);
    if (isGatewayRefusal(status, body)) throw unavailable(`the gateway refused the app token (HTTP ${status})`);
    // Shaped like callApi's errors so statusFor and the page treat both transports alike.
    throw new ToolError('SERVICE_ERROR', `${code}: ${message}`, { httpStatus: status, serviceCode: code });
  }

  /** Whether the gateway holds a Kiro sign-in; makes no BFF call. */
  async signInStatus(): Promise<{ signedIn: boolean; idp?: string; hint?: string }> {
    const { status, body } = await this.request('GET', '/kiro/status');
    if (status !== 200 || body === null || typeof body !== 'object') {
      throw unavailable(`the status route answered HTTP ${status}`);
    }
    const b = body as { signedIn?: unknown; idp?: unknown; hint?: unknown };
    return {
      signedIn: b.signedIn === true,
      ...(typeof b.idp === 'string' ? { idp: b.idp } : {}),
      ...(typeof b.hint === 'string' ? { hint: b.hint } : {}),
    };
  }
}

const clientsByEnv = new WeakMap<object, GatewayClient>();

/** One client per env object, so the app token is exchanged once and reused across calls. */
export function gatewayClientFor(env: Env, doFetch: typeof fetch = fetch): GatewayClient {
  let client = clientsByEnv.get(env);
  if (!client) {
    client = new GatewayClient(gatewayTarget(env), doFetch);
    clientsByEnv.set(env, client);
  }
  return client;
}
