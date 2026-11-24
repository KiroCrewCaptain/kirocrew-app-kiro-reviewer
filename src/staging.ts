// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextResponseRequest, SubmitRequest } from './client/types.js';

/** Prepared-payload store: dir 0700, files 0600, 30-minute expiry. */

export const STAGING_TTL_MS = 30 * 60 * 1000;
export const PREPARED_ID_RE = /^prep-[0-9a-f]{16}$/;

export type StagedKind = 'review' | 'context';

export interface StagedPayload {
  /** Missing means 'review' (files staged before context rounds existed). */
  kind?: StagedKind;
  /** POST path below the stage for kind 'context'. */
  apiPath?: string;
  payload: SubmitRequest | ContextResponseRequest;
  digest: string;
  summaryMarkdown: string;
  reviewId?: string;
  createdAt: string;
}

export const newPreparedId = (): string => `prep-${randomBytes(8).toString('hex')}`;

const preparedDir = (dataDir: string): string => path.join(dataDir, 'prepared');

function fileFor(dataDir: string, preparedId: string): string {
  if (!PREPARED_ID_RE.test(preparedId)) throw new Error('invalid preparedId');
  return path.join(preparedDir(dataDir), `${preparedId}.json`);
}

function ensureDir(dataDir: string): string {
  const dir = preparedDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Deletes staged files older than the TTL. Called on each prepare. */
export function cleanupExpired(dataDir: string, nowMs: number): number {
  const dir = preparedDir(dataDir);
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^prep-[0-9a-f]{16}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      let created = statSync(file).mtimeMs;
      try {
        const parsed = Date.parse((JSON.parse(readFileSync(file, 'utf8')) as StagedPayload).createdAt);
        if (Number.isFinite(parsed)) created = parsed;
      } catch {
        // Unreadable staged file: fall back to its mtime.
      }
      if (nowMs - created > STAGING_TTL_MS) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // Raced with another delete; ignore.
    }
  }
  return removed;
}

export function stagePayload(dataDir: string, preparedId: string, staged: StagedPayload): string {
  ensureDir(dataDir);
  const file = fileFor(dataDir, preparedId);
  writeFileSync(file, JSON.stringify(staged), { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return file;
}

/** Loads a staged payload; returns null when it is missing, unreadable or expired (expired files are deleted). */
export function loadStaged(dataDir: string, preparedId: string, nowMs: number): StagedPayload | null {
  let file: string;
  try {
    file = fileFor(dataDir, preparedId);
  } catch {
    return null;
  }
  try {
    const staged = JSON.parse(readFileSync(file, 'utf8')) as StagedPayload;
    const created = Date.parse(staged.createdAt);
    if (!Number.isFinite(created) || nowMs - created > STAGING_TTL_MS) {
      rmSync(file, { force: true });
      return null;
    }
    return staged;
  } catch {
    return null;
  }
}

export function deleteStaged(dataDir: string, preparedId: string): void {
  rmSync(fileFor(dataDir, preparedId), { force: true });
}
