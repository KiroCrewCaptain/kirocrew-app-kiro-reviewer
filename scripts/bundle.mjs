// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Bundles the MCP server (dist/server.mjs) and the Crew page backend (dist/ui-backend.mjs), each with every
// dependency inlined, so the installed app needs no node_modules at runtime.
/* global console */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(import.meta.dirname);
const outDir = path.join(root, 'dist');

rmSync(outDir, { recursive: true, force: true });

const entries = [
  ['server', 'src/server.ts'],
  ['ui-backend', 'src/ui/backend.ts'],
];

for (const [name, entry] of entries) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(outDir, `${name}.mjs`),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    keepNames: true,
    sourcemap: false,
    minify: false,
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log(`bundle: ${entry} -> dist/${name}.mjs`);
}

// The MCP Apps chat card: one self-contained HTML file (script inlined, no network) served as a ui:// resource.
const card = await build({
  entryPoints: [path.join(root, 'card', 'main.mjs')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
const script = card.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = readFileSync(path.join(root, 'card', 'card.html'), 'utf8');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, 'card.html'),
  template.replace('/*CARD_SCRIPT*/', () => script),
);
console.log('bundle: card/main.mjs -> dist/card.html');
