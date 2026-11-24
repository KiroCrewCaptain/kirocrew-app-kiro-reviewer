// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from 'node:crypto';
import type { ClientInfo, FindingResponse, SubmitRequest } from '../client/types.js';
import type { RedactionLocation } from '../redact.js';
import type { ContextDecision } from './contextAnswers.js';
import type { FileStatus } from './diffInfo.js';

/** Canonical JSON: object keys sorted recursively, no whitespace, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** payloadDigest = sha256 of the canonical payload JSON. */
export const payloadDigest = (payload: unknown): string => sha256Hex(canonicalJson(payload));

/** Idempotency token for the service. */
export const newClientToken = (): string => randomBytes(16).toString('hex');

export interface PayloadSummary {
  repo: string;
  base: string;
  baseSha: string;
  mergeBase: string;
  head: string;
  headSha: string;
  includeUncommitted: boolean;
  files: Array<{ path: string; status: FileStatus; added: number; removed: number }>;
  diffBytes: number;
  changedLines: number;
  rules: { reviewMd: boolean; revision: string };
  contextFiles: Array<{ path: string; bytes: number }>;
  redactions: RedactionLocation[];
  level?: string;
  iterationBudget?: number;
  reviewId?: string;
  /** Context rounds for a new review (absent on a resubmit: the session setting applies). */
  contextRounds?: number;
  /** Number of manifest paths sent (names only). */
  manifestPaths?: number;
  /** Author intent: shown as a bounded excerpt. Already redacted. */
  intent?: string;
  /** Commit messages: count and summed utf-8 bytes of subjects+bodies. */
  commitCount?: number;
  commitBytes?: number;
  /** Number of derived refs (trailers + inline ticket/sim/cr ids) across the commits. */
  refCount?: number;
  /** Finding responses: the author's dispositions of the previous iteration's findings. */
  responses?: FindingResponse[];
  /** Dev-only test hook sent as client.faultInjection. */
  testHook?: string;
}

export const SUMMARY_MAX_CHARS = 4_000;
export const SUMMARY_MAX_FILES = 50;
export const SUMMARY_MAX_REDACTION_LOCATIONS = 20;
/** Default author-intent excerpt length in the approval summary. */
export const SUMMARY_INTENT_CHARS = 280;
const DISPLAY_PATH_CHARS = 120;

