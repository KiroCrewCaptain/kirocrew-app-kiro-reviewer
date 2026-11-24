// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_MAX, readHistory, recordReview } from '../src/history.js';
import { submitTool } from '../src/tools/submit.js';
import { jsonResponse, makeDeps, makeRepo, rm, tempDir } from './helpers.js';
import { prepareTool } from '../src/tools/prepare.js';

let dataDir: string;
beforeEach(() => {
  dataDir = tempDir('kcr-hist-');
});
afterEach(() => rm(dataDir));

const id = (n: number): string => `rev-${n.toString(16).padStart(24, '0')}`;

describe('history', () => {
  it('is empty when the file is missing or unreadable', () => {
    expect(readHistory(dataDir)).toEqual([]);
    writeFileSync(path.join(dataDir, 'reviews.json'), 'not json');
    expect(readHistory(dataDir)).toEqual([]);
  });

  it('records newest first, keeps the first entry for a repeated id, and writes 0600', () => {
    recordReview(dataDir, { reviewId: id(1), trackedAt: 'a', headRef: 'one' });
    recordReview(dataDir, { reviewId: id(2), trackedAt: 'b' });
    recordReview(dataDir, { reviewId: id(1), trackedAt: 'c', headRef: 'changed' });
    expect(readHistory(dataDir).map((e) => e.reviewId)).toEqual([id(2), id(1)]);
    expect(readHistory(dataDir)[1].headRef).toBe('one');
    expect(statSync(path.join(dataDir, 'reviews.json')).mode & 0o777).toBe(0o600);
  });

  it('drops the stored payload of a trimmed review', async () => {
    const { saveSubmission, loadStored } = await import('../src/payloadStore.js');
    saveSubmission(dataDir, id(0), 1, { base: { ref: 'm', commit: 'c' }, diff: 'd' }, 'x');
    for (let i = 0; i <= HISTORY_MAX; i++) recordReview(dataDir, { reviewId: id(i), trackedAt: 'x' });
    expect(loadStored(dataDir, id(0))).toEqual([]);
  });

  it('caps the list and drops malformed entries', () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++) recordReview(dataDir, { reviewId: id(i), trackedAt: 'x' });
    expect(readHistory(dataDir)).toHaveLength(HISTORY_MAX);
    writeFileSync(
      path.join(dataDir, 'reviews.json'),
      JSON.stringify([
        { reviewId: 'bad', trackedAt: 'x' },
        { reviewId: id(1), trackedAt: 'x' },
      ]),
    );
    expect(readHistory(dataDir)).toHaveLength(1);
  });
});

describe('code_review_submit records history', () => {
  it('adds the submitted review with its branch and base', async () => {
    const repo = makeRepo();
    try {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse(202, { reviewId: id(7), iteration: 1, status: 'QUEUED', iterationBudget: 3, warnings: [] }),
      );
      const deps = makeDeps(dataDir, fetchImpl);
      const prep = await prepareTool({ repoPath: repo, base: 'mainline', contextRounds: 0 }, deps);
      const s = prep.structuredContent as { preparedId: string; payloadDigest: string; summaryMarkdown: string };
      await submitTool({ preparedId: s.preparedId, payloadDigest: s.payloadDigest }, deps);
      const [entry] = readHistory(dataDir);
      expect(entry.reviewId).toBe(id(7));
      expect(entry.baseRef).toBe('mainline');
      expect(entry.headRef).toBe('feature');
      const { loadStored } = await import('../src/payloadStore.js');
      const [stored] = loadStored(dataDir, id(7));
      expect(stored.number).toBe(1);
      expect(stored.submission?.diff).toContain('req.query.id');
      expect(stored.submission?.base.ref).toBe('mainline');
    } finally {
      rm(repo);
    }
  });
});
