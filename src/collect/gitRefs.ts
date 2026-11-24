// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side mirror of the service's trailer/ref extraction, used only to show a derived-ref count in the
 * approval summary. The service re-derives refs authoritatively from `commits`; this is display-only. Pure, no I/O.
 */

export interface CommitMessage {
  subject: string;
  body?: string;
}

const TRAILER_KEYS = new Set(['fixes', 'closes', 'refs', 'sim', 'cr', 'related']);
export const MAX_REFS = 50;
export const MAX_REF_VALUE_CHARS = 200;

const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.+?)[ \t]*$/;
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const SIM_CR_RE = /\b(sim|cr):(\S+)/gi;

const cap = (s: string): string => [...s].slice(0, MAX_REF_VALUE_CHARS).join('');

function trailersOf(body: string): Array<{ kind: string; value: string }> {
  const lines = body.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  const block = lines.slice(start, end);
  if (block.length === 0) return [];
  const refs: Array<{ kind: string; value: string }> = [];
  for (const line of block) {
    const m = TRAILER_LINE_RE.exec(line);
    if (m === null) return [];
    const kind = m[1].toLowerCase();
    if (TRAILER_KEYS.has(kind)) refs.push({ kind, value: cap(m[2]) });
  }
  return refs;
}

function inlineRefs(text: string): Array<{ kind: string; value: string }> {
  const refs: Array<{ kind: string; value: string }> = [];
  for (const m of text.matchAll(SIM_CR_RE))
    refs.push({ kind: m[1].toLowerCase(), value: cap(`${m[1].toLowerCase()}:${m[2]}`) });
  for (const m of text.matchAll(TICKET_RE)) refs.push({ kind: 'ticket', value: cap(m[0]) });
  return refs;
}

/** De-duplicated, capped ref count across the given commits (matches the service extractor). */
export function countDerivedRefs(commits: ReadonlyArray<CommitMessage>): number {
  const seen = new Set<string>();
  const push = (ref: { kind: string; value: string }): void => {
    if (ref.value === '' || seen.size >= MAX_REFS) return;
    seen.add(`${ref.kind}|${ref.value}`);
  };
  for (const c of commits) {
    const body = c.body ?? '';
    for (const ref of trailersOf(body)) push(ref);
    for (const ref of inlineRefs(c.subject)) push(ref);
    for (const ref of inlineRefs(body)) push(ref);
  }
  return Math.min(seen.size, MAX_REFS);
}