/** Inline-code-safe display text: no backticks, no newlines, bounded length. */
function code(s: string, max = DISPLAY_PATH_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[`\u0000-\u001f\u007f]/g, "'");
  const short = [...clean].length > max ? [...clean].slice(0, max - 1).join('') + '…' : clean;
  return `\`${short}\``;
}

const short = (sha: string): string => sha.slice(0, 12);

interface SummaryCaps {
  files: number;
  locations: number;
  context: number;
  /** Max code points of the author-intent excerpt shown. */
  intent: number;
  /** Max response rows shown. */
  responses: number;
}

function render(s: PayloadSummary, caps: SummaryCaps): string {
  const lines: string[] = [];
  lines.push(
    s.reviewId ? `### Code review resubmit for ${s.reviewId} (not sent yet)` : '### Code review payload (not sent yet)',
  );
  lines.push('');
  lines.push(`- Repository: ${code(s.repo)}`);
  lines.push(`- Base: ${code(s.base)} at ${code(short(s.baseSha))}; diff from merge-base ${code(short(s.mergeBase))}`);
  lines.push(
    s.includeUncommitted
      ? `- Head: ${code(s.head)} working tree, including uncommitted changes (untracked files excluded)`
      : `- Head: ${code(s.head)} at ${code(short(s.headSha))} (committed changes only)`,
  );
  if (s.reviewId) lines.push(`- Resubmit: new iteration of ${s.reviewId}`);
  else lines.push(`- Level: ${s.level ?? 'standard'}; iteration budget: ${s.iterationBudget ?? 3}`);
  if (s.contextRounds !== undefined) {
    lines.push(
      s.contextRounds > 0
        ? `- Context requests: up to ${s.contextRounds} rounds per review`
        : '- Context requests: disabled',
    );
  }
  if (s.manifestPaths !== undefined && s.manifestPaths > 0) {
    lines.push(`- File manifest: ${s.manifestPaths} paths (names only, for context requests)`);
  }
  if (s.intent !== undefined && s.intent !== '') {
    lines.push(`- Author intent (your claim, shown to the reviewer as untrusted): ${code(s.intent, caps.intent)}`);
  }
  if (s.commitCount !== undefined && s.commitCount > 0) {
    lines.push(
      `- Commit messages: ${s.commitCount} (${s.commitBytes ?? 0} bytes), ${s.refCount ?? 0} derived refs; author/email/timestamp excluded`,
    );
  }
  if (s.responses !== undefined && s.responses.length > 0) {
    lines.push(`- Responses to previous findings: ${s.responses.length}`);
    for (const r of s.responses.slice(0, caps.responses)) {
      const dismissal =
        r.disposition === 'false_positive' || r.disposition === 'wont_fix' || r.disposition === 'deferred';
      const ack = r.acknowledged === true ? 'acknowledged' : 'not acknowledged';
      const note = dismissal
        ? ` — dismissal (${ack}); if this finding is blocking it is set aside only with your explicit "yes"`
        : '';
      const comment = r.comment !== undefined && r.comment !== '' ? `: ${code(r.comment, caps.intent)}` : '';
      lines.push(`  - ${code(r.findingId)} → ${r.disposition}${note}${comment}`);
    }
    if (s.responses.length > caps.responses) lines.push(`  - … and ${s.responses.length - caps.responses} more`);
  }
  if (s.testHook) lines.push(`- Test hook: ${s.testHook}`);
  lines.push(`- Diff: ${s.files.length} files, ${s.diffBytes} bytes, ${s.changedLines} changed lines`);
  lines.push('- Note: the service excludes generated, fixture, lock and vendored files by default.');
  lines.push(`- REVIEW.md from merge-base ${code(short(s.rules.revision))}: ${s.rules.reviewMd ? 'yes' : 'none'}`);
  const ctxBytes = s.contextFiles.reduce((a, c) => a + c.bytes, 0);
  lines.push(`- Context files: ${s.contextFiles.length} (${ctxBytes} bytes)`);
  for (const c of s.contextFiles.slice(0, caps.context)) lines.push(`  - ${code(c.path)} (${c.bytes} bytes)`);
  if (s.contextFiles.length > caps.context) lines.push(`  - … and ${s.contextFiles.length - caps.context} more`);

  const counts = new Map<string, number>();
  for (const r of s.redactions) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  if (s.redactions.length === 0) {
    lines.push('- Redactions: none');
  } else {
    const byType = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, n]) => `${t} ×${n}`)
      .join(', ');
    lines.push(`- Redactions: ${s.redactions.length} (${byType}); values replaced with [REDACTED:<type>]`);
    for (const r of s.redactions.slice(0, caps.locations)) lines.push(`  - ${code(`${r.file}:${r.line}`)} ${r.type}`);
    if (s.redactions.length > caps.locations) lines.push(`  - … and ${s.redactions.length - caps.locations} more`);
  }
  lines.push('');
  lines.push('| Status | File | +/- |');
  lines.push('|---|---|---|');
  for (const f of s.files.slice(0, caps.files))
    lines.push(`| ${f.status} | ${code(f.path)} | +${f.added}/-${f.removed} |`);
  if (s.files.length > caps.files) lines.push(`| | … and ${s.files.length - caps.files} more | |`);
  lines.push('');
  lines.push('Nothing has been sent. Submitting sends exactly this payload to the Kiro Reviewer service.');
  return lines.join('\n');
}

/**
 * summaryMarkdown: at most 50 files and the first 20 redaction locations.
 * If it still exceeds 4,000 chars, the file list is shortened first, then the redaction locations,
 * then the context list. Counts and totals are never dropped.
 */
