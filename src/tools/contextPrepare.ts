// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { z } from 'zod';
import { callApi } from '../client/http.js';
import type { ContextResponseRequest, GetReviewResponse } from '../client/types.js';
import { answerRequests, refusalReason } from '../collect/contextAnswers.js';
import { decodeRepoText, openRepo, readRepoFile } from '../collect/git.js';
import { buildContextSummaryMarkdown, canonicalJson, payloadDigest } from '../collect/payload.js';
import { loadServiceConfig, resolveDataDir } from '../config.js';
import { ToolError } from '../errors.js';
import { checkContextResponseLimits, checkRequestBytes, LIMITS, limitExceeded, utf8Bytes } from '../limits.js';
import { redactText, type RedactionLocation } from '../redact.js';
import { checkRequestPath } from '../safety.js';
import { cleanupExpired, newPreparedId, stagePayload } from '../staging.js';
import { parseInput, REVIEW_ID_RE, success, type ToolDeps } from './common.js';

/**
 * code_review_context_prepare: auto-approved; its only network call is the read-only
 * GetReview. Answers the reviewer's context requests locally (path refusal, denylist, redaction,
 * limits) and stages a digest-bound response for code_review_context_submit.
 */

export const REQUEST_ID_RE = /^r[1-9]c[1-9]$/;

export const contextPrepareInputShape = {
  repoPath: z.string().min(1).describe('Absolute path of the git repository root.'),
  reviewId: z.string().regex(REVIEW_ID_RE).describe('reviewId whose iteration is NEEDS_CONTEXT.'),
  iteration: z.number().int().min(1).max(5).optional().describe('Iteration number (default latest).'),
  includeUncommitted: z
    .boolean()
    .optional()
    .describe('Read files from the working tree instead of HEAD (default false).'),
  decline: z
    .array(z.string().regex(REQUEST_ID_RE))
    .optional()
    .describe('Request ids the user does not want shared; they are sent as declined.'),
  extraFiles: z
    .array(z.string().min(1))
    .max(LIMITS.contextResponseUnsolicitedFiles)
    .optional()
    .describe('Up to 8 extra repo-relative files, only when the user asks to share them.'),
};

export const contextPrepareInputSchema = z.object(contextPrepareInputShape).strict();

export async function contextPrepareTool(input: unknown, deps: ToolDeps) {
  const args = parseInput(contextPrepareInputSchema, input);
  if (!path.isAbsolute(args.repoPath)) {
    throw new ToolError('VALIDATION_ERROR', 'repoPath must be an absolute path.', {
      issues: [{ path: 'repoPath', message: 'must be absolute' }],
    });
  }
  const includeUncommitted = args.includeUncommitted ?? false;
  const dataDir = resolveDataDir(deps.env);
  const now = deps.clock.now();
  cleanupExpired(dataDir, now);

  // The open round, read from the service (read-only).
  const config = loadServiceConfig(deps.env);
  const review = (
    await callApi<GetReviewResponse>(
      config,
      {
        method: 'GET',
        path: `/reviews/${args.reviewId}`,
        ...(args.iteration !== undefined ? { query: { iteration: String(args.iteration) } } : {}),
      },
      deps.http,
    )
  ).body;
  const it = review.iteration;
  const round = it.contextRound ?? null;
  if (round && (round.state === 'EXPIRED' || round.state === 'TIMED_OUT')) {
    throw new ToolError(
      'CONTEXT_WINDOW_CLOSED',
      'The context window closed; the review continues without this context.',
      {
        ...(round.expiresAt ? { expiresAt: round.expiresAt } : {}),
      },
    );
  }
  if (it.status !== 'NEEDS_CONTEXT' || !round || round.state !== 'AWAITING') {
    throw new ToolError('CONTEXT_NOT_REQUESTED', 'This review iteration is not waiting for context.');
  }
  const requests = it.contextRequests ?? [];
  const decline = new Set(args.decline ?? []);
  for (const id of decline) {
    if (!requests.some((r) => r.requestId === id)) {
      throw new ToolError('VALIDATION_ERROR', 'decline names a request id that is not in this round.', {
        issues: [{ path: 'decline', message: 'unknown request id' }],
      });
    }
  }

  // Local answers.
  const repo = await openRepo(args.repoPath);
  const answered = await answerRequests({
    top: repo.top,
    headSha: repo.headSha,
    includeUncommitted,
    requests,
    decline,
    maxBytes: round.maxBytes,
  });
  const redactions: RedactionLocation[] = [...answered.redactions];
  let total = answered.decisions.reduce((a, d) => a + d.bytes, 0);

  // Extra files the user chose to share: refusals are errors here (nothing is silently dropped).
  const context: Array<{ path: string; content: string }> = [];
  for (const rel of args.extraFiles ?? []) {
    const check = checkRequestPath(repo.top, rel);
    if (!check.ok) {
      const reason = refusalReason(check.reason);
      if (reason === null) throw new ToolError('CONTEXT_NOT_FOUND', 'An extra file does not exist.');
      throw new ToolError('CONTEXT_PATH_INVALID', `An extra file was refused (${reason}).`);
    }
    const buf = await readRepoFile(repo.top, repo.headSha, check.posix, includeUncommitted);
    if (buf === null) {
      throw new ToolError(
        'CONTEXT_NOT_FOUND',
        'An extra file is not committed at HEAD (commit it or use includeUncommitted).',
      );
    }
    const text = decodeRepoText(buf);
    if (text === null) throw new ToolError('CONTEXT_NOT_TEXT', 'An extra file is not UTF-8 text.');
    const red = redactText(text, check.posix);
    redactions.push(...red.redactions);
    context.push({ path: check.posix, content: red.text });
    total += utf8Bytes(red.text);
  }

  const body: ContextResponseRequest = {
    round: round.round,
    responses: answered.responses,
    ...(context.length > 0 ? { context } : {}),
  };
  checkContextResponseLimits(body);
  if (total > round.maxBytes) {
    const limit =
      round.maxBytes >= LIMITS.contextResponseTotalBytes ? 'contextResponse.totalBytes' : 'context.iterationTotalBytes';
    throw limitExceeded(limit, round.maxBytes, total);
  }
  checkRequestBytes(canonicalJson(body));
  const digest = payloadDigest(body);
  const summaryMarkdown = buildContextSummaryMarkdown({
    reviewId: review.reviewId,
    iteration: it.number,
    round: round.round,
    expiresAt: round.expiresAt,
    decisions: answered.decisions,
    extraFiles: context.map((c) => ({ path: c.path, bytes: utf8Bytes(c.content) })),
    redactions,
  });

  const preparedId = newPreparedId();
  stagePayload(dataDir, preparedId, {
    kind: 'context',
    apiPath: `/reviews/${review.reviewId}/iterations/${it.number}/context`,
    payload: body,
    digest,
    summaryMarkdown,
    reviewId: review.reviewId,
    createdAt: new Date(now).toISOString(),
  });
  deps.log(`code_review_context_prepare: staged ${preparedId} for ${review.reviewId} round ${round.round}`);
  return success(summaryMarkdown, {
    preparedId,
    payloadDigest: digest,
    summaryMarkdown,
    expiresAt: round.expiresAt,
    decisions: answered.decisions,
  });
}
