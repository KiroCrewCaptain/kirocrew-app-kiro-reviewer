// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { ContextOutcome } from '../src/client/types.js';
import {
  escapeCell,
  MISSING_CONTEXT_TEXT,
  NEEDS_CONTEXT_TEXT,
  NO_FINDINGS_CAVEAT,
  renderReview,
  STILL_RUNNING_TEXT,
} from '../src/render.js';
import { finding, review } from './helpers.js';

const ID = 'rev-0123456789abcdef01234567';

describe('renderReview headers', () => {
  it('IN_PROGRESS for non-terminal status', () => {
    const md = renderReview(review({ status: 'RUNNING', outcome: 'IN_PROGRESS' }), { waitElapsed: true });
    expect(md.split('\n')[0]).toBe(`⏳ Code review ${ID} iteration 1 is still running.`);
    expect(md).toContain(STILL_RUNNING_TEXT);
  });

  it('NO_FINDINGS with the fixed caveat', () => {
    const md = renderReview(review());
    expect(md.split('\n')[0]).toBe(
      `✅ Code review ${ID} iteration 1 completed with no findings. ${NO_FINDINGS_CAVEAT}`,
    );
  });

  it('FINDINGS with counts, grouped lists and details', () => {
    const f = finding();
    const md = renderReview(
      review({ outcome: 'FINDINGS', counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 } }, [f]),
    );
    expect(md.split('\n')[0]).toBe(
      `🔎 Code review ${ID} iteration 1 completed: 1 blocking, 1 active, 0 suppressed, 0 resolved.`,
    );
    expect(md).not.toContain('| Severity |');
    expect(md.split('\n')[2]).toBe(`[Open in Kiro Reviewer →](/apps/kiro-code-reviewer?review=${ID})`);
    expect(md).toContain('**Blocking (1)**');
    expect(md).toContain('- 🟠 **High** · SQL built by string concatenation  \n  `src/users.ts:2` · new');
    expect(md).toContain('<details><summary>SQL built by string concatenation · `src/users.ts:2`</summary>');
    expect(md).toContain('<sub>Finding f-0123456789abcdef</sub>');
    // The ID is only in the details footer, not in the visible list.
    expect(md.split('<details>')[0]).not.toContain('f-0123456789abcdef');
    expect(md).toContain('Iteration 1 of budget 3. Model usage: 3 calls, 1000 input tokens, 100 output tokens.');
  });

  for (const status of ['PARTIAL', 'FAILED'] as const) {
    it(`${status} renders INCOMPLETE even if outcome says NO_FINDINGS`, () => {
      const md = renderReview(
        review({
          status,
          outcome: 'NO_FINDINGS',
          completeness: {
            reviewersPlanned: ['correctness', 'security'],
            reviewersSucceeded: ['correctness'],
            reviewersFailed: [{ reviewer: 'security', code: 'REVIEWER_ERROR' }],
            verify: 'OK',
            budgetExhausted: false,
            deadlineHit: false,
            candidatesTruncated: false,
            findingsTruncated: false,
          },
        }),
      );
      const head = md.split('\n')[0];
      expect(head).toContain(`is INCOMPLETE (${status})`);
      expect(head).toContain('reviewer security failed (REVIEWER_ERROR)');
      expect(head).toContain('These results are not a clean review.');
      expect(md).not.toContain('no findings');
    });
  }

  it('COMPLETED with outcome FINDINGS but active=0 does not claim findings and vice versa is forced', () => {
    const md = renderReview(review({ status: 'RUNNING', outcome: 'NO_FINDINGS' }));
    expect(md.split('\n')[0]).toContain('is still running');
  });
});

describe('service notes: cache hit, excluded files, skipped rules', () => {
  const baseCompleteness = review().iteration.completeness;

  it('a cache hit prints the cached-result line', () => {
    const md = renderReview(review({ cache: { hit: true, cachedAt: '2026-11-12T10:00:00.000Z' } }));
    expect(md.split('\n')).toContain(
      '♻️ Cached result from 2026-11-12T10:00:00.000Z: identical diff, rules, context and level; no model calls.',
    );
  });

  it('excluded files are listed escaped, capped at 20 with "and N more"', () => {
    const files = ['test/fixtures/a`b|c.json', ...Array.from({ length: 21 }, (_, i) => `vendor/f${i}.go`)];
    const md = renderReview(review({ excludedFiles: files }));
    const line = md.split('\n').find((l) => l.startsWith('Excluded from review'));
    expect(line).toBeDefined();
    expect(line).toContain("`test/fixtures/a'b\\|c.json`");
    expect(line).toContain('`vendor/f18.go`');
    expect(line).not.toContain('vendor/f19.go');
    expect(line?.endsWith('… and 2 more')).toBe(true);
  });

  it('skipped custom rules are listed', () => {
    const md = renderReview(
      review({ completeness: { ...baseCompleteness!, rulesApplied: ['a'], rulesSkipped: ['docs-only', 'x<y>'] } }),
    );
    expect(md.split('\n')).toContain('Custom rules skipped (no matching changed file): docs-only, x&lt;y&gt;');
  });

  it('older responses without these fields, a miss and empty lists print none of the lines', () => {
    for (const r of [
      review(),
      review({ cache: { hit: false, cachedAt: null }, excludedFiles: [] }),
      review({ completeness: { ...baseCompleteness!, rulesSkipped: [] } }),
    ]) {
      const md = renderReview(r);
      expect(md).not.toContain('Cached result');
      expect(md).not.toContain('Excluded from review');
      expect(md).not.toContain('Custom rules skipped');
    }
  });
});

