// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cbor } from '@smithy/core/cbor';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_FILE, loadServiceConfig, loadTransport } from '../src/config.js';
import { toErrorResult } from '../src/errors.js';
import { getTool } from '../src/tools/get.js';
import { statusTool } from '../src/tools/status.js';
import { suppressTool } from '../src/tools/suppress.js';
import { makeDeps, rm, tempDir, withoutRestFake } from './helpers.js';

const REV = 'rev-0123456789abcdef01234567';
const FINDING = 'f-0123456789abcdef';
const KEY = 'ksk_exampleexampleexample';
let dataDir: string;

beforeEach(() => {
  dataDir = tempDir('kcr-bff-');
});
afterEach(() => rm(dataDir));

const bffEnv = (over: Record<string, string | undefined> = {}) => ({
  KIRO_CODE_REVIEWER_DATA_DIR: dataDir,
  KIRO_CODE_REVIEWER_TRANSPORT: 'bff',
  KIRO_API_KEY: KEY,
  ...over,
});

function cborResponse(body: unknown, status = 200): Response {
  return new Response(Buffer.from(cbor.serialize(body)), {
    status,
    headers: { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor' },
  });
}

function bffDeps(fetchImpl: typeof fetch, env = bffEnv()) {
  return { ...withoutRestFake(makeDeps(dataDir, fetchImpl)), env };
}

describe('bff transport config', () => {
  it('defaults to the Kiro BFF when nothing is set: kiro in the page backend, bff elsewhere', () => {
    const base = { KIRO_CODE_REVIEWER_DATA_DIR: dataDir };
    expect(loadTransport(base)).toBe('bff');
    expect(loadTransport({ ...base, KIROCREW_PROXY_SECRET: 's' })).toBe('kiro');
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ transport: 'bff' }));
    expect(loadTransport({ ...base, KIROCREW_PROXY_SECRET: 's' })).toBe('bff');
  });

  it('is selected by KIRO_CODE_REVIEWER_TRANSPORT or config.json and defaults to the prod origin', () => {
    expect(loadTransport(bffEnv())).toBe('bff');
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ transport: 'bff' }));
    expect(loadTransport({ KIRO_CODE_REVIEWER_DATA_DIR: dataDir })).toBe('bff');
    const c = loadServiceConfig({ KIRO_CODE_REVIEWER_DATA_DIR: dataDir, KIRO_API_KEY: KEY });
    expect(c.bff).toEqual({ endpoint: 'https://app.kiro.dev', apiKey: KEY });
  });

  it('takes the endpoint from the env or config.json bffEndpoint, env first', () => {
    writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ transport: 'bff', bffEndpoint: 'https://staging.kiro.test' }),
    );
    const env = { KIRO_CODE_REVIEWER_DATA_DIR: dataDir, KIRO_API_KEY: KEY };
    expect(loadServiceConfig(env).bff?.endpoint).toBe('https://staging.kiro.test');
    expect(
      loadServiceConfig({ ...env, KIRO_CODE_REVIEWER_BFF_ENDPOINT: 'https://other.kiro.test' }).bff?.endpoint,
    ).toBe('https://other.kiro.test');
  });

  it('takes the endpoint from config.json kiroRegion when no bffEndpoint is set', () => {
    const env = { KIRO_CODE_REVIEWER_DATA_DIR: dataDir, KIRO_API_KEY: KEY };
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ transport: 'bff', kiroRegion: 'eu-central-1' }));
    expect(loadServiceConfig(env).bff?.endpoint).toBe('https://eu-central-1.app.kiro.dev');
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ transport: 'bff', kiroRegion: 'mars-1' }));
    expect(() => loadServiceConfig(env)).toThrow(/kiroRegion/);
  });

  it('refuses an endpoint that is not a bare https origin', () => {
    expect(() => loadServiceConfig(bffEnv({ KIRO_CODE_REVIEWER_BFF_ENDPOINT: 'http://app.kiro.dev' }))).toThrow(
      /endpoint/i,
    );
  });

  it('reads the key from the data-dir file when KIRO_API_KEY is unset', () => {
    const file = path.join(dataDir, API_KEY_FILE);
    writeFileSync(file, `${KEY}\n`);
    chmodSync(file, 0o600);
    expect(loadServiceConfig(bffEnv({ KIRO_API_KEY: undefined })).bff?.apiKey).toBe(KEY);
  });

  it('refuses a key file other users can read', () => {
    const file = path.join(dataDir, API_KEY_FILE);
    writeFileSync(file, KEY);
    chmodSync(file, 0o644);
    expect(() => loadServiceConfig(bffEnv({ KIRO_API_KEY: undefined }))).toThrow(/must not be readable by others/);
  });

  it('says what is missing when there is no key', () => {
    try {
      loadServiceConfig(bffEnv({ KIRO_API_KEY: undefined }));
      expect.unreachable();
    } catch (e) {
      expect(toErrorResult(e).structuredContent.error.code).toBe('CONFIG_MISSING_API_KEY');
    }
  });

  it('rejects an unknown transport', () => {
    expect(() =>
      loadTransport({ KIRO_CODE_REVIEWER_DATA_DIR: dataDir, KIRO_CODE_REVIEWER_TRANSPORT: 'carrier-pigeon' }),
    ).toThrow(/"kiro" or "bff"/);
  });
});

