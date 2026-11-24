// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { ContextDecision } from '../src/collect/contextAnswers.js';
import {
  buildContextSummaryMarkdown,
  buildPayload,
  buildSummaryMarkdown,
  canonicalJson,
  newClientToken,
  payloadDigest,
  SUMMARY_MAX_CHARS,
  type PayloadSummary,
} from '../src/collect/payload.js';
import type { RedactionLocation } from '../src/redact.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function summary(overrides: Partial<PayloadSummary> = {}): PayloadSummary {
  return {
    repo: 'my-repo',
    base: 'origin/mainline',
    baseSha: SHA_A,
    mergeBase: SHA_B,
    head: 'feature/x',
    headSha: SHA_C,
    includeUncommitted: false,
    files: [{ path: 'src/users.ts', status: 'modified', added: 3, removed: 1 }],
    diffBytes: 1234,
    changedLines: 4,
    rules: { reviewMd: true, revision: SHA_B },
    contextFiles: [{ path: 'docs/spec.md', bytes: 99 }],
    redactions: [],
    level: 'standard',
    iterationBudget: 3,
    ...overrides,
  };
}

describe('canonical JSON and digest', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('digest is stable across key order', () => {
    expect(payloadDigest({ a: 1, b: 'x' })).toBe(payloadDigest({ b: 'x', a: 1 }));
    expect(payloadDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
  });

  it('clientToken is 32 hex chars', () => {
    expect(newClientToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('buildPayload', () => {
  const base = {
    baseRef: 'origin/mainline',
    mergeBase: SHA_B,
    headRef: 'feature/x',
    headSha: SHA_C,
    includeUncommitted: false,
    diff: 'diff --git a/x b/x\n',
    rules: { reviewMd: '# Guidance\n' },
    context: [{ path: 'docs/spec.md', content: 'hi' }],
    repo: 'my-repo',
    clientVersion: '0.1.0',
    clientToken: 'f'.repeat(32),
  };

  it('builds a submit request with base rules and merge-base commit', () => {
    const p = buildPayload(base);
    expect(p).toMatchObject({
      level: 'standard',
      iterationBudget: 3,
      base: { ref: 'origin/mainline', commit: SHA_B },
      head: { ref: 'feature/x', commit: SHA_C },
      rules: { source: 'base', revision: SHA_B, reviewMd: '# Guidance\n' },
      client: { name: 'kiro-code-reviewer-crew', version: '0.1.0', repo: 'my-repo' },
    });
  });

  it('resubmit omits level/iterationBudget; working tree omits head.commit; no rules object without files', () => {
    const p = buildPayload({ ...base, reviewId: 'rev-' + '0'.repeat(24), includeUncommitted: true, rules: {} });
    expect(p.level).toBeUndefined();
    expect(p.iterationBudget).toBeUndefined();
    expect(p.head).toEqual({ ref: 'feature/x' });
    expect(p.rules).toBeUndefined();
  });

  it('contextRounds only on new reviews and only when > 0; manifest only when non-empty; test hook in client', () => {
    expect(buildPayload({ ...base, contextRounds: 2, manifest: ['src/a.ts'] })).toMatchObject({
      contextRounds: 2,
      manifest: ['src/a.ts'],
    });
    const off = buildPayload({ ...base, contextRounds: 0, manifest: [] });
    expect(off).not.toHaveProperty('contextRounds');
    expect(off).not.toHaveProperty('manifest');
    const resubmit = buildPayload({ ...base, reviewId: 'rev-' + '0'.repeat(24), contextRounds: 2, manifest: ['a'] });
    expect(resubmit).not.toHaveProperty('contextRounds');
    expect(resubmit.manifest).toEqual(['a']);
    expect(buildPayload({ ...base, faultInjection: 'context_request' }).client?.faultInjection).toBe('context_request');
    expect(buildPayload(base).client).not.toHaveProperty('faultInjection');
  });

  it('intent and commits are emitted only when present', () => {
    expect(buildPayload(base)).not.toHaveProperty('intent');
    expect(buildPayload(base)).not.toHaveProperty('commits');
    const p = buildPayload({
      ...base,
      intent: 'Make it read-only.',
      commits: [{ subject: 'fix: a', body: 'Fixes: ABC-1' }, { subject: 'chore: b' }],
    });
    expect(p.intent).toBe('Make it read-only.');
    expect(p.commits).toEqual([{ subject: 'fix: a', body: 'Fixes: ABC-1' }, { subject: 'chore: b' }]);
    // Empty intent and empty commit list are dropped.
    expect(buildPayload({ ...base, intent: '', commits: [] })).not.toHaveProperty('intent');
    expect(buildPayload({ ...base, intent: '', commits: [] })).not.toHaveProperty('commits');
  });

  it('responses are emitted only on a resubmit and only when non-empty', () => {
    const rid = 'rev-' + '0'.repeat(24);
    const responses = [
      { findingId: 'f-0000000000000001', disposition: 'false_positive' as const, comment: 'ok' },
      { findingId: 'f-0000000000000002', disposition: 'wont_fix' as const, acknowledged: true },
    ];
    // New review: responses are dropped even if passed (resubmit-only).
    expect(buildPayload({ ...base, responses })).not.toHaveProperty('responses');
    // Resubmit: responses are sent verbatim.
    expect(buildPayload({ ...base, reviewId: rid, responses }).responses).toEqual(responses);
    // Empty list dropped.
    expect(buildPayload({ ...base, reviewId: rid, responses: [] })).not.toHaveProperty('responses');
  });
});

describe('context summaryMarkdown', () => {
  const decision = (i: number, over: Partial<ContextDecision> = {}): ContextDecision => ({
    requestId: `r1c${i}`,
    kind: 'file',
    target: `src/f${i}.ts`,
    reason: 'r'.repeat(300),
    decision: 'provide',
    bytes: 10,
    ...over,
  });
  const ctx = {
    reviewId: 'rev-' + '0'.repeat(24),
    iteration: 2,
    round: 1,
    expiresAt: '2026-11-12T12:02:00Z',
    extraFiles: [{ path: 'docs/a.md', bytes: 5 }],
    redactions: [] as RedactionLocation[],
  };

  it('renders heading, deadline, totals, table and closing line', () => {
    const md = buildContextSummaryMarkdown({
      ...ctx,
      decisions: [
        decision(1),
        decision(2, { decision: 'declined', localReason: 'refused: secret-like path', bytes: 0 }),
      ],
    });
    const lines = md.split('\n');
    expect(lines[0]).toBe(`### Context for code review ${ctx.reviewId} iteration 2, round 1 (not sent yet)`);
    expect(md).toContain('Respond before 2026-11-12T12:02:00Z; after that the review continues without this context.');
    expect(md).toContain('- Requests: 2; provide 1, decline 1, not found 0; 15 bytes in total');
    expect(md).toContain('  - `docs/a.md` (5 bytes)');
    expect(md).toContain('declined (refused: secret-like path)');
    expect(lines[lines.length - 1]).toBe(
      'Nothing has been sent. Submitting sends exactly this context to the Kiro Reviewer service.',
    );
  });

  it('stays within 4,000 chars for 8 long reasons and 100 redactions, keeping every request id', () => {
    const redactions: RedactionLocation[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'jwt',
      file: `src/f${i}.ts`,
      line: i + 1,
    }));
    const decisions = Array.from({ length: 8 }, (_, i) => decision(i + 1));
    const md = buildContextSummaryMarkdown({ ...ctx, decisions, redactions });
    expect(md.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(md).toContain('- Redactions: 100 (jwt ×100)');
    for (const d of decisions) expect(md).toContain(`| ${d.requestId} |`);
  });
});

describe('summaryMarkdown', () => {
  it('shows context rounds, manifest count and the test hook', () => {
    const md = buildSummaryMarkdown(summary({ contextRounds: 2, manifestPaths: 12, testHook: 'context_request' }));
    expect(md).toContain('- Context requests: up to 2 rounds per review');
    expect(md).toContain('- File manifest: 12 paths (names only, for context requests)');
    expect(md).toContain('- Test hook: context_request');
    expect(buildSummaryMarkdown(summary({ contextRounds: 0 }))).toContain('- Context requests: disabled');
    const plain = buildSummaryMarkdown(summary());
    expect(plain).not.toContain('Context requests');
    expect(plain).not.toContain('File manifest');
    expect(plain).not.toContain('Test hook');
  });

  it('shows author intent (bounded excerpt) and the commit count/bytes/refs when present', () => {
    const md = buildSummaryMarkdown(
      summary({ intent: 'Make getUser read-only.', commitCount: 3, commitBytes: 512, refCount: 2 }),
    );
    expect(md).toContain('- Author intent (your claim, shown to the reviewer as untrusted): `Make getUser read-only.`');
    expect(md).toContain('- Commit messages: 3 (512 bytes), 2 derived refs; author/email/timestamp excluded');
    // Absent by default.
    const plain = buildSummaryMarkdown(summary());
    expect(plain).not.toContain('Author intent');
    expect(plain).not.toContain('Commit messages:');
  });

  it('the intent excerpt is bounded and the summary stays within 4,000 chars with a very long intent', () => {
    const md = buildSummaryMarkdown(
      summary({ intent: 'x'.repeat(5_000), commitCount: 1, commitBytes: 10, refCount: 0 }),
    );
    expect(md.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(md).toContain('Author intent');
  });

  it('lists finding responses and flags blocking dismissals needing acknowledgement', () => {
    const md = buildSummaryMarkdown(
      summary({
        reviewId: 'rev-' + '0'.repeat(24),
        responses: [
          { findingId: 'f-0000000000000001', disposition: 'false_positive', comment: 'intentional' },
          { findingId: 'f-0000000000000002', disposition: 'wont_fix', acknowledged: true },
          { findingId: 'f-0000000000000003', disposition: 'fixed' },
        ],
      }),
    );
    expect(md).toContain('- Responses to previous findings: 3');
    expect(md).toContain('`f-0000000000000001` → false_positive — dismissal (not acknowledged)');
    expect(md).toContain('`f-0000000000000002` → wont_fix — dismissal (acknowledged)');
    expect(md).toContain('`f-0000000000000003` → fixed');
    expect(md).toContain('intentional');
    // Absent by default.
    expect(buildSummaryMarkdown(summary())).not.toContain('Responses to previous findings');
  });

  it('includes base, files, sizes, rules and context', () => {
    const md = buildSummaryMarkdown(summary());
    expect(md).toContain('origin/mainline');
    expect(md).toContain(SHA_B.slice(0, 12));
    expect(md).toContain('src/users.ts');
    expect(md).toContain('1234 bytes');
    expect(md).toContain('4 changed lines');
    expect(md).toContain('REVIEW.md from merge-base');
    expect(md).toContain('docs/spec.md');
    expect(md).toContain('Redactions: none');
    expect(md).toContain('Level: standard; iteration budget: 3');
    expect(md).toContain('- Note: the service excludes generated, fixture, lock and vendored files by default.');
  });

  it('stays within 4,000 chars for 50 files and 100 redactions, keeping counts and capping locations at 20', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/some/fairly/long/directory/name/module-${String(i).padStart(3, '0')}/implementation-file.ts`,
      status: 'modified' as const,
      added: 10,
      removed: 2,
    }));
    const redactions: RedactionLocation[] = Array.from({ length: 100 }, (_, i) => ({
      type: i % 2 === 0 ? 'generic-secret' : 'aws-access-key-id',
      file: files[i % 50].path,
      line: i + 1,
    }));
    const md = buildSummaryMarkdown(summary({ files, redactions }));
    expect(md.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(md).toContain('Redactions: 100 (aws-access-key-id ×50, generic-secret ×50)');
    expect(md).toContain('Diff: 50 files');
    expect(md).toMatch(/… and \d+ more/);
    const locationLines = md.split('\n').filter((l) => /^ {2}- `.*:\d+` /.test(l));
    expect(locationLines.length).toBeLessThanOrEqual(20);
  });

  it('lists at most 50 files', () => {
    const files = Array.from({ length: 60 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'added' as const,
      added: 1,
      removed: 0,
    }));
    const md = buildSummaryMarkdown(summary({ files }));
    expect(md).toContain('… and 10 more');
    expect(md).toContain('Diff: 60 files');
  });
});
