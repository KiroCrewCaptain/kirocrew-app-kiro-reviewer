// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ZodRawShape } from 'zod';
import type { ToolDeps } from './common.js';
import { contextPrepareInputShape, contextPrepareTool } from './contextPrepare.js';
import { contextSubmitInputShape, contextSubmitTool } from './contextSubmit.js';
import { getInputShape, getTool } from './get.js';
import { prepareInputShape, prepareTool } from './prepare.js';
import { statusInputShape, statusTool } from './status.js';
import { submitInputShape, submitTool } from './submit.js';
import { suppressInputShape, suppressTool } from './suppress.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** One tool, served by the MCP server and by the page backend's agent-tools route. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  shape: ZodRawShape;
  annotations: { readOnlyHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };
  /** Kiro Crew renders the review card for this tool's result. */
  card?: boolean;
  /** Seconds Kiro Crew waits for an agent-tools answer. */
  timeoutSeconds: number;
  run: (input: unknown, deps: ToolDeps) => Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'code_review_prepare',
    title: 'Prepare Code review payload',
    description:
      'Local only, no network. Collects the git diff from the merge-base of `base` and HEAD, base-revision rules and approved context files; redacts secrets; checks limits; stages the payload. Returns preparedId, payloadDigest and summaryMarkdown. Show summaryMarkdown to the user, then call code_review_submit.',
    shape: prepareInputShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
    card: true,
    timeoutSeconds: 120,
    run: prepareTool,
  },
  {
    name: 'code_review_submit',
    title: 'Send staged payload to Kiro Reviewer',
    description:
      'Sends a payload staged by code_review_prepare to the Kiro Reviewer service. Pass preparedId and payloadDigest exactly as returned by prepare.',
    shape: submitInputShape,
    annotations: { readOnlyHint: false, openWorldHint: true },
    timeoutSeconds: 60,
    run: submitTool,
  },
  {
    name: 'code_review_get',
    title: 'Get code review results',
    description:
      'Reads a review iteration, waiting up to waitSeconds (0..90, default 60) for a terminal status. Returns immediately with needsContext: true when the status is NEEDS_CONTEXT (call code_review_context_prepare right away). Returns structured results and Markdown. If still running, call again.',
    shape: getInputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
    card: true,
    timeoutSeconds: 150,
    run: getTool,
  },
  {
    name: 'code_review_suppress',
    title: 'Suppress a code review finding',
    description:
      'Suppresses one finding for the rest of the review session. Only on the user’s explicit request, with a reason.',
    shape: suppressInputShape,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    timeoutSeconds: 60,
    run: suppressTool,
  },
  {
    name: 'code_review_context_prepare',
    title: 'Prepare context the reviewer requested',
    description:
      'Call when code_review_get reports NEEDS_CONTEXT. Reads the open context round (read-only GET), answers each request from the local repository (refuses paths outside the repo, under .git/ or secret-like; redacts secrets; checks limits) and stages the response. Nothing is sent. Pass decline (request ids) for anything the user does not want shared, and extraFiles only when the user asks. Returns preparedId, payloadDigest, summaryMarkdown and expiresAt. Show summaryMarkdown to the user, then call code_review_context_submit.',
    shape: contextPrepareInputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
    card: true,
    timeoutSeconds: 120,
    run: contextPrepareTool,
  },
  {
    name: 'code_review_context_submit',
    title: 'Send staged context to Kiro Reviewer',
    description:
      'Sends context staged by code_review_context_prepare to the Kiro Reviewer service. Pass preparedId and payloadDigest exactly as returned by context_prepare.',
    shape: contextSubmitInputShape,
    annotations: { readOnlyHint: false, openWorldHint: true },
    timeoutSeconds: 60,
    run: contextSubmitTool,
  },
  {
    name: 'code_review_status',
    title: 'Check Kiro Reviewer setup',
    description:
      'Read-only. Reports the endpoint and credential situation as the reviewer tools see it, and checks the service with one read. Call it when another code_review tool fails with a credential or config error, and show the result to the user.',
    shape: statusInputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
    timeoutSeconds: 60,
    run: statusTool,
  },
];
