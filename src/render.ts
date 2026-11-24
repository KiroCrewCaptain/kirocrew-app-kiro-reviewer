// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Finding, GetReviewResponse, IterationStatus, Outcome, Severity } from './client/types.js';
import { TERMINAL_STATUSES } from './client/types.js';

/**
 * Markdown rendering. The renderer applies the outcome rule client-side: a
 * non-terminal status is always IN_PROGRESS and a terminal non-COMPLETED status is always
 * INCOMPLETE, whatever the `outcome` field says.
 */

export const NO_FINDINGS_CAVEAT = '(A review with no findings does not mean the code is defect-free.)';
export const STILL_RUNNING_TEXT = 'still running — call code_review_get again';
export const NEEDS_CONTEXT_TEXT = 'Call code_review_context_prepare now; the window is about 2 minutes.';
export const MISSING_CONTEXT_TEXT = 'Reviewed without some requested context (not fully informed).';
const REASON_MAX = 300;
const TITLE_MAX = 120;

/** NEEDS_CONTEXT with an AWAITING round: the client must prepare and submit context now. */
export function awaitingContext(r: GetReviewResponse): boolean {
  return r.iteration.status === 'NEEDS_CONTEXT' && r.iteration.contextRound?.state === 'AWAITING';
}

/** The outcome the client displays. */
export function displayOutcome(status: IterationStatus, active: number): Outcome {
  if (!TERMINAL_STATUSES.includes(status)) return 'IN_PROGRESS';
  if (status !== 'COMPLETED') return 'INCOMPLETE';
  return active > 0 ? 'FINDINGS' : 'NO_FINDINGS';
}

/** Escapes text for a table cell or inline Markdown. */
export function escapeCell(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|');
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

function escapeBlock(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\r\n|\r|\n/)
    .map((l) => `> ${l}`)
    .join('\n');
}

function location(f: Finding): string {
  const range = f.endLine > f.startLine ? `${f.startLine}-${f.endLine}` : `${f.startLine}`;
  const file = f.file
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|');
  return `\`${file}:${range}\``;
}

function incompleteReasons(r: GetReviewResponse): string {
  const it = r.iteration;
  const reasons: string[] = [];
  const c = it.completeness;
  if (c) {
    for (const f of c.reviewersFailed ?? []) reasons.push(`reviewer ${f.reviewer} failed (${f.code})`);
    if (c.verify && c.verify !== 'OK') reasons.push(`verify ${c.verify}`);
    if (c.budgetExhausted) reasons.push('model budget exhausted');
    if (c.deadlineHit) reasons.push('work deadline hit');
    if (c.candidatesTruncated) reasons.push('candidates truncated');
    if (c.findingsTruncated) reasons.push('findings truncated');
  }
  if (it.error) reasons.push(`error ${it.error.code}${it.error.stage ? ` in ${it.error.stage}` : ''}`);
  if (reasons.length === 0) reasons.push(`status ${it.status}`);
  return escapeCell(reasons.join('; '));
}

const contextMissing = (r: GetReviewResponse): boolean => r.iteration.completeness?.context?.missing === true;

function header(r: GetReviewResponse, outcome: Outcome): string {
  const id = r.reviewId;
  const n = r.iteration.number;
  const k = r.iteration.counts;
  switch (outcome) {
    case 'IN_PROGRESS':
      if (awaitingContext(r)) {
        return `📎 Code review ${id} iteration ${n} is waiting for context the reviewer requested.`;
      }
      if (r.iteration.status === 'NEEDS_CONTEXT') {
        const state = r.iteration.contextRound?.state;
        return state === 'RESPONDED' || state === 'APPLIED'
          ? `📨 Code review ${id} iteration ${n} is applying the submitted context.`
          : `⏳ Code review ${id} iteration ${n} is resuming without the requested context.`;
      }
      return `⏳ Code review ${id} iteration ${n} is still running.`;
    case 'NO_FINDINGS':
      return `✅ Code review ${id} iteration ${n} completed with no findings. ${NO_FINDINGS_CAVEAT}${contextMissing(r) ? ` ${MISSING_CONTEXT_TEXT}` : ''}`;
    case 'FINDINGS':
      return `🔎 Code review ${id} iteration ${n} completed: ${k.blocking} blocking, ${k.active} active, ${k.suppressed} suppressed, ${k.resolved} resolved.`;
    case 'INCOMPLETE':
      return `⚠️ Code review ${id} iteration ${n} is INCOMPLETE (${r.iteration.status}): ${incompleteReasons(r)}. These results are not a clean review.`;
  }
}

export interface RenderOptions {
  /** True when code_review_get's wait elapsed before a terminal status. */
  waitElapsed?: boolean;
}

