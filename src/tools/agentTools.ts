// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { toErrorResult, ToolError } from '../errors.js';
import type { ToolDeps } from './common.js';
import { TOOLS, type ToolResult } from './registry.js';

/**
 * The manifest `agentTools` block: Kiro Crew lists these tools under kirocrew-core and forwards each call to
 * `POST /api/agent-tools` on the page backend. Crew reads the block only for a first-party app.
 */

export const AGENT_TOOLS_ROUTE = 'agent-tools';
export const AGENT_TOOLS_NAMESPACE = 'code_review';
const MAX_RESULT_CHARS = 60_000;
/** Crew's cap on a string argument that states no maxLength. */
const MAX_STRING_CHARS = 65_536;

type Json = Record<string, unknown>;

/** Crew's argument names are lowercase identifiers: `repoPath` is declared as `repo_path`. */
const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Every argument name of every tool, camelCase to snake_case, for rewriting the descriptions too. */
const ARG_NAMES = new Map(TOOLS.flatMap((t) => Object.keys(t.shape).map((k) => [k, snake(k)] as const)));

function crewText(s: string): string {
  return s.replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g, (w) => ARG_NAMES.get(w) ?? w);
}

/**
 * Crew's argument schemas allow only scalars and arrays of strings or integers, so an array of objects is declared
 * as a JSON-encoded string and decoded before the tool's own schema checks it.
 */
function jsonEncodedFields(shape: z.ZodRawShape): string[] {
  const props = (z.toJSONSchema(z.object(shape)) as Json).properties as Record<string, Json>;
  return Object.keys(props).filter((k) => props[k].type === 'array' && (props[k].items as Json)?.type === 'object');
}

function crewProperty(p: Json, jsonEncoded: boolean): Json {
  const description = typeof p.description === 'string' ? { description: crewText(p.description) } : {};
  if (jsonEncoded) {
    return {
      type: 'string',
      description: crewText(`${p.description ?? ''} Pass the array JSON-encoded as a string.`.trim()),
      maxLength: MAX_STRING_CHARS,
    };
  }
  switch (p.type) {
    case 'string':
      return {
        type: 'string',
        ...description,
        ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
        ...(typeof p.maxLength === 'number' ? { maxLength: p.maxLength } : {}),
      };
    case 'integer':
    case 'number':
      return {
        type: p.type,
        ...description,
        ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}),
        ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}),
      };
    case 'boolean':
      return { type: 'boolean', ...description };
    case 'array': {
      const items = p.items as Json;
      return {
        type: 'array',
        ...description,
        items: { type: items.type, ...(typeof items.maxLength === 'number' ? { maxLength: items.maxLength } : {}) },
        ...(typeof p.maxItems === 'number' ? { maxItems: p.maxItems } : {}),
      };
    }
    default:
      throw new Error(`agentTools: unsupported argument type ${String(p.type)}`);
  }
}

function crewSchema(shape: z.ZodRawShape): Json {
  const s = z.toJSONSchema(z.object(shape).strict()) as Json;
  const props = s.properties as Record<string, Json>;
  const encoded = new Set(jsonEncodedFields(shape));
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(props).map(([k, p]) => [snake(k), crewProperty(p, encoded.has(k))])),
    ...(Array.isArray(s.required) && s.required.length ? { required: (s.required as string[]).map(snake) } : {}),
    additionalProperties: false,
  };
}

/** The `agentTools` block for app.json, built from the same tool table the MCP server serves. */
export function agentToolsBlock(): Json {
  return {
    namespace: AGENT_TOOLS_NAMESPACE,
    route: AGENT_TOOLS_ROUTE,
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: crewText(t.description),
      inputSchema: crewSchema(t.shape),
      timeoutSeconds: t.timeoutSeconds,
      maxResultChars: MAX_RESULT_CHARS,
      result: 'text',
    })),
  };
}

/** Answers one forwarded call `{tool, arguments}`: `{text}` on success, `{error, code}` on failure. */
export async function callAgentTool(body: Json, deps: ToolDeps): Promise<Json> {
  const def = TOOLS.find((t) => t.name === body.tool);
  if (!def || body.arguments === null || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) {
    return { error: 'Unknown tool or arguments that are not an object.', code: 'VALIDATION_ERROR' };
  }
  const byCrewName = new Map(Object.keys(def.shape).map((k) => [snake(k), k]));
  const args: Json = Object.fromEntries(
    Object.entries(body.arguments as Json).map(([k, v]) => [byCrewName.get(k) ?? k, v]),
  );
  let result: ToolResult;
  try {
    for (const k of jsonEncodedFields(def.shape)) {
      if (typeof args[k] !== 'string') continue;
      try {
        args[k] = JSON.parse(args[k]);
      } catch {
        throw new ToolError('VALIDATION_ERROR', `${k} must be a JSON-encoded array.`);
      }
    }
    result = (await def.run(args, deps)) as ToolResult;
  } catch (err) {
    deps.log(`${def.name}: error ${err instanceof ToolError ? err.code : 'INTERNAL_ERROR'}`);
    result = toErrorResult(err);
  }
  const text = result.content.map((c) => c.text).join('\n\n');
  if (!result.isError) {
    const data = result.structuredContent === undefined ? '' : `\n\n${JSON.stringify(result.structuredContent)}`;
    return { text: text + data };
  }
  const code = (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
  return { error: text, ...(code ? { code } : {}) };
}
