#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# onEnable check for the kiro-code-reviewer Crew app. Read-only: it never changes Crew or AWS configuration.
set -u

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0

ok() { echo "ok: $*"; }
fail() {
  echo "error: $*" >&2
  status=1
}

if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else fail "git is not on PATH"; fi

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major}" -ge 22 ]; then ok "node $(node --version)"; else fail "Node.js >= 22 required (found $(node --version))"; fi
else
  fail "node is not on PATH (Node.js >= 22 required)"
fi

if [ -f "${app_dir}/dist/server.mjs" ]; then ok "dist/server.mjs present"; else fail "dist/server.mjs missing (run npm run build before installing)"; fi
if [ -x "${app_dir}/bin/kiro-code-reviewer-mcp" ]; then ok "launcher executable"; else fail "bin/kiro-code-reviewer-mcp is missing or not executable"; fi
if [ -f "${app_dir}/skills/code-review/SKILL.md" ]; then ok "skill code-review present"; else fail "skills/code-review/SKILL.md missing"; fi

echo "not checked: the Kiro API key (KIRO_API_KEY or data/kiro-api-key; checked on first tool call)"
exit "${status}"
