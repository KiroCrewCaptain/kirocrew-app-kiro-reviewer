// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stdio smoke harness. Drives dist/server.mjs over MCP stdio against the Kiro BFF with a Kiro API key. Running it is the operator's explicit approval to send the synthetic payloads and context.
 * Scenario A: blocking findings with contextRounds 0. Scenario B: the reviewer requests context (dev
 * test hook context_request), the harness answers it and the review completes with that context.
 * Scenario C: three iterations of one review (two blocking defects, fix one and resubmit with finding responses,
 * fix the other and resubmit), so the Crew page shows iteration tabs, deltas, resolved findings and threads.
 * KIRO_CODE_REVIEWER_SMOKE_SCENARIOS=C (comma list, default A,B,C) picks scenarios.
 *
 *   KIRO_API_KEY=<key> npm run smoke    # KIRO_CODE_REVIEWER_BFF_ENDPOINT picks another origin
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CALL_OPTIONS = { timeout: 150_000 };
const appDir = path.dirname(import.meta.dirname);

const REVIEW_V1 = `# Review guidance

Database queries must use parameterized statements, never string concatenation.
`;
const REVIEW_V2 = `# Review guidance
`;
const CLEAN = `export async function getUser(db: { query(sql: string, params: unknown[]): Promise<unknown> }, id: string) {
  return db.query('SELECT * FROM users WHERE id = ?', [id]);
}
`;
const DEFECT = `import type { Request } from 'express';

export async function getUser(db: { query(sql: string): Promise<unknown> }, req: Request) {
  const id = req.query.id;
  return db.query("SELECT * FROM users WHERE id = '" + id + "'");
}
`;

const ORDERS_CLEAN = `export async function getOrder(db: { query(sql: string, params: unknown[]): Promise<unknown> }, orderId: string) {
  return db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
}
`;
const ORDERS_DEFECT = `import type { Request } from 'express';

export async function getOrder(db: { query(sql: string): Promise<unknown> }, req: Request) {
  const orderId = req.query.orderId;
  return db.query("SELECT * FROM orders WHERE id = '" + orderId + "'");
}
`;

const AUTH = `export async function isAllowed(user: string): Promise<boolean> {
  return user.startsWith('admin-');
}
`;
const USERS_BASE = `import { isAllowed } from './auth';

export async function deleteUser(user: string, id: string): Promise<string> {
  if (!(await isAllowed(user))) throw new Error('forbidden');
  return id;
}
`;
const USERS_FEATURE = `import { isAllowed } from './auth';

export async function deleteUser(user: string, id: string): Promise<string> {
  if (!isAllowed(user)) throw new Error('forbidden');
  return id;
}

export async function renameUser(user: string, id: string, name: string): Promise<string> {
  if (!isAllowed(user)) throw new Error('forbidden');
  return \`\${id}:\${name}\`;
}
`;

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

function initRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'kcr-smoke-'));
  git(repo, ['init', '-q', '-b', 'mainline']);
  git(repo, ['config', 'user.email', 'smoke@example.com']);
  git(repo, ['config', 'user.name', 'Code Reviewer Smoke']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(repo, 'src'));
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

/** Scenario A: SQL concatenation, and a branch that drops the REVIEW.md guidance against it. */
function makeRepoA(): string {
  const repo = initRepo();
  writeFileSync(path.join(repo, 'REVIEW.md'), REVIEW_V1);
  writeFileSync(path.join(repo, 'src', 'users.ts'), CLEAN);
  commitAll(repo, 'base');
  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(repo, 'src', 'users.ts'), DEFECT);
  writeFileSync(path.join(repo, 'REVIEW.md'), REVIEW_V2);
  commitAll(repo, 'feature');
  return repo;
}

/** Scenario B: an async isAllowed (src/auth.ts, unchanged) called without await in the diff. */
function makeRepoB(): string {
  const repo = initRepo();
  writeFileSync(path.join(repo, 'src', 'auth.ts'), AUTH);
  writeFileSync(path.join(repo, 'src', 'users.ts'), USERS_BASE);
  commitAll(repo, 'base');
  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(repo, 'src', 'users.ts'), USERS_FEATURE);
  commitAll(repo, 'feature');
  return repo;
}

/** Scenario C: two files with SQL concatenation, fixed one per iteration. */
function makeRepoC(): string {
  const repo = initRepo();
  writeFileSync(path.join(repo, 'REVIEW.md'), REVIEW_V1);
  writeFileSync(path.join(repo, 'src', 'users.ts'), CLEAN);
  writeFileSync(path.join(repo, 'src', 'orders.ts'), ORDERS_CLEAN);
  commitAll(repo, 'base');
  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(repo, 'src', 'users.ts'), DEFECT);
  writeFileSync(path.join(repo, 'src', 'orders.ts'), ORDERS_DEFECT);
  commitAll(repo, 'feature: add user and order lookups');
  return repo;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