export function buildSummaryMarkdown(s: PayloadSummary): string {
  const caps: SummaryCaps = {
    files: Math.min(SUMMARY_MAX_FILES, s.files.length),
    locations: Math.min(SUMMARY_MAX_REDACTION_LOCATIONS, s.redactions.length),
    context: s.contextFiles.length,
    intent: SUMMARY_INTENT_CHARS,
    responses: s.responses?.length ?? 0,
  };
  let md = render(s, caps);
  while (md.length > SUMMARY_MAX_CHARS) {
    if (caps.files > 0) caps.files--;
    else if (caps.locations > 0) caps.locations--;
    else if (caps.context > 0) caps.context--;
    else if (caps.responses > 0) caps.responses--;
    else if (caps.intent > 40) caps.intent = Math.max(40, caps.intent - 40);
    else break;
    md = render(s, caps);
  }
  return md;
}

export interface BuildPayloadInput {
  reviewId?: string;
  level?: SubmitRequest['level'];
  iterationBudget?: number;
  baseRef: string;
  mergeBase: string;
  headRef: string;
  headSha: string;
  includeUncommitted: boolean;
  diff: string;
  rules?: { reviewMd?: string };
  context: Array<{ path: string; content: string }>;
  repo: string;
  clientVersion: string;
  clientToken: string;
  /** New reviews only; sent when > 0. */
  contextRounds?: number;
  /** Sent when non-empty. */
  manifest?: string[];
  /** Author's intent; sent when present. Already redacted by the caller. */
  intent?: string;
  /** Commit messages; sent when non-empty. Subjects/bodies already redacted by the caller. */
  commits?: Array<{ subject: string; body?: string }>;
  /** Finding responses; sent when non-empty. Comments already redacted by the caller. */
  responses?: FindingResponse[];
  faultInjection?: ClientInfo['faultInjection'];
}

const CLIENT_FIELD_RE = /^[\w .@/-]{1,100}$/;

/** Builds the SubmitReview or ResubmitReview request body. */
export function buildPayload(i: BuildPayloadInput): SubmitRequest {
  const payload: SubmitRequest = {
    clientToken: i.clientToken,
    base: { ref: i.baseRef, commit: i.mergeBase },
    head: i.includeUncommitted ? { ref: i.headRef } : { ref: i.headRef, commit: i.headSha },
    diff: i.diff,
    client: {
      name: 'kiro-code-reviewer-crew',
      version: i.clientVersion,
      ...(CLIENT_FIELD_RE.test(i.repo) ? { repo: i.repo } : {}),
      ...(i.faultInjection ? { faultInjection: i.faultInjection } : {}),
    },
  };
  if (!i.reviewId) {
    payload.level = i.level ?? 'standard';
    payload.iterationBudget = i.iterationBudget ?? 3;
    if (i.contextRounds !== undefined && i.contextRounds > 0) payload.contextRounds = i.contextRounds;
  }
  if (i.manifest && i.manifest.length > 0) payload.manifest = i.manifest;
  if (i.intent !== undefined && i.intent !== '') payload.intent = i.intent;
  if (i.commits && i.commits.length > 0) payload.commits = i.commits;
  if (i.reviewId && i.responses && i.responses.length > 0) payload.responses = i.responses;
  if (i.rules?.reviewMd !== undefined) {
    payload.rules = { source: 'base', revision: i.mergeBase, ...i.rules };
  }
  if (i.context.length > 0) payload.context = i.context;
  return payload;
}

export interface ContextSummary {
  reviewId: string;
  iteration: number;
  round: number;
  expiresAt: string | null;
  decisions: readonly ContextDecision[];
  extraFiles: ReadonlyArray<{ path: string; bytes: number }>;
  redactions: readonly RedactionLocation[];
}

export const CONTEXT_REASON_CHARS = 300;
const MIN_REASON_CHARS = 40;

/** Table-cell-safe text: no newlines, control characters, backticks or pipes; HTML escaped; bounded. */
function cell(s: string, max: number): string {
  const clean = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|');
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : clean;
}

