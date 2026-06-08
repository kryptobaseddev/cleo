/**
 * Unit tests for the T11477 {@link SkillExecutorAdapter} — the concrete
 * in-process implementation of the `SkillExecutor` DIP seam declared in
 * `@cleocode/contracts/tools/skill-executor`.
 *
 * The suite proves:
 *  - AC1 — a `ct-*` skill is resolved by id and run in-process.
 *  - AC4 — the skill→tool joint is in-process: the injected guarded tool surface
 *    is the one the runner sees; no subprocess is spawned.
 *  - Failure semantics — an unresolvable skill or a throwing runner yields a
 *    `status: 'failure'` envelope (never throws).
 *
 * Fixtures: a tmp project root holds `.agents/skills/<id>/SKILL.md`, which the
 * existing `findSkill()` discovery picks up via the `project-custom` search path
 * once `CLEO_PROJECT_ROOT` is pinned to the tmp dir.
 *
 * @task T11477
 * @epic T11391
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GuardedToolSurface,
  SkillExecuteInput,
} from '@cleocode/contracts/tools/skill-executor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSkillRunner, SkillExecutorAdapter } from '../skill-executor-adapter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let projectRoot: string;
let prevProjectRoot: string | undefined;

/**
 * Write a fixture `ct-*` skill into `<projectRoot>/.agents/skills/<id>/SKILL.md`
 * so {@link findSkill} resolves it via the `project-custom` search path.
 */
function createFixtureSkill(id: string, frontmatter: string, body = 'Body'): void {
  const skillDir = join(projectRoot, '.agents', 'skills', id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
}

/**
 * A guarded tool surface stub that records which methods were invoked, so the
 * test can assert the injected surface reaches the runner (AC4).
 */
function makeGuardSpy(): { tools: GuardedToolSurface; calls: string[] } {
  const calls: string[] = [];
  const tools: GuardedToolSurface = {
    async readFileText(input) {
      calls.push('readFileText');
      return { path: input.path, content: '' };
    },
    async readJson<T>() {
      calls.push('readJson');
      return {} as T;
    },
    async writeFileAtomic(input) {
      calls.push('writeFileAtomic');
      return { path: input.path, bytesWritten: 0 };
    },
    async pathExists() {
      calls.push('pathExists');
      return { exists: false };
    },
    async executeShell() {
      calls.push('executeShell');
      return { stdout: '', stderr: '', code: 0 };
    },
    async executePty() {
      calls.push('executePty');
      return { stdout: '', stderr: '', code: 0, mode: 'spawn' as const, ptyFellBack: false };
    },
    async runGit() {
      calls.push('runGit');
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  return { tools, calls };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-skill-adapter-'));
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

describe('SkillExecutorAdapter — in-process ct-* skill execution (T11477)', () => {
  it('AC1: resolves a ct-* skill by id and runs it in-process (success envelope)', async () => {
    createFixtureSkill(
      'ct-demo',
      'name: ct-demo\ndescription: A demo skill\nprotocol: implementation',
    );
    const adapter = new SkillExecutorAdapter({ cwd: projectRoot });
    const { tools } = makeGuardSpy();

    const result = await adapter.execute({ skillId: 'ct-demo', context: {}, tools });

    expect(result.status).toBe('success');
    expect(result.output['resolved']).toBe(true);
    expect(result.output['skillId']).toBe('ct-demo');
    expect(result.output['dirName']).toBe('ct-demo');
    expect(result.output['protocol']).toBe('implementation');
    expect(result.error).toBeUndefined();
  });

  it('AC4: the injected guarded tool surface reaches the runner (in-process joint)', async () => {
    createFixtureSkill('ct-tooluser', 'name: ct-tooluser\ndescription: uses tools');
    const { tools, calls } = makeGuardSpy();
    let seenTools: GuardedToolSurface | null = null;

    const adapter = new SkillExecutorAdapter({
      cwd: projectRoot,
      runner: async (_skill, input: SkillExecuteInput) => {
        seenTools = input.tools;
        await input.tools.pathExists({ path: join(projectRoot, 'x') });
        return { status: 'success', output: { ran: true } };
      },
    });

    const result = await adapter.execute({ skillId: 'ct-tooluser', context: { k: 1 }, tools });

    expect(result.status).toBe('success');
    expect(result.output['ran']).toBe(true);
    // The exact injected surface (not a freshly constructed guard) was used.
    expect(seenTools).toBe(tools);
    expect(calls).toContain('pathExists');
  });

  it('returns failure (does not throw) when the skill cannot be resolved', async () => {
    const adapter = new SkillExecutorAdapter({ cwd: projectRoot });
    const { tools } = makeGuardSpy();

    const result = await adapter.execute({ skillId: 'ct-nonexistent', context: {}, tools });

    expect(result.status).toBe('failure');
    expect(result.output).toEqual({});
    expect(result.error).toContain('ct-nonexistent');
  });

  it('returns failure (does not throw) when the runner rejects', async () => {
    createFixtureSkill('ct-boom', 'name: ct-boom\ndescription: throws');
    const { tools } = makeGuardSpy();
    const adapter = new SkillExecutorAdapter({
      cwd: projectRoot,
      runner: async () => {
        throw new Error('kaboom');
      },
    });

    const result = await adapter.execute({ skillId: 'ct-boom', context: {}, tools });

    expect(result.status).toBe('failure');
    expect(result.error).toBe('kaboom');
  });

  it('defaultSkillRunner is deterministic and reports resolution metadata', async () => {
    createFixtureSkill('ct-meta', 'name: ct-meta\ndescription: meta');
    const { tools } = makeGuardSpy();
    const skill = {
      name: 'ct-meta',
      dirName: 'ct-meta',
      path: '/x',
      skillMdPath: '/x/SKILL.md',
      frontmatter: { name: 'ct-meta', description: 'meta' },
    };

    const result = await defaultSkillRunner(skill, { skillId: 'ct-meta', context: {}, tools });

    expect(result.status).toBe('success');
    expect(result.output['skillId']).toBe('ct-meta');
    expect(result.output['resolved']).toBe(true);
  });
});
