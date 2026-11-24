// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { z } from 'zod';
import type { HttpDeps } from '../client/http.js';
import { ToolError } from '../errors.js';

export const CLIENT_VERSION = '0.1.0';
export const REVIEW_ID_RE = /^rev-[0-9a-f]{24}$/;
export const FINDING_ID_RE = /^f-[0-9a-f]{16}$/;
export const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Dependencies injected into every tool (tests replace fetch, credentials and the clock). */
export interface ToolDeps {
  env: Record<string, string | undefined>;
  http: HttpDeps;
  clock: Clock;
  /** stderr logger; callers pass only tool names and codes, never content. */
  log: (msg: string) => void;
}

export interface ToolSuccess {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

export function success(markdown: string, structured: Record<string, unknown>): ToolSuccess {
  return {
    content: [
      { type: 'text', text: markdown },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

/** Validates tool input with the tool's zod schema; issues name paths only, never values. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid tool input.', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