/** At most this many excluded paths are listed (the rest are counted). */
export const EXCLUDED_LIST_MAX = 20;

/** Escaped list of up to `max` items, plus "… and N more". */
export function listWithMore(items: readonly string[], max: number, fmt: (s: string) => string = escapeCell): string {
  const shown = items.slice(0, max).map(fmt).join(', ');
  return items.length > max ? `${shown} … and ${items.length - max} more` : shown;
}

/** Cache-hit, excluded-file and skipped-rule notes (never silent). */
function serviceNotes(r: GetReviewResponse): string[] {
  const it = r.iteration;
  const notes: string[] = [];
  if (it.cache?.hit) {
    const at = it.cache.cachedAt ? ` from ${escapeCell(it.cache.cachedAt)}` : '';
    notes.push(`♻️ Cached result${at}: identical diff, rules, context and level; no model calls.`);
  }
  if (it.excludedFiles && it.excludedFiles.length > 0) {
    notes.push(
      `Excluded from review (generated/fixture/lock/vendored): ${listWithMore(it.excludedFiles, EXCLUDED_LIST_MAX, (p) => `\`${escapeCell(p)}\``)}`,
    );
  }
  const skipped = it.completeness?.rulesSkipped ?? [];
  if (skipped.length > 0) {
    notes.push(`Custom rules skipped (no matching changed file): ${skipped.map(escapeCell).join(', ')}`);
  }
  if (TERMINAL_STATUSES.includes(it.status)) notes.push(...contextNotes(r));
  return notes;
}

const ids = (xs: readonly string[] | undefined): string => (xs ?? []).map(escapeCell).join(', ');

/** Context-round outcome of a terminal iteration (never silent about missing context). */
function contextNotes(r: GetReviewResponse): string[] {
  const c = r.iteration.completeness?.context;
  if (!c || c.requested.length === 0) return [];
  const parts = [`${c.provided.length} provided`];
  if (c.declined.length > 0) parts.push(`declined: ${ids(c.declined)}`);
  if (c.notFound.length > 0) parts.push(`not found: ${ids(c.notFound)}`);
  if (c.unanswered.length > 0) parts.push(`not provided${c.timedOut ? ' (timed out)' : ''}: ${ids(c.unanswered)}`);
  const notes = [`Context round ${c.round ?? '?'}: ${c.requested.length} requested; ${parts.join('; ')}.`];
  if (c.missing) notes.push(MISSING_CONTEXT_TEXT);
  return notes;
}

/** The open context round: requests with the reviewer's (untrusted, escaped) reasons. */
function needsContextSection(r: GetReviewResponse): string[] {
  const it = r.iteration;
  const round = it.contextRound;
  const out = [
    '',
    `The reviewer requested more context (round ${round?.round ?? '?'}); respond before ${escapeCell(round?.expiresAt ?? 'the deadline')}, after that the review continues without it.`,
  ];
  const requests = it.contextRequests ?? [];
  if (requests.length > 0) {
    out.push('', '| Request | Kind | Target | Reason (from the reviewer) |', '|---|---|---|---|');
    for (const q of requests) {
      const target =
        q.kind === 'search'
          ? (q.query ?? '')
          : q.kind === 'range'
            ? `${q.path ?? ''}:${q.startLine ?? '?'}-${q.endLine ?? '?'}`
            : (q.path ?? '');
      out.push(
        `| ${escapeCell(q.requestId)} | ${escapeCell(q.kind)} | \`${escapeCell(truncate(target, TITLE_MAX))}\` | ${escapeCell(truncate(q.reason, REASON_MAX))} |`,
      );
    }
  }
  out.push('', NEEDS_CONTEXT_TEXT);
  return out;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];
const SEVERITY_BADGE: Record<Severity, string> = {
  critical: '🔴 **Critical**',
  high: '🟠 **High**',
  medium: '🟡 **Medium**',
  low: '🔵 **Low**',
  nit: '⚪ **Nit**',
};

const bySeverity = (a: Finding, b: Finding): number =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
  a.file.localeCompare(b.file) ||
  a.startLine - b.startLine;

/** One list item: badge, title, then location and state on a second line. No ID (it is in the structured result). */
function findingItem(f: Finding): string {
  const extra: string[] = [
    location(f),
    f.state === 'NEW' ? 'new' : f.state === 'PERSISTING' ? 'still open' : 'resolved',
  ];
  if (f.dismissedByAuthor) extra.push('dismissed by author, still blocking');
  if (f.claimedFixedStillPresent) extra.push('claimed fixed, still present');
  return `- ${SEVERITY_BADGE[f.severity] ?? escapeCell(f.severity)} · ${escapeCell(truncate(f.title, TITLE_MAX))}  \n  ${extra.join(' · ')}`;
}

