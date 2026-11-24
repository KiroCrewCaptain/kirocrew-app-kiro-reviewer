// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { HUNK_RE, unquotePath } from './collect/diffInfo.js';

/**
 * Secret redaction. Line-oriented; each pattern replaces only the secret
 * value with `[REDACTED:<type>]`. Linear-time regexes only; lines are matched in chunks of at most
 * 10,000 chars. Reported locations never carry the value.
 */

export type RedactionType =
  | 'aws-access-key-id'
  | 'aws-secret-access-key'
  | 'private-key'
  | 'github-token'
  | 'slack-token'
  | 'jwt'
  | 'generic-secret';

export interface RedactionLocation {
  type: RedactionType;
  file: string;
  line: number;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionLocation[];
}

export const LINE_MATCH_CAP = 10_000;

const marker = (type: RedactionType): string => `[REDACTED:${type}]`;

interface WholePattern {
  type: RedactionType;
  re: RegExp;
}

/** Patterns whose whole match is the secret value. */
const WHOLE_PATTERNS: WholePattern[] = [
  { type: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { type: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { type: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

const AWS_SECRET_RE =
  /(aws_?secret_?access_?key|aws_?secret|secretAccessKey)(["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})/gi;
const GENERIC_RE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{8,200})/gi;
/** A quoted `private_key` value, whole (escapes included), e.g. a GCP service-account key. */
const QUOTED_PK_RE = /("private[_-]?key"\s*:\s*")((?:[^"\\]|\\.)+)(")/gi;
/** A `private_key` assignment (TOML, YAML, .env, code); the whole quoted or bare value is captured. */
const BARE_PK_RE = /(private[_-]?key['"]?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi;
/** Key material: 40+ base64 / base64url chars, `\n` escapes included. */
const KEY_VALUE_RE = /^[A-Za-z0-9+/=_\\-]{40,}$/;
/** A whole line of 60+ base64 chars: a key body line whose BEGIN marker is not in view. */
const KEY_BODY_RE = /^\s*[A-Za-z0-9+/]{60,}={0,2}\s*$/;
/** A short base64 line directly after a body line: the body's last line. */
const KEY_TAIL_RE = /^\s*=?[A-Za-z0-9+/]{4,}={0,2}\s*$/;
const PLACEHOLDER_RES = [/^\$\{.*\}$/, /^<.*>$/, /^(x+|\*+)$/];
const PK_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PK_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

/** Base64 key body: mixed case and digits, which rules out hex digests and `////` dividers. */
function isKeyBodyLine(content: string): boolean {
  return KEY_BODY_RE.test(content) && isMixed(content);
}

function isMixed(content: string): boolean {
  return /[A-Z]/.test(content) && /[a-z]/.test(content) && /[0-9]/.test(content);
}

/** The body's last line: padded, or mixed case and digits (rules out plain words after a body). */
function isKeyTailLine(content: string): boolean {
  return KEY_TAIL_RE.test(content) && (content.trim().endsWith('=') || isMixed(content));
}

function isPlaceholder(value: string): boolean {
  return value.startsWith('[REDACTED:') || PLACEHOLDER_RES.some((re) => re.test(value));
}

function redactChunk(chunk: string, found: RedactionType[]): string {
  let out = chunk;
  for (const p of WHOLE_PATTERNS) {
    out = out.replace(p.re, () => {
      found.push(p.type);
      return marker(p.type);
    });
  }
  out = out.replace(AWS_SECRET_RE, (_m, key: string, sep: string) => {
    found.push('aws-secret-access-key');
    return `${key}${sep}${marker('aws-secret-access-key')}`;
  });
  out = out.replace(QUOTED_PK_RE, (m, prefix: string, value: string, quote: string) => {
    if (isPlaceholder(value)) return m;
    found.push('private-key');
    return `${prefix}${marker('private-key')}${quote}`;
  });
  out = out.replace(BARE_PK_RE, (m, prefix: string, value: string) => {
    const first = value[0];
    const quote = value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first) ? first : '';
    if (!KEY_VALUE_RE.test(quote ? value.slice(1, -1) : value.replace(/^['"]/, ''))) return m;
    found.push('private-key');
    return `${prefix}${quote}${marker('private-key')}${quote}`;
  });
  out = out.replace(GENERIC_RE, (m, prefix: string, value: string) => {
    if (isPlaceholder(value)) return m;
    found.push('generic-secret');
    return `${prefix}${marker('generic-secret')}`;
  });
  return out;
}

/** Redacts one line of content (no diff prefix). Returns the new text and the types found. */
export function redactLine(content: string): { text: string; types: RedactionType[] } {
  const types: RedactionType[] = [];
  if (content.length <= LINE_MATCH_CAP) return { text: redactChunk(content, types), types };
  let text = '';
  for (let i = 0; i < content.length; i += LINE_MATCH_CAP) {
    text += redactChunk(content.slice(i, i + LINE_MATCH_CAP), types);
  }
  return { text, types };
}

/**
 * Stateful private-key tracker shared by the diff and plain-text redactors. Everything from a BEGIN
 * marker through its END marker is replaced, whether the key spans lines or sits on one line (a PEM
 * in a JSON string with `\n` escapes). A key cut off by a hunk or line range is caught by its END
 * marker (text before it is replaced) and by whole base64 body lines. Text outside the key goes
 * through redactLine.
 */
class PrivateKeyState {
  inBlock = false;
  /** The previous line was a bare key body line; a run is reported once. */
  inBody = false;

  /** Redacts one line; `key` is true when any part of it belongs to a private key. */
  redact(content: string): { text: string; types: RedactionType[]; key: boolean } {
    const types: RedactionType[] = [];
    let key = this.inBlock;
    let text = '';
    let rest = content;
    if (!this.inBlock) {
      if (isKeyBodyLine(content) || (this.inBody && isKeyTailLine(content))) {
        if (!this.inBody) types.push('private-key');
        this.inBody = true;
        return { text: marker('private-key'), types, key: true };
      }
      const end = PK_END_RE.exec(content);
      const begin = PK_BEGIN_RE.exec(content);
      if (end && (!begin || end.index < begin.index)) {
        if (!this.inBody) types.push('private-key');
        text = marker('private-key');
        rest = content.slice(end.index + end[0].length);
        key = true;
      }
    }
    this.inBody = false;
    for (;;) {
      if (this.inBlock) {
        const end = PK_END_RE.exec(rest);
        text += marker('private-key');
        if (!end) return { text, types, key };
        this.inBlock = false;
        rest = rest.slice(end.index + end[0].length);
        continue;
      }
      const begin = PK_BEGIN_RE.exec(rest);
      if (!begin) break;
      const before = redactLine(rest.slice(0, begin.index));
      text += before.text;
      types.push(...before.types, 'private-key');
      key = true;
      this.inBlock = true;
      rest = rest.slice(begin.index + begin[0].length);
    }
    const after = redactLine(rest);
    return { text: text + after.text, types: [...types, ...after.types], key };
  }
}

/** Redacts a plain text file (context file or REVIEW.md); `line` is the 1-based file line. */
export function redactText(text: string, file: string): RedactionResult {
  const pk = new PrivateKeyState();
  const redactions: RedactionLocation[] = [];
  const lines = text.split('\n').map((content, i) => {
    const r = pk.redact(content);
    for (const type of r.types) redactions.push({ type, file, line: i + 1 });
    return r.text;
  });
  return { text: lines.join('\n'), redactions };
}

/**
 * Redacts a unified diff. Header lines (diff --git, index, ---, +++, @@) are kept; only the content
 * of `+`, `-` and context lines is redacted, and the one-character prefix is preserved. A line is
 * reported with its new-side number for adds/context and its old-side number for deletes.
 */
export function redactDiff(diff: string): RedactionResult {
  const redactions: RedactionLocation[] = [];
  let file = '';
  let oldPath = '';
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let pkNew = new PrivateKeyState();
  let pkOld = new PrivateKeyState();
  const out = diff.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      pkNew = new PrivateKeyState();
      pkOld = new PrivateKeyState();
      const rest = line.slice('diff --git '.length);
      const idx = rest.lastIndexOf(' b/');
      file = idx >= 0 ? unquotePath(rest.slice(idx + 1)).replace(/^b\//, '') : rest;
      oldPath = file;
      return line;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      pkNew = new PrivateKeyState();
      pkOld = new PrivateKeyState();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      return line;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = unquotePath(line.slice(4).trim());
        if (p !== '/dev/null') oldPath = p.replace(/^a\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = unquotePath(line.slice(4).trim());
        file = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
      }
      return line;
    }
    const prefix = line[0];
    if (prefix !== '+' && prefix !== '-' && prefix !== ' ') return line; // "\ No newline at end of file", blank
    const content = line.slice(1);
    const isDelete = prefix === '-';
    const lineNo = isDelete ? oldLine : newLine;
    const reportFile = isDelete ? oldPath : file;
    if (prefix === '+') newLine++;
    else if (prefix === '-') oldLine++;
    else {
      oldLine++;
      newLine++;
    }
    // Track key blocks per side: context lines feed both sides. A side inside a key wins.
    const states = prefix === '+' ? [pkNew] : prefix === '-' ? [pkOld] : [pkNew, pkOld];
    const results = states.map((s) => s.redact(content));
    const r = results.find((x) => x.key) ?? results[0]!;
    for (const type of r.types) redactions.push({ type, file: reportFile, line: lineNo });
    return `${prefix}${r.text}`;
  });
  return { text: out.join('\n'), redactions };
}
