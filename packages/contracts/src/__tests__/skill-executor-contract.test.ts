/**
 * Contract tests for the `SkillExecutor` DIP seam
 * (`@cleocode/contracts/tools/skill-executor`, P1 · T11476).
 *
 * Pins the dispatcher-facing abstraction so the concrete in-process
 * `SkillExecutorAdapter` (T11477) binds to a stable, runtime-decoupled shape.
 * Types-only module — these are type-level assertions exercised via a fake.
 *
 * @epic T11391
 * @task T11476
 * @saga T11387
 */

import { describe, expect, it } from 'vitest';
import type {
  ExecuteShellResult,
  PathExistsResult,
  ReadFileResult,
  WriteFileResult,
} from '../tools/atomic.js';
import type {
  GuardedToolSurface,
  SkillExecuteInput,
  SkillExecuteResult,
  SkillExecuteStatus,
  SkillExecutor,
} from '../tools/skill-executor.js';

/** Minimal in-test guarded surface — every method routes to a typed stub. */
const fakeTools: GuardedToolSurface = {
  async readFileText(input): Promise<ReadFileResult> {
    return { path: input.path, content: '' };
  },
  async readJson<T>(_path: string): Promise<T> {
    return {} as T;
  },
  async writeFileAtomic(input): Promise<WriteFileResult> {
    return { path: input.path, bytesWritten: 0 };
  },
  async pathExists(_input): Promise<PathExistsResult> {
    return { exists: false };
  },
  async executeShell(_input): Promise<ExecuteShellResult> {
    return { stdout: '', stderr: '', code: 0 };
  },
  async executePty(_input) {
    return { stdout: '', stderr: '', code: 0, mode: 'spawn', ptyFellBack: false };
  },
  async runGit(_input): Promise<ExecuteShellResult> {
    return { stdout: '', stderr: '', code: 0 };
  },
};

/** A fake SkillExecutor — proves the abstraction is implementable by injection. */
const fakeExecutor: SkillExecutor = {
  async execute(input: SkillExecuteInput): Promise<SkillExecuteResult> {
    if (input.skillId === 'boom') {
      return { status: 'failure', output: {}, error: 'kaboom' };
    }
    return { status: 'success', output: { ranSkill: input.skillId } };
  },
};

describe('SkillExecutor DIP seam (AC1)', () => {
  it('execute() accepts { skillId, context, tools } and resolves a terminal envelope', async () => {
    const result = await fakeExecutor.execute({
      skillId: 'noop',
      context: { foo: 'bar' },
      tools: fakeTools,
    });
    expect(result.status).toBe<SkillExecuteStatus>('success');
    expect(result.output).toEqual({ ranSkill: 'noop' });
    expect(result.error).toBeUndefined();
  });

  it('surfaces a failure envelope with status + error', async () => {
    const result = await fakeExecutor.execute({
      skillId: 'boom',
      context: {},
      tools: fakeTools,
    });
    expect(result.status).toBe<SkillExecuteStatus>('failure');
    expect(result.error).toBe('kaboom');
    expect(result.output).toEqual({});
  });
});

describe('GuardedToolSurface dependency (AC2)', () => {
  it('the injected tools surface exposes the guarded atomic primitives', async () => {
    const input: SkillExecuteInput = { skillId: 's', context: {}, tools: fakeTools };
    const read = await input.tools.readFileText({ path: '/abs/x.ts' });
    expect(read.path).toBe('/abs/x.ts');
    const wrote = await input.tools.writeFileAtomic({ path: '/abs/y.ts', content: 'z' });
    expect(wrote.bytesWritten).toBe(0);
    const shell = await input.tools.executeShell({ command: 'true' });
    expect(shell.code).toBe(0);
    const git = await input.tools.runGit({ args: ['status'] });
    expect(git.code).toBe(0);
  });
});

describe('result-status taxonomy', () => {
  it('SkillExecuteStatus is exactly success | failure', () => {
    const statuses: SkillExecuteStatus[] = ['success', 'failure'];
    expect(statuses).toEqual(['success', 'failure']);
  });
});