interface Prepared {
  preparedId: string;
  payloadDigest: string;
  summaryMarkdown: string;
}

interface GetResult {
  needsContext?: boolean;
  iteration: {
    number: number;
    status: string;
    outcome: string;
    counts: { active: number; blocking: number; suppressed: number; resolved: number };
    completeness?: { context?: { provided: string[]; missing: boolean } } | null;
  };
  findings: Array<{ findingId: string; file: string; state: string; blocking: boolean; title: string }>;
}

function textOf(r: ToolResult): string {
  return (r.content ?? []).find((c) => c.type === 'text')?.text ?? '';
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = (await client.callTool({ name, arguments: args }, undefined, CALL_OPTIONS)) as ToolResult;
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return r;
}

/** prepare → submit (running this harness is the operator's approval) → reviewId. */
async function prepareAndSubmit(client: Client, args: Record<string, unknown>): Promise<string> {
  const p = (await call(client, 'code_review_prepare', args)).structuredContent as unknown as Prepared;
  console.log(p.summaryMarkdown);
  const sub = await call(client, 'code_review_submit', {
    preparedId: p.preparedId,
    payloadDigest: p.payloadDigest,
    approvedSummary: p.summaryMarkdown,
  });
  console.log(textOf(sub));
  return (sub.structuredContent as { reviewId: string }).reviewId;
}

/** Polls code_review_get until `done` holds or `max` calls were made. */
async function poll(
  client: Client,
  reviewId: string,
  done: (g: GetResult) => boolean,
  max = 6,
): Promise<{ r: ToolResult; g: GetResult }> {
  let last: { r: ToolResult; g: GetResult } | null = null;
  for (let i = 0; i < max; i++) {
    const r = await call(client, 'code_review_get', { reviewId, waitSeconds: 90 });
    last = { r, g: r.structuredContent as unknown as GetResult };
    if (done(last.g)) break;
  }
  if (!last) throw new Error('no code_review_get result');
  console.log(textOf(last.r));
  return last;
}

