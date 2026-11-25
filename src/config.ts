// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BFF_ENDPOINT,
  DEFAULT_KIRO_REGION,
  KIRO_REGION_ENDPOINTS,
  loadBffConfig,
  type BffConfig,
} from './client/bff.js';
import { gatewayClientFor } from './client/gateway.js';
import { ToolError } from './errors.js';

/** Values come from env first, then `<dataDir>/config.json`. Read on every tool call. */
export interface ServiceConfig {
  /** The Kiro BFF origin. */
  endpoint: string;
  /** The data dir (staged payloads, config.json, the optional API key file). */
  dataDir: string;
  bff: BffConfig;
}

type Env = Record<string, string | undefined>;

/** The local data directory (staged payloads, config.json). */
export function resolveDataDir(env: Env = process.env): string {
  const fromEnv = env.KIRO_CODE_REVIEWER_DATA_DIR;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(expandHome(fromEnv.trim()));
  return path.join(os.homedir(), '.kiro', 'crew', 'apps', 'kiro-code-reviewer', 'data');
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

interface FileConfig {
  serviceApis?: unknown;
  transport?: unknown;
  bffEndpoint?: unknown;
  kiroRegion?: unknown;
}

function readFileConfig(dataDir: string): FileConfig {
  const file = path.join(dataDir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as FileConfig) : {};
  } catch {
    throw new ToolError('CONFIG_INVALID', 'The Kiro Reviewer config.json in the data directory is not valid JSON.');
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** The Kiro region from config.json `kiroRegion`, else us-east-1. */
export function loadKiroRegion(env: Env = process.env): string {
  const region = readFileConfig(resolveDataDir(env)).kiroRegion;
  if (region === undefined) return DEFAULT_KIRO_REGION;
  if (typeof region !== 'string' || !(region in KIRO_REGION_ENDPOINTS)) {
    throw new ToolError(
      'CONFIG_INVALID',
      `config.json "kiroRegion" must be one of ${Object.keys(KIRO_REGION_ENDPOINTS).join(', ')}.`,
    );
  }
  return region;
}

/** Stores `kiroRegion` in config.json, keeping its other settings. */
export function saveKiroRegion(region: string, env: Env = process.env): void {
  if (!(region in KIRO_REGION_ENDPOINTS)) {
    throw new ToolError('VALIDATION_ERROR', `region must be one of ${Object.keys(KIRO_REGION_ENDPOINTS).join(', ')}.`);
  }
  const dataDir = resolveDataDir(env);
  const next = { ...readFileConfig(dataDir), kiroRegion: region };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Resolves and validates the service settings needed by submit/get/suppress. */
export function loadServiceConfig(env: Env = process.env): ServiceConfig {
  const dataDir = resolveDataDir(env);
  if (loadTransport(env) === 'kiro') return loadKiroServiceConfig(env, dataDir);
  return loadBffServiceConfig(env, dataDir, readFileConfig(dataDir));
}

export const API_KEY_FILE = 'kiro-api-key';

/** The Kiro API key: `KIRO_API_KEY`, else the first line of `<dataDir>/kiro-api-key` (not readable by others). */
function readApiKey(env: Env, dataDir: string): string | undefined {
  const fromEnv = str(env.KIRO_API_KEY);
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, API_KEY_FILE);
  if (!existsSync(file)) return undefined;
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new ToolError(
      'CONFIG_INVALID_API_KEY',
      `The ${API_KEY_FILE} file must not be readable by others (chmod 600).`,
    );
  }
  return str(readFileSync(file, 'utf8').split('\n')[0]);
}

const API_KEY_RE = /^ksk_\S{16,}$/;
const LAST4_MIN_LENGTH = 12;

export interface ApiKeyStatus {
  set: boolean;
  source?: 'env' | 'file';
  /** The last four characters, never more. */
  last4?: string;
}

/** Whether a key is set, where it comes from and its last four characters. */
export function apiKeyStatus(env: Env = process.env): ApiKeyStatus {
  const key = readApiKey(env, resolveDataDir(env));
  if (key === undefined) return { set: false };
  const source = str(env.KIRO_API_KEY) ? 'env' : 'file';
  return key.length >= LAST4_MIN_LENGTH ? { set: true, source, last4: key.slice(-4) } : { set: true, source };
}

/** Writes the key to `<dataDir>/kiro-api-key` (mode 0600), replacing any earlier one. */
export function saveApiKey(key: string, env: Env = process.env): void {
  const value = key.trim();
  if (!API_KEY_RE.test(value)) {
    throw new ToolError(
      'VALIDATION_ERROR',
      'The key must start with ksk_, be at least 20 characters and contain no whitespace.',
    );
  }
  const dataDir = resolveDataDir(env);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, API_KEY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    throw new ToolError('CONFIG_INVALID_API_KEY', `Could not save the ${API_KEY_FILE} file.`);
  }
}

