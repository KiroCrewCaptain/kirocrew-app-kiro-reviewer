// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deleteStored } from './payloadStore.js';
import { REVIEW_ID_RE } from './tools/common.js';

/** Local list of reviews this machine submitted or tracked, for the Crew page (the service has no list API). */

export const HISTORY_MAX = 100;

export interface HistoryEntry {
  reviewId: string;
  /** ISO time the entry was first recorded. */
  trackedAt: string;
  repo?: string;
  headRef?: string;
  baseRef?: string;
  level?: string;
  intent?: string;
}

const fileFor = (dataDir: string): string => path.join(dataDir, 'reviews.json');

function isEntry(v: unknown): v is HistoryEntry {
  if (v === null || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.reviewId === 'string' && REVIEW_ID_RE.test(e.reviewId) && typeof e.trackedAt === 'string';
}

/** Newest first. A missing or unreadable file is an empty history. */
export function readHistory(dataDir: string): HistoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fileFor(dataDir), 'utf8'));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
}

/** Adds an entry (or keeps the existing one for the same reviewId), trims to HISTORY_MAX and drops trimmed payloads. */
export function recordReview(dataDir: string, entry: HistoryEntry): HistoryEntry[] {
  const existing = readHistory(dataDir);
  if (existing.some((e) => e.reviewId === entry.reviewId)) return existing;
  const all = [entry, ...existing];
  const next = all.slice(0, HISTORY_MAX);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = fileFor(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  for (const dropped of all.slice(HISTORY_MAX)) deleteStored(dataDir, dropped.reviewId);
  return next;
}
