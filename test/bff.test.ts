// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cbor } from '@smithy/core/cbor';
import { describe, expect, it, vi } from 'vitest';
import { bffCall, loadBffConfig, serviceCodeOf, type BffConfig } from '../src/client/bff.js';
import { callBff } from '../src/client/bffApi.js';
import type { HttpDeps } from '../src/client/http.js';
import { ToolError } from '../src/errors.js';

const CONFIG: BffConfig = { endpoint: 'https://staging.kiro.test', apiKey: 'ksk_exampleexampleexample' };
const REV = 'rev-0123456789abcdef01234567';
const FINDING = 'f-0123456789abcdef';

function cborResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(cbor.serialize(body)), {
    status,
    headers: { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor', ...headers },
  });
}

/** A fetch that answers with the given replies in order and records each call. */
function fakeFetch(...replies: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies.shift();
    if (next === undefined) throw new Error('no reply queued');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const noSleep = { sleep: async () => {}, random: () => 0 };
const sent = (call: { init: RequestInit }): Record<string, unknown> =>
  cbor.deserialize(call.init.body as Uint8Array) as Record<string, unknown>;

async function codeOf(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return e as ToolError;
  }
  throw new Error('expected a failure');
}

describe('loadBffConfig', () => {
  it('defaults to the prod origin and trims the key', () => {
    expect(loadBffConfig({ apiKey: ' ksk_abc \n' })).toEqual({ endpoint: 'https://app.kiro.dev', apiKey: 'ksk_abc' });
  });
  it('accepts an https origin and drops a trailing slash', () => {
    expect(loadBffConfig({ endpoint: 'https://staging.kiro.test/', apiKey: 'k' }).endpoint).toBe(
      'https://staging.kiro.test',
    );
  });
  it.each([
    ['http scheme', 'http://app.kiro.dev'],
    ['a path', 'https://app.kiro.dev/service'],
    ['a query', 'https://app.kiro.dev/?x=1'],
    ['credentials', 'https://user:pw@app.kiro.dev'],
    ['not a URL', 'nope'],
  ])('refuses %s', (_name, endpoint) => {
    expect(() => loadBffConfig({ endpoint, apiKey: 'k' })).toThrow(/endpoint/i);
  });
  it('requires a key without whitespace inside', () => {
    expect(() => loadBffConfig({})).toThrow(/No Kiro API key/);
    expect(() => loadBffConfig({ apiKey: 'ksk a b' })).toThrow(/whitespace/);
  });
});

describe('serviceCodeOf', () => {
  it.each([
    [404, { __type: 'com.amazon#ResourceNotFoundException' }, 'NOT_FOUND'],
    [400, { __type: 'x#ValidationException' }, 'VALIDATION_ERROR'],
    [409, { __type: 'x#CodeReviewConflictException', reason: 'ITERATION_IN_PROGRESS' }, 'ITERATION_IN_PROGRESS'],
    [409, { __type: 'x#CodeReviewConflictException', reason: 'bad reason' }, 'CONFLICT'],
    [403, { __type: 'x#AccessDeniedException' }, 'ACCESS_DENIED'],
    [429, { __type: 'x#ThrottlingException' }, 'THROTTLED'],
    [500, { __type: 'x#InternalFailureException' }, 'InternalFailureException'],
    [401, null, 'UNAUTHORIZED'],
    [418, null, 'HTTP_418'],
  ])('maps %s %j to %s', (status, body, code) => {
    expect(serviceCodeOf(status, body)).toBe(code);
  });
});