/** Deletes the saved key file; `KIRO_API_KEY` in the environment is untouched. */
export function removeApiKey(env: Env = process.env): void {
  rmSync(path.join(resolveDataDir(env), API_KEY_FILE), { force: true });
}

/** Settings for the `bff` transport: `KIRO_CODE_REVIEWER_BFF_ENDPOINT` or config.json `bffEndpoint`, plus the key. */
function loadBffServiceConfig(env: Env, dataDir: string, fileConfig: FileConfig): ServiceConfig {
  const endpoint =
    str(env.KIRO_CODE_REVIEWER_BFF_ENDPOINT) ??
    str(fileConfig.bffEndpoint) ??
    KIRO_REGION_ENDPOINTS[loadKiroRegion(env)];
  const apiKey = readApiKey(env, dataDir);
  const bff = loadBffConfig({ ...(endpoint ? { endpoint } : {}), ...(apiKey ? { apiKey } : {}) });
  return { endpoint: bff.endpoint, dataDir, bff };
}

/**
 * Settings for the `kiro` transport. The gateway hook holds the Kiro sign-in and the BFF endpoint
 * (`bffEndpoint` in config.json, read there), so this process needs no key. It works only where the
 * gateway handed the process its address and app secret (the page backend), not in the MCP server.
 */
function loadKiroServiceConfig(env: Env, dataDir: string): ServiceConfig {
  const bff: BffConfig = {
    endpoint: DEFAULT_BFF_ENDPOINT,
    apiKey: '',
    send: (operation, input, deps) =>
      gatewayClientFor(env, deps.fetch).call(operation, input as Record<string, unknown>),
  };
  return { endpoint: bff.endpoint, dataDir, bff };
}

/** Service APIs the Crew page uses. false = served from local stub data. */
export interface ServiceApiFlags {
  feedback: boolean;
  list: boolean;
  payload: boolean;
  unsuppress: boolean;
}

/**
 * `<dataDir>/config.json` `serviceApis`; each flag is true only when set to the boolean true, except `list`, which is on
 * (the BFF has ListCodeReviews) unless set to false.
 */
export function loadServiceApiFlags(env: Env = process.env): ServiceApiFlags {
  const raw = readFileConfig(resolveDataDir(env)).serviceApis;
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    feedback: o.feedback === true,
    list: typeof o.list === 'boolean' ? o.list : true,
    payload: o.payload === true,
    unsuppress: o.unsuppress === true,
  };
}

/**
 * How the app reaches the Kiro BFF: `bff` with an API key (the tools and the page), or `kiro` through the gateway with
 * Crew's Kiro sign-in (the page backend only). The default is `kiro` where Crew gave this process its app secret, which
 * is the page backend, and `bff` elsewhere, which is the MCP server.
 */
export type Transport = 'kiro' | 'bff';

/** `KIRO_CODE_REVIEWER_TRANSPORT`, else `<dataDir>/config.json` `transport`, else the default above. */
export function loadTransport(env: Env = process.env): Transport {
  const fileConfig = readFileConfig(resolveDataDir(env));
  const value =
    str(env.KIRO_CODE_REVIEWER_TRANSPORT) ?? str(fileConfig.transport) ?? (env.KIROCREW_PROXY_SECRET ? 'kiro' : 'bff');
  if (value === 'kiro' || value === 'bff') return value;
  throw new ToolError('CONFIG_INVALID', 'KIRO_CODE_REVIEWER_TRANSPORT must be "kiro" or "bff".');
}