describe('state labels and escaping', () => {
  it('groups active, resolved and suppressed; only active findings get details', () => {
    const md = renderReview(
      review({ outcome: 'FINDINGS', counts: { active: 1, blocking: 0, suppressed: 1, resolved: 1 } }, [
        finding({ findingId: 'f-1111111111111111', state: 'PERSISTING' }),
        finding({ findingId: 'f-2222222222222222', state: 'PERSISTING', suppressed: true }),
        finding({ findingId: 'f-3333333333333333', state: 'RESOLVED' }),
      ]),
    );
    expect(md).toContain('**Blocking (1)**');
    expect(md).toContain('· still open');
    expect(md).toContain('**Resolved (1)**');
    expect(md).toContain('**Suppressed (1)**');
    expect(md).toContain('<sub>Finding f-1111111111111111</sub>');
    expect(md).not.toContain('<sub>Finding f-2222222222222222</sub>');
    expect(md).not.toContain('<sub>Finding f-3333333333333333</sub>');
  });

  it('escapes cells and HTML, truncates titles to 120 chars', () => {
    expect(escapeCell('a|b\nc`d<e>')).toBe("a\\|b c'd&lt;e&gt;");
    const long = 'T'.repeat(200);
    const md = renderReview(
      review({ outcome: 'FINDINGS', counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 } }, [
        finding({ title: long, explanation: '<script>alert(1)</script>\nline2' }),
      ]),
    );
    expect(md).toContain(`${'T'.repeat(119)}…`);
    expect(md).not.toContain('T'.repeat(121));
    expect(md).toContain('> &lt;script&gt;alert(1)&lt;/script&gt;\n> line2');
    expect(md).not.toContain('<script>');
  });

  it('never says approved/passed/clean outside the fixed caveat texts', () => {
    const outputs = [
      renderReview(review()).replace(NO_FINDINGS_CAVEAT, ''),
      renderReview(
        review({ outcome: 'FINDINGS', counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 } }, [finding()]),
      ),
      renderReview(review({ status: 'RUNNING' }), { waitElapsed: true }),
    ];
    for (const md of outputs) expect(md).not.toMatch(/approved|passed|clean/i);
  });
});

