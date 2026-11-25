// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { z } from 'zod';
import { changedFilePaths, fitChangedFiles, readChangedFiles } from '../collect/changedFiles.js';
import { scanDiff } from '../collect/diffInfo.js';
import { collectRepo, listTrackedFiles, REF_RE } from '../collect/git.js';
import { buildManifest } from '../collect/manifest.js';
import { countDerivedRefs } from '../collect/gitRefs.js';
import {
  buildPayload,
  buildSummaryMarkdown,
  canonicalJson,
  newClientToken,
  payloadDigest,
  type PayloadSummary,
} from '../collect/payload.js';
import { resolveDataDir } from '../config.js';
import { ToolError } from '../errors.js';
import {
  checkLimit,
  checkPayloadLimits,
  checkRequestBytes,
  checkResponsesLimits,
  LIMITS,
  MAX_CONTEXT_ROUNDS_PER_REVIEW,
  utf8Bytes,
} from '../limits.js';
import { redactDiff, redactText, type RedactionLocation } from '../redact.js';
import { cleanupExpired, newPreparedId, stagePayload } from '../staging.js';
import { CLIENT_VERSION, parseInput, REVIEW_ID_RE, success, type ToolDeps } from './common.js';

/** code_review_prepare: local only, no network. */
export const prepareInputShape = {
  repoPath: z.string().min(1).describe('Absolute path of the git repository root.'),
  base: z
    .string()
    .regex(REF_RE)
    .refine((s) => !s.startsWith('-'), { message: 'must not start with -' })
    .describe('Base ref, e.g. origin/mainline.'),
  level: z.enum(['quick', 'standard', 'deep']).optional().describe('Review depth (new reviews only).'),
  iterationBudget: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.iterationBudgetMax)
    .optional()
    .describe('Max iterations, 1..50 (new reviews only).'),
  contextFiles: z.array(z.string().min(1)).optional().describe('Up to 20 repo-relative files the user approved.'),
  includeUncommitted: z.boolean().optional().describe('Diff the working tree instead of HEAD (default false).'),
  reviewId: z.string().regex(REVIEW_ID_RE).optional().describe('Existing review; prepares a resubmit.'),
  contextRounds: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT_ROUNDS_PER_REVIEW)
    .optional()
    .describe(
      'Rounds in which the reviewer may request more repository context, 0..2 per review (new reviews only; default 2; 0 opts out).',
    ),
  includeChangedFiles: z
    .boolean()
    .optional()
    .describe(
      'Also send the full text of the modified and renamed files, matching include-changed-files in the GitHub action (default true; false opts out). Added files are not attached, since the diff carries them whole; deleted, binary, secret-like and non-text files are skipped. Attached files are redacted, listed in the summary and count toward the context limits; files that do not fit are skipped and listed.',
    ),
  includeManifest: z
    .boolean()
    .optional()
    .describe('Send the tracked file names (no content) so the reviewer can request context (default true).'),
  intent: z
    .string()
    .optional()
    .describe(
      'A short statement of what this change is meant to do, written from the task. Shown in the summary and sent to the reviewer as an untrusted author claim for lightweight spec-drift checking. Optional.',
    ),
  responses: z
    .array(
      z
        .object({
          findingId: z.string().regex(/^f-[0-9a-f]{16}$/),
          disposition: z.enum(['fixed', 'false_positive', 'wont_fix', 'deferred', 'question']),
          comment: z.string().optional(),
          acknowledged: z.boolean().optional(),
        })
        .strict(),
    )
    .optional()
    .describe(
      'Dispositions of the PREVIOUS iteration\'s findings (resubmit only). disposition in fixed | false_positive | wont_fix | deferred | question. For a BLOCKING finding you want to set aside, set acknowledged: true ONLY after the user has said "yes" in chat to that specific finding; the service records an unacknowledged blocking dismissal as a no-op. Shown to the user in the summary.',
    ),
};

/** Dev-only test hook (smoke harness only; not a user setting). */
export const TEST_FAULT_INJECTION_ENV = 'KIRO_CODE_REVIEWER_TEST_FAULT_INJECTION';
export const DEFAULT_CONTEXT_ROUNDS = MAX_CONTEXT_ROUNDS_PER_REVIEW;

