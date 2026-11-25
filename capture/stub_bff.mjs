// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Stand-in for the Kiro BFF, used only to photograph the Crew page: it answers the review operations over
// Smithy RPC v2 CBOR with made-up reviews of a made-up shop. capture/demo-backend.mjs bundles it into the page
// backend; see capture/run.sh.
import { cbor } from '@smithy/core/cbor';
const HOUR = 3_600_000;
const now = Date.now();
const ago = (h) => now - h * HOUR;

const ID_A = 'rev-5b1f0c7e2a9d4e6831c0aa11';
const ID_B = 'rev-9d3a41c8e07b2f5566d1bb22';
const ID_C = 'rev-2c8e6f10b4a7d9e3055fcc33';
const F = {
  sql: 'f-a1b2c3d4e5f60718',
  authz: 'f-b2c3d4e5f6071829',
  amount: 'f-c3d4e5f607182930',
  csv: 'f-d4e5f60718293041',
};
const BASE = { ref: 'origin/main', commit: '8e1c4f2a9b7d03c56e1f2a3b4c5d6e7f80910a1b' };
const HEAD = { ref: 'feature/order-lookup', commit: '3f2a1c47d8e9b0a1c2d3e4f5061728394a5b6c7d' };

const body1 = [
  "const express = require('express');",
  "const db = require('../db');",
  '',
  'const router = express.Router();',
  '',
  "// Look up one customer's orders by the email in the query string.",
  "router.get('/orders', async (req, res) => {",
  '  const email = req.query.email;',
  '  const rows = await db.query(',
  '    "SELECT id, total, status FROM orders WHERE customer_email = \'" + email + "\'"',
  '  );',
  '  res.json(rows);',
  '});',
  '',
  "router.post('/orders/:id/refund', async (req, res) => {",
  '  const amount = req.body.amount;',
  "  await db.query('UPDATE orders SET refunded = refunded + $1 WHERE id = $2', [",
  '    amount,',
  '    req.params.id,',
  '  ]);',
  '  res.json({ ok: true });',
  '});',
  '',
  "router.get('/orders/:id/export', async (req, res) => {",
  "  const rows = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);",
  "  res.type('text/csv').send(rows.map((r) => Object.values(r).join(',')).join('\\n'));",
  '});',
  '',
  'module.exports = router;',
];
const body2 = [
  ...body1.slice(0, 8),
  '  const rows = await db.query(',
  "    'SELECT id, total, status FROM orders WHERE customer_email = $1',",
  '    [email],',
  '  );',
  ...body1.slice(11),
];
const diffOf = (lines) =>
  [
    'diff --git a/src/routes/orders.js b/src/routes/orders.js',
    'new file mode 100644',
    'index 0000000..3f2a1c4',
    '--- /dev/null',
    '+++ b/src/routes/orders.js',
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');

const finding = (id, extra) => ({
  findingId: id,
  fingerprint: `fp-${id.slice(2)}`,
  file: 'src/routes/orders.js',
  side: 'new',
  suppressed: false,
  firstSeenIteration: 1,
  carriedForward: false,
  verified: true,
  reviewers: ['security'],
  ...extra,
});

const reviews = {
  [ID_A]: {
    reviewId: ID_A,
    level: 'standard',
    iterationBudget: 5,
    createdAt: ago(5),
    updatedAt: ago(1),
    repo: 'trailhead-outfitters/storefront',
    iterations: [
      { number: 1, status: 'COMPLETED', createdAt: ago(5) },
      { number: 2, status: 'COMPLETED', createdAt: ago(1) },
    ],
    findingsByIteration: {
      1: [
        finding(F.sql, {
          startLine: 9,
          endLine: 11,
          severity: 'critical',
          blocking: true,
          category: 'security',
          title: 'Customer email is concatenated into the SQL query',
          explanation:
            "The email from the query string is pasted into the SQL text, so a request such as `?email=x' OR '1'='1` returns every customer's orders. This is an SQL injection.",
          suggestion: "Pass the email as a bound parameter: db.query('... WHERE customer_email = $1', [email]).",
          state: 'NEW',
          resolvedIteration: null,
          confidence: 0.97,
        }),
        finding(F.authz, {
          startLine: 15,
          endLine: 15,
          severity: 'high',
          blocking: true,
          category: 'security',
          title: 'Refund route can be called by anyone',
          explanation:
            'POST /orders/:id/refund changes money fields but nothing checks who is calling or whether they may refund this order.',
          suggestion:
            'Require a signed-in staff user before the handler runs, and check the order belongs to the shop.',
          state: 'NEW',
          resolvedIteration: null,
          confidence: 0.9,
        }),
        finding(F.amount, {
          startLine: 16,
          endLine: 20,
          severity: 'medium',
          blocking: false,
          category: 'correctness',
          title: 'Refund amount is not validated',
          explanation:
            'A negative, zero or non-numeric amount is written to the database as is, so a refund can add money back to the total.',
          suggestion: 'Reject anything that is not a positive number no larger than the order total.',
          state: 'NEW',
          resolvedIteration: null,
          confidence: 0.85,
          reviewers: ['correctness'],
        }),
        finding(F.csv, {
          startLine: 26,
          endLine: 26,
          severity: 'low',
          blocking: false,
          category: 'security',
          title: 'CSV export does not guard against spreadsheet formulas',
          explanation:
            'A value that starts with = + - or @ is run as a formula when the file is opened in a spreadsheet.',
          suggestion: 'Prefix such values with a single quote before joining them.',
          state: 'NEW',
          resolvedIteration: null,
          confidence: 0.6,
        }),
      ],
      2: [
        finding(F.sql, {
          startLine: 9,
          endLine: 11,
          severity: 'critical',
          blocking: true,
          category: 'security',
          title: 'Customer email is concatenated into the SQL query',
          explanation:
            'The email is now passed as a bound parameter, so the query text no longer depends on the request.',
          suggestion: null,
          state: 'RESOLVED',
          resolvedIteration: 2,
          confidence: 0.97,
        }),
        finding(F.authz, {
          startLine: 16,
          endLine: 16,
          severity: 'high',
          blocking: true,
          category: 'security',
          title: 'Refund route can be called by anyone',
          explanation:
            'POST /orders/:id/refund changes money fields but nothing checks who is calling or whether they may refund this order.',
          suggestion:
            'Require a signed-in staff user before the handler runs, and check the order belongs to the shop.',
          state: 'PERSISTING',
          resolvedIteration: null,
          carriedForward: true,
          confidence: 0.9,
        }),
        finding(F.amount, {
          startLine: 17,
          endLine: 21,
          severity: 'medium',
          blocking: false,
          category: 'correctness',
          title: 'Refund amount is not validated',
          explanation:
            'A negative, zero or non-numeric amount is written to the database as is, so a refund can add money back to the total.',
          suggestion: 'Reject anything that is not a positive number no larger than the order total.',
          state: 'PERSISTING',
          resolvedIteration: null,
          carriedForward: true,
          confidence: 0.85,
          reviewers: ['correctness'],
        }),
        finding(F.csv, {
          startLine: 27,
          endLine: 27,
          severity: 'low',
          blocking: false,
          category: 'security',
          title: 'CSV export does not guard against spreadsheet formulas',
          explanation:
            'A value that starts with = + - or @ is run as a formula when the file is opened in a spreadsheet.',
          suggestion: 'Prefix such values with a single quote before joining them.',
          state: 'PERSISTING',
          resolvedIteration: null,
          carriedForward: true,
          confidence: 0.6,
        }),
      ],
    },
    diffs: { 1: diffOf(body1), 2: diffOf(body2) },
    head: HEAD,
    intent: 'Add an order lookup by customer email and a refund action to the storefront API.',
    commits: [{ subject: 'Add order lookup, refund and export routes' }],
  },
  [ID_B]: summary('feature/gift-cards', 'COMPLETED', 'NO_FINDINGS', ago(26), 'quick'),
  [ID_C]: summary('fix/cart-rounding', 'COMPLETED', 'FINDINGS', ago(50), 'deep', 1),
};

function summary(headRef, status, outcome, created, level, low = 0) {
  return {
    reviewId: headRef === 'feature/gift-cards' ? ID_B : ID_C,
    level,
    iterationBudget: 5,
    createdAt: created,
    updatedAt: created + HOUR / 4,
    repo: 'trailhead-outfitters/storefront',
    iterations: [{ number: 1, status, createdAt: created }],
    findingsByIteration: {
      1: low
        ? [
            finding('f-e5f6071829304152', {
              file: 'src/cart/totals.js',
              startLine: 14,
              endLine: 14,
              severity: 'low',
              blocking: false,
              category: 'correctness',
              title: 'Rounding is applied to each line instead of the total',
              explanation: 'Rounding every line first can make the total differ from the sum by a cent.',
              suggestion: 'Round once, after adding the lines.',
              state: 'NEW',
              resolvedIteration: null,
              confidence: 0.7,
              reviewers: ['correctness'],
            }),
          ]
        : [],
    },
    diffs: { 1: diffOf(body1.slice(0, 3)) },
    head: { ref: headRef, commit: HEAD.commit },
    outcome,
  };
}

const state = { feedback: {}, suppressed: {} };

function currentFindings(r, it) {
  return (r.findingsByIteration[it] ?? []).map((f) => {
    const s = state.suppressed[f.findingId];
    const fb = state.feedback[f.findingId];
    return {
      ...f,
      ...(s ? { suppressed: true, suppressionReason: s.reason } : {}),
      ...(fb ? { feedback: fb } : {}),
    };
  });
}

function countsOf(findings) {
  const active = findings.filter((f) => f.state !== 'RESOLVED' && !f.suppressed);
  return {
    active: active.length,
    blocking: active.filter((f) => f.blocking).length,
    suppressed: findings.filter((f) => f.suppressed).length,
    resolved: findings.filter((f) => f.state === 'RESOLVED').length,
  };
}

function iterationView(r, n) {
  const it = r.iterations.find((i) => i.number === n);
  const fs = currentFindings(r, n);
  const counts = countsOf(fs);
  return {
    number: n,
    status: it.status,
    outcome: counts.active + counts.suppressed + counts.resolved > 0 ? 'FINDINGS' : 'NO_FINDINGS',
    counts,
    warnings: [],
    base: BASE,
    createdAt: it.createdAt,
    startedAt: it.createdAt + 1000,
    completedAt: it.createdAt + 40_000,
  };
}

const handlers = {
  ListCodeReviews: () => ({
    reviews: Object.values(reviews)
      .map((r) => {
        const n = r.iterations.length;
        return {
          reviewId: r.reviewId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          level: r.level,
          latestIteration: n,
          status: 'COMPLETED',
          counts: countsOf(currentFindings(r, n)),
          repo: r.repo,
          headRef: r.head.ref,
          baseRef: BASE.ref,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }),
  GetCodeReview: ({ reviewId, iteration }) => {
    const r = reviews[reviewId];
    if (!r) throw notFound();
    const latest = r.iterations.length;
    const n = iteration ?? latest;
    return {
      reviewId,
      level: r.level,
      iterationBudget: r.iterationBudget,
      latestIteration: latest,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      iterations: r.iterations.map((i) => ({ number: i.number, status: i.status })),
      iteration: iterationView(r, n),
      findings: currentFindings(r, n),
    };
  },
  GetCodeReviewIterationPayload: ({ reviewId, iteration }) => {
    const r = reviews[reviewId];
    if (!r || !r.diffs[iteration]) throw notFound();
    return {
      reviewId,
      iteration,
      sentAt: r.iterations[iteration - 1].createdAt,
      base: BASE,
      head: r.head,
      level: r.level,
      diff: r.diffs[iteration],
      context: [],
      intent: r.intent,
      commits: r.commits,
      manifestCount: 0,
      contextRounds: [],
      expiresAt: now + 30 * 24 * HOUR,
    };
  },
  UpdateCodeReviewFinding: ({ reviewId, findingId, reason }) => {
    state.suppressed[findingId] = { reason: reason ?? null };
    return { reviewId, findingId, suppressed: true, ...(reason ? { reason } : {}), createdAt: Date.now() };
  },
  UpdateCodeReviewFeedback: ({ reviewId, findingId, vote, reason, comment }) => {
    const fb = { vote, ...(reason ? { reason } : {}), ...(comment ? { comment } : {}), updatedAt: Date.now() };
    state.feedback[findingId] = fb;
    return { reviewId, findingId, ...fb };
  },
};

function notFound() {
  return Object.assign(new Error('not found'), { status: 404, type: 'ResourceNotFoundException' });
}

/** A `fetch` that answers the Kiro BFF's review operations from the demo data above. */
export function stubFetch() {
  return async (input, init = {}) => {
    const op = String(input).split('/').pop();
    const reply = (status, obj) =>
      new Response(cbor.serialize(obj), {
        status,
        headers: { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor' },
      });
    try {
      const bytes = init.body ? new Uint8Array(init.body) : new Uint8Array();
      const args = bytes.length ? cbor.deserialize(bytes) : {};
      if (!handlers[op]) return reply(400, { __type: 'ValidationException', message: `no such operation ${op}` });
      return reply(200, handlers[op](args));
    } catch (e) {
      return reply(e.status ?? 500, { __type: e.type ?? 'InternalServerException', message: String(e.message) });
    }
  };
}
