// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fitChangedFiles, changedFilePaths } from '../src/collect/changedFiles.js';
import type { SubmitRequest } from '../src/client/types.js';
import { LIMITS } from '../src/limits.js';
import { loadStaged } from '../src/staging.js';
import { prepareTool } from '../src/tools/prepare.js';
import { fakeClock, git, makeDeps, makeRepo, rm, tempDir, write } from './helpers.js';

let repo: string;
let dataDir: string;

beforeEach(() => {
  repo = makeRepo();
  dataDir = tempDir('kcr-data-');
});
afterEach(() => {
  rm(repo);
  rm(dataDir);
});

async function prepare(input: Record<string, unknown>) {
  const clock = fakeClock();
  const r = await prepareTool({ repoPath: repo, base: 'mainline', ...input }, makeDeps(dataDir, undefined, clock));
  const out = r.structuredContent as { preparedId: string; summaryMarkdown: string };
  const staged = loadStaged(dataDir, out.preparedId, clock.now());
  if (!staged) throw new Error('nothing staged');
  return { payload: staged.payload as SubmitRequest, summary: out.summaryMarkdown };
}

function commitAll(message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

/** Commits files on the base branch and rebases the feature branch onto it, so editing them later is a modification. */
function addToBase(files: Record<string, string>): void {
  git(repo, 'checkout', '-q', 'mainline');
  for (const [p, content] of Object.entries(files)) write(repo, p, content);
  commitAll('base files');
  git(repo, 'checkout', '-q', 'feature');
  git(repo, 'rebase', '-q', 'mainline');
}

describe('includeChangedFiles', () => {
  it('is on by default, and false sends no changed file unless the user picked it', async () => {
    expect((await prepare({})).payload.context?.map((c) => c.path)).toEqual(['src/users.ts']);
    const { payload, summary } = await prepare({ includeChangedFiles: false });
    expect(payload.context).toBeUndefined();
    expect(summary).not.toContain('sent in full');
  });

  it('sends modified files in any language in full, redacted, and says so in the summary', async () => {
    addToBase({ 'src/orders.py': 'def place():\n    return 0\n' });
    write(repo, 'src/orders.py', 'API_KEY = "AKIAABCDEFGHIJKLMNOP"\ndef place():\n    return 1\n');
    write(repo, 'docs/spec.md', '# Spec, edited\n');
    commitAll('more');
    const { payload, summary } = await prepare({ includeChangedFiles: true });

    const sent = new Map((payload.context ?? []).map((c) => [c.path, c.content]));
    expect([...sent.keys()].sort()).toEqual(['docs/spec.md', 'src/orders.py', 'src/users.ts']);
    expect(sent.get('src/users.ts')).toContain('export const b');
    expect(sent.get('src/orders.py')).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(sent.get('src/orders.py')).toContain('[REDACTED');
    expect(summary).toContain('Changed files sent in full: 3');
    expect(summary).toMatch(/Redactions: [1-9]/);
  });

  it('does not attach a file the diff adds, since the diff carries it whole', async () => {
    write(repo, 'src/added.ts', 'export const c = 1;\n');
    commitAll('add');
    const { payload, summary } = await prepare({ includeChangedFiles: true });
    expect((payload.context ?? []).map((c) => c.path)).toEqual(['src/users.ts']);
    expect(summary).toContain('Changed files sent in full: 1');
    expect(summary).not.toContain('src/added.ts` (');
  });

  it('does not send a file twice when the user also picked it as context', async () => {
    const { payload, summary } = await prepare({ includeChangedFiles: true, contextFiles: ['src/users.ts'] });
    expect((payload.context ?? []).map((c) => c.path)).toEqual(['src/users.ts']);
    expect(summary).toContain('Changed files sent in full: 0');
  });

  it('refuses secret-like paths and symlinks out of the repository, and lists them as not sent', async () => {
    const outside = tempDir('kcr-outside-');
    write(outside, 'leak.ts', 'export const secret = 1;\n');
    write(outside, 'old.ts', 'export const old = 1;\n');
    git(repo, 'checkout', '-q', 'mainline');
    write(repo, 'src/.env.ts', 'export const x = 0;\n');
    symlinkSync(path.join(outside, 'old.ts'), path.join(repo, 'src', 'link.ts'));
    commitAll('base risky');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'mainline');
    write(repo, 'src/.env.ts', 'export const x = 1;\n');
    rm(path.join(repo, 'src', 'link.ts'));
    symlinkSync(path.join(outside, 'leak.ts'), path.join(repo, 'src', 'link.ts'));
    try {
      commitAll('risky');
      const { payload, summary } = await prepare({ includeChangedFiles: true, includeUncommitted: true });
      const paths = (payload.context ?? []).map((c) => c.path);
      expect(paths).toEqual(['src/users.ts']);
      expect(summary).toContain('not sent: `src/.env.ts` (refused)');
      expect(summary).toContain('not sent: `src/link.ts` (refused)');
      expect(JSON.stringify(payload)).not.toContain('export const secret');
    } finally {
      rm(outside);
    }
  });

  it('skips deleted files and files that would exceed the context limits instead of failing', async () => {
    addToBase({ 'src/big.js': '// big\n', 'src/small.java': 'class Small { }\n' });
    git(repo, 'rm', '-q', 'src/users.ts');
    const big = 'x'.repeat(LIMITS.contextFileBytes + 1);
    write(repo, 'src/big.js', `// ${big}\n`);
    write(repo, 'src/small.java', 'class Small {}\n');
    commitAll('mixed');
    const { payload, summary } = await prepare({ includeChangedFiles: true });
    expect((payload.context ?? []).map((c) => c.path)).toEqual(['src/small.java']);
    expect(summary).toContain('not sent: `src/big.js` (too-large)');
  });
});

