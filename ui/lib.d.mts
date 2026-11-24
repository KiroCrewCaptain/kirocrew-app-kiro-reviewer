// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Types for ui/lib.mjs, used by the vitest suite.

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'meta';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary';
  hunks: Array<{ header: string; lines: DiffLine[] }>;
  adds: number;
  dels: number;
}
export interface FindingRef {
  file: string;
  side: 'new' | 'old';
  startLine: number;
  endLine: number;
}

export const SEVERITIES: string[];
export function severityRank(severity: string): number;
export function shortId(id: string): string;
export function groupCounts<T>(items: T[], keyOf: (item: T) => string): Record<string, number>;
export function relTime(iso: string, now?: number): string;
export function formatDuration(ms: number): string;
export function parseApiError(err: unknown): string;
export function apiErrorCode(err: unknown): string;
export function needsKiroSignIn(code: string): boolean;
export function parseUnifiedDiff(text: string): DiffFile[];
export function filePath(f: DiffFile): string;
export function snippetFor(
  files: DiffFile[],
  finding: FindingRef,
  pad?: number,
): { path: string; lines: Array<DiffLine & { hit: boolean }> } | null;
export function placeFindings<T extends FindingRef>(
  files: DiffFile[],
  findings: T[],
): { perFile: Array<{ anchors: Record<string, T[]>; unanchored: T[] }>; outside: T[] };
export interface PromptFinding extends FindingRef {
  findingId: string;
  severity: string;
  blocking: boolean;
  title: string;
  explanation: string;
  suggestion: string | null;
}
export interface ReviewLike {
  reviewId: string;
  level: string;
  latestIteration: number;
  terminal: boolean;
  iteration: {
    number: number;
    status: string;
    outcome: string;
    counts: { active: number; blocking: number; suppressed: number; resolved: number };
    completeness?: { context?: { missing: boolean } } | null;
  };
  findings: Array<{ state: string; suppressed: boolean; resolvedIteration: number | null }>;
}
export function buildFixPrompt(findings: PromptFinding[], review: Pick<ReviewLike, 'reviewId' | 'iteration'>): string;
export function iterationDelta(
  review: ReviewLike,
): { fresh: number; persisting: number; resolved: number; since: number } | null;
export function buildHandoff(review: ReviewLike, entry?: { headRef?: string; baseRef?: string } | null): string;
export type Band = 'red' | 'yellow' | 'green' | 'run';
export const BANDS: Band[];
export interface BandSummary {
  status?: string;
  blocking: number;
  active: number;
}
export function reviewBand(s: BandSummary | null | undefined): Band | null;
export function bandCounts(
  reviews: Array<{ reviewId: string }>,
  summaries: Record<string, BandSummary | undefined>,
): { all: number; red: number; yellow: number; green: number; run: number };
export function gateSummary(review: {
  iteration: {
    status: string;
    counts: { active: number; blocking: number };
    completeness?: {
      reviewersSucceeded?: string[];
      verify?: string;
      context?: { round: number | null; requested: string[]; provided: string[] } | null;
    } | null;
  };
}): { band: Band | null; verdict: string; detail: string };
