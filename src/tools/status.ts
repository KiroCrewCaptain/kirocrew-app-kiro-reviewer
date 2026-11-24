// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { callApi } from '../client/http.js';
import { loadServiceConfig, resolveDataDir, type ServiceConfig } from '../config.js';
import { ToolError } from '../errors.js';
import { parseInput, success, type ToolDeps } from './common.js';

/**
 * code_review_status: auto-approved, read-only. Reports the config as THIS server process sees it (which can differ
 * from the user's shell under Kiro Crew), then checks the service with one read of a review id that cannot exist:
 * 404 REVIEW_NOT_FOUND means the endpoint and the API key both work.
 */
export const statusInputSchema = z.object({}).strict();
export const statusInputShape = {};

const PROBE_REVIEW_ID = 'rev-000000000000000000000000';

type ServiceCheck = { ok: boolean; detail: string };

async function serviceStatus(config: ServiceConfig, deps: ToolDeps) {
  let service: ServiceCheck;
  try {
    await callApi(config, { method: 'GET', path: `/reviews/${PROBE_REVIEW_ID}` }, deps.http);
    service = { ok: true, detail: 'reachable' };
  } catch (e) {
    const code = e instanceof ToolError ? String(e.details.serviceCode ?? e.code) : 'INTERNAL_ERROR';
    const status = e instanceof ToolError ? e.details.httpStatus : undefined;
    const hint =
      code === 'UNAUTHORIZED' || status === 401
        ? ': the Kiro API key was rejected'
        : code === 'ACCESS_DENIED' || status === 403
          ? ': the service refused this key (Kiro Reviewer not enabled for this user?)'
          : code === 'REDIRECT'
            ? ': the endpoint is behind a sign-in page'
            : '';
    service =
      status === 404
        ? { ok: true, detail: 'reachable, API key accepted' }
        : { ok: false, detail: `${code}${status ? ` (HTTP ${status})` : ''}${hint}` };
  }
  const lines = [
    service.ok ? '✅ Kiro Reviewer is ready.' : '⚠ Kiro Reviewer cannot reach the service yet.',
    '',
    `- Transport: Kiro BFF with an API key; endpoint ${config.endpoint}`,
    `- Service: ${service.detail}`,
  ];
  return success(lines.join('\n'), { configured: true, transport: 'bff', endpoint: config.endpoint, service });
}

export async function statusTool(input: unknown, deps: ToolDeps) {
  parseInput(statusInputSchema, input);
  let config;
  try {
    config = loadServiceConfig(deps.env);
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    const md = `⚠ Kiro Reviewer is not configured: ${e.message}`;
    return success(md, { configured: false, code: e.code, message: e.message, dataDir: resolveDataDir(deps.env) });
  }
  return serviceStatus(config, deps);
}
