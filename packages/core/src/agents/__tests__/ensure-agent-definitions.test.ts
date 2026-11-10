/**
 * `ensureAgentDefinitions` writes the canonical lead and worker for each
 * provider with project agent-file support, is a no-op on a second run,
 * reports unsupported providers, and never overwrites a user's own file.
 *
 * @task T14378
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider, type Provider } from '@cleocode/caamp';
import { LEAD_DENIED_TOOLS, LEAD_RUNNER_TOOL } from '@cleocode/contracts/operations/orchestrate.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentDefinitionReportLines,
  applyLeadToolPolicy,
  ensureAgentDefinitions,
} from '../ensure-agent-definitions.js';

function provider(id: string): Provider {
  const p = getProvider(id);
  if (!p) throw new Error(`registry has no ${id}`);
  return p;
}

describe('ensureAgentDefinitions (T14378)', () => {
  let root: string;
  const providers = (): Provider[] => [
    provider('claude-code'),
    provider('opencode'),
    provider('codex'),
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-agent-defs-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes lead and worker per supported provider; the Claude lead has no Bash, Edit or Write', async () => {
    const report = await ensureAgentDefinitions(root, { providers: providers() });
    expect(report.skipped).toBeUndefined();
    const written = report.outcomes.filter((o) => o.status === 'created').map((o) => o.path);
    expect(written.sort()).toEqual(
      [
        join(root, '.claude/agents/cleo-lead.md'),
        join(root, '.claude/agents/cleo-worker.md'),
        join(root, '.opencode/agents/cleo-lead.md'),
        join(root, '.opencode/agents/cleo-worker.md'),
      ].sort(),
    );

    const lead = readFileSync(join(root, '.claude/agents/cleo-lead.md'), 'utf-8');
    const toolsLine = lead.split('\n').find((l) => l.startsWith('tools:')) ?? '';
    expect(toolsLine).toContain('Agent');
    for (const denied of ['Bash', 'Edit', 'Write']) {
      expect(toolsLine.split(/[",\s]+/)).not.toContain(denied);
    }
    expect(lead).toMatch(/^disallowedTools: ".*Bash.*Edit.*Write/m);
    // T14374: the lead's one command route is the runner, served by its own MCP server.
    expect(toolsLine.split(/[",\s]+/)).toContain(LEAD_RUNNER_TOOL);
    const deniedLine = lead.split('\n').find((l) => l.startsWith('disallowedTools:')) ?? '';
    for (const denied of LEAD_DENIED_TOOLS) expect(deniedLine).toContain(denied);
    expect(lead).toContain(
      'mcpServers:\n  - cleo-lead:\n      type: stdio\n      command: "cleo"\n      args: ["orchestrate","lead-runner"]\n',
    );

    const worker = readFileSync(join(root, '.claude/agents/cleo-worker.md'), 'utf-8');
    expect(worker).toMatch(/^background: true$/m);
    expect(worker).not.toMatch(/^tools:/m);

    const ocLead = readFileSync(join(root, '.opencode/agents/cleo-lead.md'), 'utf-8');
    expect(ocLead).toMatch(/^mode: primary$/m);
    expect(ocLead).toMatch(/^ {2}bash: deny$/m);
    expect(ocLead).toMatch(/^ {2}edit: deny$/m);
  });

  it('lead policy denies every LEAD_DENIED_TOOLS entry even when the file allows one (T14374)', () => {
    const lead = applyLeadToolPolicy({
      name: 'cleo-lead',
      role: 'lead',
      description: 'd',
      prompt: 'p',
      tools: ['Agent', 'Bash'],
    });
    expect(lead.tools).toEqual(['Agent', LEAD_RUNNER_TOOL]);
    expect(lead.deniedTools).toEqual([...LEAD_DENIED_TOOLS]);
    expect(lead.mcpServers?.['cleo-lead']).toEqual({
      command: 'cleo',
      args: ['orchestrate', 'lead-runner'],
    });
    const worker = { name: 'w', role: 'worker' as const, description: 'd', prompt: 'p' };
    expect(applyLeadToolPolicy(worker)).toBe(worker);
  });

  it('reports a provider without agent-file support as unsupported', async () => {
    const report = await ensureAgentDefinitions(root, { providers: providers() });
    expect(report.outcomes).toContainEqual({ provider: 'codex', status: 'unsupported' });
    expect(agentDefinitionReportLines(report).warnings).toContain(
      'agent definitions unsupported (no project agent-file support): codex',
    );
  });

  it('changes nothing on a second run', async () => {
    await ensureAgentDefinitions(root, { providers: providers() });
    const before = readFileSync(join(root, '.claude/agents/cleo-lead.md'), 'utf-8');
    const second = await ensureAgentDefinitions(root, { providers: providers() });
    const fileOutcomes = second.outcomes.filter((o) => o.path);
    expect(fileOutcomes).toHaveLength(4);
    expect(fileOutcomes.every((o) => o.status === 'unchanged')).toBe(true);
    expect(agentDefinitionReportLines(second).applied).toEqual([]);
    expect(readFileSync(join(root, '.claude/agents/cleo-lead.md'), 'utf-8')).toBe(before);
  });

  it('leaves a file without the CLEO marker alone', async () => {
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    const mine = '---\nname: cleo-lead\ndescription: mine\n---\nmy prompt\n';
    writeFileSync(join(root, '.claude/agents/cleo-lead.md'), mine);
    const report = await ensureAgentDefinitions(root, { providers: [provider('claude-code')] });
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({
        provider: 'claude-code',
        agent: 'cleo-lead',
        status: 'user-owned',
      }),
    );
    expect(readFileSync(join(root, '.claude/agents/cleo-lead.md'), 'utf-8')).toBe(mine);
  });

  it('refreshes a stale generated file', async () => {
    await ensureAgentDefinitions(root, { providers: [provider('claude-code')] });
    const path = join(root, '.claude/agents/cleo-worker.md');
    writeFileSync(path, `${readFileSync(path, 'utf-8')}\nstale\n`);
    const report = await ensureAgentDefinitions(root, { providers: [provider('claude-code')] });
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ agent: 'cleo-worker', status: 'updated' }),
    );
    expect(readFileSync(path, 'utf-8')).not.toContain('stale');
  });
});
