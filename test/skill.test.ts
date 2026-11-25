// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/server.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

describe('skill and manifest', () => {
  const skill = read('skills/code-review/SKILL.md');

  it('SKILL.md submits after showing the summary, with no extra confirmation', () => {
    expect(skill).toContain('The user asking for a review is the go-ahead to send the review payload and any context');
    expect(skill).toContain('then submit in the same turn without asking again');
    expect(skill).not.toMatch(/reply yes/);
  });

  it('SKILL.md sends context rounds without asking and always shows a card for a ready review', () => {
    expect(skill).toContain('you answer each round without asking');
    expect(skill).not.toContain('you ask the user before every round');
    expect(skill).toContain('**Always show a card when a review is ready**');
    expect(skill).toContain('paste the Markdown from `code_review_get` verbatim');
    expect(skill).not.toContain('<mcwidget>');
  });

  it('SKILL.md documents the NEEDS_CONTEXT loop, the round cap and the missing-context final message', () => {
    expect(skill).toContain(
      'when `code_review_get` returns `needsContext: true` (status `NEEDS_CONTEXT` with an open round), immediately call `code_review_context_prepare`',
    );
    expect(skill).toContain('it waits while the submitted context is applied');
    expect(skill).toContain('On `CONTEXT_WINDOW_CLOSED`, say so and continue polling');
    expect(skill).toContain('up to 2 rounds per review');
    expect(skill).toContain('`contextRounds: 0`');
    expect(skill).toContain('`completeness.context.missing` is true');
    for (const tool of ['code_review_context_prepare', 'code_review_context_submit']) expect(skill).toContain(tool);
  });

  it('SKILL.md documents the optional intent step and that it is an untrusted claim', () => {
    expect(skill).toMatch(/Write the intent \(optional\)/);
    expect(skill).toContain('untrusted author claim');
    expect(skill).toContain('spec-drift');
    expect(skill).toMatch(/optional `intent`/);
    expect(skill).toContain("collects the branch's commit messages");
  });

  it('SKILL.md documents finding responses and the blocking-acknowledgement gate', () => {
    expect(skill).toContain('## Responses to previous findings');
    expect(skill).toMatch(/`fixed` is a \*\*claim\*\*/);
    expect(skill).toContain('`false_positive | wont_fix | deferred` on a **non-blocking** finding suppresses it');
    expect(skill).toContain(
      'Set `acknowledged: true` on a **blocking** finding only when the user has said to set aside',
    );
    expect(skill).toContain('`counts.blocking` is never reduced');
  });

  it('SKILL.md has frontmatter name and version', () => {
    expect(skill).toMatch(/^---\nname: code-review\n/);
    expect(skill).toMatch(/metadata:\n {2}version: 0\.1\.0/);
  });

  it('app.json uses only the planned manifest fields and timeout 150000', () => {
    const app = JSON.parse(read('app.json')) as Record<string, unknown> & {
      mcpServers: {
        'code-reviewer': {
          command: string;
          args: unknown[];
          timeout: number;
          autoApprove: string[];
          poolable: boolean;
        };
      };
      permissions: { mcpTools: string[] };
    };
    expect(Object.keys(app).sort()).toEqual(
      [
        'name',
        'version',
        'displayName',
        'description',
        'author',
        'iconPath',
        'iconPathDark',
        'skills',
        'mcpServers',
        'permissions',
        'setup',
        'dependencies',
        'platform',
        'backend',
        'ui',
        'agentTools',
      ].sort(),
    );
    expect(app.name).toBe('kiro-code-reviewer');
    expect(app.mcpServers['code-reviewer'].timeout).toBe(150000);
    // /bin/sh expands ~ itself: neither Crew's MCP gateway nor its probe expands a ~ in `command`.
    expect(app.mcpServers['code-reviewer'].command).toBe('/bin/sh');
    expect(app.mcpServers['code-reviewer'].args).toEqual([
      '-c',
      'exec ~/.kiro/crew/apps/kiro-code-reviewer/bin/kiro-code-reviewer-mcp',
    ]);
    // Routed through Crew's shared MCP gateway, which is what renders the MCP Apps chat card.
    expect(app.mcpServers['code-reviewer'].poolable).toBe(true);
    expect([...app.mcpServers['code-reviewer'].autoApprove].sort()).toEqual([...TOOL_NAMES].sort());
    expect(app.permissions.mcpTools).toHaveLength(7);
    expect([...app.permissions.mcpTools].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('launcher and setup script are executable', () => {
    expect(statSync(path.join(root, 'bin/kiro-code-reviewer-mcp')).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(root, 'setup/on_enable.sh')).mode & 0o111).not.toBe(0);
  });
});
