// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { callApi } from '../client/http.js';
import type {
  FeedbackReason,
  FeedbackResponse,
  FeedbackVote,
  FindingFeedback,
  GetReviewResponse,
  IterationPayloadResponse,
  ListReviewsResponse,
  UnsuppressResponse,
} from '../client/types.js';
import { loadServiceApiFlags, loadServiceConfig, resolveDataDir } from '../config.js';
import { ToolError } from '../errors.js';
import { readHistory, type HistoryEntry } from '../history.js';
import { loadStored, type StoredIteration } from '../payloadStore.js';
import { FINDING_ID_RE, REVIEW_ID_RE, type ToolDeps } from '../tools/common.js';

/**
 * The three service APIs the page needs. Each goes to the service when its
 * `serviceApis` flag is on, and to local stub data in the data dir otherwise.
 */

export const FEEDBACK_COMMENT_MAX = 500;
const VOTES: readonly FeedbackVote[] = ['up', 'down'];
const REASONS: readonly FeedbackReason[] = ['wrong', 'not_relevant', 'too_minor', 'already_handled', 'other'];

export interface FeedbackInput {
  vote: FeedbackVote | null;
  reason?: FeedbackReason;
  comment?: string;
}

/** Validates a feedback body with the service's rules. */
export function parseFeedback(body: Record<string, unknown>): FeedbackInput {
  const { vote, reason, comment } = body;
  if (vote !== null && !VOTES.includes(vote as FeedbackVote)) {
    throw new ToolError('VALIDATION_ERROR', 'vote must be "up", "down" or null.');
  }
  if (reason !== undefined && !REASONS.includes(reason as FeedbackReason)) {
    throw new ToolError('VALIDATION_ERROR', `reason must be one of ${REASONS.join(', ')}.`);
  }
  if (reason !== undefined && vote !== 'down') {
    throw new ToolError('VALIDATION_ERROR', 'reason is allowed only with vote "down".');
  }
  if (comment !== undefined && typeof comment !== 'string') {
    throw new ToolError('VALIDATION_ERROR', 'comment must be a string.');
  }
  if (typeof comment === 'string' && [...comment].length > FEEDBACK_COMMENT_MAX) {
    throw new ToolError('LIMIT_EXCEEDED', `comment exceeds ${FEEDBACK_COMMENT_MAX} characters.`, {
      limit: 'feedback.commentChars',
      max: FEEDBACK_COMMENT_MAX,
    });
  }
  return {
    vote: vote as FeedbackVote | null,
    ...(reason !== undefined ? { reason: reason as FeedbackReason } : {}),
    ...(typeof comment === 'string' && comment.trim() !== '' ? { comment: comment.trim() } : {}),
  };
}

/* ---------- stub store: <dataDir>/feedback.json ---------- */

type FeedbackFile = Record<string, Record<string, FindingFeedback>>;

const feedbackFile = (dataDir: string): string => path.join(dataDir, 'feedback.json');

function readFeedbackFile(dataDir: string): FeedbackFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(feedbackFile(dataDir), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FeedbackFile) : {};
  } catch {
    return {};
  }
}

function writeFeedbackFile(dataDir: string, data: FeedbackFile): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = feedbackFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/* ---------- 1. feedback ---------- */

export async function putFeedback(
  deps: ToolDeps,
  reviewId: string,
  findingId: string,
  input: FeedbackInput,
): Promise<FeedbackResponse> {
  if (!REVIEW_ID_RE.test(reviewId) || !FINDING_ID_RE.test(findingId)) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid review or finding id.');
  }
  if (loadServiceApiFlags(deps.env).feedback) {
    const res = await callApi<FeedbackResponse>(
      loadServiceConfig(deps.env),
      { method: 'POST', path: `/reviews/${reviewId}/findings/${findingId}/feedback`, body: JSON.stringify(input) },
      deps.http,
    );
    return res.body;
  }
  const dataDir = resolveDataDir(deps.env);
  const all = readFeedbackFile(dataDir);
  const forReview = { ...(all[reviewId] ?? {}) };
  const updatedAt = new Date(deps.clock.now()).toISOString();
  if (input.vote === null) delete forReview[findingId];
  else {
    forReview[findingId] = {
      vote: input.vote,
      reason: input.reason ?? null,
      comment: input.comment ?? null,
      updatedAt,
    };
  }
  writeFeedbackFile(dataDir, { ...all, [reviewId]: forReview });
  const saved = forReview[findingId];
  return {
    reviewId,
    findingId,
    vote: saved?.vote ?? null,
    reason: saved?.reason ?? null,
    comment: saved?.comment ?? null,
    updatedAt,
  };
}

