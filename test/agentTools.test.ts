// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentToolsBlock, callAgentTool } from '../src/tools/agentTools.js';
import { TOOLS } from '../src/tools/registry.js';
import { makeDeps, rm, tempDir } from './helpers.js';

let dataDir: string;
beforeEach(() => {
  dataDir = tempDir('kcr-at-');
});
afterEach(() => rm(dataDir));

describe('agentTools', () => {
  it('app.json carries the block built from the tool table (run npm run agent-tools)', () => {
    const manifest = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
    expect(manifest.agentTools).toEqual(agentToolsBlock());
  });

  it('declares every tool with snake_case arguments and a JSON-encoded responses array', () => {
    const block = agentToolsBlock() as { tools: Array<{ name: string; inputSchema: { properties: object } }> };
    expect(block.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const prepare = block.tools.find((t) => t.name === 'code_review_prepare')!.inputSchema.properties;
    expect(Object.keys(prepare)).toContain('repo_path');
    expect(prepare).toMatchObject({ responses: { type: 'string' } });
    for (const t of block.tools) {
      for (const k of Object.keys(t.inputSchema.properties)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('maps snake_case arguments back and answers a failure as {error, code}', async () => {
    const deps = makeDeps(dataDir, vi.fn<typeof fetch>());
    const out = await callAgentTool(
      {
        tool: 'code_review_submit',
        arguments: { prepared_id: 'prep-0000000000000000', payload_digest: '0'.repeat(64) },
      },
      deps,
    );
    expect(out).toMatchObject({ code: 'PREPARED_NOT_FOUND' });
  });

  it('refuses an unknown tool and a responses value that is not JSON', async () => {
    const deps = makeDeps(dataDir, vi.fn<typeof fetch>());
    expect(await callAgentTool({ tool: 'nope', arguments: {} }, deps)).toMatchObject({ code: 'VALIDATION_ERROR' });
    const bad = await callAgentTool(
      { tool: 'code_review_prepare', arguments: { repo_path: dataDir, base: 'main', responses: '{nope' } },
      deps,
    );
    expect(bad).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