describe('bffCall', () => {
  it('posts CBOR with the API key identity headers and drops undefined members', async () => {
    const f = fakeFetch(cborResponse({ ok: true }));
    await expect(bffCall(CONFIG, 'GetCodeReview', { reviewId: REV, iteration: undefined }, f)).resolves.toEqual({
      ok: true,
    });
    const call = f.calls[0];
    expect(call.url).toBe('https://staging.kiro.test/service/KiroWebBearerService/operation/GetCodeReview');
    expect(call.init.redirect).toBe('manual');
    expect(call.init.headers).toMatchObject({
      authorization: `Bearer ${CONFIG.apiKey}`,
      TokenType: 'API_KEY',
      'smithy-protocol': 'rpc-v2-cbor',
      'content-type': 'application/cbor',
    });
    expect(sent(call)).toEqual({ reviewId: REV });
  });

  it('retries a 5xx and then succeeds', async () => {
    const f = fakeFetch(
      cborResponse({ __type: 'x#InternalFailureException', message: 'm' }, 500),
      cborResponse({ ok: 1 }),
    );
    await expect(bffCall(CONFIG, 'GetCodeReview', {}, { ...f, ...noSleep })).resolves.toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(2);
  });

  it('gives up after three attempts and reports the service code and status', async () => {
    const f = fakeFetch(
      ...[0, 1, 2].map(() => cborResponse({ __type: 'x#InternalFailureException', message: 'm' }, 500)),
    );
    const e = await codeOf(bffCall(CONFIG, 'ListCodeReviews', {}, { ...f, ...noSleep }));
    expect(f.calls).toHaveLength(3);
    expect(e.code).toBe('SERVICE_ERROR');
    expect(e.details).toMatchObject({ httpStatus: 500, serviceCode: 'InternalFailureException' });
  });

  it('retries network errors', async () => {
    const f = fakeFetch(new Error('boom'), cborResponse({ ok: 1 }));
    await expect(bffCall(CONFIG, 'GetCodeReview', {}, { ...f, ...noSleep })).resolves.toEqual({ ok: 1 });
    const g = fakeFetch(...[0, 1, 2].map(() => new Error('boom')));
    expect((await codeOf(bffCall(CONFIG, 'GetCodeReview', {}, { ...g, ...noSleep }))).code).toBe('NETWORK_ERROR');
  });

  it('does not retry a 4xx and maps a conflict to its reason', async () => {
    const f = fakeFetch(
      cborResponse({ __type: 'x#CodeReviewConflictException', message: 'busy', reason: 'ITERATION_IN_PROGRESS' }, 409),
    );
    const e = await codeOf(bffCall(CONFIG, 'UpdateCodeReview', {}, { ...f, ...noSleep }));
    expect(f.calls).toHaveLength(1);
    expect(e.message).toMatch(/^ITERATION_IN_PROGRESS: busy/);
    expect(e.details).toMatchObject({ httpStatus: 409, serviceCode: 'ITERATION_IN_PROGRESS' });
  });

  it('says the key was rejected without echoing the server message', async () => {
    const f = fakeFetch(cborResponse({ __type: 'x#UnauthorizedException', message: 'token ksk_leak' }, 401));
    const e = await codeOf(bffCall(CONFIG, 'GetCodeReview', {}, f));
    expect(e.message).toBe('UNAUTHORIZED: The Kiro API key was rejected.');
  });

  it('refuses a redirect and names only the host', async () => {
    const f = fakeFetch(
      new Response(null, { status: 302, headers: { location: 'https://idp.example.com/login?token=secret' } }),
    );
    const e = await codeOf(bffCall(CONFIG, 'GetCodeReview', {}, f));
    expect(f.calls).toHaveLength(1);
    expect(e.details).toMatchObject({ httpStatus: 302, serviceCode: 'REDIRECT' });
    expect(e.message).toContain('idp.example.com');
    expect(e.message).not.toContain('secret');
  });

  it('refuses a 200 that is not an rpc-v2-cbor reply', async () => {
    const f = fakeFetch(new Response('<html>', { status: 200 }));
    expect((await codeOf(bffCall(CONFIG, 'GetCodeReview', {}, f))).details.serviceCode).toBe('BAD_REPLY');
  });

  it('refuses a reply over the size cap', async () => {
    const f = fakeFetch(cborResponse({ ok: 1 }, 200, { 'content-length': String(9 * 1024 * 1024) }));
    expect((await codeOf(bffCall(CONFIG, 'GetCodeReview', {}, f))).message).toMatch(/RESPONSE_TOO_LARGE/);
  });
});

