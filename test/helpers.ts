// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../src/client/http.js';
import type { ErrorEnvelope, GetReviewResponse } from '../src/client/types.js';
import { ToolError } from '../src/errors.js';
import type { ToolDeps } from '../src/tools/common.js';

/** Base URL of the REST fake the tool tests talk to (see restSend). */
export const ENDPOINT = 'https://reviewer.test/v1';
export const TEST_API_KEY = 'ksk_testtesttesttest';

/**
 * Serves the tools' REST-shaped requests from `fetchImpl` as `${ENDPOINT}${path}` JSON calls, with the service's
 * error envelope and retry policy (5xx/429/network up to 3 attempts, never START_FAILED), so tool tests can fake the
 * service per route instead of per BFF operation.
 */
export function restSend(fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>) {
  return async <T>(req: ApiRequest): Promise<ApiResponse<T>> => {
    const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : '';
    let last: ToolError | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = 500 * 2 ** (attempt - 1);
        if (req.shouldRetry && !req.shouldRetry(delay)) break;
        await sleep(delay);
      }
      let res: Response;
      try {
        res = await fetchImpl(`${ENDPOINT}${req.path}${qs}`, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          ...(req.method === 'POST' ? { body: req.body ?? '' } : {}),
        });
      } catch {
        last = new ToolError('NETWORK_ERROR', 'The Kiro Reviewer service could not be reached.');
        continue;
      }
      const text = await res.text().catch(() => '');
      let body: unknown;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      if (res.status >= 200 && res.status < 300) return { status: res.status, body: body as T, headers: res.headers };
      const env = (body !== null && typeof body === 'object' ? body : {}) as ErrorEnvelope;
      const serviceCode = typeof env.error?.code === 'string' ? env.error.code : 'UNKNOWN';
      const err = new ToolError('SERVICE_ERROR', `${serviceCode}: ${env.error?.message ?? `HTTP ${res.status}`}`, {
        httpStatus: res.status,
        serviceCode,
        ...(typeof env.error?.limit === 'string' ? { limit: env.error.limit } : {}),
        ...(typeof env.error?.max === 'number' ? { max: env.error.max } : {}),
        ...(typeof env.error?.actual === 'number' ? { actual: env.error.actual } : {}),
      });
      if (serviceCode === 'START_FAILED' || (res.status !== 429 && res.status < 500)) throw err;
      last = err;
    }
    throw last ?? new ToolError('NETWORK_ERROR', 'The Kiro Reviewer service could not be reached.');
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rm(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

export function write(repo: string, rel: string, content: string): void {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A repo with `mainline` (REVIEW.md v1, src/users.ts) and `feature` checked out with changes. */
export function makeRepo(opts: { modifyRules?: boolean } = {}): string {
  const repo = tempDir('kcr-git-');
  git(repo, 'init', '-q', '-b', 'mainline');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'REVIEW.md', '# Review guidance (base)\n');
  write(repo, 'src/users.ts', 'export const a = 1;\n');
  write(repo, 'docs/spec.md', '# Spec\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'src/users.ts', 'export const a = 1;\nexport const b = "x" + req.query.id;\n');
  if (opts.modifyRules) write(repo, 'REVIEW.md', '# Review guidance (head)\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feature');
  return repo;
}

export interface FakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
}

export function fakeClock(start = Date.parse('2026-11-12T12:00:00Z')): FakeClock {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export function makeDeps(
  dataDir: string,
  fetchImpl: typeof fetch = vi.fn<typeof fetch>(),
  clock: FakeClock = fakeClock(),
): ToolDeps {
  return {
    env: { KIRO_CODE_REVIEWER_DATA_DIR: dataDir, KIRO_API_KEY: TEST_API_KEY },
    http: {
      fetch: fetchImpl,
      sleep: async (ms) => clock.sleep(ms),
      random: () => 0,
      send: restSend(fetchImpl, async (ms) => clock.sleep(ms)),
    },
    clock,
    log: () => undefined,
  };
}

/** The deps without the REST fake, for tests that exercise the real BFF or gateway client. */
export function withoutRestFake(deps: ToolDeps): ToolDeps {
  const http = { ...deps.http };
  delete http.send;
  return { ...deps, http };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function review(
  overrides: Partial<GetReviewResponse['iteration']> = {},
  findings: GetReviewResponse['findings'] = [],
): GetReviewResponse {
  return {
    reviewId: 'rev-0123456789abcdef01234567',
    level: 'standard',
    iterationBudget: 3,
    latestIteration: 1,
    createdAt: '2026-11-12T12:00:00Z',
    updatedAt: '2026-11-12T12:01:00Z',
    iterations: [{ number: 1, status: overrides.status ?? 'COMPLETED' }],
    iteration: {
      number: 1,
      status: 'COMPLETED',
      outcome: 'NO_FINDINGS',
      completeness: {
        reviewersPlanned: ['correctness', 'security'],
        reviewersSucceeded: ['correctness', 'security'],
        reviewersFailed: [],
        verify: 'OK',
        budgetExhausted: false,
        deadlineHit: false,
        candidatesTruncated: false,
        findingsTruncated: false,
      },
      counts: { active: 0, blocking: 0, suppressed: 0, resolved: 0 },
      modelUsage: { calls: 3, inputTokens: 1000, outputTokens: 100 },
      warnings: [],
      error: null,
      ...overrides,
    },
    findings,
  };
}

export function finding(
  overrides: Partial<GetReviewResponse['findings'][number]> = {},
): GetReviewResponse['findings'][number] {
  return {
    findingId: 'f-0123456789abcdef',
    fingerprint: 'a'.repeat(64),
    file: 'src/users.ts',
    side: 'new',
    startLine: 2,
    endLine: 2,
    title: 'SQL built by string concatenation',
    explanation: 'User input flows into the query.',
    suggestion: 'Use a parameterized query.',
    severity: 'high',
    category: 'security',
    ruleId: null,
    blocking: true,
    suppressed: false,
    suppressionReason: null,
    state: 'NEW',
    firstSeenIteration: 1,
    resolvedIteration: null,
    carriedForward: false,
    confidence: 9,
    verified: true,
    reviewers: ['security'],
    ...overrides,
  };
}
