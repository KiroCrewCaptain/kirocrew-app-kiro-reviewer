// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextRequest, ContextRoundView, GetReviewResponse } from '../src/client/types.js';
import { buildManifest } from '../src/collect/manifest.js';
import { toErrorResult } from '../src/errors.js';
import type { StagedPayload } from '../src/staging.js';
import { contextPrepareTool } from '../src/tools/contextPrepare.js';
import { CONTEXT_WINDOW_CLOSED_MESSAGE, contextSubmitTool } from '../src/tools/contextSubmit.js';
import { prepareTool, TEST_FAULT_INJECTION_ENV } from '../src/tools/prepare.js';
import { submitTool } from '../src/tools/submit.js';
import { git, jsonResponse, makeDeps, makeRepo, review, rm, tempDir, write } from './helpers.js';

const ID = 'rev-0123456789abcdef01234567';
const EXPIRES = '2026-11-12T12:02:00.000Z';
const CONTEXT_URL = `https://reviewer.test/v1/reviews/${ID}/iterations/1/context`;

let repo: string;
let outside: string;
let dataDir: string;

beforeEach(() => {
  repo = makeRepo();
  outside = tempDir('kcr-outside-');
  dataDir = tempDir('kcr-ctx-data-');
  write(repo, 'src/auth.ts', 'export async function isAllowed(u: string) {\n  return u.length > 0;\n}\n');
  write(repo, 'src/keys.ts', 'export const a = 1;\nconst password = "hunter2hunter2";\nexport const b = 2;\n');
  write(repo, 'config/.env', 'isAllowed=1\n');
  write(repo, 'src/big.ts', `// ${'x'.repeat(100_001)}\n`);
  writeFileSync(path.join(repo, 'src', 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'more files');
  write(outside, 'notes.txt', 'outside the repository\n');
  symlinkSync(path.join(outside, 'notes.txt'), path.join(repo, 'src', 'link.ts'));
});
afterEach(() => {
  rm(repo);
  rm(outside);
  rm(dataDir);
});

function req(requestId: string, kind: ContextRequest['kind'], over: Partial<ContextRequest> = {}): ContextRequest {
  return {
    requestId,
    kind,
    path: null,
    startLine: null,
    endLine: null,
    query: null,
    reason: `reason for ${requestId}`,
    ...over,
  };
}

function waiting(requests: ContextRequest[], round: Partial<ContextRoundView> = {}): GetReviewResponse {
  return review({
    status: 'NEEDS_CONTEXT',
    outcome: 'IN_PROGRESS',
    completeness: null,
    contextRequests: requests,
    contextRound: {
      round: 1,
      state: 'AWAITING',
      requestedAt: '2026-11-12T12:00:00.000Z',
      expiresAt: EXPIRES,
      respondedAt: null,
      maxBytes: 200_000,
      ...round,
    },
  });
}

const accepted = {
  reviewId: ID,
  iteration: 1,
  round: 1,
  status: 'RESPONDED',
  provided: ['r1c1'],
  declined: [],
  notFound: [],
  unanswered: [],
  unsolicited: 0,
};

/** fetch: GET → `get`, POST → `post`. */
function fetcher(get: GetReviewResponse, post: () => Response = () => jsonResponse(202, accepted)) {
  return vi.fn<typeof fetch>(async (_url, init) => (init?.method === 'POST' ? post() : jsonResponse(200, get)));
}

interface PrepOut {
  preparedId: string;
  payloadDigest: string;
  summaryMarkdown: string;
  expiresAt: string;
  decisions: Array<{ requestId: string; decision: string; localReason?: string; bytes: number }>;
}

async function contextPrepare(get: GetReviewResponse, args: Record<string, unknown> = {}) {
  const f = fetcher(get);
  const deps = makeDeps(dataDir, f);
  const r = await contextPrepareTool({ repoPath: repo, reviewId: ID, ...args }, deps);
  const out = r.structuredContent as unknown as PrepOut;
  const staged = JSON.parse(
    readFileSync(path.join(dataDir, 'prepared', `${out.preparedId}.json`), 'utf8'),
  ) as StagedPayload & { payload: { round: number; responses: Array<Record<string, unknown>>; context?: unknown[] } };
  return { out, staged, fetch: f, deps };
}

async function errorOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    return toErrorResult(e).structuredContent.error;
  }
  throw new Error('expected an error');
}

const decisionOf = (out: PrepOut, id: string) => out.decisions.find((d) => d.requestId === id);