async function scenarioA(client: Client, repo: string): Promise<boolean> {
  const reviewId = await prepareAndSubmit(client, {
    repoPath: repo,
    base: 'mainline',
    level: 'standard',
    contextRounds: 0,
  });
  const { g } = await poll(client, reviewId, (x) => x.iteration.outcome !== 'IN_PROGRESS');
  const ok = g.iteration.outcome === 'FINDINGS' && g.findings.length >= 1;
  console.log(`smoke A: outcome ${g.iteration.outcome}, ${g.findings.length} findings -> ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

async function scenarioB(client: Client, repo: string): Promise<boolean> {
  const reviewId = await prepareAndSubmit(client, {
    repoPath: repo,
    base: 'mainline',
    level: 'standard',
    contextRounds: 2,
  });
  const first = await poll(client, reviewId, (x) => x.needsContext === true || x.iteration.outcome !== 'IN_PROGRESS');
  if (first.g.iteration.status !== 'NEEDS_CONTEXT') {
    console.log(`smoke B: expected NEEDS_CONTEXT, got ${first.g.iteration.status} -> FAIL`);
    return false;
  }
  const cp = (await call(client, 'code_review_context_prepare', { repoPath: repo, reviewId }))
    .structuredContent as unknown as Prepared;
  console.log(cp.summaryMarkdown);
  const cs = await call(client, 'code_review_context_submit', {
    preparedId: cp.preparedId,
    payloadDigest: cp.payloadDigest,
    approvedSummary: cp.summaryMarkdown,
  });
  console.log(textOf(cs));
  const { g } = await poll(client, reviewId, (x) => x.iteration.outcome !== 'IN_PROGRESS');
  const provided = g.iteration.completeness?.context?.provided ?? [];
  const ok = g.iteration.status === 'COMPLETED' && provided.length >= 1;
  console.log(
    `smoke B: status ${g.iteration.status}, outcome ${g.iteration.outcome}, context provided ${provided.length} -> ${ok ? 'PASS' : 'FAIL'}`,
  );
  return ok;
}

interface Response {
  findingId: string;
  disposition: 'fixed' | 'question';
  comment?: string;
}

/** prepare (resubmit of `reviewId`) → submit → wait for a terminal status. */
async function resubmit(
  client: Client,
  repo: string,
  reviewId: string,
  responses: Response[],
  intent: string,
): Promise<GetResult> {
  const p = (
    await call(client, 'code_review_prepare', { repoPath: repo, base: 'mainline', reviewId, responses, intent })
  ).structuredContent as unknown as Prepared;
  console.log(p.summaryMarkdown);
  console.log(
    textOf(
      await call(client, 'code_review_submit', {
        preparedId: p.preparedId,
        payloadDigest: p.payloadDigest,
        approvedSummary: p.summaryMarkdown,
      }),
    ),
  );
  return (await poll(client, reviewId, (x) => x.iteration.outcome !== 'IN_PROGRESS')).g;
}

async function scenarioC(client: Client, repo: string): Promise<boolean> {
  const reviewId = await prepareAndSubmit(client, {
    repoPath: repo,
    base: 'mainline',
    level: 'standard',
    contextRounds: 0,
    iterationBudget: 3,
    intent: 'Add user and order lookups.',
  });
  const it1 = (await poll(client, reviewId, (x) => x.iteration.outcome !== 'IN_PROGRESS')).g;
  console.log(`smoke C iteration 1: ${it1.iteration.outcome}, ${it1.findings.length} findings`);
  if (it1.iteration.status !== 'COMPLETED' || it1.findings.length === 0) {
    console.log('smoke C: iteration 1 produced no findings to work with -> FAIL');
    return false;
  }

  // Iteration 2: fix users.ts, ask a question about orders.ts.
  writeFileSync(path.join(repo, 'src', 'users.ts'), CLEAN);
  commitAll(repo, 'fix: parameterize the user lookup');
  const respond2: Response[] = it1.findings.map((f) =>
    f.file.endsWith('users.ts')
      ? { findingId: f.findingId, disposition: 'fixed' }
      : {
          findingId: f.findingId,
          disposition: 'question',
          comment: 'Is this exploitable if the order id only ever comes from our own router?',
        },
  );
  const it2 = await resubmit(client, repo, reviewId, respond2, 'Parameterize the user lookup; order lookup unchanged.');
  console.log(
    `smoke C iteration 2: ${it2.iteration.outcome}, active ${it2.iteration.counts.active}, resolved ${it2.iteration.counts.resolved}`,
  );

  // Iteration 3: fix orders.ts too.
  writeFileSync(path.join(repo, 'src', 'orders.ts'), ORDERS_CLEAN);
  commitAll(repo, 'fix: parameterize the order lookup');
  const respond3: Response[] = it2.findings
    .filter((f) => f.state !== 'RESOLVED' && f.file.endsWith('orders.ts'))
    .map((f) => ({ findingId: f.findingId, disposition: 'fixed' }));
  const it3 = await resubmit(client, repo, reviewId, respond3, 'Parameterize the order lookup as well.');
  console.log(
    `smoke C iteration 3: ${it3.iteration.outcome}, active ${it3.iteration.counts.active}, resolved ${it3.iteration.counts.resolved}`,
  );

  const ok =
    it2.iteration.number === 2 &&
    it3.iteration.number === 3 &&
    it2.iteration.status === 'COMPLETED' &&
    it3.iteration.status === 'COMPLETED';
  console.log(
    `smoke C: ${reviewId} iterations ${it3.iteration.number}, resolved by the end ${it3.iteration.counts.resolved} (informational) -> ${ok ? 'PASS' : 'FAIL'}`,
  );
  return ok;
}

async function main(): Promise<number> {
  if (!process.env.KIRO_API_KEY) {
    console.error('smoke: set KIRO_API_KEY');
    return 2;
  }
  const repoA = makeRepoA();
  const repoB = makeRepoB();
  const repoC = makeRepoC();
  const wanted = new Set(
    (process.env.KIRO_CODE_REVIEWER_SMOKE_SCENARIOS ?? 'A,B,C').split(',').map((x) => x.trim().toUpperCase()),
  );
  // KIRO_CODE_REVIEWER_SMOKE_DATA_DIR: send from this data dir and keep it (e.g. the Crew app's, so the page shows the runs).
  const keptDataDir = process.env.KIRO_CODE_REVIEWER_SMOKE_DATA_DIR?.trim();
  const dataDir = keptDataDir ? path.resolve(keptDataDir) : mkdtempSync(path.join(os.tmpdir(), 'kcr-smoke-data-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.KIRO_CODE_REVIEWER_DATA_DIR = dataDir;
  // Dev-only hook: the service injects one file request when the planner asks for nothing (deterministic B).
  env.KIRO_CODE_REVIEWER_TEST_FAULT_INJECTION = 'context_request';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(appDir, 'dist', 'server.mjs')],
    env,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'kcr-smoke', version: '0.1.0' });
  try {
    await client.connect(transport);
    const results: boolean[] = [];
    for (const [name, run] of [
      ['A', () => scenarioA(client, repoA)],
      ['B', () => scenarioB(client, repoB)],
      ['C', () => scenarioC(client, repoC)],
    ] as const) {
      if (!wanted.has(name)) continue;
      try {
        results.push(await run());
      } catch (err) {
        console.log(`smoke ${name}: ${err instanceof Error ? err.message : String(err)} -> FAIL`);
        results.push(false);
      }
    }
    return results.every(Boolean) ? 0 : 1;
  } finally {
    await client.close().catch(() => undefined);
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    rmSync(repoC, { recursive: true, force: true });
    if (!keptDataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`smoke: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