describe('changedFilePaths', () => {
  it('keeps modified and renamed files in diff order, and leaves out added, deleted and binary ones', () => {
    expect(
      changedFilePaths([
        { path: 'a.ts', oldPath: 'a.ts', status: 'modified', added: 1, removed: 0 },
        { path: 'gone.py', oldPath: 'gone.py', status: 'deleted', added: 0, removed: 1 },
        { path: 'img.png', oldPath: null, status: 'binary', added: 0, removed: 0 },
        { path: 'README.md', oldPath: 'README.md', status: 'modified', added: 1, removed: 0 },
        { path: 'lib/New.java', oldPath: 'lib/Old.java', status: 'renamed', added: 0, removed: 0 },
        { path: 'native/x.HPP', oldPath: null, status: 'added', added: 3, removed: 0 },
        { path: 'main.go', oldPath: 'main.go', status: 'modified', added: 1, removed: 0 },
      ]),
    ).toEqual(['a.ts', 'README.md', 'lib/New.java', 'main.go']);
  });
});

describe('fitChangedFiles', () => {
  it('counts the files already in context against the file-count and total-byte limits', () => {
    const existing = Array.from({ length: LIMITS.contextFiles - 1 }, (_, i) => ({ path: `c${i}.ts`, content: 'x' }));
    const fit = fitChangedFiles(existing, [
      { path: 'one.ts', content: 'a' },
      { path: 'two.ts', content: 'b' },
    ]);
    expect(fit.attached.map((a) => a.path)).toEqual(['one.ts']);
    expect(fit.skipped).toEqual([{ path: 'two.ts', reason: 'context-limit' }]);

    const nearlyFull = [{ path: 'c.ts', content: 'x'.repeat(LIMITS.contextTotalBytes - 10) }];
    const byBytes = fitChangedFiles(nearlyFull, [
      { path: 'big.ts', content: 'y'.repeat(20) },
      { path: 'tiny.ts', content: 'z' },
    ]);
    expect(byBytes.attached.map((a) => a.path)).toEqual(['tiny.ts']);
    expect(byBytes.skipped).toEqual([{ path: 'big.ts', reason: 'context-limit' }]);
  });
});
