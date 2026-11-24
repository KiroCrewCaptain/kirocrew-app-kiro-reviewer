// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toErrorResult } from '../src/errors.js';
import { loadServiceApiFlags } from '../src/config.js';
import { recordReview } from '../src/history.js';
import { saveSubmission } from '../src/payloadStore.js';
import {
  clearLocalUnsuppress,
  getSent,
  listReviews,
  MAX_LIST_PAGES,
  parseFeedback,
  putFeedback,
  unsuppressFinding,
  withStubUnsuppress,
  withStubFeedback,
} from '../src/ui/serviceApis.js';
import { finding, jsonResponse, makeDeps, review, rm, tempDir } from './helpers.js';

const ID = 'rev-0123456789abcdef01234567';
const FID = 'f-0123456789abcdef';
let dataDir: string;

beforeEach(() => {
  dataDir = tempDir('kcr-svcapi-');
});
afterEach(() => rm(dataDir));

const enable = (flags: Record<string, boolean>): void => {
  writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ serviceApis: flags }));
};
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return toErrorResult(e).structuredContent.error.code as string;
  }
  return 'none';
};

describe('parseFeedback', () => {
  it('accepts votes, reasons with down only, and trims comments', () => {
    expect(parseFeedback({ vote: 'up' })).toEqual({ vote: 'up' });
    expect(parseFeedback({ vote: null })).toEqual({ vote: null });
    expect(parseFeedback({ vote: 'down', reason: 'too_minor', comment: '  meh ' })).toEqual({
      vote: 'down',
      reason: 'too_minor',
      comment: 'meh',
    });
    expect(parseFeedback({ vote: 'down', comment: '   ' })).toEqual({ vote: 'down' });
  });

  it('rejects bad input with the service codes', () => {
    expect(codeOf(() => parseFeedback({}))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseFeedback({ vote: 'meh' }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseFeedback({ vote: 'up', reason: 'wrong' }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseFeedback({ vote: 'down', reason: 'nope' }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseFeedback({ vote: 'down', comment: 5 }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseFeedback({ vote: 'down', comment: 'x'.repeat(501) }))).toBe('LIMIT_EXCEEDED');
  });
});

describe('feedback stub', () => {
  it('stores, merges into a review, overwrites and clears without calling the service', async () => {
    const f = vi.fn<typeof fetch>();
    const deps = makeDeps(dataDir, f);
    const saved = await putFeedback(deps, ID, FID, { vote: 'down', reason: 'wrong' });
    expect(saved).toMatchObject({ reviewId: ID, findingId: FID, vote: 'down', reason: 'wrong', comment: null });
    expect(statSync(path.join(dataDir, 'feedback.json')).mode & 0o777).toBe(0o600);

    const r = withStubFeedback(deps, review({}, [finding(), finding({ findingId: 'f-ffffffffffffffff' })]));
    expect(r.findings[0].feedback).toMatchObject({ vote: 'down', reason: 'wrong' });
    expect(r.findings[1].feedback).toBeNull();

    await putFeedback(deps, ID, FID, { vote: 'up' });
    expect(withStubFeedback(deps, review({}, [finding()])).findings[0].feedback).toMatchObject({
      vote: 'up',
      reason: null,
    });

    const cleared = await putFeedback(deps, ID, FID, { vote: null });
    expect(cleared.vote).toBeNull();
    expect(withStubFeedback(deps, review({}, [finding()])).findings[0].feedback).toBeNull();
    expect(JSON.parse(readFileSync(path.join(dataDir, 'feedback.json'), 'utf8'))).toEqual({ [ID]: {} });
    expect(f).not.toHaveBeenCalled();
  });

  it('posts to the service when enabled and leaves GetReview feedback alone', async () => {
    enable({ feedback: true });
    const body = { reviewId: ID, findingId: FID, vote: 'up', reason: null, comment: null, updatedAt: 'x' };
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, body));
    const deps = makeDeps(dataDir, f);
    expect(await putFeedback(deps, ID, FID, { vote: 'up' })).toEqual(body);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain(`/reviews/${ID}/findings/${FID}/feedback`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ vote: 'up' });
    const r = review({}, [finding({ feedback: null })]);
    expect(withStubFeedback(deps, r)).toBe(r);
  });
});