describe('tools over the bff transport', () => {
  it('code_review_get fetches the review from the BFF and prints it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      cborResponse({
        reviewId: REV,
        level: 'standard',
        iterationBudget: 3,
        latestIteration: 1,
        createdAt: 1763424000000,
        updatedAt: 1763424060000,
        iterations: [{ number: 1, status: 'COMPLETED' }],
        iteration: {
          number: 1,
          status: 'COMPLETED',
          outcome: 'NO_FINDINGS',
          counts: { active: 0, blocking: 0, suppressed: 0, resolved: 0 },
          warnings: [],
        },
        findings: [],
      }),
    );
    const res = await getTool({ reviewId: REV, waitSeconds: 0 }, bffDeps(fetchImpl));
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://app.kiro.dev/service/KiroWebBearerService/operation/GetCodeReview',
    );
    expect(res.structuredContent).toMatchObject({ reviewId: REV });
    expect(JSON.stringify(res.structuredContent)).not.toContain(KEY);
  });

  it('code_review_suppress calls UpdateCodeReviewFinding', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      cborResponse({
        reviewId: REV,
        findingId: FINDING,
        suppressed: true,
        reason: 'accepted risk',
        createdAt: 1763424000000,
      }),
    );
    const res = await suppressTool({ reviewId: REV, findingId: FINDING, reason: 'accepted risk' }, bffDeps(fetchImpl));
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/operation\/UpdateCodeReviewFinding$/);
    expect(res.content[0].text).toContain('Suppressed');
  });

  it('a BFF error reaches the tool as SERVICE_ERROR with the status and code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      cborResponse({ __type: 'x#AccessDeniedException', message: 'not enabled' }, 403),
    );
    try {
      await suppressTool({ reviewId: REV, findingId: FINDING }, bffDeps(fetchImpl));
      expect.unreachable();
    } catch (e) {
      expect(toErrorResult(e).structuredContent.error).toMatchObject({
        code: 'SERVICE_ERROR',
        httpStatus: 403,
        serviceCode: 'ACCESS_DENIED',
      });
    }
  });

  it('code_review_status reports ready when the probe review is not found', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      cborResponse({ __type: 'x#ResourceNotFoundException', message: 'no' }, 404),
    );
    const res = await statusTool({}, bffDeps(fetchImpl));
    expect(res.content[0].text).toContain('✅ Kiro Reviewer is ready.');
    expect(res.content[0].text).toContain('API key accepted');
    expect(res.structuredContent).toMatchObject({ configured: true, transport: 'bff', service: { ok: true } });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('code_review_status explains a refused key, a 500 and a sign-in redirect', async () => {
    const cases: Array<[Response, RegExp]> = [
      [cborResponse({ __type: 'x#UnauthorizedException' }, 401), /API key was rejected/],
      [cborResponse({ __type: 'x#AccessDeniedException' }, 403), /not enabled for this user/],
      [new Response(null, { status: 302, headers: { location: 'https://idp.example.com/x' } }), /sign-in page/],
    ];
    for (const [reply, text] of cases) {
      const res = await statusTool({}, bffDeps(vi.fn<typeof fetch>(async () => reply)));
      expect(res.content[0].text).toContain('cannot reach the service');
      expect(res.content[0].text).toMatch(text);
    }
  });

  it('code_review_status reports a missing key as not configured', async () => {
    const res = await statusTool({}, bffDeps(vi.fn<typeof fetch>(), bffEnv({ KIRO_API_KEY: undefined })));
    expect(res.structuredContent).toMatchObject({ configured: false, code: 'CONFIG_MISSING_API_KEY' });
  });
});
