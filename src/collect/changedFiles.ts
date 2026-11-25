// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ToolError } from '../errors.js';
import { LIMITS, utf8Bytes } from '../limits.js';
import { checkRequestPath } from '../safety.js';
import type { DiffFileInfo } from './diffInfo.js';
import { decodeRepoText, readRepoFile } from './git.js';

/**
 * Changed files sent in full (includeChangedFiles), like the GitHub action's `include-changed-files`, so the
 * reviewers see whole files rather than hunks.
 */

export type ChangedFileSkipReason = 'refused' | 'not-found' | 'not-text' | 'too-large' | 'context-limit';

export interface ChangedFileSkip {
  path: string;
  reason: ChangedFileSkipReason;
}

export interface ChangedFileCandidate {
  path: string;
  content: string;
}

/**
 * Changed files to send in full: modified or renamed, in diff order. Added files are left out, since the diff already
 * carries them whole; deleted and binary files have no text to send. Non-text files are skipped when read.
 */
export function changedFilePaths(files: readonly DiffFileInfo[]): string[] {
  return files.filter((f) => f.status === 'modified' || f.status === 'renamed').map((f) => f.path);
}

/**
 * Reads each changed path's full text at HEAD (or from the working tree with includeUncommitted).
 * Paths go through the same checks as a context-round request (realpath containment, .git/ and the
 * secret-path denylist on both the requested and the resolved path). Paths in `exclude` (already
 * sent as context) are left out silently. Nothing here applies the context limits; see fitChangedFiles.
 */
export async function readChangedFiles(input: {
  top: string;
  headSha: string;
  includeUncommitted: boolean;
  paths: readonly string[];
  exclude: ReadonlySet<string>;
}): Promise<{ candidates: ChangedFileCandidate[]; skipped: ChangedFileSkip[] }> {
  const candidates: ChangedFileCandidate[] = [];
  const skipped: ChangedFileSkip[] = [];
  for (const rel of input.paths) {
    // Already sent as a context file the user picked.
    if (input.exclude.has(rel)) continue;
    const check = checkRequestPath(input.top, rel);
    if (!check.ok) {
      skipped.push({ path: rel, reason: check.reason === 'NOT_FOUND' ? 'not-found' : 'refused' });
      continue;
    }
    let buf: Buffer | null;
    try {
      buf = await readRepoFile(input.top, input.headSha, check.posix, input.includeUncommitted);
    } catch (e) {
      if (e instanceof ToolError && e.code === 'LIMIT_EXCEEDED') {
        skipped.push({ path: rel, reason: 'too-large' });
        continue;
      }
      throw e;
    }
    if (buf === null) {
      skipped.push({ path: rel, reason: 'not-found' });
      continue;
    }
    const text = decodeRepoText(buf);
    if (text === null) {
      skipped.push({ path: rel, reason: 'not-text' });
      continue;
    }
    candidates.push({ path: check.posix, content: text });
  }
  return { candidates, skipped };
}

/**
 * Keeps candidates, in order, while they fit the per-file and total context limits left after the
 * files already in `context`. Call it on redacted content, since that is what is sent and checked.
 * A file that does not fit is skipped, never an error.
 */
export function fitChangedFiles(
  context: ReadonlyArray<{ path: string; content: string }>,
  candidates: readonly ChangedFileCandidate[],
): { attached: ChangedFileCandidate[]; skipped: ChangedFileSkip[] } {
  let files = context.length;
  let bytes = context.reduce((n, c) => n + utf8Bytes(c.content), 0);
  const attached: ChangedFileCandidate[] = [];
  const skipped: ChangedFileSkip[] = [];
  for (const c of candidates) {
    const size = utf8Bytes(c.content);
    if (size > LIMITS.contextFileBytes) {
      skipped.push({ path: c.path, reason: 'too-large' });
      continue;
    }
    if (files + 1 > LIMITS.contextFiles || bytes + size > LIMITS.contextTotalBytes) {
      skipped.push({ path: c.path, reason: 'context-limit' });
      continue;
    }
    files += 1;
    bytes += size;
    attached.push(c);
  }
  return { attached, skipped };
}
