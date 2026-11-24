// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ServiceConfig } from '../config.js';
import { callBff } from './bffApi.js';

export const FETCH_TIMEOUT_MS = 20_000;

export interface HttpDeps {
  fetch: typeof fetch;
  /** Environment for the gateway client. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Replaces the BFF call (tests inject a REST fake here). */
  send?: <T>(req: ApiRequest) => Promise<ApiResponse<T>>;
}

/** A REST-shaped request; bffApi.ts serves each route from one Kiro BFF operation. */
export interface ApiRequest {
  method: 'GET' | 'POST';
  /** Path, e.g. /reviews/rev-…; must start with '/'. */
  path: string;
  query?: Record<string, string>;
  /** Exact body bytes (already serialized JSON). */
  body?: string;
  /**
   * Called before each retry with the backoff delay; returning false skips the retry
   * (code_review_get uses this to respect its wait deadline).
   */
  shouldRetry?: (delayMs: number) => boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** Calls the service; returns 2xx responses and throws ToolError otherwise. */
export function callApi<T = unknown>(config: ServiceConfig, req: ApiRequest, deps: HttpDeps): Promise<ApiResponse<T>> {
  return deps.send ? deps.send<T>(req) : callBff<T>(config.bff, req, deps);
}
