// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHistory, recordReview } from '../src/history.js';
import { createUiServer, MAX_BODY_BYTES, verifyProxySignature } from '../src/ui/backend.js';
import { ENDPOINT, finding, jsonResponse, makeDeps, review, rm, tempDir, withoutRestFake } from './helpers.js';

// Loosely typed on purpose: tests probe response fields of several shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const SECRET = 'test-secret';
const ID = 'rev-0123456789abcdef01234567';
const FID = 'f-0123456789abcdef';
let dataDir: string;
let server: Server | undefined;

beforeEach(() => {
  dataDir = tempDir('kcr-ui-');
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rm(dataDir);
});

const sign = (
  method: string,
  target: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
  secret = SECRET,
): string =>
  `${ts}:${createHmac('sha256', secret)
    .update(`${ts}:${method}:${target}:${createHash('sha256').update(body).digest('hex')}`)
    .digest('hex')}`;

async function start(fetchImpl: typeof fetch = vi.fn<typeof fetch>()) {
  const deps = makeDeps(dataDir, fetchImpl);
  server = createUiServer(deps, SECRET);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, target: string, body?: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(base + target, {
      method,
      headers: { 'content-type': 'application/json', 'x-kirocrew-proxy': sign(method, target, text), ...headers },
      ...(text ? { body: text } : {}),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return { base, call, deps };
}

describe('verifyProxySignature', () => {
  const now = 1_800_000_000;
  const good = sign('GET', '/api/x?a=1', '', now);
  it('accepts a valid fresh signature', () => {
    expect(verifyProxySignature(good, 'GET', '/api/x?a=1', Buffer.alloc(0), SECRET, now)).toBe(true);
  });
  it.each([
    ['wrong target', 'GET', '/api/y', SECRET, now],
    ['wrong method', 'POST', '/api/x?a=1', SECRET, now],
    ['wrong secret', 'GET', '/api/x?a=1', 'other', now],
    ['stale', 'GET', '/api/x?a=1', SECRET, now + 61],
    ['empty secret', 'GET', '/api/x?a=1', '', now],
  ])('rejects %s', (_n, method, target, secret, at) => {
    expect(verifyProxySignature(good, method, target, Buffer.alloc(0), secret, at)).toBe(false);
  });
  it('rejects a swapped body and malformed headers', () => {
    expect(verifyProxySignature(good, 'GET', '/api/x?a=1', Buffer.from('x'), SECRET, now)).toBe(false);
    for (const h of [undefined, '', 'abc', `${now}:`, `${now}:zz`, `x:${'a'.repeat(64)}`]) {
      expect(verifyProxySignature(h, 'GET', '/api/x?a=1', Buffer.alloc(0), SECRET, now)).toBe(false);
    }
  });
});

describe('ui backend', () => {
  it('serves /health without a signature and rejects other routes without one', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const unsigned = await fetch(`${base}/api/reviews`);
    expect(unsigned.status).toBe(401);
    const bad = await fetch(`${base}/api/reviews`, {
      headers: { 'x-kirocrew-proxy': sign('GET', '/api/reviews', '', undefined, 'wrong') },
    });
    expect(bad.status).toBe(401);
  });

  it('listens on loopback only', async () => {
    await start();
    expect((server!.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('reports status without leaking the endpoint', async () => {
    const { call } = await start();
    const r = await call('GET', '/api/status');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ configured: true, kiroRegion: 'us-east-1' });
    expect(JSON.stringify(r.json)).not.toContain(ENDPOINT);
  });

  it('with no API key, reports the missing key as a normal status', async () => {
    const f = vi.fn<typeof fetch>();
    const deps = makeDeps(dataDir, f);
    delete deps.env.KIRO_API_KEY;
    server = createUiServer(deps, SECRET);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const target = '/api/status';
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${target}`, {
      headers: { 'x-kirocrew-proxy': sign('GET', target, '') },
    });
    const json = (await res.json()) as { configured: boolean; code: string };
    expect(json.configured).toBe(false);
    expect(json.code).toBe('CONFIG_MISSING_API_KEY');
  });

  it('lists tracked reviews when the list API is off', async () => {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ serviceApis: { list: false } }));
    recordReview(dataDir, { reviewId: ID, trackedAt: '2026-11-12T12:00:00Z', headRef: 'feature' });
    const { call } = await start();
    const r = await call('GET', '/api/reviews');
    expect(r.json).toEqual({
      source: 'local',
      reviews: [
        { reviewId: ID, trackedAt: '2026-11-12T12:00:00Z', createdAt: '2026-11-12T12:00:00Z', headRef: 'feature' },
      ],
    });
  });

  it('returns a review with the displayed outcome and flags', async () => {
    const f = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        200,
        review({ outcome: 'FINDINGS', counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 } }, [finding()]),
      ),
    );
    const { call } = await start(f);
    const r = await call('GET', `/api/reviews/${ID}?iteration=1`);
    expect(r.status).toBe(200);
    expect(r.json.iteration.outcome).toBe('FINDINGS');
    expect(r.json.terminal).toBe(true);
    expect(r.json.awaitingContext).toBe(false);
    expect(r.json.findings).toHaveLength(1);
    expect(String(f.mock.calls[0][0])).toContain('iteration=1');
  });

  it('shows IN_PROGRESS for a running review regardless of the service outcome', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, review({ status: 'RUNNING', outcome: 'NO_FINDINGS' })));
    const { call } = await start(f);
    const r = await call('GET', `/api/reviews/${ID}`);
    expect(r.json.iteration.outcome).toBe('IN_PROGRESS');
    expect(r.json.terminal).toBe(false);
  });

  it('flags an awaiting context round', async () => {
    const f = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        200,
        review({
          status: 'NEEDS_CONTEXT',
          outcome: 'IN_PROGRESS',
          contextRound: {
            round: 1,
            state: 'AWAITING',
            requestedAt: null,
            expiresAt: null,
            respondedAt: null,
            maxBytes: 1,
          },
        }),
      ),
    );
    const { call } = await start(f);
    expect((await call('GET', `/api/reviews/${ID}`)).json.awaitingContext).toBe(true);
  });

  it('rejects a bad iteration and unknown routes', async () => {
    const f = vi.fn<typeof fetch>();
    const { call } = await start(f);
    expect((await call('GET', `/api/reviews/${ID}?iteration=9`)).status).toBe(400);
    expect((await call('GET', '/api/reviews/not-an-id')).status).toBe(404);
    expect((await call('DELETE', `/api/reviews/${ID}`)).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('maps a service 404 to 404 and other service errors to 502', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: 'REVIEW_NOT_FOUND', message: 'nope' } }))
      .mockResolvedValue(jsonResponse(403, { message: 'Forbidden' }));
    const { call } = await start(f);
    const a = await call('GET', `/api/reviews/${ID}`);
    expect(a.status).toBe(404);
    expect(a.json.error.code).toBe('SERVICE_ERROR');
    expect((await call('GET', `/api/reviews/${ID}`)).status).toBe(502);
  });

  it('tracks only reviews the service returns', async () => {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ serviceApis: { list: false } }));
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: 'REVIEW_NOT_FOUND' } }))
      .mockImplementation(async () => jsonResponse(200, review()));
    const { call } = await start(f);
    expect((await call('POST', '/api/reviews/track', { reviewId: ID })).status).toBe(404);
    expect(readHistory(dataDir)).toEqual([]);
    const ok = await call('POST', '/api/reviews/track', { reviewId: ID });
    expect(ok.status).toBe(200);
    expect(readHistory(dataDir).map((e) => e.reviewId)).toEqual([ID]);
    expect((await call('POST', '/api/reviews/track', { reviewId: 'rev-zz' })).status).toBe(400);
    expect((await call('POST', '/api/reviews/track', ['x'])).status).toBe(400);
  });

  it('returns what was sent for a review, and nothing for an unknown one', async () => {
    const { saveSubmission } = await import('../src/payloadStore.js');
    saveSubmission(
      dataDir,
      ID,
      1,
      { base: { ref: 'mainline', commit: 'abc' }, diff: 'diff --git a/x b/x', manifest: ['a', 'b'] },
      't',
    );
    const f = vi.fn<typeof fetch>();
    const { call } = await start(f);
    const r = await call('GET', `/api/reviews/${ID}/iterations/1/sent`);
    expect(r.status).toBe(200);
    expect(r.json.source).toBe('local');
    expect(r.json.iteration.submission).toMatchObject({ diff: 'diff --git a/x b/x', manifestCount: 2, context: [] });
    expect(r.json.iteration.submission.manifest).toBeUndefined();
    const none = await call('GET', `/api/reviews/${ID}/iterations/2/sent`);
    expect(none.json).toEqual({ source: 'none', iteration: null });
    expect((await call('GET', `/api/reviews/${ID}/iterations/0/sent`)).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('records feedback (stub), returns it on the review, and validates input', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, review({}, [finding()])));
    const { call } = await start(f);
    const saved = await call('POST', `/api/reviews/${ID}/findings/${FID}/feedback`, {
      vote: 'down',
      reason: 'too_minor',
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ vote: 'down', reason: 'too_minor' });
    const r = await call('GET', `/api/reviews/${ID}`);
    expect(r.json.findings[0].feedback).toMatchObject({ vote: 'down', reason: 'too_minor' });
    expect(
      (await call('POST', `/api/reviews/${ID}/findings/${FID}/feedback`, { vote: 'up', reason: 'wrong' })).status,
    ).toBe(400);
    expect(
      (await call('POST', `/api/reviews/${ID}/findings/${FID}/feedback`, { vote: 'down', comment: 'x'.repeat(501) }))
        .status,
    ).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('unsuppresses locally, shows the finding active, and a new suppress clears the override', async () => {
    const f = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/suppress')
        ? jsonResponse(200, { reviewId: ID, findingId: FID, suppressed: true, reason: null, createdAt: 'x' })
        : jsonResponse(
            200,
            review({ counts: { active: 0, blocking: 0, suppressed: 1, resolved: 0 } }, [
              finding({ suppressed: true, suppressionReason: 'known' }),
            ]),
          ),
    );
    const { call } = await start(f);
    expect((await call('GET', `/api/reviews/${ID}`)).json.findings[0].suppressed).toBe(true);
    const un = await call('POST', `/api/reviews/${ID}/findings/${FID}/unsuppress`, {});
    expect(un.status).toBe(200);
    expect(un.json.suppressed).toBe(false);
    const after = await call('GET', `/api/reviews/${ID}`);
    expect(after.json.findings[0]).toMatchObject({ suppressed: false, locallyUnsuppressed: true });
    expect(after.json.iteration.counts).toMatchObject({ active: 1, suppressed: 0 });
    await call('POST', `/api/reviews/${ID}/findings/${FID}/suppress`, {});
    expect((await call('GET', `/api/reviews/${ID}`)).json.findings[0].suppressed).toBe(true);
  });

  it('suppresses a finding with a reason', async () => {
    const f = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { reviewId: ID, findingId: FID, suppressed: true, reason: 'known', createdAt: 'x' }),
    );
    const { call } = await start(f);
    const r = await call('POST', `/api/reviews/${ID}/findings/${FID}/suppress`, { reason: 'known' });
    expect(r.status).toBe(200);
    expect(r.json.suppressed).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain(`/reviews/${ID}/findings/${FID}/suppress`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: 'known' });
  });

  it('validates suppress input before calling the service', async () => {
    const f = vi.fn<typeof fetch>();
    const { call } = await start(f);
    expect((await call('POST', `/api/reviews/${ID}/findings/${FID}/suppress`, { reason: 5 })).status).toBe(400);
    expect(
      (await call('POST', `/api/reviews/${ID}/findings/${FID}/suppress`, { reason: 'r'.repeat(501) })).status,
    ).toBe(400);
    expect((await call('POST', `/api/reviews/${ID}/findings/f-zz/suppress`, {})).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects an oversized body', async () => {
    const { base } = await start();
    const body = JSON.stringify({ reason: 'x'.repeat(MAX_BODY_BYTES) });
    const target = `/api/reviews/${ID}/findings/${FID}/suppress`;
    const res = await fetch(base + target, {
      method: 'POST',
      body,
      headers: { 'x-kirocrew-proxy': sign('POST', target, body) },
    }).catch(() => null);
    // The server may reset the connection after replying 413.
    if (res) expect(res.status).toBe(413);
  });
});

describe('ui backend over the Kiro transport', () => {
  const ORIGIN = 'http://127.0.0.1:6777';
  const KIRO_ENV = {
    KIRO_CODE_REVIEWER_TRANSPORT: 'kiro',
    KIROCREW_APP_NAME: 'kiro-code-reviewer',
    KIROCREW_GATEWAY_ORIGIN: ORIGIN,
    KIROCREW_GATEWAY_ORIGIN_PROOF: createHmac('sha256', SECRET).update(ORIGIN).digest('hex'),
    KIROCREW_PROXY_SECRET: SECRET,
  };

  async function startKiro(handler: (url: string, init: RequestInit | undefined) => Response) {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.replace(ORIGIN, '')}`);
      if (u.endsWith('/token')) return jsonResponse(200, { token: 't' });
      return handler(u, init);
    });
    const deps = {
      ...withoutRestFake(makeDeps(dataDir, fetchImpl)),
      env: { KIRO_CODE_REVIEWER_DATA_DIR: dataDir, ...KIRO_ENV },
    };
    server = createUiServer(deps, SECRET);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, target: string, body?: unknown) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      const res = await fetch(base + target, {
        method,
        headers: { 'content-type': 'application/json', 'x-kirocrew-proxy': sign(method, target, text) },
        ...(text ? { body: text } : {}),
      });
      return { status: res.status, json: (await res.json()) as Json };
    };
    return { call, calls, fetchImpl };
  }

  it('reads a review through the gateway, with no call to the service endpoint', async () => {
    const { call, calls } = await startKiro(() => jsonResponse(200, review()));
    const res = await call('GET', `/api/reviews/${ID}?iteration=2`);
    expect(res.status).toBe(200);
    expect(res.json.reviewId).toBe(ID);
    expect(calls).toEqual([
      'POST /api/apps/kiro-code-reviewer/token',
      'POST /api/apps/kiro-code-reviewer/kiro/GetCodeReview',
    ]);
  });

  it('suppresses through the gateway and clears the local override', async () => {
    const { call, fetchImpl } = await startKiro(() =>
      jsonResponse(200, { reviewId: ID, findingId: FID, suppressed: true, reason: 'known', createdAt: 'x' }),
    );
    const res = await call('POST', `/api/reviews/${ID}/findings/${FID}/suppress`, { reason: 'known' });
    expect(res.status).toBe(200);
    expect(res.json.suppressed).toBe(true);
    const posted = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/kiro/UpdateCodeReviewFinding'));
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ reviewId: ID, findingId: FID, reason: 'known' });
  });

  it('lists reviews through the gateway with ListCodeReviews', async () => {
    const { call, fetchImpl } = await startKiro(() => jsonResponse(200, { reviews: [] }));
    const res = await call('GET', '/api/reviews');
    expect(res.status).toBe(200);
    const posted = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/kiro/ListCodeReviews'));
    expect(posted).toBeDefined();
  });

  it('reports the sign-in state as the page status', async () => {
    const signedOut = await startKiro(() => jsonResponse(200, { signedIn: false, hint: 'Settings → Kiro account.' }));
    expect((await signedOut.call('GET', '/api/status')).json).toMatchObject({
      configured: false,
      transport: 'kiro',
      code: 'KIRO_SIGN_IN_REQUIRED',
    });
  });

  it('answers 409 with the sign-in code when the gateway has no sign-in', async () => {
    const { call } = await startKiro(() =>
      jsonResponse(401, { error: { code: 'KIRO_SIGN_IN_REQUIRED', message: 'Not signed in to Kiro.' } }),
    );
    const res = await call('GET', `/api/reviews/${ID}`);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('KIRO_SIGN_IN_REQUIRED');
  });

  it('saves the Kiro region and reports it in the status', async () => {
    const { call } = await startKiro(() => jsonResponse(200, { signedIn: true }));
    expect((await call('GET', '/api/status')).json.kiroRegion).toBe('us-east-1');
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ transport: 'kiro' }));
    expect((await call('POST', '/api/kiro-region', { region: 'eu-central-1' })).status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'))).toEqual({
      transport: 'kiro',
      kiroRegion: 'eu-central-1',
    });
    expect((await call('GET', '/api/status')).json.kiroRegion).toBe('eu-central-1');
    const bad = await call('POST', '/api/kiro-region', { region: 'mars-1' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('VALIDATION_ERROR');
  });

  it('serves a forwarded agent tool call on /api/agent-tools', async () => {
    const { call } = await startKiro(() => jsonResponse(200, { signedIn: true }));
    const res = await call('POST', '/api/agent-tools', {
      tool: 'code_review_submit',
      arguments: { prepared_id: 'prep-0000000000000000', payload_digest: '0'.repeat(64) },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ code: 'PREPARED_NOT_FOUND' });
  });
});