describe('callBff routes', () => {
  const run = async (req: Parameters<typeof callBff>[1], ...replies: Response[]) => {
    const f = fakeFetch(...replies);
    const deps: HttpDeps = { fetch: f.fetch, ...noSleep };
    const res = await callBff(CONFIG, req, deps);
    return { res, f, op: f.calls[0].url.split('/').pop(), input: sent(f.calls[0]) };
  };

  it('POST /reviews creates, keeps only modeled members and drops fault injection', async () => {
    const body = JSON.stringify({
      clientToken: 'a'.repeat(32),
      base: { ref: 'main', commit: 'a'.repeat(40) },
      diff: 'd',
      level: 'quick',
      iterationBudget: 2,
      contextRounds: 1,
      unknownMember: 1,
      client: { name: 'n', version: '1', repo: 'r', faultInjection: 'context_request' },
    });
    const { res, op, input } = await run(
      { method: 'POST', path: '/reviews', body },
      cborResponse({ reviewId: REV, iteration: 1, status: 'QUEUED', iterationBudget: 2, warnings: [] }),
    );
    expect(op).toBe('CreateCodeReview');
    expect(input).toEqual({
      clientToken: 'a'.repeat(32),
      base: { ref: 'main', commit: 'a'.repeat(40) },
      diff: 'd',
      level: 'quick',
      iterationBudget: 2,
      contextRounds: 1,
      client: { name: 'n', version: '1', repo: 'r' },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ reviewId: REV, iteration: 1, status: 'QUEUED' });
  });

  it('POST /reviews/{id}/iterations resubmits and never sends a level', async () => {
    const body = JSON.stringify({
      diff: 'd',
      level: 'deep',
      base: { ref: 'main', commit: 'a'.repeat(40) },
      responses: [{ findingId: FINDING, disposition: 'fixed', comment: 'c', extra: 1 }],
    });
    const { op, input } = await run(
      { method: 'POST', path: `/reviews/${REV}/iterations`, body },
      cborResponse({ reviewId: REV, iteration: 2, status: 'QUEUED' }),
    );
    expect(op).toBe('UpdateCodeReview');
    expect(input).toEqual({
      reviewId: REV,
      diff: 'd',
      base: { ref: 'main', commit: 'a'.repeat(40) },
      responses: [{ findingId: FINDING, disposition: 'fixed', comment: 'c' }],
    });
  });

  it('GET /reviews/{id} maps timestamps, fills nulls and gives an unfinished iteration zero counts', async () => {
    const { res, op, input } = await run(
      { method: 'GET', path: `/reviews/${REV}`, query: { iteration: '2' } },
      cborResponse({
        reviewId: REV,
        createdAt: 1763424000000,
        iteration: { number: 2, status: 'RUNNING', outcome: 'IN_PROGRESS', contextRequests: [{ requestId: 'r1c1' }] },
        findings: [{ findingId: FINDING, severity: 'high' }],
      }),
    );
    expect(op).toBe('GetCodeReview');
    expect(input).toEqual({ reviewId: REV, iteration: 2 });
    const body = res.body as {
      createdAt: string;
      iteration: Record<string, unknown>;
      findings: Array<Record<string, unknown>>;
    };
    expect(res.status).toBe(200);
    expect(body.createdAt).toBe('2025-11-18T00:00:00.000Z');
    expect(body.iteration.counts).toEqual({ active: 0, blocking: 0, suppressed: 0, resolved: 0 });
    expect(body.iteration).toMatchObject({ completeness: null, contextRound: null, error: null, startedAt: null });
    expect(body.iteration.contextRequests).toEqual([
      { requestId: 'r1c1', path: null, startLine: null, endLine: null, query: null },
    ]);
    expect(body.findings[0]).toMatchObject({ suggestion: null, ruleId: null, suppressionReason: null, feedback: null });
  });

  it('GET /reviews/{id} without a query asks for the latest iteration', async () => {
    const { input } = await run(
      { method: 'GET', path: `/reviews/${REV}` },
      cborResponse({ reviewId: REV, iteration: {}, findings: [] }),
    );
    expect(input).toEqual({ reviewId: REV });
  });

  it('GET /reviews lists, caps the page size at 50 and gives unfinished reviews zero counts', async () => {
    const { res, op, input } = await run(
      { method: 'GET', path: '/reviews', query: { limit: '200', nextToken: 'tok' } },
      cborResponse({ reviews: [{ reviewId: REV, updatedAt: 1763424000000 }], nextToken: 'n2' }),
    );
    expect(op).toBe('ListCodeReviews');
    expect(input).toEqual({ maxResults: 50, nextToken: 'tok' });
    expect(res.body).toEqual({
      reviews: [
        {
          reviewId: REV,
          updatedAt: '2025-11-18T00:00:00.000Z',
          counts: { active: 0, blocking: 0, suppressed: 0, resolved: 0 },
        },
      ],
      nextToken: 'n2',
    });
  });

  it('GET …/payload fetches the iteration payload', async () => {
    const { res, op, input } = await run(
      { method: 'GET', path: `/reviews/${REV}/iterations/3/payload` },
      cborResponse({ reviewId: REV, iteration: 3, sentAt: 1763424000000, diff: 'd', context: [] }),
    );
    expect(op).toBe('GetCodeReviewIterationPayload');
    expect(input).toEqual({ reviewId: REV, iteration: 3 });
    expect(res.body).toMatchObject({ sentAt: '2025-11-18T00:00:00.000Z' });
  });

  it('POST …/context answers a round', async () => {
    const reply = {
      reviewId: REV,
      iteration: 1,
      round: 1,
      status: 'RESPONDED',
      provided: ['r1c1'],
      declined: [],
      notFound: [],
      unanswered: [],
      unsolicited: 0,
    };
    const { res, op, input } = await run(
      {
        method: 'POST',
        path: `/reviews/${REV}/iterations/1/context`,
        body: JSON.stringify({
          round: 1,
          responses: [{ requestId: 'r1c1', status: 'provided', content: 'x' }],
          junk: 1,
        }),
      },
      cborResponse(reply),
    );
    expect(op).toBe('UpdateCodeReviewContext');
    expect(input).toEqual({
      reviewId: REV,
      iteration: 1,
      round: 1,
      responses: [{ requestId: 'r1c1', status: 'provided', content: 'x' }],
    });
    expect(res.body).toEqual(reply);
  });

  it('POST …/suppress sends the reason and returns the shape the tool prints', async () => {
    const { res, op, input } = await run(
      { method: 'POST', path: `/reviews/${REV}/findings/${FINDING}/suppress`, body: '{"reason":"accepted"}' },
      cborResponse({
        reviewId: REV,
        findingId: FINDING,
        suppressed: true,
        reason: 'accepted',
        createdAt: 1763424000000,
      }),
    );
    expect(op).toBe('UpdateCodeReviewFinding');
    expect(input).toEqual({ reviewId: REV, findingId: FINDING, reason: 'accepted' });
    expect(res.body).toEqual({
      reviewId: REV,
      findingId: FINDING,
      suppressed: true,
      reason: 'accepted',
      createdAt: '2025-11-18T00:00:00.000Z',
    });
  });

  it('POST …/suppress without a reason returns reason null', async () => {
    const { input, res } = await run(
      { method: 'POST', path: `/reviews/${REV}/findings/${FINDING}/suppress`, body: '{}' },
      cborResponse({ reviewId: REV, findingId: FINDING, suppressed: true, createdAt: 1 }),
    );
    expect(input).toEqual({ reviewId: REV, findingId: FINDING });
    expect((res.body as { reason: unknown }).reason).toBeNull();
  });

  it('POST …/feedback records a vote', async () => {
    const { res, op, input } = await run(
      {
        method: 'POST',
        path: `/reviews/${REV}/findings/${FINDING}/feedback`,
        body: '{"vote":"down","reason":"WRONG","comment":"c","x":1}',
      },
      cborResponse({ reviewId: REV, findingId: FINDING, vote: 'down', reason: 'WRONG', updatedAt: 1763424000000 }),
    );
    expect(op).toBe('UpdateCodeReviewFeedback');
    expect(input).toEqual({ reviewId: REV, findingId: FINDING, vote: 'down', reason: 'WRONG', comment: 'c' });
    expect(res.body).toMatchObject({ vote: 'down', comment: null, updatedAt: '2025-11-18T00:00:00.000Z' });
  });

  it('un-suppress and unknown routes fail as UNSUPPORTED without a network call', async () => {
    const f = fakeFetch();
    const deps: HttpDeps = { fetch: f.fetch };
    for (const req of [
      { method: 'POST' as const, path: `/reviews/${REV}/findings/${FINDING}/unsuppress`, body: '{}' },
      { method: 'GET' as const, path: '/other' },
      { method: 'GET' as const, path: `/reviews/${REV}/../x` },
    ]) {
      const e = await codeOf(callBff(CONFIG, req, deps));
      expect(e.details).toMatchObject({ httpStatus: 501, serviceCode: 'UNSUPPORTED' });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('a missing review is a 404 NOT_FOUND, as the status probe expects', async () => {
    const f = fakeFetch(cborResponse({ __type: 'x#ResourceNotFoundException', message: 'no such review' }, 404));
    const e = await codeOf(
      callBff(CONFIG, { method: 'GET', path: '/reviews/rev-000000000000000000000000' }, { fetch: f.fetch }),
    );
    expect(e.details).toMatchObject({ httpStatus: 404, serviceCode: 'NOT_FOUND' });
  });
});
