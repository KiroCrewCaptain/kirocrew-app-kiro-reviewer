// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A tool failure with a stable code. Messages are fixed text or name only
 * non-sensitive values (limit names, profile names); they never carry repository content.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ToolErrorResult {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { error: Record<string, unknown> };
}

/** Converts any thrown value into the MCP tool-error shape. Unknown errors become INTERNAL_ERROR. */
export function toErrorResult(err: unknown): ToolErrorResult {
  const e =
    err instanceof ToolError
      ? err
      : new ToolError('INTERNAL_ERROR', 'Unexpected error in the Kiro Reviewer MCP server.');
  return {
    isError: true,
    content: [{ type: 'text', text: `${e.code}: ${e.message}` }],
    structuredContent: { error: { code: e.code, message: e.message, ...e.details } },
  };
}
