// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs before the page backend's own module code: points it at the in-process stand-in review service and at a
// fresh data dir. Capture only; never part of the shipped app.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stubFetch } from './stub_bff.mjs';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'kcr-demo-'));
writeFileSync(
  path.join(dataDir, 'config.json'),
  JSON.stringify({ serviceApis: { feedback: true, list: true, payload: true, unsuppress: false } }),
);
process.env.KIRO_CODE_REVIEWER_DATA_DIR = dataDir;
process.env.KIRO_CODE_REVIEWER_TRANSPORT = 'bff';
process.env.KIRO_API_KEY = 'ksk_demo_not_a_real_key';
globalThis.fetch = stubFetch();
