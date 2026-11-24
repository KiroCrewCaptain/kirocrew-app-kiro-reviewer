// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { callApi } from '../client/http.js';
import type { SubmitRequest, SubmitResponse } from '../client/types.js';
import { canonicalJson, sha256Hex } from '../collect/payload.js';
import { loadServiceConfig, resolveDataDir } from '../config.js';
import { recordReview } from '../history.js';
import { saveSubmission } from '../payloadStore.js';
import { ToolError } from '../errors.js';
import { deleteStaged, loadStaged, PREPARED_ID_RE } from '../staging.js';
import { DIGEST_RE, parseInput, success, type ToolDeps } from './common.js';
import { escapeCell, EXCLUDED_LIST_MAX, listWithMore } from '../render.js';

/** code_review_submit: sends the payload `code_review_prepare` staged, bound by its digest. */
export const submitInputShape = {
  preparedId: z.string().regex(PREPARED_ID_RE).describe('preparedId returned by code_review_prepare.'),
  payloadDigest: z.string().regex(DIGEST_RE).describe('payloadDigest returned by code_review_prepare.'),
};

export const submitInputSchema = z.object(submitInputShape).strict();

export async function submitTool(input: unknown, deps: ToolDeps) {
  const args = parseInput(submitInputSchema, input);
  const dataDir = resolveDataDir(deps.env);

  // Step 1: staged payload.
  const staged = loadStaged(dataDir, args.preparedId, deps.clock.now());
  if (!staged) {
    throw new ToolError(
      'PREPARED_NOT_FOUND',
      'No staged payload for this preparedId (missing or expired after 30 min).',
    );
  }
  if ((staged.kind ?? 'review') !== 'review') {
    throw new ToolError(
      'PREPARED_KIND_MISMATCH',
      'This preparedId holds context for a review round; send it with code_review_context_submit.',
    );
  }
  // Step 2: byte-exact digest binding.
  const body = canonicalJson(staged.payload);
  const recomputed = sha256Hex(body);
  if (recomputed !== staged.digest || recomputed !== args.payloadDigest) {
    throw new ToolError('DIGEST_MISMATCH', 'payloadDigest does not match the staged payload; nothing was sent.');
  }

  // Step 3: only now touch the network.
  const config = loadServiceConfig(deps.env);
  const path = staged.reviewId ? `/reviews/${staged.reviewId}/iterations` : '/reviews';
  const res = await callApi<SubmitResponse>(config, { method: 'POST', path, body }, deps.http);

  // Step 4: success.
  if (res.status === 202) deleteStaged(dataDir, args.preparedId);
  const r = res.body;
  recordSubmitted(dataDir, r.reviewId, r.iteration, staged.payload as SubmitRequest, deps);
  deps.log(`code_review_submit: ${r.reviewId} iteration ${r.iteration} ${r.status}`);
  const warnings = Array.isArray(r.warnings) && r.warnings.length > 0 ? ` Warnings: ${r.warnings.join(', ')}.` : '';
  const excludedFiles = Array.isArray(r.excludedFiles) ? r.excludedFiles : [];
  const excluded =
    excludedFiles.length > 0
      ? ` ${excludedFiles.length} file(s) excluded from review (generated/fixture/lock/vendored): ${listWithMore(excludedFiles, EXCLUDED_LIST_MAX, (p) => `\`${escapeCell(p)}\``)}.`
      : '';
  const markdown = `📨 Submitted code review ${r.reviewId} iteration ${r.iteration} of ${r.iterationBudget} (status ${r.status}).${warnings}${excluded} Call code_review_get with this reviewId for results.`;
  return success(markdown, {
    reviewId: r.reviewId,
    iteration: r.iteration,
    status: r.status,
    iterationBudget: r.iterationBudget,
    warnings: r.warnings ?? [],
    excludedFiles,
  });
}

const INTENT_MAX = 200;

/** Records the review and what was sent for the Crew page. A write failure must not fail an accepted submit. */
function recordSubmitted(
  dataDir: string,
  reviewId: string,
  iteration: number,
  payload: SubmitRequest,
  deps: ToolDeps,
): void {
  const sentAt = new Date(deps.clock.now()).toISOString();
  try {
    saveSubmission(dataDir, reviewId, iteration, payload, sentAt);
  } catch {
    deps.log('code_review_submit: could not store the sent payload');
  }
  try {
    recordReview(dataDir, {
      reviewId,
      trackedAt: sentAt,
      ...(payload.client?.repo ? { repo: payload.client.repo } : {}),
      ...(payload.head?.ref ? { headRef: payload.head.ref } : {}),
      baseRef: payload.base.ref,
      ...(payload.level ? { level: payload.level } : {}),
      ...(payload.intent ? { intent: payload.intent.slice(0, INTENT_MAX) } : {}),
    });
  } catch {
    deps.log('code_review_submit: could not record review history');
  }
}