function detailsBlock(f: Finding): string[] {
  const out = ['', `<details><summary>${escapeCell(truncate(f.title, TITLE_MAX))} · ${location(f)}</summary>`, ''];
  const badges: string[] = [];
  if (f.dismissedByAuthor) {
    const reason = f.dismissalReason ? `: ${escapeCell(truncate(f.dismissalReason, REASON_MAX))}` : '';
    badges.push(
      `**Blocking, dismissed by author** (${escapeCell(f.dismissalDisposition ?? 'dismissed')}${reason}). Still shown as blocking; the service gates nothing.`,
    );
  }
  if (f.claimedFixedStillPresent) badges.push('**Claimed fixed, still present.**');
  if (badges.length > 0) out.push(badges.join(' '), '');
  out.push(escapeBlock(f.explanation));
  if (f.suggestion) out.push('', '**Suggestion:**', '', escapeBlock(f.suggestion));
  if (f.thread && f.thread.length > 0) {
    out.push('', '**Thread:**');
    for (const t of f.thread)
      out.push('', `*${escapeCell(t.author)} (iteration ${t.iteration}):*`, '', escapeBlock(t.text));
  }
  out.push('', `<sub>Finding ${escapeCell(f.findingId)}</sub>`, '', '</details>');
  return out;
}

/**
 * Findings as grouped lists (no wide table: in a chat column a 6-column table wraps mid-word). Blocking first, then
 * other active findings, then resolved and suppressed as one-liners; details per active finding below.
 */
function findingsSection(r: GetReviewResponse, findings: Finding[]): string[] {
  const active = findings.filter((f) => f.state !== 'RESOLVED' && !f.suppressed).sort(bySeverity);
  const blocking = active.filter((f) => f.blocking);
  const other = active.filter((f) => !f.blocking);
  const resolved = findings.filter((f) => f.state === 'RESOLVED').sort(bySeverity);
  const suppressed = findings.filter((f) => f.suppressed && f.state !== 'RESOLVED').sort(bySeverity);
  const out: string[] = [];
  if (blocking.length > 0) out.push('', `**Blocking (${blocking.length})**`, '', ...blocking.map(findingItem));
  if (other.length > 0)
    out.push(
      '',
      `**${blocking.length > 0 ? 'Other findings' : 'Findings'} (${other.length})**`,
      '',
      ...other.map(findingItem),
    );
  if (resolved.length > 0) {
    out.push('', `**Resolved (${resolved.length})**`, '');
    for (const f of resolved) out.push(`- ~~${escapeCell(truncate(f.title, TITLE_MAX))}~~ · ${location(f)}`);
  }
  if (suppressed.length > 0) {
    out.push('', `**Suppressed (${suppressed.length})**`, '');
    for (const f of suppressed) {
      const why = f.suppressionReason ? ` · ${escapeCell(truncate(f.suppressionReason, REASON_MAX))}` : '';
      out.push(`- ~~${escapeCell(truncate(f.title, TITLE_MAX))}~~ · ${location(f)}${why}`);
    }
  }
  for (const f of active) out.push(...detailsBlock(f));
  return out;
}

/** Kiro Crew route of the Kiro Reviewer page; `review` selects (and tracks) a review. */
export const PAGE_ROUTE = '/apps/kiro-code-reviewer';
export const pageLink = (reviewId: string): string => `${PAGE_ROUTE}?review=${encodeURIComponent(reviewId)}`;

export function renderReview(r: GetReviewResponse, opts: RenderOptions = {}): string {
  const outcome = displayOutcome(r.iteration.status, r.iteration.counts.active);
  const out: string[] = [header(r, outcome), '', `[Open in Kiro Reviewer →](${pageLink(r.reviewId)})`];
  const notes = serviceNotes(r);
  if (notes.length > 0) out.push('', ...notes);
  if (awaitingContext(r)) out.push(...needsContextSection(r));
  else if (outcome === 'IN_PROGRESS' && opts.waitElapsed)
    out.push('', `Status ${r.iteration.status}: ${STILL_RUNNING_TEXT}.`);

  const findings = outcome === 'IN_PROGRESS' ? [] : r.findings;
  if (findings.length > 0) out.push(...findingsSection(r, findings));
  if (r.iteration.warnings && r.iteration.warnings.length > 0) {
    out.push('', `Warnings: ${r.iteration.warnings.map(escapeCell).join(', ')}`);
  }
  const u = r.iteration.modelUsage;
  const usage = u ? `${u.calls} calls, ${u.inputTokens} input tokens, ${u.outputTokens} output tokens` : 'n/a';
  out.push('', `<sub>Iteration ${r.iteration.number} of budget ${r.iterationBudget}. Model usage: ${usage}.</sub>`);
  return out.join('\n');
}
