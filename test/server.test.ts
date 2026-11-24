// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CARD_FONT_ORIGINS, CARD_MIME, CARD_URI, createServer, TOOL_NAMES } from '../src/server.js';
import { makeDeps, rm, tempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rm(dirs.pop()!);
});

async function connect() {
  const dataDir = tempDir('kcr-srv-');
  dirs.push(dataDir);
  writeFileSync(path.join(dataDir, 'card.html'), '<!doctype html><html><body>card</body></html>');
  const server = createServer(makeDeps(dataDir), path.join(dataDir, 'card.html'));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

describe('MCP server', () => {
  it('lists the 7 tools with input schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.code_review_prepare.inputSchema.required).toEqual(expect.arrayContaining(['repoPath', 'base']));
    expect(byName.code_review_submit.inputSchema.required).toEqual(['preparedId', 'payloadDigest']);
    expect(byName.code_review_get.inputSchema.required).toEqual(['reviewId']);
    expect(byName.code_review_suppress.inputSchema.required).toEqual(expect.arrayContaining(['reviewId', 'findingId']));
    expect(tools).toHaveLength(7);
    expect(byName.code_review_status.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.code_review_context_prepare.inputSchema.required).toEqual(
      expect.arrayContaining(['repoPath', 'reviewId']),
    );
    expect(byName.code_review_context_prepare.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(byName.code_review_context_submit.inputSchema.required).toEqual(['preparedId', 'payloadDigest']);
    expect(byName.code_review_context_submit.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.code_review_context_submit.description).not.toMatch(/replied yes/);
    await client.close();
  });

  it('returns tool errors as isError with structuredContent', async () => {
    const client = await connect();
    const r = await client.callTool({
      name: 'code_review_submit',
      arguments: { preparedId: 'prep-0000000000000000', payloadDigest: '0'.repeat(64) },
    });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe('PREPARED_NOT_FOUND');
    await client.close();
  });

  it('declares the chat card on the get, prepare and context_prepare tools only', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withCard = tools.filter(
      (t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri === CARD_URI,
    );
    expect(withCard.map((t) => t.name).sort()).toEqual([
      'code_review_context_prepare',
      'code_review_get',
      'code_review_prepare',
    ]);
    await client.close();
  });

  it("serves the card as an MCP Apps resource that may only load Crew's web fonts", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([CARD_URI]);
    const read = await client.readResource({ uri: CARD_URI });
    const c = read.contents[0] as unknown as {
      mimeType: string;
      text: string;
      _meta: { ui: { csp: object; permissions: Record<string, unknown> } };
    };
    expect(c.mimeType).toBe(CARD_MIME);
    expect(c.text).toContain('<body>card</body>');
    expect(c._meta.ui.csp).toEqual({ resourceDomains: CARD_FONT_ORIGINS });
    expect(CARD_FONT_ORIGINS).toEqual(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
    expect(Object.keys(c._meta.ui.permissions)).toEqual(['clipboardWrite']);
    await client.close();
  });
});
