// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toErrorResult } from '../src/errors.js';
import { STAGING_TTL_MS } from '../src/staging.js';
import { prepareTool } from '../src/tools/prepare.js';
import { submitTool } from '../src/tools/submit.js';
import { fakeClock, jsonResponse, makeDeps, makeRepo, rm, tempDir, type FakeClock } from './helpers.js';

let repo: string;
let dataDir: string;
let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;
let clock: FakeClock;

beforeEach(() => {
  repo = makeRepo();
  dataDir = tempDir('kcr-data-');
  fetchSpy = vi.fn<typeof fetch>(async () =>
    jsonResponse(202, {
      reviewId: 'rev-0123456789abcdef01234567',
      iteration: 1,
      status: 'QUEUED',
      iterationBudget: 3,
      warnings: [],
    }),
  );
  clock = fakeClock();
});
afterEach(() => {
  rm(repo);
  rm(dataDir);
});

async function prepare() {
  const deps = makeDeps(dataDir, fetchSpy, clock);
  const r = await prepareTool({ repoPath: repo, base: 'mainline' }, deps);
  return { deps, ...(r.structuredContent as { preparedId: string; payloadDigest: string; summaryMarkdown: string }) };
}

async function submitCode(input: Record<string, unknown>, deps: ReturnType<typeof makeDeps>) {
  try {
    await submitTool(input, deps);
    return { code: 'OK', details: {} as Record<string, unknown> };
  } catch (e) {
    const err = toErrorResult(e).structuredContent.error;
    return { code: err.code as string, details: err };
  }
}