describe('listReviews', () => {
  it('serves the local history when the list API is off', async () => {
    enable({ list: false });
    recordReview(dataDir, { reviewId: ID, trackedAt: 't', intent: 'why' });
    const f = vi.fn<typeof fetch>();
    expect(await listReviews(makeDeps(dataDir, f))).toEqual({
      source: 'local',
      reviews: [{ reviewId: ID, trackedAt: 't', createdAt: 't', intent: 'why' }],
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('uses the service when enabled, keeps local intent, and passes nextToken', async () => {
    enable({ list: true });
    recordReview(dataDir, { reviewId: ID, trackedAt: 't', intent: 'why' });
    const summary = {
      reviewId: ID,
      createdAt: 'c',
      updatedAt: 'u',
      level: 'standard',
      latestIteration: 2,
      status: 'COMPLETED',
      counts: { active: 1, blocking: 0, suppressed: 0, resolved: 2 },
    };
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { reviews: [summary], nextToken: 'n2' }));
    const out = await listReviews(makeDeps(dataDir, f), 'n1');
    expect(out.source).toBe('service');
    expect(out.nextToken).toBe('n2');
    expect(out.reviews[0]).toMatchObject({ ...summary, intent: 'why' });
    expect(String(f.mock.calls[0][0])).toContain('nextToken=n1');
  });

  const summaryOf = (n: number) => ({
    reviewId: `rev-${n.toString(16).padStart(24, '0')}`,
    createdAt: 'c',
    updatedAt: 'u',
    level: 'standard',
    latestIteration: 1,
    status: 'COMPLETED',
    counts: { active: 0, blocking: 0, suppressed: 0, resolved: 0 },
  });

  it('follows every page when no token is given, and drops a review that comes back twice', async () => {
    enable({ list: true });
    const pages: Record<string, unknown> = {
      first: { reviews: [summaryOf(1), summaryOf(2)], nextToken: 'p2' },
      p2: { reviews: [summaryOf(2), summaryOf(3)], nextToken: 'p3' },
      p3: { reviews: [summaryOf(4)] },
    };
    const f = vi.fn<typeof fetch>(async (url) =>
      jsonResponse(200, pages[new URL(String(url)).searchParams.get('nextToken') ?? 'first']),
    );
    const out = await listReviews(makeDeps(dataDir, f));
    expect(out.reviews.map((r) => r.reviewId)).toEqual([1, 2, 3, 4].map((n) => summaryOf(n).reviewId));
    expect(out.nextToken).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('stops at the page cap and says there is more', async () => {
    enable({ list: true });
    let n = 0;
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { reviews: [summaryOf(++n)], nextToken: `t${n}` }));
    const out = await listReviews(makeDeps(dataDir, f));
    expect(f).toHaveBeenCalledTimes(MAX_LIST_PAGES);
    expect(out.reviews).toHaveLength(MAX_LIST_PAGES);
    expect(out.nextToken).toBe(`t${MAX_LIST_PAGES}`);
  });

  it('reads one page when it is given a token', async () => {
    enable({ list: true });
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { reviews: [summaryOf(1)], nextToken: 'more' }));
    const out = await listReviews(makeDeps(dataDir, f), 'start');
    expect(f).toHaveBeenCalledTimes(1);
    expect(out.nextToken).toBe('more');
  });
});

describe('the list flag', () => {
  const write = (config: unknown, env: Record<string, string> = {}) => {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
    return loadServiceApiFlags({ KIRO_CODE_REVIEWER_DATA_DIR: dataDir, ...env }).list;
  };
  it('is on by default', () => {
    expect(write({})).toBe(true);
    expect(write({ transport: 'bff' })).toBe(true);
    expect(write({}, { KIRO_CODE_REVIEWER_TRANSPORT: 'bff' })).toBe(true);
  });
  it('can be set either way', () => {
    expect(write({ transport: 'bff', serviceApis: { list: false } })).toBe(false);
    expect(write({ serviceApis: { list: true } })).toBe(true);
  });
});

