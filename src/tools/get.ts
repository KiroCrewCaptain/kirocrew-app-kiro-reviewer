// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { callApi, FETCH_TIMEOUT_MS } from '../client/http.js';
import type { GetReviewResponse } from '../client/types.js';
import { TERMINAL_STATUSES } from '../client/types.js';
import { loadServiceConfig, type ServiceConfig } from '../config.js';
import { awaitingContext, displayOutcome, renderReview } from '../render.js';
import { parseInput, REVIEW_ID_RE, success, type ToolDeps } from './common.js';

/** code_review_get: auto-approved, read-only, bounded wait. */
export const POLL_INTERVAL_MS = 5_000;
export const MAX_WAIT_SECONDS = 90;
export const DEFAULT_WAIT_SECONDS = 60;

export const getInputShape = {
  reviewId: z.string().regex(REVIEW_ID_RE).describe('reviewId returned by code_review_submit.'),
  iteration: z.number().int().min(1).max(5).optional().describe('Iteration number (default latest).'),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      'Seconds to wait for a terminal status or an open context request (NEEDS_CONTEXT with an AWAITING round), 0..90 (default 60).',
    ),
};

export const getInputSchema = z.object(getInputShape).strict();

export async function getTool(input: unknown, deps: ToolDeps) {
  const args = parseInput(getInputSchema, input);
  const config = loadServiceConfig(deps.env);
  const waitMs = (args.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  const start = deps.clock.now();
  const elapsed = (): number => deps.clock.now() - start;
  // A retry or another poll may start only if it cannot finish after the wait budget (+ one fetch timeout).
  const fits = (delayMs: number): boolean => elapsed() + delayMs + FETCH_TIMEOUT_MS <= waitMs;

  const fetchReview = (cfg: ServiceConfig) =>
    callApi<GetReviewResponse>(
      cfg,
      {
        method: 'GET',
        path: `/reviews/${args.reviewId}`,
        ...(args.iteration !== undefined ? { query: { iteration: String(args.iteration) } } : {}),
        shouldRetry: fits,
      },
      deps.http,
    );

  // An open (AWAITING) context round stops the wait: the context window is about 2 minutes. NEEDS_CONTEXT with a
  // submitted round (RESPONDED/APPLIED) or a closed one is still being resumed, so keep waiting.
  const stopWaiting = (r: GetReviewResponse): boolean =>
    TERMINAL_STATUSES.includes(r.iteration.status) || awaitingContext(r);

  let review = (await fetchReview(config)).body;
  while (!stopWaiting(review)) {
    if (elapsed() + POLL_INTERVAL_MS + FETCH_TIMEOUT_MS > waitMs) break;
    await deps.clock.sleep(POLL_INTERVAL_MS);
    try {
      review = (await fetchReview(config)).body;
    } catch {
      break; // Return the last good state.
    }
  }

  const terminal = TERMINAL_STATUSES.includes(review.iteration.status);
  const needsContext = awaitingContext(review);
  const outcome = displayOutcome(review.iteration.status, review.iteration.counts.active);
  const markdown = renderReview(review, { waitElapsed: !terminal && !needsContext });
  deps.log(`code_review_get: ${review.reviewId} iteration ${review.iteration.number} ${review.iteration.status}`);
  return success(markdown, {
    ...review,
    iteration: { ...review.iteration, outcome },
    markdown,
    ...(needsContext ? { needsContext: true } : terminal ? {} : { stillRunning: true }),
  } as unknown as Record<string, unknown>);
}
