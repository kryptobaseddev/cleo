/**
 * Tests for the `run_skill` agent tool (T11949 · M7 · epic T11456).
 *
 * FULLY MOCKED — no real SKILL.md on disk. The skills-subsystem seam
 * ({@link SkillResolver}) is INJECTED, so every assertion runs in-process.
 * Covers:
 *   - AC1 registration via the self-registering marker + part of the built-in
 *     catalog (toolset 'agent');
 *   - run_skill resolves an invocable skill via `findSkill` + returns its
 *     instructions and dispatch protocol;
 *   - rejects a non-invocable skill (typed E_SKILL_NOT_INVOCABLE) and an unknown
 *     skill (E_SKILL_NOT_FOUND) without throwing;
 *   - availability always-true daemon-OFF;
 *   - Zod schema validation (missing name → invalid-args).
 *
 * @task T11949
 * @epic T11456
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { describe, expect, it } from 'vitest';
import type { Skill } from '../../skills/types.js';
import { AgentToolRegistry } from '../agent-registry.js';
import { registerBuiltinAgentTools } from '../builtin-agent-tools.js';
import { ToolDispatchEngine } from '../dispatch.js';
import { createToolGuard } from '../guard.js';
import {
  type RunSkillResult,
  registerSkillAgentTool,
  type SkillResolver,
} from '../skill-agent-tool.js';

const noopSurface = {} as GuardedToolSurface;

/** Build a minimal {@link Skill} fixture. */
function skill(name: string, invocable: boolean): Skill {
  return {
    name,
    dirName: name,
    path: `/skills/${name}`,
    skillMdPath: `/skills/${name}/SKILL.md`,
    frontmatter: { name, description: `${name} desc`, invocable, protocol: 'research' },
    content: `# ${name}\nbody`,
  };
}

/** A fake {@link SkillResolver} over a fixed in-memory skill set. */
function fakeResolver(skills: readonly Skill[]): SkillResolver {
  const byName = new Map(skills.map((s) => [s.dirName, s]));
  return {
    findSkill: (name) => byName.get(name) ?? null,
    dispatchExplicit: (name) => {
      const s = byName.get(name);
      if (s === undefined) return null;
      return {
        skill: s.dirName,
        strategy: 'label',
        confidence: 1,
        ...(s.frontmatter.protocol !== undefined ? { protocol: s.frontmatter.protocol } : {}),
      };
    },
  };
}

// ===========================================================================
// AC1 — registration
// ===========================================================================

describe('run_skill — registration (AC1)', () => {
  it('exports a self-registering marker that registers run_skill', async () => {
    const mod = await import('../skill-agent-tool.js');
    expect(typeof mod.registerAgentTools).toBe('function');
    const registry = new AgentToolRegistry();
    mod.registerAgentTools(registry);
    expect(registry.get('run_skill')).toBeDefined();
  });

  it('is part of the built-in catalog in the agent toolset', async () => {
    const registry = new AgentToolRegistry();
    registerBuiltinAgentTools(registry);
    await registry.init({ skipBuiltins: true });
    const tool = registry.get('run_skill');
    expect(tool?.toolset).toBe('agent');
    expect(registry.byToolset('agent').some((t) => t.name === 'run_skill')).toBe(true);
  });
});

// ===========================================================================
// Availability + resolution
// ===========================================================================

describe('run_skill — availability + resolution', () => {
  async function execFor(skills: readonly Skill[]) {
    const registry = new AgentToolRegistry();
    registerSkillAgentTool(registry, { resolver: fakeResolver(skills) });
    await registry.init({ skipBuiltins: true });
    const exec = registry.getExecutable('run_skill');
    if (exec === undefined) throw new Error('run_skill missing');
    return { registry, exec };
  }

  it('is available with NO egress / capabilities (daemon-OFF)', async () => {
    const { registry } = await execFor([]);
    expect(
      registry.available({ networkEgressAllowed: false }).some((t) => t.name === 'run_skill'),
    ).toBe(true);
  });

  it('resolves an invocable skill and returns its instructions + protocol', async () => {
    const { exec } = await execFor([skill('ct-research-agent', true)]);
    const out = (await exec({ name: 'ct-research-agent' }, noopSurface)) as RunSkillResult;
    expect(out.ok).toBe(true);
    expect(out.skill).toBe('ct-research-agent');
    expect(out.protocol).toBe('research');
    expect(out.instructions).toContain('ct-research-agent');
  });

  it('rejects a non-invocable skill (typed, no throw)', async () => {
    const { exec } = await execFor([skill('ct-task-executor', false)]);
    const out = (await exec({ name: 'ct-task-executor' }, noopSurface)) as RunSkillResult;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('E_SKILL_NOT_INVOCABLE');
  });

  it('rejects an unknown skill (typed, no throw)', async () => {
    const { exec } = await execFor([]);
    const out = (await exec({ name: 'nope' }, noopSurface)) as RunSkillResult;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('E_SKILL_NOT_FOUND');
  });
});

// ===========================================================================
// Schema validation through the frozen dispatch engine
// ===========================================================================

describe('run_skill — schema validation', () => {
  async function engine(): Promise<ToolDispatchEngine> {
    const registry = new AgentToolRegistry();
    registerSkillAgentTool(registry, { resolver: fakeResolver([skill('s', true)]) });
    await registry.init({ skipBuiltins: true });
    return new ToolDispatchEngine({ registry, tools: createToolGuard({ mode: 'enforce' }) });
  }

  it('rejects run_skill without a name as invalid-args', async () => {
    const res = await (await engine()).dispatch({ id: 'c1', name: 'run_skill', arguments: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it('dispatches a valid run_skill call', async () => {
    const res = await (await engine()).dispatch({
      id: 'c2',
      name: 'run_skill',
      arguments: { name: 's' },
    });
    expect(res.ok).toBe(true);
  });
});
