// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { callApi } from '../client/http.js';
import type { SuppressResponse } from '../client/types.js';
import { canonicalJson } from '../collect/payload.js';
import { loadServiceConfig } from '../config.js';
import { checkSuppressReason } from '../limits.js';
import { escapeCell } from '../render.js';
import { FINDING_ID_RE, parseInput, REVIEW_ID_RE, success, type ToolDeps } from './common.js';

/** code_review_suppress: NOT auto-approved; only on the user's explicit request. */
export const suppressInputShape = {
  reviewId: z.string().regex(REVIEW_ID_RE).describe('The review the finding belongs to.'),
  findingId: z.string().regex(FINDING_ID_RE).describe('The finding to suppress, f-<16 hex>.'),
  reason: z.string().optional().describe('Why the user suppresses it (≤ 500 chars).'),
};

export const suppressInputSchema = z.object(suppressInputShape).strict();

export async function suppressTool(input: unknown, deps: ToolDeps) {
  const args = parseInput(suppressInputSchema, input);
  checkSuppressReason(args.reason);
  const config = loadServiceConfig(deps.env);
  const body = canonicalJson(args.reason !== undefined ? { reason: args.reason } : {});
  const res = await callApi<SuppressResponse>(
    config,
    { method: 'POST', path: `/reviews/${args.reviewId}/findings/${args.findingId}/suppress`, body },
    deps.http,
  );
  const r = res.body;
  deps.log(`code_review_suppress: ${r.reviewId} ${r.findingId}`);
  const reason = r.reason ? ` Reason: ${escapeCell(r.reason)}` : '';
  return success(`🔕 Suppressed ${r.findingId} in code review ${r.reviewId}.${reason}`, { ...r });
}
