/**
 * Integration test for the wired atomic-tool chain (T11474 · E-TOOLS-WIRE · AC3).
 *
 * Proves the END-TO-END joint the wire-or-revert rule requires: a `ct-*` skill
 * node, run in-process by the {@link SkillExecutorAdapter} (T11477 · #897),
 * reaches the atomic fs/shell primitives ONLY through a REAL
 * {@link createToolGuard} deny-first chokepoint — not a stub. This closes the
 * loop AC1 (barrel exports the guard) → AC2 (atomic calls funnel through the
 * guard) → AC3 (a skill node calls `readFileText` / `executeShell` via the
 * guard).
 *
 * Distinct from `skill-executor-adapter.test.ts`, which exercises the adapter
 * against a recording STUB surface. Here the injected surface is the production
 * `createToolGuard({ allowedRoots: [...] })` result, so the test also covers the
 * guard's allow/deny behavior on the path AND command axes through the runner.
 *
 * @task T11474
 * @epic T11391
 * @saga T11387
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecuteShellResult } from '@cleocode/contracts/tools/atomic';
import type { SkillExecuteInput } from '@cleocode/contracts/tools/skill-executor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillExecutorAdapter } from '../../skills/skill-executor-adapter.js';
import { createToolGuard, GuardDeniedError } from '../../tools/index.js';

let projectRoot: string;
let prevProjectRoot: string | undefined;

/** Deterministic shell executor — never spawns a real subprocess. */
const fakeExec = (): Promise<ExecuteShellResult> =>
  Promise.resolve({ stdout: 'pong', stderr: '', code: 0 });

/**
 * Write a fixture `ct-*` skill into `<projectRoot>/.agents/skills/<id>/SKILL.md`
 * so {@link SkillExecutorAdapter}'s `findSkill()` resolves it in-process.
 */
function createFixtureSkill(id: string): void {
  const skillDir = join(projectRoot, '.agents', 'skills', id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: probe\n---\nBody`);
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-tools-wire-'));
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

describe('atomic-tool wiring through the guard (T11474 · AC3)', () => {
  it('a resolved skill node reads a file and runs a command via a REAL createToolGuard', async () => {
    createFixtureSkill('ct-tools-wire-probe');
    const tools = createToolGuard({ allowedRoots: [projectRoot] });
    const target = join(projectRoot, 'note.txt');

    const adapter = new SkillExecutorAdapter({
      cwd: projectRoot,
      // A model-phase runner stand-in: it sequences atomic primitives entirely
      // through the injected guard (input.tools), never touching raw fs/shell.
      runner: async (_skill, input: SkillExecuteInput) => {
        await input.tools.writeFileAtomic({ path: target, content: 'hello' });
        const { content } = await input.tools.readFileText({ path: target });
        const { stdout, code } = await input.tools.executeShell(
          { command: 'echo', args: ['ping'] },
          fakeExec,
        );
        return { status: 'success', output: { content, stdout, code } };
      },
    });

    const result = await adapter.execute({
      skillId: 'ct-tools-wire-probe',
      context: {},
      tools,
    });

    // The skill resolved in-process and its runner reached readFileText +
    // executeShell THROUGH the guard chokepoint (AC3) — the wire-or-revert joint.
    expect(result.status).toBe('success');
    expect(result.output['content']).toBe('hello');
    expect(result.output['stdout']).toBe('pong');
    expect(result.output['code']).toBe(0);
  });

  it('guard surface (as injected into a skill node) reads/writes/execs in-process', async () => {
    const tools = createToolGuard({ allowedRoots: [projectRoot] });
    const target = join(projectRoot, 'note.txt');

    // Drive the guarded surface exactly as a SkillExecutorAdapter runner would
    // (input.tools.*) — proving readFileText + executeShell are reachable via
    // the guard chokepoint (AC3) with no raw-primitive import in sight.
    await tools.writeFileAtomic({ path: target, content: 'hello' });
    const { content } = await tools.readFileText({ path: target });
    const { stdout, code } = await tools.executeShell(
      { command: 'echo', args: ['ping'] },
      fakeExec,
    );

    expect(content).toBe('hello');
    expect(stdout).toBe('pong');
    expect(code).toBe(0);
  });

  it('enforce-mode guard denies an out-of-root read before any fs touch (AC2)', async () => {
    const tools = createToolGuard({ allowedRoots: [projectRoot], mode: 'enforce' });
    await expect(tools.readFileText({ path: '/etc/cleo-should-not-exist' })).rejects.toBeInstanceOf(
      GuardDeniedError,
    );
  });

  it('enforce-mode guard denies a denylisted command before spawn (AC2)', async () => {
    const tools = createToolGuard({
      allowedRoots: [projectRoot],
      deniedCommands: ['rm'],
      mode: 'enforce',
    });
    await expect(
      tools.executeShell({ command: 'rm', args: ['-rf', projectRoot] }, fakeExec),
    ).rejects.toBeInstanceOf(GuardDeniedError);
  });

  it('the barrel exposes the guard, NOT the raw bypassable primitives (AC1 · AC2)', async () => {
    const barrel = await import('../../tools/index.js');
    // Guarded entrypoint + date-gated mechanism are public…
    expect(typeof barrel.createToolGuard).toBe('function');
    expect(typeof barrel.resolveDefaultGuardMode).toBe('function');
    expect(typeof barrel.GUARD_ENFORCE_DEADLINE).toBe('string');
    expect(barrel.GUARD_ENFORCE_FLIP_ENABLED).toBe(false);
    // …but the raw side-effecting primitives are NOT re-exported from the barrel
    // (no public bypass of the chokepoint).
    const surfaced = Object.keys(barrel);
    expect(surfaced).not.toContain('writeFileAtomic');
    expect(surfaced).not.toContain('executeShell');
    expect(surfaced).not.toContain('runGit');
    expect(surfaced).not.toContain('readFileText');
  });
});

describe('date-gated default mode mechanism (T11474 · AC4)', () => {
  it('default mode is held at warn while the owner flip is disabled', async () => {
    const { resolveDefaultGuardMode, GUARD_ENFORCE_FLIP_ENABLED } = await import(
      '../../tools/guard.js'
    );
    // The flip is owner-gated and currently held off.
    expect(GUARD_ENFORCE_FLIP_ENABLED).toBe(false);
    // …so the date-gate yields warn regardless of the instant evaluated.
    expect(resolveDefaultGuardMode(new Date('2000-01-01T00:00:00.000Z'))).toBe('warn');
    expect(resolveDefaultGuardMode(new Date('2099-01-01T00:00:00.000Z'))).toBe('warn');
  });

  it('an unconfigured guard defaults to warn (no throw on an out-of-root path)', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cleo-tools-wire-other-'));
    try {
      const tools = createToolGuard({ allowedRoots: [projectRoot] }); // mode omitted
      const res = await tools.writeFileAtomic({
        path: join(other, 'x.txt'),
        content: 'ok',
      });
      expect(res.bytesWritten).toBe(2); // warn-then-proceed (default held at warn)
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