describe('context rounds', () => {
  const outcome = (over: Partial<ContextOutcome> = {}): ContextOutcome => ({
    planner: 'REQUESTED',
    round: 1,
    requested: ['r1c1', 'r1c2', 'r1c3', 'r1c4'],
    provided: ['r1c1'],
    declined: ['r1c2'],
    notFound: ['r1c3'],
    unanswered: ['r1c4'],
    timedOut: false,
    unsolicited: 0,
    entries: [],
    missing: true,
    ...over,
  });
  const completeness = (context: ContextOutcome) => ({ ...review().iteration.completeness!, context });

  it('NEEDS_CONTEXT renders the requests with escaped, truncated reasons and the call to action', () => {
    const md = renderReview(
      review({
        status: 'NEEDS_CONTEXT',
        outcome: 'IN_PROGRESS',
        contextRequests: [
          {
            requestId: 'r1c1',
            kind: 'range',
            path: 'src/a|b.ts',
            startLine: 3,
            endLine: 9,
            query: null,
            reason: `<script>x</script> | ${'q'.repeat(400)}`,
          },
          {
            requestId: 'r1c2',
            kind: 'search',
            path: null,
            startLine: null,
            endLine: null,
            query: 'isAllowed(',
            reason: 'ok',
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
      }),
      { waitElapsed: false },
    );
    expect(md.split('\n')[0]).toBe(`📎 Code review ${ID} iteration 1 is waiting for context the reviewer requested.`);
    expect(md).toContain('round 1); respond before 2026-11-12T12:02:00Z');
    expect(md).toContain('| Request | Kind | Target | Reason (from the reviewer) |');
    const row = md.split('\n').find((l) => l.startsWith('| r1c1 '))!;
    expect(row).toContain('`src/a\\|b.ts:3-9`');
    expect(row).toContain('&lt;script&gt;x&lt;/script&gt; \\|');
    expect(row).not.toContain('<script>');
    expect(row).toContain('…');
    expect(md).toContain('| r1c2 | search | `isAllowed(` | ok |');
    expect(md).toContain(NEEDS_CONTEXT_TEXT);
    expect(md).not.toContain(STILL_RUNNING_TEXT);
  });

  it('NEEDS_CONTEXT with a submitted or closed round renders no requests and no call to action', () => {
    const at = (state: 'RESPONDED' | 'APPLIED' | 'TIMED_OUT') =>
      renderReview(
        review({
          status: 'NEEDS_CONTEXT',
          outcome: 'IN_PROGRESS',
          contextRound: {
            round: 1,
            state,
            requestedAt: '2026-11-12T12:00:00Z',
            expiresAt: '2026-11-12T12:02:00Z',
            respondedAt: '2026-11-12T12:00:30Z',
            maxBytes: 200_000,
          },
        }),
        { waitElapsed: true },
      );
    for (const state of ['RESPONDED', 'APPLIED'] as const) {
      const md = at(state);
      expect(md.split('\n')[0]).toBe(`📨 Code review ${ID} iteration 1 is applying the submitted context.`);
      expect(md).toContain(STILL_RUNNING_TEXT);
      expect(md).not.toContain(NEEDS_CONTEXT_TEXT);
    }
    expect(at('TIMED_OUT').split('\n')[0]).toBe(
      `⏳ Code review ${ID} iteration 1 is resuming without the requested context.`,
    );
  });

  it('a terminal iteration with missing context lists the outcome and is never fully informed', () => {
    const md = renderReview(review({ completeness: completeness(outcome({ timedOut: true })) }));
    expect(md.split('\n')[0]).toBe(
      `✅ Code review ${ID} iteration 1 completed with no findings. ${NO_FINDINGS_CAVEAT} ${MISSING_CONTEXT_TEXT}`,
    );
    expect(md).toContain(
      'Context round 1: 4 requested; 1 provided; declined: r1c2; not found: r1c3; not provided (timed out): r1c4.',
    );
    expect(md.split('\n')).toContain(MISSING_CONTEXT_TEXT);
  });

  it('FINDINGS with missing context also carries the note', () => {
    const md = renderReview(
      review(
        {
          outcome: 'FINDINGS',
          counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 },
          completeness: completeness(outcome()),
        },
        [finding()],
      ),
    );
    expect(md.split('\n')).toContain(MISSING_CONTEXT_TEXT);
  });

  it('fully provided context or no round prints no missing-context text', () => {
    const full = outcome({
      requested: ['r1c1'],
      provided: ['r1c1'],
      declined: [],
      notFound: [],
      unanswered: [],
      missing: false,
    });
    const md = renderReview(review({ completeness: completeness(full) }));
    expect(md).toContain('Context round 1: 1 requested; 1 provided.');
    expect(md).not.toContain(MISSING_CONTEXT_TEXT);
    const none = renderReview(
      review({
        completeness: completeness(
          outcome({
            planner: 'DISABLED',
            round: null,
            requested: [],
            provided: [],
            declined: [],
            notFound: [],
            unanswered: [],
            missing: false,
          }),
        ),
      }),
    );
    expect(none).not.toContain('Context round');
  });
});

describe('finding responses in the findings output', () => {
  const findings = (over = {}) =>
    review({ outcome: 'FINDINGS', counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 } }, [
      finding({
        thread: [
          { author: 'agent', text: 'wont_fix: risk accepted', iteration: 2 },
          { author: 'reviewer', text: 'Still an issue: input is not validated.', iteration: 2 },
        ],
        dismissedByAuthor: true,
        dismissalReason: 'risk accepted',
        dismissalDisposition: 'wont_fix',
        ...over,
      }),
    ]);

  it('renders the thread entries and the blocking-dismissed badge, escaped', () => {
    const md = renderReview(findings());
    expect(md).toContain('**Thread:**');
    expect(md).toContain('*agent (iteration 2):*');
    expect(md).toContain('*reviewer (iteration 2):*');
    expect(md).toContain('> wont_fix: risk accepted');
    expect(md).toContain('> Still an issue: input is not validated.');
    expect(md).toContain('**Blocking, dismissed by author** (wont_fix: risk accepted).');
    expect(md).toContain('gates nothing');
  });

  it('renders the claimed-fixed-still-present badge', () => {
    const md = renderReview(findings({ dismissedByAuthor: false, claimedFixedStillPresent: true }));
    expect(md).toContain('**Claimed fixed, still present.**');
  });

  it('escapes untrusted thread text (no raw HTML)', () => {
    const md = renderReview(
      findings({ thread: [{ author: 'agent', text: '<script>alert(1)</script>', iteration: 2 }] }),
    );
    expect(md).not.toContain('<script>');
    expect(md).toContain('&lt;script&gt;');
  });
});
