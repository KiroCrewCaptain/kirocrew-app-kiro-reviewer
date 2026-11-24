// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextResponseRequest, SubmitRequest } from './client/types.js';
import { REVIEW_ID_RE } from './tools/common.js';

/**
 * Local copy of what this machine sent per review iteration (already redacted), for the Crew page's Diff and
 * Context views. The service does not return the diff. Dir 0700, files 0600.
 */

export interface StoredSubmission {
  sentAt: string;
  base: SubmitRequest['base'];
  head?: SubmitRequest['head'];
  level?: SubmitRequest['level'];
  diff: string;
  context: Array<{ path: string; content: string }>;
  rules?: SubmitRequest['rules'];
  intent?: string;
  commits?: SubmitRequest['commits'];
  responses?: SubmitRequest['responses'];
  manifestCount: number;
}

export interface StoredContextRound {
  sentAt: string;
  round: number;
  responses: ContextResponseRequest['responses'];
  context: Array<{ path: string; content: string }>;
}

export interface StoredIteration {
  number: number;
  submission: StoredSubmission | null;
  contextRounds: StoredContextRound[];
}

const SUBMISSION_RE = /^iteration-([1-9][0-9]{0,3})\.json$/;
const ROUND_RE = /^iteration-([1-9][0-9]{0,3})-context-([1-9][0-9]{0,3})\.json$/;

function reviewDir(dataDir: string, reviewId: string): string {
  if (!REVIEW_ID_RE.test(reviewId)) throw new Error('invalid reviewId');
  return path.join(dataDir, 'reviews', reviewId);
}

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

const positiveInt = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 9999;

export function saveSubmission(
  dataDir: string,
  reviewId: string,
  iteration: number,
  payload: SubmitRequest,
  sentAt: string,
): void {
  if (!positiveInt(iteration)) throw new Error('invalid iteration');
  const stored: StoredSubmission = {
    sentAt,
    base: payload.base,
    ...(payload.head ? { head: payload.head } : {}),
    ...(payload.level ? { level: payload.level } : {}),
    diff: payload.diff,
    context: payload.context ?? [],
    ...(payload.rules ? { rules: payload.rules } : {}),
    ...(payload.intent ? { intent: payload.intent } : {}),
    ...(payload.commits ? { commits: payload.commits } : {}),
    ...(payload.responses ? { responses: payload.responses } : {}),
    manifestCount: payload.manifest?.length ?? 0,
  };
  writeJson(reviewDir(dataDir, reviewId), `iteration-${iteration}.json`, stored);
}

export function saveContextRound(
  dataDir: string,
  reviewId: string,
  iteration: number,
  payload: ContextResponseRequest,
  sentAt: string,
): void {
  if (!positiveInt(iteration) || !positiveInt(payload.round)) throw new Error('invalid iteration or round');
  const stored: StoredContextRound = {
    sentAt,
    round: payload.round,
    responses: payload.responses,
    context: payload.context ?? [],
  };
  writeJson(reviewDir(dataDir, reviewId), `iteration-${iteration}-context-${payload.round}.json`, stored);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Every stored iteration of a review, ascending. Missing review dir means nothing stored. */
export function loadStored(dataDir: string, reviewId: string): StoredIteration[] {
  const dir = reviewDir(dataDir, reviewId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const byNumber = new Map<number, StoredIteration>();
  const entry = (n: number): StoredIteration => {
    let it = byNumber.get(n);
    if (!it) {
      it = { number: n, submission: null, contextRounds: [] };
      byNumber.set(n, it);
    }
    return it;
  };
  for (const name of names) {
    const s = SUBMISSION_RE.exec(name);
    if (s) {
      const v = readJson<StoredSubmission>(path.join(dir, name));
      if (v && typeof v.diff === 'string') entry(Number(s[1])).submission = v;
      continue;
    }
    const r = ROUND_RE.exec(name);
    if (r) {
      const v = readJson<StoredContextRound>(path.join(dir, name));
      if (v && Array.isArray(v.responses)) entry(Number(r[1])).contextRounds.push(v);
    }
  }
  for (const it of byNumber.values()) it.contextRounds.sort((a, b) => a.round - b.round);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function deleteStored(dataDir: string, reviewId: string): void {
  rmSync(reviewDir(dataDir, reviewId), { recursive: true, force: true });
}
