/**
 * Lead tool strip (T14357): claude-code strips the lead's denied tools with
 * `--disallowedTools`, providers that cannot strip refuse a lead spawn with
 * `E_LEAD_TOOLS_UNSTRIPPED`, and worker spawns keep their tool set.
 *
 * @task T14357
 * @epic T14351
 */

import type { AdapterSpawnProvider, SpawnContext } from '@cleocode/contracts';
import { E_LEAD_TOOLS_UNSTRIPPED, LEAD_DENIED_TOOLS } from '@cleocode/contracts';
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
    expect(args).not.toContain('--allowedTools');
    const flag = args.indexOf('--disallowedTools');
    expect(flag).toBeGreaterThanOrEqual(0);
    const denied = (args[flag + 1] ?? '').split(',');
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(denied).toEqual([...LEAD_DENIED_TOOLS]);
    expect(args.at(-1)).toBe('/tmp/prompt.md');
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
