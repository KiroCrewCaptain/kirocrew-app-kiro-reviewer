// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Writes the app.json `agentTools` block from src/tools/registry.ts. test/agentTools.test.ts fails when it is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { agentToolsBlock } from '../src/tools/agentTools.js';

const file = new URL('../app.json', import.meta.url);
const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
manifest.agentTools = agentToolsBlock();
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
