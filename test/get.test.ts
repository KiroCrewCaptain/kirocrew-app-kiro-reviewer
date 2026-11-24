// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextRoundState } from '../src/client/types.js';
import { toErrorResult } from '../src/errors.js';
import { getTool } from '../src/tools/get.js';
import { fakeClock, jsonResponse, makeDeps, review, rm, tempDir, type FakeClock } from './helpers.js';

const ID = 'rev-0123456789abcdef01234567';
let dataDir: string;
let clock: FakeClock;

beforeEach(() => {
  dataDir = tempDir('kcr-get-');
  clock = fakeClock();
});
afterEach(() => rm(dataDir));

/** fetch that advances the fake clock by `fetchMs` per call and returns RUNNING `runningCalls` times. */
function fetcher(runningCalls: number, fetchMs = 0) {
  let n = 0;
  return vi.fn<typeof fetch>(async () => {
    clock.advance(fetchMs);
    n++;
    return jsonResponse(200, n <= runningCalls ? review({ status: 'RUNNING', outcome: 'IN_PROGRESS' }) : review());
  });
}

describe('code_review_get', () => {
  it('rejects waitSeconds > 90', async () => {
    const f = fetcher(0);
    try {
      await getTool({ reviewId: ID, waitSeconds: 91 }, makeDeps(dataDir, f, clock));
      expect.unreachable();
    } catch (e) {
      expect(toErrorResult(e).structuredContent.error.code).toBe('VALIDATION_ERROR');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('returns immediately on a terminal status', async () => {
    const f = fetcher(0);
    const r = await getTool({ reviewId: ID }, makeDeps(dataDir, f, clock));
    expect(f).toHaveBeenCalledTimes(1);
    expect((r.structuredContent as { iteration: { outcome: string } }).iteration.outcome).toBe('NO_FINDINGS');
  });

  it('polls every 5 s until terminal', async () => {
    const f = fetcher(2);
    const start = clock.now();
    const r = await getTool({ reviewId: ID, waitSeconds: 60 }, makeDeps(dataDir, f, clock));
    expect(f).toHaveBeenCalledTimes(3);
    expect(clock.now() - start).toBe(10_000);
    expect((r.structuredContent as { iteration: { status: string } }).iteration.status).toBe('COMPLETED');
  });

  it('stops when elapsed + 5 s + 20 s > waitSeconds and reports still running', async () => {
    const f = fetcher(1000);
    const start = clock.now();
    const r = await getTool({ reviewId: ID, waitSeconds: 60 }, makeDeps(dataDir, f, clock));
    // Polls at 0, 5, ..., 40 s: at 35 s, 35 + 25 = 60 is not > 60, so it polls once more; at 40 s, 65 > 60 → stop.
    expect(f).toHaveBeenCalledTimes(9);
    expect(clock.now() - start).toBe(40_000);
    expect(r.structuredContent).toMatchObject({ stillRunning: true, iteration: { outcome: 'IN_PROGRESS' } });
    expect(r.content[0].text).toContain('still running — call code_review_get again');
  });

  it('returns immediately on NEEDS_CONTEXT without sleeping', async () => {
    const waiting = review({
      status: 'NEEDS_CONTEXT',
      outcome: 'IN_PROGRESS',
      contextRequests: [
        {
          requestId: 'r1c1',
          kind: 'file',
          path: 'src/auth.ts',
          startLine: null,
          endLine: null,
          query: null,
          reason: 'see isAllowed',
        },
      ],
      contextRound: {
        round: 1,
        state: 'AWAITING',
        requestedAt: '2026-11-12T12:00:00Z',
        expiresAt: '2026-11-12T12:02:00Z',
        respondedAt: null,
        maxBytes: 200_000,
      },
    });
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, waiting));
    const start = clock.now();
    const r = await getTool({ reviewId: ID, waitSeconds: 90 }, makeDeps(dataDir, f, clock));
    expect(f).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(start);
    expect(r.structuredContent).toMatchObject({ needsContext: true, iteration: { status: 'NEEDS_CONTEXT' } });
    expect(r.structuredContent).not.toHaveProperty('stillRunning');
    expect(r.content[0].text).toContain('code_review_context_prepare');
    expect(r.content[0].text).not.toContain('still running — call code_review_get again');
  });

  describe('a submitted context round is still being applied (NEEDS_CONTEXT, not AWAITING)', () => {
    const round = (n: number, state: ContextRoundState) => ({
      round: n,
      state,
      requestedAt: '2026-11-12T12:00:00Z',
      expiresAt: '2026-11-12T12:02:00Z',
      respondedAt: state === 'AWAITING' ? null : '2026-11-12T12:00:30Z',
      maxBytes: 200_000,
    });
    const needs = (n: number, state: ContextRoundState) =>
      review({ status: 'NEEDS_CONTEXT', outcome: 'IN_PROGRESS', contextRound: round(n, state) });
    const sequence = (...bodies: unknown[]) => {
      let i = 0;
      return vi.fn<typeof fetch>(async () => jsonResponse(200, bodies[Math.min(i++, bodies.length - 1)]));
    };

    it('keeps polling through RESPONDED until COMPLETED', async () => {
      const f = sequence(needs(1, 'RESPONDED'), needs(1, 'RESPONDED'), review());
      const start = clock.now();
      const r = await getTool({ reviewId: ID, waitSeconds: 60 }, makeDeps(dataDir, f, clock));
      expect(f).toHaveBeenCalledTimes(3);
      expect(clock.now() - start).toBe(10_000);
      expect((r.structuredContent as { iteration: { status: string } }).iteration.status).toBe('COMPLETED');
      expect(r.structuredContent).not.toHaveProperty('needsContext');
    });

    it('RESPONDED for the whole wait is bounded by waitSeconds and reports still running, not needsContext', async () => {
      const f = sequence(needs(1, 'RESPONDED'));
      const start = clock.now();
      const r = await getTool({ reviewId: ID, waitSeconds: 60 }, makeDeps(dataDir, f, clock));
      expect(f).toHaveBeenCalledTimes(9);
      expect(clock.now() - start).toBe(40_000);
      expect(r.structuredContent).toMatchObject({ stillRunning: true, iteration: { status: 'NEEDS_CONTEXT' } });
      expect(r.structuredContent).not.toHaveProperty('needsContext');
      expect(r.content[0].text).toContain('is applying the submitted context');
      expect(r.content[0].text).toContain('still running — call code_review_get again');
      expect(r.content[0].text).not.toContain('code_review_context_prepare');
    });

    it('stops when a new round (round 2) is AWAITING', async () => {
      const f = sequence(needs(1, 'RESPONDED'), needs(1, 'APPLIED'), needs(2, 'AWAITING'));
      const r = await getTool({ reviewId: ID, waitSeconds: 60 }, makeDeps(dataDir, f, clock));
      expect(f).toHaveBeenCalledTimes(3);
      expect(r.structuredContent).toMatchObject({
        needsContext: true,
        iteration: { contextRound: { round: 2, state: 'AWAITING' } },
      });
      expect(r.content[0].text).toContain('code_review_context_prepare');
    });
  });

  it('waitSeconds 0 fetches once', async () => {
    const f = fetcher(1000);
    await getTool({ reviewId: ID, waitSeconds: 0 }, makeDeps(dataDir, f, clock));
    expect(f).toHaveBeenCalledTimes(1);
  });

  for (const waitSeconds of [0, 30, 60, 90]) {
    it(`worst case with 20 s fetches and 503s stays <= waitSeconds + 20 s (wait ${waitSeconds})`, async () => {
      let n = 0;
      const slow = vi.fn<typeof fetch>(async () => {
        clock.advance(20_000);
        n++;
        return n % 2 === 0
          ? jsonResponse(503, { error: { code: 'INTERNAL_ERROR' } })
          : jsonResponse(200, review({ status: 'RUNNING', outcome: 'IN_PROGRESS' }));
      });
      const start = clock.now();
      await getTool({ reviewId: ID, waitSeconds }, makeDeps(dataDir, slow, clock));
      expect(clock.now() - start).toBeLessThanOrEqual(waitSeconds * 1000 + 20_000);
    });
  }
});