describe('code_review_prepare staging', () => {
  it('stages with dir 0700 and file 0600 and makes no network call', async () => {
    const p = await prepare();
    expect(fetchSpy).not.toHaveBeenCalled();
    const dir = path.join(dataDir, 'prepared');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = path.join(dir, `${p.preparedId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(p.preparedId).toMatch(/^prep-[0-9a-f]{16}$/);
    expect(p.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deletes expired staged files on the next prepare', async () => {
    const first = await prepare();
    clock.advance(STAGING_TTL_MS + 1);
    await prepare();
    expect(readdirSync(path.join(dataDir, 'prepared'))).not.toContain(`${first.preparedId}.json`);
  });
});

describe('code_review_submit', () => {
  it('sends the staged payload and deletes the staged file on 202', async () => {
    const p = await prepare();
    const r = await submitTool({ preparedId: p.preparedId, payloadDigest: p.payloadDigest }, p.deps);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://reviewer.test/v1/reviews');
    expect(init?.method).toBe('POST');
    expect(r.structuredContent).toMatchObject({
      reviewId: 'rev-0123456789abcdef01234567',
      iteration: 1,
      status: 'QUEUED',
    });
    expect(existsSync(path.join(dataDir, 'prepared', `${p.preparedId}.json`))).toBe(false);
  });

  it('reports excludedFiles (count + escaped list) in markdown and structuredContent', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse(202, {
        reviewId: 'rev-0123456789abcdef01234567',
        iteration: 1,
        status: 'QUEUED',
        iterationBudget: 3,
        warnings: ['FILES_EXCLUDED'],
        excludedFiles: ['test/fixtures/big.json', 'package-lock.json'],
      }),
    );
    const p = await prepare();
    const r = await submitTool({ preparedId: p.preparedId, payloadDigest: p.payloadDigest }, p.deps);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('Warnings: FILES_EXCLUDED.');
    expect(text).toContain(
      '2 file(s) excluded from review (generated/fixture/lock/vendored): `test/fixtures/big.json`, `package-lock.json`.',
    );
    expect(r.structuredContent).toMatchObject({ excludedFiles: ['test/fixtures/big.json', 'package-lock.json'] });
  });

  it('an older service response without excludedFiles → excludedFiles [] and no exclusion text', async () => {
    const p = await prepare();
    const r = await submitTool({ preparedId: p.preparedId, payloadDigest: p.payloadDigest }, p.deps);
    expect((r.content[0] as { text: string }).text).not.toContain('excluded');
    expect(r.structuredContent).toMatchObject({ excludedFiles: [] });
  });

  it('DIGEST_MISMATCH: a digest differing in one byte → no fetch', async () => {
    const p = await prepare();
    const flipped = (p.payloadDigest[0] === 'a' ? 'b' : 'a') + p.payloadDigest.slice(1);
    const r = await submitCode({ preparedId: p.preparedId, payloadDigest: flipped }, p.deps);
    expect(r.code).toBe('DIGEST_MISMATCH');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PREPARED_NOT_FOUND: missing or expired → no fetch', async () => {
    const p = await prepare();
    const missing = await submitCode({ preparedId: 'prep-0000000000000000', payloadDigest: p.payloadDigest }, p.deps);
    expect(missing.code).toBe('PREPARED_NOT_FOUND');
    clock.advance(STAGING_TTL_MS + 1);
    const expired = await submitCode({ preparedId: p.preparedId, payloadDigest: p.payloadDigest }, p.deps);
    expect(expired.code).toBe('PREPARED_NOT_FOUND');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('code_review_prepare git metadata', () => {
  it('collects commit messages, passes intent, and shows both in the summary; intent reaches the payload', async () => {
    const deps = makeDeps(dataDir, fetchSpy, clock);
    const prep = await prepareTool(
      { repoPath: repo, base: 'mainline', intent: 'Make getUser read-only; no writes.' },
      deps,
    );
    const sc = prep.structuredContent as {
      preparedId: string;
      summaryMarkdown: string;
      summary: { intent?: string; commitCount?: number; commitBytes?: number; refCount?: number };
    };
    // Summary shows the intent and the commit count/bytes/refs.
    expect(sc.summaryMarkdown).toContain('Author intent');
    expect(sc.summaryMarkdown).toContain('Make getUser read-only; no writes.');
    expect(sc.summaryMarkdown).toContain('Commit messages: 1');
    expect(sc.summary.intent).toBe('Make getUser read-only; no writes.');
    expect(sc.summary.commitCount).toBe(1);
    // The staged payload carries intent and the commit (makeRepo's "feature" commit).
    const staged = JSON.parse(readFileSync(path.join(dataDir, 'prepared', `${sc.preparedId}.json`), 'utf8')) as {
      payload: { intent?: string; commits?: Array<{ subject: string }> };
    };
    expect(staged.payload.intent).toBe('Make getUser read-only; no writes.');
    expect(staged.payload.commits?.[0].subject).toBe('feature');
  });

  it('without intent, neither the summary nor the payload carry an author intent (commits still collected)', async () => {
    const p = await prepare();
    expect(p.summaryMarkdown).not.toContain('Author intent');
    // Commits are still collected and shown.
    expect(p.summaryMarkdown).toContain('Commit messages: 1');
    const staged = JSON.parse(readFileSync(path.join(dataDir, 'prepared', `${p.preparedId}.json`), 'utf8')) as {
      payload: { intent?: string; commits?: unknown[] };
    };
    expect(staged.payload).not.toHaveProperty('intent');
    expect(staged.payload.commits).toHaveLength(1);
  });

  it('a secret in the intent is redacted before it is staged and counted in the summary', async () => {
    const deps = makeDeps(dataDir, fetchSpy, clock);
    const prep = await prepareTool(
      { repoPath: repo, base: 'mainline', intent: 'Rotate key AKIAIOSFODNN7EXAMPLE now.' },
      deps,
    );
    const sc = prep.structuredContent as {
      preparedId: string;
      summaryMarkdown: string;
      summary: { redactions: Array<{ type: string; file: string }> };
    };
    const staged = JSON.parse(readFileSync(path.join(dataDir, 'prepared', `${sc.preparedId}.json`), 'utf8')) as {
      payload: { intent?: string };
    };
    expect(staged.payload.intent).toContain('[REDACTED:aws-access-key-id]');
    expect(staged.payload.intent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(sc.summary.redactions.some((r) => r.file === 'intent')).toBe(true);
    expect(sc.summaryMarkdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('code_review_prepare finding responses', () => {
  const RID = 'rev-0123456789abcdef01234567';
  const responses = [
    { findingId: 'f-0000000000000001', disposition: 'false_positive' as const, comment: 'validated upstream' },
    { findingId: 'f-0000000000000002', disposition: 'wont_fix' as const, acknowledged: true },
  ];

  it('rejects responses on a new review (no reviewId)', async () => {
    const deps = makeDeps(dataDir, fetchSpy, clock);
    await expect(prepareTool({ repoPath: repo, base: 'mainline', responses }, deps)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('stages responses on a resubmit, shows them in the summary, and redacts comment text', async () => {
    const deps = makeDeps(dataDir, fetchSpy, clock);
    const prep = await prepareTool(
      {
        repoPath: repo,
        base: 'mainline',
        reviewId: RID,
        responses: [
          ...responses,
          { findingId: 'f-0000000000000003', disposition: 'deferred', comment: 'rotate key AKIAIOSFODNN7EXAMPLE' },
        ],
      },
      deps,
    );
    const sc = prep.structuredContent as { preparedId: string; summaryMarkdown: string };
    expect(sc.summaryMarkdown).toContain('Responses to previous findings: 3');
    expect(sc.summaryMarkdown).toContain('`f-0000000000000002` → wont_fix — dismissal (acknowledged)');
    const staged = JSON.parse(readFileSync(path.join(dataDir, 'prepared', `${sc.preparedId}.json`), 'utf8')) as {
      payload: { responses?: Array<{ findingId: string; comment?: string; acknowledged?: boolean }> };
    };
    expect(staged.payload.responses).toHaveLength(3);
    const deferred = staged.payload.responses!.find((r) => r.findingId === 'f-0000000000000003')!;
    expect(deferred.comment).toContain('[REDACTED:aws-access-key-id]');
    expect(deferred.comment).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(sc.summaryMarkdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