interface ContextCaps {
  rows: number;
  reasonChars: number;
  locations: number;
  extra: number;
}

function decisionText(d: ContextDecision): string {
  const label = d.decision === 'provide' ? 'provide' : d.decision === 'not_found' ? 'not found' : 'declined';
  return d.localReason ? `${label} (${d.localReason})` : label;
}

function renderContext(s: ContextSummary, caps: ContextCaps): string {
  const lines: string[] = [];
  lines.push(`### Context for code review ${s.reviewId} iteration ${s.iteration}, round ${s.round} (not sent yet)`);
  lines.push('');
  lines.push(`Respond before ${s.expiresAt ?? 'the deadline'}; after that the review continues without this context.`);
  lines.push('');
  const provided = s.decisions.filter((d) => d.decision === 'provide');
  const bytes = provided.reduce((a, d) => a + d.bytes, 0) + s.extraFiles.reduce((a, f) => a + f.bytes, 0);
  lines.push(
    `- Requests: ${s.decisions.length}; provide ${provided.length}, decline ${s.decisions.filter((d) => d.decision === 'declined').length}, not found ${s.decisions.filter((d) => d.decision === 'not_found').length}; ${bytes} bytes in total`,
  );
  lines.push(`- Extra files (not requested): ${s.extraFiles.length}`);
  for (const f of s.extraFiles.slice(0, caps.extra)) lines.push(`  - ${code(f.path)} (${f.bytes} bytes)`);
  if (s.extraFiles.length > caps.extra) lines.push(`  - … and ${s.extraFiles.length - caps.extra} more`);
  const counts = new Map<string, number>();
  for (const r of s.redactions) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  if (s.redactions.length === 0) {
    lines.push('- Redactions: none');
  } else {
    const byType = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, n]) => `${t} ×${n}`)
      .join(', ');
    lines.push(`- Redactions: ${s.redactions.length} (${byType}); values replaced with [REDACTED:<type>]`);
    for (const r of s.redactions.slice(0, caps.locations)) lines.push(`  - ${code(`${r.file}:${r.line}`)} ${r.type}`);
    if (s.redactions.length > caps.locations) lines.push(`  - … and ${s.redactions.length - caps.locations} more`);
  }
  lines.push('');
  lines.push('| Request | Kind | Target | Reason (from the reviewer) | Decision | Bytes |');
  lines.push('|---|---|---|---|---|---|');
  for (const d of s.decisions.slice(0, caps.rows)) {
    lines.push(
      `| ${cell(d.requestId, 20)} | ${d.kind} | ${code(d.target).replace(/\|/g, '\\|')} | ${cell(d.reason, caps.reasonChars)} | ${decisionText(d)} | ${d.bytes} |`,
    );
  }
  if (s.decisions.length > caps.rows) lines.push(`| … and ${s.decisions.length - caps.rows} more | | | | | |`);
  lines.push('');
  lines.push('Nothing has been sent. Submitting sends exactly this context to the Kiro Reviewer service.');
  return lines.join('\n');
}

/**
 * Approval summary of a context round (<= 4,000 chars). Shrinks redaction locations first, then the
 * extra-file list, then reason length (down to 40 chars), then table rows. Counts are never dropped.
 */
export function buildContextSummaryMarkdown(s: ContextSummary): string {
  const caps: ContextCaps = {
    rows: s.decisions.length,
    reasonChars: CONTEXT_REASON_CHARS,
    locations: Math.min(SUMMARY_MAX_REDACTION_LOCATIONS, s.redactions.length),
    extra: s.extraFiles.length,
  };
  let md = renderContext(s, caps);
  while (md.length > SUMMARY_MAX_CHARS) {
    if (caps.locations > 0) caps.locations--;
    else if (caps.extra > 0) caps.extra--;
    else if (caps.reasonChars > MIN_REASON_CHARS) caps.reasonChars = Math.max(MIN_REASON_CHARS, caps.reasonChars - 20);
    else if (caps.rows > 0) caps.rows--;
    else break;
    md = renderContext(s, caps);
  }
  return md;
}