/** Adds stub feedback to a GetReview response (the service adds it itself once the API ships). */
export function withStubFeedback(deps: ToolDeps, review: GetReviewResponse): GetReviewResponse {
  if (loadServiceApiFlags(deps.env).feedback) return review;
  const forReview = readFeedbackFile(resolveDataDir(deps.env))[review.reviewId] ?? {};
  return { ...review, findings: review.findings.map((f) => ({ ...f, feedback: forReview[f.findingId] ?? null })) };
}

/* ---------- 4. unsuppress ---------- */

const unsuppressedFile = (dataDir: string): string => path.join(dataDir, 'unsuppressed.json');

function readUnsuppressed(dataDir: string): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(unsuppressedFile(dataDir), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string[]>)
      : {};
  } catch {
    return {};
  }
}

function writeUnsuppressed(dataDir: string, data: Record<string, string[]>): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = unsuppressedFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export async function unsuppressFinding(
  deps: ToolDeps,
  reviewId: string,
  findingId: string,
): Promise<UnsuppressResponse> {
  if (!REVIEW_ID_RE.test(reviewId) || !FINDING_ID_RE.test(findingId)) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid review or finding id.');
  }
  if (loadServiceApiFlags(deps.env).unsuppress) {
    const res = await callApi<UnsuppressResponse>(
      loadServiceConfig(deps.env),
      { method: 'POST', path: `/reviews/${reviewId}/findings/${findingId}/unsuppress`, body: '{}' },
      deps.http,
    );
    return res.body;
  }
  const dataDir = resolveDataDir(deps.env);
  const all = readUnsuppressed(dataDir);
  const ids = new Set(all[reviewId] ?? []);
  ids.add(findingId);
  writeUnsuppressed(dataDir, { ...all, [reviewId]: [...ids] });
  return { reviewId, findingId, suppressed: false, updatedAt: new Date(deps.clock.now()).toISOString() };
}

/** A fresh suppress makes the service the source of truth again. */
export function clearLocalUnsuppress(deps: ToolDeps, reviewId: string, findingId: string): void {
  const dataDir = resolveDataDir(deps.env);
  const all = readUnsuppressed(dataDir);
  if (!(all[reviewId] ?? []).includes(findingId)) return;
  writeUnsuppressed(dataDir, { ...all, [reviewId]: all[reviewId].filter((id) => id !== findingId) });
}

/**
 * While the unsuppress API is stubbed, show locally unsuppressed findings as active again and correct the counts of
 * the shown iteration. The service still suppresses them; `locallyUnsuppressed` lets the page say so.
 */
export function withStubUnsuppress(deps: ToolDeps, review: GetReviewResponse): GetReviewResponse {
  if (loadServiceApiFlags(deps.env).unsuppress) return review;
  const ids = new Set(readUnsuppressed(resolveDataDir(deps.env))[review.reviewId] ?? []);
  if (ids.size === 0) return review;
  let active = 0;
  let blocking = 0;
  const findings = review.findings.map((f) => {
    if (!f.suppressed || !ids.has(f.findingId)) return f;
    if (f.state !== 'RESOLVED') {
      active++;
      if (f.blocking) blocking++;
    }
    return { ...f, suppressed: false, suppressionReason: null, locallyUnsuppressed: true };
  });
  const c = review.iteration.counts;
  return {
    ...review,
    findings,
    iteration: {
      ...review.iteration,
      counts: {
        ...c,
        active: c.active + active,
        blocking: c.blocking + blocking,
        suppressed: Math.max(0, c.suppressed - active),
      },
    },
  };
}

