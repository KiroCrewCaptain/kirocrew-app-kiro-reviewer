// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ToolError } from '../errors.js';
import { bffCall, type BffConfig, type BffDeps } from './bff.js';
import type { ApiRequest, ApiResponse, HttpDeps } from './http.js';

/**
 * Serves the REST-shaped requests the tools make from the Kiro BFF operations. The tools keep their paths and
 * response types; this maps each route to one operation and the reply back to the service's JSON shape.
 */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

/** Members the BFF reports as epoch milliseconds. The tools work with ISO-8601 strings. */
const TIMESTAMP_KEYS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'cachedAt',
  'requestedAt',
  'expiresAt',
  'respondedAt',
  'sentAt',
]);

/** Copies a decoded reply: timestamps become ISO strings and 64-bit integers become numbers. */
export function fromWire(v: unknown, key?: string): unknown {
  if (typeof v === 'bigint') return fromWire(Number(v), key);
  if (Array.isArray(v)) return v.map((x) => fromWire(x));
  if (v !== null && typeof v === 'object') {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) out[k] = fromWire(x, k);
    return out;
  }
  if (typeof v === 'number' && key !== undefined && TIMESTAMP_KEYS.has(key)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return v;
}

/** The model leaves unset members absent; the tools' types say `null`. */
function nullable(o: Rec, keys: readonly string[]): void {
  for (const k of keys) if (o[k] === undefined) o[k] = null;
}

const noCounts = (): Rec => ({ active: 0, blocking: 0, suppressed: 0, resolved: 0 });

/** The BFF leaves `counts` off an iteration that has not finished; the tools read it unconditionally. */
function toGetReview(wire: unknown): unknown {
  const r = rec(fromWire(wire));
  const it = rec(r.iteration);
  if (it.counts === undefined) it.counts = noCounts();
  nullable(it, ['completeness', 'contextRound', 'error', 'startedAt', 'completedAt', 'rulesRevision']);
  nullable(rec(it.cache), ['cachedAt']);
  nullable(rec(rec(it.completeness).context), ['round']);
  for (const q of list(it.contextRequests)) nullable(q, ['path', 'startLine', 'endLine', 'query']);
  for (const f of list(r.findings)) {
    nullable(f, [
      'suggestion',
      'ruleId',
      'suppressionReason',
      'resolvedIteration',
      'confidence',
      'dismissalReason',
      'dismissalDisposition',
      'feedback',
    ]);
  }
  return r;
}

function toList(wire: unknown): unknown {
  const r = rec(fromWire(wire));
  for (const s of list(r.reviews)) if (s.counts === undefined) s.counts = noCounts();
  return r;
}

