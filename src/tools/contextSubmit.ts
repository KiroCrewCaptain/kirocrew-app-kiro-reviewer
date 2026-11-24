// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { callApi } from '../client/http.js';
import type { ContextResponseAccepted } from '../client/types.js';
import { canonicalJson, sha256Hex } from '../collect/payload.js';
import { loadServiceConfig, resolveDataDir } from '../config.js';
import { ToolError } from '../errors.js';
import { saveContextRound } from '../payloadStore.js';
import { deleteStaged, loadStaged, PREPARED_ID_RE } from '../staging.js';
import type { ContextResponseRequest } from '../client/types.js';
import { DIGEST_RE, parseInput, success, type ToolDeps } from './common.js';

/** code_review_context_submit: POSTs the context response `code_review_context_prepare` staged, bound by its digest. */

export const contextSubmitInputShape = {
  preparedId: z.string().regex(PREPARED_ID_RE).describe('preparedId returned by code_review_context_prepare.'),
  payloadDigest: z.string().regex(DIGEST_RE).describe('payloadDigest returned by code_review_context_prepare.'),
};

export const contextSubmitInputSchema = z.object(contextSubmitInputShape).strict();

const CONTEXT_PATH_RE = /^\/reviews\/rev-[0-9a-f]{24}\/iterations\/[1-9][0-9]{0,3}\/context$/;
export const CONTEXT_WINDOW_CLOSED_MESSAGE = 'The context window closed; the review continues without this context.';

export async function contextSubmitTool(input: unknown, deps: ToolDeps) {
  const args = parseInput(contextSubmitInputSchema, input);
  const dataDir = resolveDataDir(deps.env);

  const staged = loadStaged(dataDir, args.preparedId, deps.clock.now());
  if (!staged) {
    throw new ToolError(
      'PREPARED_NOT_FOUND',
      'No staged context for this preparedId (missing or expired after 30 min).',
    );
  }
  if (staged.kind !== 'context' || !staged.apiPath || !CONTEXT_PATH_RE.test(staged.apiPath)) {
    throw new ToolError(
      'PREPARED_KIND_MISMATCH',
      'This preparedId holds a review payload; send it with code_review_submit.',
    );
  }
  const body = canonicalJson(staged.payload);
  const recomputed = sha256Hex(body);
  if (recomputed !== staged.digest || recomputed !== args.payloadDigest) {
    throw new ToolError('DIGEST_MISMATCH', 'payloadDigest does not match the staged context; nothing was sent.');
  }

  const config = loadServiceConfig(deps.env);
  let res;
  try {
    res = await callApi<ContextResponseAccepted>(config, { method: 'POST', path: staged.apiPath, body }, deps.http);
  } catch (e) {
    if (e instanceof ToolError && e.details.serviceCode === 'CONTEXT_WINDOW_CLOSED') {
      throw new ToolError('CONTEXT_WINDOW_CLOSED', CONTEXT_WINDOW_CLOSED_MESSAGE, { httpStatus: e.details.httpStatus });
    }
    throw e;
  }
  if (res.status === 202) deleteStaged(dataDir, args.preparedId);
  const r = res.body;
  const list = (xs: unknown): string[] =>
    Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : [];
  const accepted = {
    reviewId: r.reviewId,
    iteration: r.iteration,
    round: r.round,
    status: r.status,
    provided: list(r.provided),
    declined: list(r.declined),
    notFound: list(r.notFound),
    unanswered: list(r.unanswered),
    unsolicited: typeof r.unsolicited === 'number' ? r.unsolicited : 0,
  };
  try {
    saveContextRound(
      dataDir,
      accepted.reviewId,
      accepted.iteration,
      staged.payload as ContextResponseRequest,
      new Date(deps.clock.now()).toISOString(),
    );
  } catch {
    deps.log('code_review_context_submit: could not store the sent context');
  }
  deps.log(`code_review_context_submit: ${accepted.reviewId} iteration ${accepted.iteration} round ${accepted.round}`);
  const markdown = `📨 Sent context for code review ${accepted.reviewId} iteration ${accepted.iteration}, round ${accepted.round}: ${accepted.provided.length} provided, ${accepted.declined.length} declined, ${accepted.notFound.length} not found, ${accepted.unanswered.length} unanswered, ${accepted.unsolicited} extra files. Call code_review_get with this reviewId for results.`;
  return success(markdown, accepted);
}