function testHook(env: ToolDeps['env']): 'context_request' | undefined {
  const v = env[TEST_FAULT_INJECTION_ENV];
  if (v === undefined || v === '') return undefined;
  if (v === 'context_request') return v;
  throw new ToolError('VALIDATION_ERROR', `${TEST_FAULT_INJECTION_ENV} has an unsupported value.`, {
    issues: [{ path: TEST_FAULT_INJECTION_ENV, message: 'must be context_request' }],
  });
}

export const prepareInputSchema = z.object(prepareInputShape).strict();

export async function prepareTool(input: unknown, deps: ToolDeps) {
  const args = parseInput(prepareInputSchema, input);
  if (!path.isAbsolute(args.repoPath)) {
    throw new ToolError('VALIDATION_ERROR', 'repoPath must be an absolute path.', {
      issues: [{ path: 'repoPath', message: 'must be absolute' }],
    });
  }
  if (
    args.reviewId &&
    (args.level !== undefined || args.iterationBudget !== undefined || args.contextRounds !== undefined)
  ) {
    throw new ToolError(
      'VALIDATION_ERROR',
      'level, iterationBudget and contextRounds are fixed by the review; omit them on a resubmit.',
      {
        issues: [{ path: 'reviewId', message: 'level/iterationBudget/contextRounds must be absent' }],
      },
    );
  }
  if (args.responses !== undefined && args.reviewId === undefined) {
    throw new ToolError('VALIDATION_ERROR', 'responses apply to a resubmit; supply reviewId.', {
      issues: [{ path: 'responses', message: 'requires reviewId' }],
    });
  }
  const faultInjection = testHook(deps.env);
  const contextRounds = args.reviewId ? undefined : (args.contextRounds ?? DEFAULT_CONTEXT_ROUNDS);
  const contextFiles = args.contextFiles ?? [];
  checkLimit('context.files', LIMITS.contextFiles, contextFiles.length);
  const includeUncommitted = args.includeUncommitted ?? false;

  const dataDir = resolveDataDir(deps.env);
  const now = deps.clock.now();
  cleanupExpired(dataDir, now);

  const repo = await collectRepo({ repoPath: args.repoPath, base: args.base, includeUncommitted, contextFiles });

  // Step 8: redaction.
  const redactions: RedactionLocation[] = [];
  const diff = redactDiff(repo.diff);
  redactions.push(...diff.redactions);
  let reviewMd = repo.rules.reviewMd;
  if (reviewMd !== undefined) {
    const r = redactText(reviewMd, 'REVIEW.md');
    reviewMd = r.text;
    redactions.push(...r.redactions);
  }
  const context = repo.context.map((c) => {
    const r = redactText(c.content, c.path);
    redactions.push(...r.redactions);
    return { path: c.path, content: r.text };
  });
  const info = scanDiff(diff.text);
  // Changed files in full, after the user's context files and within what is left of the context limits.
  let includedChangedFiles: PayloadSummary['includedChangedFiles'];
  if (args.includeChangedFiles !== false) {
    const read = await readChangedFiles({
      top: repo.toplevel,
      headSha: repo.headSha,
      includeUncommitted,
      paths: changedFilePaths(info.files),
      exclude: new Set(context.map((c) => c.path)),
    });
    const redacted = read.candidates.map((c) => ({ path: c.path, ...redactText(c.content, c.path) }));
    const fit = fitChangedFiles(
      context,
      redacted.map((r) => ({ path: r.path, content: r.text })),
    );
    const kept = new Set(fit.attached.map((a) => a.path));
    for (const r of redacted) if (kept.has(r.path)) redactions.push(...r.redactions);
    context.push(...fit.attached);
    includedChangedFiles = { attached: fit.attached.map((a) => a.path), skipped: [...read.skipped, ...fit.skipped] };
  }
  // Intent and commit messages are redacted like any text before they leave the machine.
  let intent: string | undefined;
  if (args.intent !== undefined && args.intent !== '') {
    const r = redactText(args.intent, 'intent');
    intent = r.text;
    redactions.push(...r.redactions);
  }
  const commits = repo.commits.map((c, i) => {
    const rs = redactText(c.subject, `commit[${i}].subject`);
    redactions.push(...rs.redactions);
    if (c.body === undefined) return { subject: rs.text };
    const rb = redactText(c.body, `commit[${i}].body`);
    redactions.push(...rb.redactions);
    return { subject: rs.text, body: rb.text };
  });
  const commitBytes = commits.reduce((n, c) => n + utf8Bytes(c.subject) + utf8Bytes(c.body ?? ''), 0);
  // Finding responses: redact comment text before staging; keep the disposition and approval marker.
  const responses = (args.responses ?? []).map((r, i) => {
    if (r.comment === undefined) return r;
    const rc = redactText(r.comment, `response[${i}].comment`);
    redactions.push(...rc.redactions);
    return { ...r, comment: rc.text };
  });
  if (responses.length > 0) checkResponsesLimits(responses);
  const rules = reviewMd !== undefined ? { reviewMd } : {};

  // Step 9: client limit pre-check.
  const diffPaths = info.files.flatMap((f) => [f.path, ...(f.oldPath && f.oldPath !== f.path ? [f.oldPath] : [])]);
  const wantManifest = ((contextRounds ?? 0) > 0 || args.reviewId !== undefined) && args.includeManifest !== false;
  const manifest = wantManifest
    ? buildManifest(await listTrackedFiles(repo.toplevel, repo.headSha, includeUncommitted), diffPaths)
    : [];
  checkPayloadLimits({
    diff: diff.text,
    diffFiles: info.files.length,
    diffPaths,
    changedLines: info.changedLines,
    ...(args.iterationBudget !== undefined ? { iterationBudget: args.iterationBudget } : {}),
    ...(contextRounds !== undefined ? { contextRounds } : {}),
    manifest,
    context,
    rules,
    ...(intent !== undefined ? { intent } : {}),
    ...(commits.length > 0 ? { commits } : {}),
  });

  // Step 10: canonical payload, digest, summary.
  const payload = buildPayload({
    ...(args.reviewId ? { reviewId: args.reviewId } : {}),
    ...(args.level ? { level: args.level } : {}),
    ...(args.iterationBudget !== undefined ? { iterationBudget: args.iterationBudget } : {}),
    baseRef: args.base,
    mergeBase: repo.mergeBase,
    headRef: repo.headRef,
    headSha: repo.headSha,
    includeUncommitted,
    diff: diff.text,
    rules,
    context,
    repo: repo.repoName,
    clientVersion: CLIENT_VERSION,
    clientToken: newClientToken(),
    ...(contextRounds !== undefined ? { contextRounds } : {}),
    manifest,
    ...(intent !== undefined ? { intent } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(responses.length > 0 ? { responses } : {}),
    ...(faultInjection ? { faultInjection } : {}),
  });
  checkRequestBytes(canonicalJson(payload));
  const digest = payloadDigest(payload);
  const summary: PayloadSummary = {
    repo: repo.repoName,
    base: args.base,
    baseSha: repo.baseSha,
    mergeBase: repo.mergeBase,
    head: repo.headRef,
    headSha: repo.headSha,
    includeUncommitted,
    files: info.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed })),
    diffBytes: utf8Bytes(diff.text),
    changedLines: info.changedLines,
    rules: {
      reviewMd: rules.reviewMd !== undefined,
      revision: repo.mergeBase,
    },
    contextFiles: context.map((c) => ({ path: c.path, bytes: utf8Bytes(c.content) })),
    ...(includedChangedFiles ? { includedChangedFiles } : {}),
    redactions,
    ...(args.reviewId
      ? { reviewId: args.reviewId }
      : { level: payload.level, iterationBudget: payload.iterationBudget, contextRounds }),
    manifestPaths: manifest.length,
    ...(intent !== undefined ? { intent } : {}),
    ...(commits.length > 0 ? { commitCount: commits.length, commitBytes, refCount: countDerivedRefs(commits) } : {}),
    ...(responses.length > 0 ? { responses } : {}),
    ...(faultInjection ? { testHook: faultInjection } : {}),
  };
  const summaryMarkdown = buildSummaryMarkdown(summary);

  // Step 11: stage.
  const preparedId = newPreparedId();
  stagePayload(dataDir, preparedId, {
    kind: 'review',
    payload,
    digest,
    summaryMarkdown,
    ...(args.reviewId ? { reviewId: args.reviewId } : {}),
    createdAt: new Date(now).toISOString(),
  });
  deps.log(`code_review_prepare: staged ${preparedId}`);
  return success(summaryMarkdown, { preparedId, payloadDigest: digest, summary, summaryMarkdown });
}