const pick = (o: object, keys: readonly string[]): Rec => {
  const src = o as Rec;
  const out: Rec = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

const REQUEST_KEYS = [
  'clientToken',
  'base',
  'head',
  'diff',
  'rules',
  'context',
  'intent',
  'commits',
  'manifest',
] as const;

/** Only members the BFF model defines: the server may reject an unknown one. */
function wireRequest(req: Rec, extra: readonly string[]): Rec {
  const out = pick(req, [...REQUEST_KEYS, ...extra]);
  if (req.client && typeof req.client === 'object') out.client = pick(req.client, ['name', 'version', 'repo']);
  if (Array.isArray(req.responses)) {
    out.responses = (req.responses as Rec[]).map((r) =>
      pick(r, ['findingId', 'disposition', 'comment', 'acknowledged']),
    );
  }
  return out;
}

function parseBody(body: string | undefined): Rec {
  if (body === undefined || body === '') return {};
  try {
    return rec(JSON.parse(body));
  } catch {
    throw new ToolError('INTERNAL_ERROR', 'The request body was not valid JSON.');
  }
}

const REVIEW = 'rev-[0-9a-f]{24}';
const FINDING = 'f-[0-9a-f]{16}';
const ITERATION = '[1-9][0-9]{0,3}';
const ROUTES = {
  create: new RegExp(`^/reviews$`),
  resubmit: new RegExp(`^/reviews/(${REVIEW})/iterations$`),
  get: new RegExp(`^/reviews/(${REVIEW})$`),
  context: new RegExp(`^/reviews/(${REVIEW})/iterations/(${ITERATION})/context$`),
  payload: new RegExp(`^/reviews/(${REVIEW})/iterations/(${ITERATION})/payload$`),
  suppress: new RegExp(`^/reviews/(${REVIEW})/findings/(${FINDING})/suppress$`),
  unsuppress: new RegExp(`^/reviews/(${REVIEW})/findings/(${FINDING})/unsuppress$`),
  feedback: new RegExp(`^/reviews/(${REVIEW})/findings/(${FINDING})/feedback$`),
} as const;

function unsupported(what: string): ToolError {
  return new ToolError('SERVICE_ERROR', `UNSUPPORTED: ${what} is not available through the Kiro BFF.`, {
    httpStatus: 501,
    serviceCode: 'UNSUPPORTED',
  });
}

/** Sends one REST-shaped request to the BFF. The reply is shaped like the REST API's, with ISO timestamps. */
export async function callBff<T = unknown>(
  config: BffConfig,
  req: ApiRequest,
  deps: HttpDeps,
): Promise<ApiResponse<T>> {
  const bffDeps: BffDeps = {
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  };
  const call = (op: string, input: object): Promise<unknown> => bffCall(config, op, input, bffDeps);
  const done = (body: unknown): ApiResponse<T> => ({ status: 200, body: body as T, headers: new Headers() });
  const accepted = (body: unknown): ApiResponse<T> => ({ status: 202, body: body as T, headers: new Headers() });
  const { method, path } = req;
  let m: RegExpExecArray | null;

  if (method === 'POST' && ROUTES.create.test(path)) {
    const body = wireRequest(parseBody(req.body), ['level', 'iterationBudget', 'contextRounds']);
    return accepted(rec(fromWire(await call('CreateCodeReview', body))));
  }
  if (method === 'POST' && (m = ROUTES.resubmit.exec(path))) {
    const body = wireRequest(parseBody(req.body), []);
    return accepted(rec(fromWire(await call('UpdateCodeReview', { reviewId: m[1], ...body }))));
  }
  if (method === 'GET' && (m = ROUTES.get.exec(path))) {
    const iteration = Number(req.query?.iteration);
    const input = { reviewId: m[1], ...(Number.isInteger(iteration) && iteration > 0 ? { iteration } : {}) };
    return done(toGetReview(await call('GetCodeReview', input)));
  }
  if (method === 'GET' && path === '/reviews') {
    const limit = Number(req.query?.limit);
    const maxResults = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20;
    const nextToken = req.query?.nextToken;
    return done(toList(await call('ListCodeReviews', { maxResults, ...(nextToken ? { nextToken } : {}) })));
  }
  if (method === 'GET' && (m = ROUTES.payload.exec(path))) {
    return done(
      rec(fromWire(await call('GetCodeReviewIterationPayload', { reviewId: m[1], iteration: Number(m[2]) }))),
    );
  }
  if (method === 'POST' && (m = ROUTES.context.exec(path))) {
    const body = pick(parseBody(req.body), ['round', 'responses', 'context']);
    return accepted(
      rec(fromWire(await call('UpdateCodeReviewContext', { reviewId: m[1], iteration: Number(m[2]), ...body }))),
    );
  }
  if (method === 'POST' && (m = ROUTES.suppress.exec(path))) {
    const { reason } = parseBody(req.body);
    const out = rec(fromWire(await call('UpdateCodeReviewFinding', { reviewId: m[1], findingId: m[2], reason })));
    nullable(out, ['reason']);
    return done(out);
  }
  if (method === 'POST' && (m = ROUTES.feedback.exec(path))) {
    const body = pick(parseBody(req.body), ['vote', 'reason', 'comment']);
    const out = rec(fromWire(await call('UpdateCodeReviewFeedback', { reviewId: m[1], findingId: m[2], ...body })));
    nullable(out, ['vote', 'reason', 'comment']);
    return done(out);
  }
  if (method === 'POST' && ROUTES.unsuppress.test(path)) throw unsupported('Un-suppressing a finding');
  throw unsupported(`${method} ${path.replace(/rev-[0-9a-f]{24}|f-[0-9a-f]{16}/g, '…')}`);
}