describe('code_review_context_prepare', () => {
  it('answers file, range and search requests and refuses unsafe paths locally', async () => {
    const { out, staged, fetch } = await contextPrepare(
      waiting([
        req('r1c1', 'file', { path: 'src/auth.ts' }),
        req('r1c2', 'range', { path: 'src/users.ts', startLine: 2, endLine: 2 }),
        req('r1c3', 'search', { query: 'isAllowed' }),
        req('r1c4', 'file', { path: 'config/.env' }),
        req('r1c5', 'file', { path: '../outside.txt' }),
        req('r1c6', 'file', { path: '/etc/passwd' }),
        req('r1c7', 'file', { path: 'src/link.ts' }),
        req('r1c8', 'file', { path: 'src/missing.ts' }),
      ]),
    );
    // Only the read-only GET touched the network.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');

    const byId = Object.fromEntries(staged.payload.responses.map((r) => [r.requestId, r]));
    expect(byId.r1c1).toEqual({
      requestId: 'r1c1',
      status: 'provided',
      content: readFileSync(path.join(repo, 'src/auth.ts'), 'utf8'),
    });
    expect(byId.r1c2).toEqual({
      requestId: 'r1c2',
      status: 'provided',
      content: 'export const b = "x" + req.query.id;',
    });
    expect(byId.r1c3.status).toBe('provided');
    expect(byId.r1c3.content).toContain('src/auth.ts:1: export async function isAllowed');
    expect(byId.r1c3.content).not.toContain('.env');
    for (const id of ['r1c4', 'r1c5', 'r1c6', 'r1c7']) expect(byId[id]).toEqual({ requestId: id, status: 'declined' });
    expect(byId.r1c8).toEqual({ requestId: 'r1c8', status: 'not_found' });
    expect(staged.payload.round).toBe(1);
    expect(staged.payload.context).toBeUndefined();
    expect(staged.kind).toBe('context');
    expect(staged.apiPath).toBe(`/reviews/${ID}/iterations/1/context`);

    expect(decisionOf(out, 'r1c4')).toMatchObject({ decision: 'declined', localReason: 'refused: secret-like path' });
    expect(decisionOf(out, 'r1c5')).toMatchObject({ decision: 'declined', localReason: 'refused: invalid path' });
    expect(decisionOf(out, 'r1c6')).toMatchObject({ decision: 'declined', localReason: 'refused: invalid path' });
    expect(decisionOf(out, 'r1c7')).toMatchObject({ decision: 'declined', localReason: 'refused: outside repository' });
    expect(decisionOf(out, 'r1c8')).toMatchObject({ decision: 'not_found' });

    const md = out.summaryMarkdown;
    expect(md.split('\n')[0]).toBe(`### Context for code review ${ID} iteration 1, round 1 (not sent yet)`);
    expect(md).toContain(`Respond before ${EXPIRES}; after that the review continues without this context.`);
    expect(md).toContain('| Request | Kind | Target | Reason (from the reviewer) | Decision | Bytes |');
    expect(md).toContain(
      '| r1c4 | file | `config/.env` | reason for r1c4 | declined (refused: secret-like path) | 0 |',
    );
    expect(md).toContain('declined (refused: outside repository)');
    expect(md).toContain('declined (refused: invalid path)');
    expect(md).toContain('| r1c8 | file | `src/missing.ts` | reason for r1c8 | not found | 0 |');
    expect(md).toContain('Nothing has been sent. Submitting sends exactly this context to the Kiro Reviewer service.');
    expect(md.length).toBeLessThanOrEqual(4_000);
    expect(out.expiresAt).toBe(EXPIRES);
  });

  it('declines user-declined, oversize and non-text requests', async () => {
    const { out, staged } = await contextPrepare(
      waiting([
        req('r1c1', 'file', { path: 'src/auth.ts' }),
        req('r1c2', 'file', { path: 'src/big.ts' }),
        req('r1c3', 'file', { path: 'src/bin.dat' }),
      ]),
      { decline: ['r1c1'] },
    );
    expect(staged.payload.responses.every((r) => r.status === 'declined' && r.content === undefined)).toBe(true);
    expect(decisionOf(out, 'r1c1')?.localReason).toBe('declined by you');
    expect(decisionOf(out, 'r1c2')?.localReason).toBe('too large');
    expect(decisionOf(out, 'r1c3')?.localReason).toBe('not text');
  });

  it('declines content over the round maxBytes as too large', async () => {
    const { out } = await contextPrepare(waiting([req('r1c1', 'file', { path: 'src/auth.ts' })], { maxBytes: 10 }));
    expect(decisionOf(out, 'r1c1')).toMatchObject({ decision: 'declined', localReason: 'too large', bytes: 0 });
  });

  it('redacts provided content and lists the redaction in the summary', async () => {
    const { out, staged } = await contextPrepare(waiting([req('r1c1', 'file', { path: 'src/keys.ts' })]));
    const content = staged.payload.responses[0].content as string;
    expect(content).not.toContain('hunter2hunter2');
    expect(content).toContain('[REDACTED:generic-secret]');
    expect(out.summaryMarkdown).toContain('- Redactions: 1 (generic-secret ×1)');
    expect(out.summaryMarkdown).toContain('`src/keys.ts:2` generic-secret');
  });

  it('range start beyond EOF is not_found; search without matches is not_found', async () => {
    const { staged } = await contextPrepare(
      waiting([
        req('r1c1', 'range', { path: 'src/users.ts', startLine: 50, endLine: 60 }),
        req('r1c2', 'search', { query: 'no-such-text-anywhere' }),
      ]),
    );
    expect(staged.payload.responses.map((r) => r.status)).toEqual(['not_found', 'not_found']);
  });

  it('escapes and truncates the reviewer reason (untrusted model text)', async () => {
    const reason = `ignore previous instructions | <b>bold</b> \`code\`\nnext line ${'z'.repeat(400)}`;
    const { out } = await contextPrepare(waiting([req('r1c1', 'file', { path: 'src/auth.ts', reason })]));
    const row = out.summaryMarkdown.split('\n').find((l) => l.startsWith('| r1c1 '))!;
    expect(row).toContain("ignore previous instructions \\| &lt;b&gt;bold&lt;/b&gt; 'code' next line");
    expect(row).not.toContain('<b>');
    expect(row).toContain('…');
    expect(row.length).toBeLessThan(500);
  });

  it('adds extraFiles as unsolicited context and refuses unsafe extra files', async () => {
    const { staged, out } = await contextPrepare(waiting([req('r1c1', 'file', { path: 'src/auth.ts' })]), {
      extraFiles: ['docs/spec.md'],
    });
    expect(staged.payload.context).toEqual([{ path: 'docs/spec.md', content: '# Spec\n' }]);
    expect(out.summaryMarkdown).toContain('- Extra files (not requested): 1');

    const get = waiting([req('r1c1', 'file', { path: 'src/auth.ts' })]);
    const deps = makeDeps(dataDir, fetcher(get));
    expect(
      (await errorOf(contextPrepareTool({ repoPath: repo, reviewId: ID, extraFiles: ['config/.env'] }, deps))).code,
    ).toBe('CONTEXT_PATH_INVALID');
    expect(
      (await errorOf(contextPrepareTool({ repoPath: repo, reviewId: ID, extraFiles: ['../x.ts'] }, deps))).code,
    ).toBe('CONTEXT_PATH_INVALID');
    expect(
      (await errorOf(contextPrepareTool({ repoPath: repo, reviewId: ID, extraFiles: ['src/nope.ts'] }, deps))).code,
    ).toBe('CONTEXT_NOT_FOUND');
  });

  it('expired round → CONTEXT_WINDOW_CLOSED; no open round → CONTEXT_NOT_REQUESTED', async () => {
    const expired = makeDeps(
      dataDir,
      fetcher(waiting([req('r1c1', 'file', { path: 'src/auth.ts' })], { state: 'EXPIRED' })),
    );
    const e1 = await errorOf(contextPrepareTool({ repoPath: repo, reviewId: ID }, expired));
    expect(e1).toMatchObject({ code: 'CONTEXT_WINDOW_CLOSED', expiresAt: EXPIRES });

    const running = makeDeps(dataDir, fetcher(review({ status: 'RUNNING', outcome: 'IN_PROGRESS' })));
    expect((await errorOf(contextPrepareTool({ repoPath: repo, reviewId: ID }, running))).code).toBe(
      'CONTEXT_NOT_REQUESTED',
    );
  });

  it('rejects a decline id that is not in the round', async () => {
    const deps = makeDeps(dataDir, fetcher(waiting([req('r1c1', 'file', { path: 'src/auth.ts' })])));
    expect((await errorOf(contextPrepareTool({ repoPath: repo, reviewId: ID, decline: ['r1c2'] }, deps))).code).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('code_review_context_submit', () => {
  async function staged() {
    return contextPrepare(waiting([req('r1c1', 'file', { path: 'src/auth.ts' })]));
  }

  it('POSTs exactly the staged canonical body to the iteration context route and deletes it on 202', async () => {
    const { out, staged: s } = await staged();
    const f = fetcher(waiting([]));
    const deps = makeDeps(dataDir, f);
    const r = await contextSubmitTool({ preparedId: out.preparedId, payloadDigest: out.payloadDigest }, deps);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(CONTEXT_URL);
    expect(init?.method).toBe('POST');
    const { canonicalJson } = await import('../src/collect/payload.js');
    expect(init?.body).toBe(canonicalJson(s.payload));
    expect(r.structuredContent).toMatchObject({ reviewId: ID, round: 1, provided: ['r1c1'], unsolicited: 0 });
    expect(existsSync(path.join(dataDir, 'prepared', `${out.preparedId}.json`))).toBe(false);
  });

  it('stores the sent context for the Crew page', async () => {
    const { out } = await staged();
    await contextSubmitTool(
      { preparedId: out.preparedId, payloadDigest: out.payloadDigest },
      makeDeps(dataDir, fetcher(waiting([]))),
    );
    const { loadStored } = await import('../src/payloadStore.js');
    const [it1] = loadStored(dataDir, ID);
    expect(it1.number).toBe(1);
    expect(it1.contextRounds).toHaveLength(1);
    expect(it1.contextRounds[0].responses[0]).toMatchObject({ requestId: 'r1c1', status: 'provided' });
    expect(it1.contextRounds[0].responses[0].content).toContain('isAllowed');
  });

  it('DIGEST_MISMATCH sends nothing', async () => {
    const { out } = await staged();
    const f = fetcher(waiting([]));
    const deps = makeDeps(dataDir, f);
    const d = await errorOf(contextSubmitTool({ preparedId: out.preparedId, payloadDigest: '0'.repeat(64) }, deps));
    expect(d.code).toBe('DIGEST_MISMATCH');
    expect(f).not.toHaveBeenCalled();
  });

  it('a tampered staged body fails the digest check', async () => {
    const { out } = await staged();
    const file = path.join(dataDir, 'prepared', `${out.preparedId}.json`);
    const s = JSON.parse(readFileSync(file, 'utf8')) as StagedPayload & { payload: { round: number } };
    s.payload.round = 2;
    writeFileSync(file, JSON.stringify(s));
    const f = fetcher(waiting([]));
    const e = await errorOf(
      contextSubmitTool({ preparedId: out.preparedId, payloadDigest: out.payloadDigest }, makeDeps(dataDir, f)),
    );
    expect(e.code).toBe('DIGEST_MISMATCH');
    expect(f).not.toHaveBeenCalled();
  });

  it('kinds do not cross: review payload → context_submit and context payload → submit are PREPARED_KIND_MISMATCH', async () => {
    const f = fetcher(waiting([]));
    const deps = makeDeps(dataDir, f);
    const rev = (await prepareTool({ repoPath: repo, base: 'mainline' }, deps)).structuredContent as unknown as PrepOut;
    const e1 = await errorOf(contextSubmitTool({ preparedId: rev.preparedId, payloadDigest: rev.payloadDigest }, deps));
    expect(e1.code).toBe('PREPARED_KIND_MISMATCH');

    const { out } = await staged();
    const e2 = await errorOf(submitTool({ preparedId: out.preparedId, payloadDigest: out.payloadDigest }, deps));
    expect(e2.code).toBe('PREPARED_KIND_MISMATCH');
    expect(f.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('maps 409 CONTEXT_WINDOW_CLOSED to a fixed message', async () => {
    const { out } = await staged();
    const f = fetcher(waiting([]), () =>
      jsonResponse(409, { error: { code: 'CONTEXT_WINDOW_CLOSED', message: 'closed', expiresAt: EXPIRES } }),
    );
    const e = await errorOf(
      contextSubmitTool({ preparedId: out.preparedId, payloadDigest: out.payloadDigest }, makeDeps(dataDir, f)),
    );
    expect(e).toMatchObject({ code: 'CONTEXT_WINDOW_CLOSED', message: CONTEXT_WINDOW_CLOSED_MESSAGE });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

type StagedReview = StagedPayload & {
  payload: { contextRounds?: number; manifest?: string[]; client: { faultInjection?: string } };
};

async function prepareStaged(args: Record<string, unknown>, env: Record<string, string> = {}) {
  const deps = makeDeps(dataDir);
  Object.assign(deps.env, env);
  const r = await prepareTool({ repoPath: repo, base: 'mainline', ...args }, deps);
  const out = r.structuredContent as unknown as PrepOut;
  const staged = JSON.parse(
    readFileSync(path.join(dataDir, 'prepared', `${out.preparedId}.json`), 'utf8'),
  ) as StagedReview;
  return { out, staged, deps };
}

describe('code_review_prepare context rounds and manifest', () => {
  it('defaults to contextRounds 2 with a proximity-sorted, denylist-filtered manifest', async () => {
    const { out, staged } = await prepareStaged({});
    expect(staged.kind).toBe('review');
    expect(staged.payload.contextRounds).toBe(2);
    const manifest = staged.payload.manifest!;
    expect(manifest).not.toContain('config/.env');
    expect(manifest.slice(0, 2)).toEqual(['src/auth.ts', 'src/big.ts']);
    expect(manifest).toContain('REVIEW.md');
    expect(manifest.indexOf('src/users.ts')).toBeLessThan(manifest.indexOf('REVIEW.md'));
    expect(out.summaryMarkdown).toContain('- Context requests: up to 2 rounds per review');
    expect(out.summaryMarkdown).toContain(
      `- File manifest: ${manifest.length} paths (names only, for context requests)`,
    );
    expect(staged.payload.client.faultInjection).toBeUndefined();
  });

  it('contextRounds 0 sends neither contextRounds nor a manifest', async () => {
    const { out, staged } = await prepareStaged({ contextRounds: 0 });
    expect(staged.payload.contextRounds).toBeUndefined();
    expect(staged.payload.manifest).toBeUndefined();
    expect(out.summaryMarkdown).toContain('- Context requests: disabled');
    expect(out.summaryMarkdown).not.toContain('File manifest');
  });

  it('includeManifest false omits the manifest', async () => {
    const { staged } = await prepareStaged({ includeManifest: false });
    expect(staged.payload.contextRounds).toBe(2);
    expect(staged.payload.manifest).toBeUndefined();
  });

  it('rejects contextRounds on a resubmit and above 2', async () => {
    const deps = makeDeps(dataDir);
    expect(
      (await errorOf(prepareTool({ repoPath: repo, base: 'mainline', reviewId: ID, contextRounds: 1 }, deps))).code,
    ).toBe('VALIDATION_ERROR');
    expect((await errorOf(prepareTool({ repoPath: repo, base: 'mainline', contextRounds: 3 }, deps))).code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('a resubmit sends the manifest but no contextRounds', async () => {
    const { staged } = await prepareStaged({ reviewId: ID });
    expect(staged.payload.contextRounds).toBeUndefined();
    expect(staged.payload.manifest?.length).toBeGreaterThan(0);
  });

  it('the test hook env sets client.faultInjection and shows it; other values are rejected', async () => {
    const { out, staged } = await prepareStaged({}, { [TEST_FAULT_INJECTION_ENV]: 'context_request' });
    expect(staged.payload.client.faultInjection).toBe('context_request');
    expect(out.summaryMarkdown).toContain('- Test hook: context_request');
    const deps = makeDeps(dataDir);
    deps.env[TEST_FAULT_INJECTION_ENV] = 'reviewer_failure';
    expect((await errorOf(prepareTool({ repoPath: repo, base: 'mainline' }, deps))).code).toBe('VALIDATION_ERROR');
  });
});

describe('buildManifest', () => {
  it('orders by shared directory prefix with changed files, then lexicographically, and caps', () => {
    const tracked = ['README.md', 'a/z.ts', 'src/api/b.ts', 'src/api/a.ts', 'src/db/x.ts', 'src/util.ts', 'zz/y.ts'];
    expect(buildManifest(tracked, ['src/api/handler.ts'])).toEqual([
      'src/api/a.ts',
      'src/api/b.ts',
      'src/db/x.ts',
      'src/util.ts',
      'README.md',
      'a/z.ts',
      'zz/y.ts',
    ]);
    expect(buildManifest(tracked, ['src/api/handler.ts'], 3)).toEqual(['src/api/a.ts', 'src/api/b.ts', 'src/db/x.ts']);
  });

  it('drops denylisted, malformed and over-long paths', () => {
    expect(
      buildManifest(
        ['src/a.ts', '.env', 'keys/id_rsa', 'x/.ssh/config', 'bad\\path.ts', 'p'.repeat(513)],
        ['src/b.ts'],
      ),
    ).toEqual(['src/a.ts']);
  });
});
