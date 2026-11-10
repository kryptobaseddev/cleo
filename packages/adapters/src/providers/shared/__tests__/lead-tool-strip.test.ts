/**
 * Lead tool strip (T14357): claude-code strips the lead's denied tools with
 * `--disallowedTools`, providers that cannot strip refuse a lead spawn with
 * `E_LEAD_TOOLS_UNSTRIPPED`, and worker spawns keep their tool set. A lead
 * gets the command runner as its one command tool (T14363).
 *
 * @task T14357
 * @epic T14351
 */

import type { AdapterSpawnProvider, SpawnContext } from '@cleocode/contracts';
import {
  E_LEAD_TOOLS_UNSTRIPPED,
  LEAD_DENIED_TOOLS,
  LEAD_RUNNER_MCP_SERVER,
  LEAD_RUNNER_TOOL,
} from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, ClaudeCodeSpawnProvider } from '../../claude-code/spawn.js';
import { CodexSpawnProvider } from '../../codex/spawn.js';
import { GeminiCliSpawnProvider } from '../../gemini-cli/spawn.js';
import { KimiSpawnProvider } from '../../kimi/spawn.js';
import { OpenAiSdkSpawnProvider } from '../../openai-sdk/spawn.js';
import { OpenCodeSpawnProvider } from '../../opencode/spawn.js';
import { PiSpawnProvider } from '../../pi/spawn.js';
import { assertLeadToolsStrippable, LeadToolsUnstrippedError } from '../lead-tool-strip.js';

const LEAD: SpawnContext = { taskId: 'T1', prompt: 'plan', leadDeniedTools: LEAD_DENIED_TOOLS };
const WORKER: SpawnContext = { taskId: 'T1', prompt: 'work' };

describe('claude-code lead tool strip', () => {
  it('declares the strip as enforced', () => {
    expect(new ClaudeCodeSpawnProvider().leadToolStrip).toBe('enforced');
  });

  it('lead argv carries --disallowedTools with Bash, Edit and Write and no --dangerously-skip-permissions', () => {
    const args = buildClaudeArgs(LEAD, '/tmp/prompt.md');
    expect(args).not.toContain('--dangerously-skip-permissions');
    // T14363: --allowedTools only pre-approves the runner; it never strips.
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(LEAD_RUNNER_TOOL);
    const flag = args.indexOf('--disallowedTools');
    expect(flag).toBeGreaterThanOrEqual(0);
    const denied = (args[flag + 1] ?? '').split(',');
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(denied).toEqual([...LEAD_DENIED_TOOLS]);
    // The prompt file is the appended system prompt; the lead cannot Read files.
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/tmp/prompt.md');
  });

  it('lead argv serves the command runner as its only command tool (T14363)', () => {
    const args = buildClaudeArgs(LEAD, '/tmp/prompt.md');
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}');
    expect(Object.keys(config.mcpServers)).toEqual([LEAD_RUNNER_MCP_SERVER]);
    expect(args).toContain('--strict-mcp-config');
    expect(config.mcpServers[LEAD_RUNNER_MCP_SERVER]).toEqual({
      type: 'stdio',
      command: 'cleo',
      args: ['orchestrate', 'lead-runner'],
    });
    // Each variadic flag is followed by another flag, never the kickoff prompt.
    for (const flag of ['--tools', '--disallowedTools', '--allowedTools', '--mcp-config']) {
      expect(args[args.indexOf(flag) + 2]?.startsWith('--')).toBe(true);
    }
  });

  it('lead argv pins a pre-assigned session id, and ignores a malformed one (T14363)', () => {
    const sessionId = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    const pinned = buildClaudeArgs({ ...LEAD, options: { leadSessionId: sessionId } }, '/tmp/p.md');
    expect(pinned[pinned.indexOf('--session-id') + 1]).toBe(sessionId);
    const bad = buildClaudeArgs(
      { ...LEAD, options: { leadSessionId: 'x; rm -rf /' } },
      '/tmp/p.md',
    );
    expect(bad).not.toContain('--session-id');
    expect(buildClaudeArgs(LEAD, '/tmp/p.md')).not.toContain('--session-id');
  });

  it('worker argv is unchanged', () => {
    expect(buildClaudeArgs(WORKER, '/tmp/prompt.md')).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      '/tmp/prompt.md',
    ]);
    expect(buildClaudeArgs({ ...WORKER, leadDeniedTools: [] }, '/tmp/p.md')).toContain(
      '--dangerously-skip-permissions',
    );
  });
});

describe('providers without strip support', () => {
  const unsupported: ReadonlyArray<[string, AdapterSpawnProvider]> = [
    ['codex', new CodexSpawnProvider()],
    ['gemini-cli', new GeminiCliSpawnProvider()],
    ['kimi', new KimiSpawnProvider()],
    ['openai-sdk', new OpenAiSdkSpawnProvider()],
    ['opencode', new OpenCodeSpawnProvider()],
    ['pi', new PiSpawnProvider()],
  ];

  it.each(unsupported)('%s: a lead spawn throws E_LEAD_TOOLS_UNSTRIPPED', async (_id, provider) => {
    expect(provider.leadToolStrip).toBe('unsupported');
    await expect(provider.spawn(LEAD)).rejects.toMatchObject({ code: E_LEAD_TOOLS_UNSTRIPPED });
  });
});

describe('assertLeadToolsStrippable', () => {
  it('refuses a lead spawn when unsupported', () => {
    expect(() => assertLeadToolsStrippable('x', 'unsupported', LEAD)).toThrow(
      LeadToolsUnstrippedError,
    );
  });

  it('passes a lead spawn when enforced, and every worker spawn', () => {
    expect(() => assertLeadToolsStrippable('x', 'enforced', LEAD)).not.toThrow();
    expect(() => assertLeadToolsStrippable('x', 'unsupported', WORKER)).not.toThrow();
    expect(() =>
      assertLeadToolsStrippable('x', 'unsupported', { ...WORKER, leadDeniedTools: [] }),
    ).not.toThrow();
  });
});
