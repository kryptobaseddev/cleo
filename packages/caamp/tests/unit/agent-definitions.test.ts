/**
 * Canonical agent definition reader and provider renderers (T14378).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEAD_DENIED_TOOLS,
  LEAD_RUNNER_TOOL,
} from '@cleocode/contracts/operations/orchestrate.js';
import { describe, expect, it } from 'vitest';
import {
  AGENT_DEFINITION_MARKER,
  parseAgentDefinition,
  renderAgentDefinition,
} from '../../src/core/agents/agent-definitions.js';
import { getAllProviders, getProvider } from '../../src/core/registry/providers.js';

const DEFS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'agents', 'definitions');

describe('agent definitions', () => {
  it('reads the canonical lead and worker', () => {
    const lead = parseAgentDefinition(readFileSync(join(DEFS, 'cleo-lead.cant'), 'utf-8'));
    expect(lead.name).toBe('cleo-lead');
    expect(lead.role).toBe('lead');
    expect(lead.tools).toContain('mcp__mbx__*');
    expect(lead.tools).toContain(LEAD_RUNNER_TOOL);
    expect(lead.deniedTools).toEqual([...LEAD_DENIED_TOOLS]);
    const worker = parseAgentDefinition(readFileSync(join(DEFS, 'cleo-worker.cant'), 'utf-8'));
    expect(worker).toMatchObject({ name: 'cleo-worker', role: 'worker', background: true });
    expect(worker.tools).toBeUndefined();
  });

  it('rejects unknown keys, nested blocks and missing fields', () => {
    const doc = (body: string) => `---\nkind: agent\n---\n\nagent x:\n${body}\n`;
    expect(() => parseAgentDefinition(doc('  role: lead\n  colour: "red"'))).toThrow(/unknown key/);
    expect(() => parseAgentDefinition(doc('  role: lead\n  tools:\n    core: [Read]'))).toThrow(
      /unsupported line/,
    );
    expect(() => parseAgentDefinition(doc('  role: lead\n  prompt: "p"'))).toThrow(/description/);
    expect(() => parseAgentDefinition('agent x:\n  role: lead')).toThrow(/kind: agent/);
  });

  it('refuses to render a denied tool OpenCode cannot gate', () => {
    const def = {
      name: 'x',
      role: 'lead' as const,
      description: 'd',
      prompt: 'p',
      deniedTools: ['Teleport'],
    };
    expect(() => renderAgentDefinition(def, 'opencode')).toThrow(/Teleport/);
    expect(renderAgentDefinition(def, 'claude-code').content).toContain(AGENT_DEFINITION_MARKER);
  });

  it('renders per-agent MCP servers for Claude Code (T14374)', () => {
    const def = {
      name: 'x',
      role: 'lead' as const,
      description: 'd',
      prompt: 'p',
      mcpServers: { 'cleo-lead': { command: 'cleo', args: ['orchestrate', 'lead-runner'] } },
    };
    expect(renderAgentDefinition(def, 'claude-code').content).toContain(
      'mcpServers:\n  - cleo-lead:\n      type: stdio\n      command: "cleo"\n      args: ["orchestrate","lead-runner"]\n---',
    );
  });

  it('declares agent paths only for claude-code and opencode', () => {
    expect(getProvider('claude-code')?.agentDefinitions).toEqual({
      pathProject: '.claude/agents',
      format: 'claude-code',
    });
    expect(getProvider('opencode')?.agentDefinitions?.format).toBe('opencode');
    const declared = getAllProviders()
      .filter((p) => p.agentDefinitions)
      .map((p) => p.id);
    expect(declared.sort()).toEqual(['claude-code', 'opencode']);
  });
});
