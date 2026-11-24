// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toErrorResult, ToolError } from './errors.js';
import { CLIENT_VERSION, defaultClock, type ToolDeps } from './tools/common.js';
import { TOOLS } from './tools/registry.js';

/** stdio MCP server. stdout carries JSON-RPC only; logs go to stderr. */

export const TOOL_NAMES = [
  'code_review_prepare',
  'code_review_submit',
  'code_review_get',
  'code_review_suppress',
  'code_review_context_prepare',
  'code_review_context_submit',
  'code_review_status',
] as const;

const log = (msg: string): void => {
  process.stderr.write(`[kiro-code-reviewer] ${msg}\n`);
};

/** MCP Apps (SEP-1865): the chat card Kiro Crew renders inline for the tools below. */
export const CARD_URI = 'ui://kiro-code-reviewer/card';
export const CARD_MIME = 'text/html;profile=mcp-app';
const CARD_META = { ui: { resourceUri: CARD_URI } };
export const CARD_FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

/** dist/card.html next to the bundled server (built by scripts/bundle.mjs). */
export function defaultCardPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'card.html');
}

export function defaultDeps(): ToolDeps {
  return { env: process.env, http: { fetch: globalThis.fetch }, clock: defaultClock, log };
}

function wrap(name: string, fn: (input: unknown, deps: ToolDeps) => Promise<unknown>, deps: ToolDeps) {
  return async (input: unknown) => {
    try {
      return (await fn(input, deps)) as { content: Array<{ type: 'text'; text: string }> };
    } catch (err) {
      deps.log(`${name}: error ${err instanceof ToolError ? err.code : 'INTERNAL_ERROR'}`);
      return toErrorResult(err);
    }
  };
}

export function createServer(deps: ToolDeps = defaultDeps(), cardPath: string = defaultCardPath()): McpServer {
  const server = new McpServer({ name: 'kiro-code-reviewer', version: CLIENT_VERSION });
  server.registerResource(
    'review-card',
    CARD_URI,
    { title: 'Code review card', description: 'Interactive review and approval card.', mimeType: CARD_MIME },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: CARD_MIME,
          text: readFileSync(cardPath, 'utf8'),
          // Only Crew's own web fonts (the dashboard loads the same two families); no connect or frame origins.
          _meta: { ui: { csp: { resourceDomains: CARD_FONT_ORIGINS }, permissions: { clipboardWrite: {} } } },
        },
      ],
    }),
  );
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.shape,
        ...(t.card ? { _meta: CARD_META } : {}),
        annotations: t.annotations,
      },
      wrap(t.name, t.run, deps),
    );
  }
  return server;
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log('MCP server started on stdio');
}