/* ---------- 2. list ---------- */

export interface ListedReview extends Partial<HistoryEntry> {
  reviewId: string;
  /** When the review was created (service) or first recorded on this machine (stub). */
  createdAt: string;
  status?: ListReviewsResponse['reviews'][number]['status'];
  counts?: ListReviewsResponse['reviews'][number]['counts'];
  latestIteration?: number;
}

export interface ListResult {
  source: 'service' | 'local';
  reviews: ListedReview[];
  nextToken?: string;
}

/** Pages of 50 followed for one list call; a result that still has a `nextToken` was cut off here. */
export const MAX_LIST_PAGES = 20;

/** With a `nextToken`, one page from there. Without one, every page up to MAX_LIST_PAGES. */
export async function listReviews(deps: ToolDeps, nextToken?: string): Promise<ListResult> {
  const local = readHistory(resolveDataDir(deps.env));
  if (!loadServiceApiFlags(deps.env).list) {
    return { source: 'local', reviews: local.map((e) => ({ ...e, createdAt: e.trackedAt })) };
  }
  const config = loadServiceConfig(deps.env);
  const byId = new Map(local.map((e) => [e.reviewId, e]));
  const seen = new Set<string>();
  const reviews: ListedReview[] = [];
  let token = nextToken;
  for (let page = 0; page < (nextToken ? 1 : MAX_LIST_PAGES); page++) {
    const res = await callApi<ListReviewsResponse>(
      config,
      { method: 'GET', path: '/reviews', query: { limit: '50', ...(token ? { nextToken: token } : {}) } },
      deps.http,
    );
    for (const r of res.body.reviews) {
      // A review that moved between pages while we paged can come back twice.
      if (seen.has(r.reviewId)) continue;
      seen.add(r.reviewId);
      reviews.push({ ...byId.get(r.reviewId), ...r });
    }
    token = res.body.nextToken || undefined;
    if (!token) break;
  }
  return { source: 'service', reviews, ...(token ? { nextToken: token } : {}) };
}

/* ---------- 3. payload ---------- */

export interface SentResult {
  source: 'local' | 'service' | 'none';
  iteration: StoredIteration | null;
  /** The service no longer has the payload (retention). */
  expired?: boolean;
}

function fromService(p: IterationPayloadResponse): StoredIteration {
  return {
    number: p.iteration,
    submission: {
      sentAt: p.sentAt,
      base: p.base,
      ...(p.head ? { head: p.head } : {}),
      ...(p.level ? { level: p.level } : {}),
      diff: p.diff,
      context: p.context,
      ...(p.rules ? { rules: p.rules } : {}),
      ...(p.intent ? { intent: p.intent } : {}),
      ...(p.commits ? { commits: p.commits } : {}),
      ...(p.responses ? { responses: p.responses } : {}),
      manifestCount: p.manifestCount,
    },
    contextRounds: p.contextRounds,
  };
}

/** What was sent for one iteration: the local copy when this machine sent it, else the service (when enabled). */
export async function getSent(deps: ToolDeps, reviewId: string, iteration: number): Promise<SentResult> {
  const local = loadStored(resolveDataDir(deps.env), reviewId).find((i) => i.number === iteration);
  if (local) return { source: 'local', iteration: local };
  if (!loadServiceApiFlags(deps.env).payload) return { source: 'none', iteration: null };
  try {
    const res = await callApi<IterationPayloadResponse>(
      loadServiceConfig(deps.env),
      { method: 'GET', path: `/reviews/${reviewId}/iterations/${iteration}/payload` },
      deps.http,
    );
    return { source: 'service', iteration: fromService(res.body) };
  } catch (e) {
    if (e instanceof ToolError && e.details.serviceCode === 'PAYLOAD_EXPIRED') {
      return { source: 'none', iteration: null, expired: true };
    }
    throw e;
  }
}
