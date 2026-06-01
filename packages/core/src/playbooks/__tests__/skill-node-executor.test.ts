/**
 * Unit tests for the T11477 {@link createSkillNodeExecutor} — the routing layer
 * that injects the in-process {@link SkillExecutorAdapter} as the dispatcher's
 * `executor` while RETAINING the subprocess-spawn path for isolation nodes.
 *
 * Proves:
 *  - AC2 — in-process skill nodes (a resolvable `ct-*` skill) run through the
 *    adapter, REPLACING `orchestrateSpawnExecute` for those nodes.
 *  - AC3 — isolation / agent nodes still route to the injected subprocess-spawn
 *    fallback (the worktree spawn is NOT bypassed).
 *  - The `isolation` context binding forces the subprocess path even for a
 *    resolvable skill.
 *  - A missing subprocess fallback yields a structured failure (never a silent
 *    in-process downgrade of an isolation node).
 *
 * @task T11477
 * @epic T11391
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAgent } from '@cleocode/contracts';
import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchContext } from '../agent-dispatcher.js';
import {
  createSkillNodeExecutor,
  ISOLATION_CONTEXT_KEY,
  type SubprocessSpawnExecutor,
} from '../skill-node-executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let projectRoot: string;
let prevProjectRoot: string | undefined;

function createFixtureSkill(id: string): void {
  const skillDir = join(projectRoot, '.agents', 'skills', id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: fixture\n---\nBody`);
}

/** A no-op guarded surface — routing is what's under test, not tool side effects. */
const NOOP_TOOLS: GuardedToolSurface = {
  async readFileText(input) {
    return { path: input.path, content: '' };
  },
  async readJson<T>() {
    return {} as T;
  },
  async writeFileAtomic(input) {
    return { path: input.path, bytesWritten: 0 };
  },
  async pathExists() {
    return { exists: false };
  },
  async executeShell() {
    return { stdout: '', stderr: '', code: 0 };
  },
  async runGit() {
    return { stdout: '', stderr: '', code: 0 };
  },
};

function makeAgent(agentId: string): ResolvedAgent {
  return {
    agentId,
    tier: 'packaged',
    cantPath: `/fixtures/${agentId}.cant`,
    cantSha256: 'deadbeef',
    canSpawn: true,
    orchLevel: 2,
    reportsTo: null,
    skills: [],
    source: 'packaged',
    aliasApplied: false,
  };
}

function makeContext(agentId: string, context: Record<string, unknown> = {}): DispatchContext {
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    agentId,
    taskId: 'T1',
    context,
    iteration: 1,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-skill-node-exec-'));
  prevProjectRoot = process.env['CLEO_PROJECT_ROOT'];
  process.env['CLEO_PROJECT_ROOT'] = projectRoot;
});

afterEach(() => {
  if (prevProjectRoot === undefined) {
    delete process.env['CLEO_PROJECT_ROOT'];
  } else {
    process.env['CLEO_PROJECT_ROOT'] = prevProjectRoot;
  }
  rmSync(projectRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSkillNodeExecutor — routing (T11477)', () => {
  it('AC2: a resolvable ct-* skill runs in-process via the adapter (no subprocess)', async () => {
    createFixtureSkill('ct-inproc');
    let spawnCalled = false;
    const subprocessSpawn: SubprocessSpawnExecutor = async () => {
      spawnCalled = true;
      return { status: 'success', output: { spawned: true } };
    };

    const executor = createSkillNodeExecutor({
      tools: NOOP_TOOLS,
      cwd: projectRoot,
      subprocessSpawn,
    });

    const result = await executor(makeAgent('ct-inproc'), makeContext('ct-inproc'));

    expect(spawnCalled).toBe(false); // subprocess path NOT taken
    expect(result.status).toBe('success');
    expect(result.output['resolved']).toBe(true);
    expect(result.output['skillId']).toBe('ct-inproc');
  });

  it('AC3: an agent node (no resolvable skill) routes to the subprocess-spawn fallback', async () => {
    let spawnCalled = false;
    const subprocessSpawn: SubprocessSpawnExecutor = async (agent) => {
      spawnCalled = true;
      return { status: 'success', output: { spawned: agent.agentId } };
    };

    const executor = createSkillNodeExecutor({
      tools: NOOP_TOOLS,
      cwd: projectRoot,
      subprocessSpawn,
    });

    const result = await executor(makeAgent('agent-architect'), makeContext('agent-architect'));

    expect(spawnCalled).toBe(true); // subprocess path retained for isolation/agent nodes
    expect(result.status).toBe('success');
    expect(result.output['spawned']).toBe('agent-architect');
  });

  it('AC3: the isolation context binding forces the subprocess path even for a resolvable skill', async () => {
    createFixtureSkill('ct-iso');
    let spawnCalled = false;
    const subprocessSpawn: SubprocessSpawnExecutor = async () => {
      spawnCalled = true;
      return { status: 'success', output: { spawned: true } };
    };

    const executor = createSkillNodeExecutor({
      tools: NOOP_TOOLS,
      cwd: projectRoot,
      subprocessSpawn,
    });

    const result = await executor(
      makeAgent('ct-iso'),
      makeContext('ct-iso', { [ISOLATION_CONTEXT_KEY]: true }),
    );

    expect(spawnCalled).toBe(true);
    expect(result.output['spawned']).toBe(true);
  });

  it('returns a structured failure when an isolation node has no injected subprocess executor', async () => {
    const executor = createSkillNodeExecutor({ tools: NOOP_TOOLS, cwd: projectRoot });

    const result = await executor(makeAgent('agent-x'), makeContext('agent-x'));

    expect(result.status).toBe('failure');
    expect(result.error).toContain('subprocess-spawn');
    expect(result.error).toContain('agent-x');
  });
});
