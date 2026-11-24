// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient, gatewayTarget } from '../src/client/gateway.js';
import { jsonResponse } from './helpers.js';

const SECRET = 'app-secret';
const ORIGIN = 'http://127.0.0.1:6777';
const proof = (origin = ORIGIN, secret = SECRET): string => createHmac('sha256', secret).update(origin).digest('hex');
const env = (over: Record<string, string | undefined> = {}) => ({
  KIROCREW_APP_NAME: 'kiro-code-reviewer',
  KIROCREW_GATEWAY_ORIGIN: ORIGIN,
  KIROCREW_GATEWAY_ORIGIN_PROOF: proof(),
  KIROCREW_PROXY_SECRET: SECRET,
  ...over,
});

describe('gatewayTarget', () => {
  it('accepts the origin the gateway minted', () => {
    expect(gatewayTarget(env())).toEqual({ name: 'kiro-code-reviewer', origin: ORIGIN, port: '6777', secret: SECRET });
  });
  it.each([
    ['no proof', { KIROCREW_GATEWAY_ORIGIN_PROOF: undefined }],
    ['a proof for another origin', { KIROCREW_GATEWAY_ORIGIN_PROOF: proof('http://127.0.0.1:1') }],
    ['a proof under another secret', { KIROCREW_GATEWAY_ORIGIN_PROOF: proof(ORIGIN, 'other') }],
    ['no secret', { KIROCREW_PROXY_SECRET: undefined }],
    ['no app name', { KIROCREW_APP_NAME: undefined }],
    ['a bad app name', { KIROCREW_APP_NAME: '../x' }],
  ])('refuses %s', (_n, over) => {
    expect(() => gatewayTarget(env(over))).toThrow(expect.objectContaining({ code: 'KIRO_GATEWAY_UNAVAILABLE' }));
  });
  it('without an injected origin, uses loopback at KIROCREW_PORT, then dashboard.url, then 5476', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kcr-gw-'));
    try {
      const base = {
        KIROCREW_GATEWAY_ORIGIN: undefined,
        KIROCREW_GATEWAY_ORIGIN_PROOF: undefined,
        KIROCREW_HOME: home,
      };
      expect(gatewayTarget(env(base)).origin).toBe('http://127.0.0.1:5476');
      writeFileSync(path.join(home, 'config.json'), JSON.stringify({ dashboard: { url: 'http://127.0.0.1:6001' } }));
      expect(gatewayTarget(env(base)).origin).toBe('http://127.0.0.1:6001');
      expect(gatewayTarget(env({ ...base, KIROCREW_PORT: '7002' }))).toMatchObject({
        origin: 'http://127.0.0.1:7002',
        port: '7002',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it.each(['https://127.0.0.1:6777', 'http://evil.example:6777', 'http://127.0.0.1', 'http://127.0.0.1:6777/x'])(
    'refuses the non-loopback or odd origin %s even with a valid proof',
    (origin) => {
      expect(() =>
        gatewayTarget(env({ KIROCREW_GATEWAY_ORIGIN: origin, KIROCREW_GATEWAY_ORIGIN_PROOF: proof(origin) })),
      ).toThrow(expect.objectContaining({ code: 'KIRO_GATEWAY_UNAVAILABLE' }));
    },
  );
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function gateway(answers: Array<(s: Seen) => Response>) {
  const seen: Seen[] = [];
  const doFetch = vi.fn<typeof fetch>(async (url, init) => {
    const s: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(s);
    const next = answers.shift();
    if (!next) throw new Error('unexpected request');
    return next(s);
  });
  return { seen, client: new GatewayClient(gatewayTarget(env()), doFetch) };
}
const token =
  (t = 'tok-1') =>
  () =>
    jsonResponse(200, { token: t });

describe('GatewayClient', () => {
  it('exchanges the app secret once, then posts the operation with the token cookie', async () => {
    const { seen, client } = gateway([token(), () => jsonResponse(200, { ok: 1 }), () => jsonResponse(200, { ok: 2 })]);
    expect(await client.call('GetCodeReview', { reviewId: 'r' })).toEqual({ ok: 1 });
    expect(await client.call('GetCodeReview', { reviewId: 'r' })).toEqual({ ok: 2 });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${ORIGIN}/api/apps/kiro-code-reviewer/token`,
      `POST ${ORIGIN}/api/apps/kiro-code-reviewer/kiro/GetCodeReview`,
      `POST ${ORIGIN}/api/apps/kiro-code-reviewer/kiro/GetCodeReview`,
    ]);
    expect(seen[0].headers['X-App-Secret']).toBe(SECRET);
    expect(seen[1].headers.Cookie).toBe('mc_token_6777=tok-1');
    expect(seen[1].headers).not.toHaveProperty('X-App-Secret');
    expect(JSON.parse(seen[1].body ?? '')).toEqual({ reviewId: 'r' });
  });

  it('exchanges again once when the gateway refuses the token, and not for a hook error', async () => {
    const refusal = () => jsonResponse(401, { error: 'invalid token' });
    const { seen, client } = gateway([token('a'), refusal, token('b'), () => jsonResponse(200, { ok: true })]);
    expect(await client.call('GetCodeReview', {})).toEqual({ ok: true });
    expect(seen[3].headers.Cookie).toBe('mc_token_6777=b');

    const hook = gateway([
      token(),
      () => jsonResponse(401, { error: { code: 'KIRO_SIGN_IN_REQUIRED', message: 'Not signed in to Kiro.' } }),
    ]);
    await expect(hook.client.call('GetCodeReview', {})).rejects.toMatchObject({ code: 'KIRO_SIGN_IN_REQUIRED' });
    expect(hook.seen).toHaveLength(2);
  });

  it('gives up after one renewal', async () => {
    const refusal = () => jsonResponse(403, { error: 'no' });
    const { client } = gateway([token(), refusal, token(), refusal]);
    await expect(client.call('GetCodeReview', {})).rejects.toMatchObject({ code: 'KIRO_GATEWAY_UNAVAILABLE' });
  });

  it('turns a BFF error into a SERVICE_ERROR with its type and status', async () => {
    const { client } = gateway([
      token(),
      () => jsonResponse(404, { error: { code: 'ResourceNotFoundException', message: 'no such review' } }),
    ]);
    await expect(client.call('GetCodeReview', {})).rejects.toMatchObject({
      code: 'SERVICE_ERROR',
      details: { httpStatus: 404, serviceCode: 'ResourceNotFoundException' },
    });
  });

  it('never sends the secret anywhere but the token route, and refuses odd operation names', async () => {
    const { seen, client } = gateway([token(), () => jsonResponse(200, {})]);
    await client.call('GetCodeReview', {});
    // The secret appears in the token exchange and in nothing else the client sends.
    const carrying = seen.filter((s) => JSON.stringify(s).includes(SECRET));
    expect(carrying.map((s) => s.url)).toEqual([`${ORIGIN}/api/apps/kiro-code-reviewer/token`]);
    await expect(client.call('../x', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reports a failed token exchange and an unreachable gateway without leaking values', async () => {
    const down = new GatewayClient(
      gatewayTarget(env()),
      vi.fn<typeof fetch>(async () => {
        throw new Error(`connect refused ${SECRET}`);
      }),
    );
    const err = await down.call('GetCodeReview', {}).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'KIRO_GATEWAY_UNAVAILABLE' });
    expect((err as Error).message).not.toContain(SECRET);
    const denied = gateway([() => jsonResponse(403, { error: 'invalid secret' })]);
    await expect(denied.client.call('GetCodeReview', {})).rejects.toMatchObject({ code: 'KIRO_GATEWAY_UNAVAILABLE' });
  });

  it('reads the sign-in status', async () => {
    const { seen, client } = gateway([token(), () => jsonResponse(200, { signedIn: true, idp: 'BuilderId' })]);
    expect(await client.signInStatus()).toEqual({ signedIn: true, idp: 'BuilderId' });
    expect(seen[1].method).toBe('GET');
    expect(seen[1].url).toBe(`${ORIGIN}/api/apps/kiro-code-reviewer/kiro/status`);
  });
});