describe('getSent', () => {
  const payload = {
    reviewId: ID,
    iteration: 1,
    sentAt: 's',
    base: { ref: 'mainline', commit: 'abc' },
    diff: 'diff --git a/x b/x',
    context: [],
    manifestCount: 3,
    contextRounds: [
      { round: 1, sentAt: 's', responses: [{ requestId: 'r1c1', status: 'provided', content: 'x' }], context: [] },
    ],
    expiresAt: 'e',
  };

  it('prefers the local copy and does not call the service', async () => {
    enable({ payload: true });
    saveSubmission(dataDir, ID, 1, { base: { ref: 'm', commit: 'c' }, diff: 'local' }, 't');
    const f = vi.fn<typeof fetch>();
    const out = await getSent(makeDeps(dataDir, f), ID, 1);
    expect(out.source).toBe('local');
    expect(out.iteration?.submission?.diff).toBe('local');
    expect(f).not.toHaveBeenCalled();
  });

  it('returns none when nothing is local and the service API is off', async () => {
    const f = vi.fn<typeof fetch>();
    expect(await getSent(makeDeps(dataDir, f), ID, 1)).toEqual({ source: 'none', iteration: null });
    expect(f).not.toHaveBeenCalled();
  });

  it('maps the service payload, and reports an expired one', async () => {
    enable({ payload: true });
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, payload))
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: 'PAYLOAD_EXPIRED', message: 'gone' } }));
    const deps = makeDeps(dataDir, f);
    const out = await getSent(deps, ID, 1);
    expect(out.source).toBe('service');
    expect(out.iteration).toMatchObject({
      number: 1,
      submission: { diff: payload.diff, manifestCount: 3, base: payload.base },
      contextRounds: payload.contextRounds,
    });
    expect(String(f.mock.calls[0][0])).toContain(`/reviews/${ID}/iterations/1/payload`);
    expect(await getSent(deps, ID, 2)).toEqual({ source: 'none', iteration: null, expired: true });
  });
});

describe('unsuppress', () => {
  const suppressed = () =>
    review({ counts: { active: 0, blocking: 0, suppressed: 2, resolved: 0 } }, [
      finding({ suppressed: true, suppressionReason: 'known' }),
      finding({ findingId: 'f-ffffffffffffffff', suppressed: true, blocking: false, suppressionReason: 'x' }),
    ]);

  it('stub: shows the finding as active again, fixes the counts and says it is local', async () => {
    const f = vi.fn<typeof fetch>();
    const deps = makeDeps(dataDir, f);
    expect(withStubUnsuppress(deps, suppressed()).findings.every((x) => x.suppressed)).toBe(true);
    const res = await unsuppressFinding(deps, ID, FID);
    expect(res).toMatchObject({ reviewId: ID, findingId: FID, suppressed: false });
    expect(statSync(path.join(dataDir, 'unsuppressed.json')).mode & 0o777).toBe(0o600);
    const r = withStubUnsuppress(deps, suppressed());
    expect(r.findings[0]).toMatchObject({ suppressed: false, suppressionReason: null, locallyUnsuppressed: true });
    expect(r.findings[1].suppressed).toBe(true);
    expect(r.iteration.counts).toEqual({ active: 1, blocking: 1, suppressed: 1, resolved: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it('stub: a resolved finding does not change the counts, and suppressing again clears the override', async () => {
    const deps = makeDeps(dataDir, vi.fn<typeof fetch>());
    await unsuppressFinding(deps, ID, FID);
    const resolved = review({ counts: { active: 0, blocking: 0, suppressed: 1, resolved: 1 } }, [
      finding({ suppressed: true, state: 'RESOLVED' }),
    ]);
    expect(withStubUnsuppress(deps, resolved).iteration.counts).toEqual({
      active: 0,
      blocking: 0,
      suppressed: 1,
      resolved: 1,
    });
    clearLocalUnsuppress(deps, ID, FID);
    expect(withStubUnsuppress(deps, suppressed()).findings[0].suppressed).toBe(true);
    clearLocalUnsuppress(deps, ID, FID);
  });

  it('posts to the service when enabled and leaves the review alone', async () => {
    enable({ unsuppress: true });
    const body = { reviewId: ID, findingId: FID, suppressed: false, updatedAt: 'x' };
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, body));
    const deps = makeDeps(dataDir, f);
    expect(await unsuppressFinding(deps, ID, FID)).toEqual(body);
    expect(String(f.mock.calls[0][0])).toContain(`/reviews/${ID}/findings/${FID}/unsuppress`);
    const r = suppressed();
    expect(withStubUnsuppress(deps, r)).toBe(r);
  });

  it('rejects bad ids before any call', async () => {
    const f = vi.fn<typeof fetch>();
    await expect(unsuppressFinding(makeDeps(dataDir, f), 'nope', FID)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});
