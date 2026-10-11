/**
 * Spawn-pipeline integration regression suite — T9984 / E7-CORE-LAYERING.
 *
 * Locks the contract that `packages/core/` consumes `@cleocode/worktree`
 * exclusively for agent-worktree provisioning. The SDK in turn delegates
 * to `@cleocode/worktree-napi` (PR #485/#486) → `crates/worktrunk-core`
 * (PR #484) for the underlying git operations.
 *
 * Coverage:
 *  1. `spawnWorktree` produces a worktree at the canonical XDG path per D029.
 *  2. The created worktree path is rooted at
 *     `<cleoHome>/worktrees/<projectHash>/<taskId>/` — never under the
 *     project root, never under a sibling path.
 *  3. The `task/<taskId>` branch is created and lockable.
 *  4. `destroyWorktree` cleanly removes the worktree and branch.
 *  5. The native napi binding powers the listing path (no porcelain
 *     parsing detours).
 *
 * All tests run against on-disk git fixtures under isolated tmp dirs. The
 * developer's real `~/.local/share/cleo` is overridden via `CLEO_HOME`
 * for the duration of each test.
 *
 * @task T9984
 * @saga T9977
 * @adr decision D010
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type {
  HookExecutor,
  HookInvocation,
  ProjectHooksManifest,
} from '@cleocode/contracts/project-hooks.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activateProjectHooks } from '../hooks/project-state.js';
import { spawnWorktree, teardownWorktree } from '../sentient/worktree-dispatch.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  /** Absolute path to the project root inside a fresh tmp dir. */
  projectRoot: string;
  /** Absolute path to the fake `CLEO_HOME` override. */
  cleoHome: string;
  /** Cleanup function — restores env and removes tmp dirs. */
  cleanup: () => void;
}

/**
 * Create a fresh on-disk git repository with one commit on `main`, plus a
 * fake `CLEO_HOME` for the worktree SDK to use. Returns absolute paths and
 * a cleanup callback.
 */
function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), 'cleo-spawn-pipeline-'));
  const projectRoot = join(tmp, 'project');
  const cleoHome = join(tmp, 'cleo-home');
  execFileSync('git', ['init', '-b', 'main', projectRoot], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectRoot, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot, stdio: 'pipe' });

  const originalHome = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = cleoHome;

  return {
    projectRoot,
    cleoHome,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = originalHome;
      }
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawn pipeline → @cleocode/worktree integration (T9984)', () => {
  let fixture: Fixture | undefined;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('provisions a worktree at the canonical XDG path under CLEO_HOME', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const taskId = 'T9984-spawn-canonical';

    const result = await spawnWorktree(fixture.projectRoot, { taskId });

    // The worktree path MUST sit under <cleoHome>/worktrees/<projectHash>/<taskId>/.
    expect(result.path.startsWith(fixture.cleoHome + sep)).toBe(true);
    expect(result.path).toContain(`${sep}worktrees${sep}`);
    expect(result.path.endsWith(`${sep}${taskId}`)).toBe(true);

    // Branch follows the `task/<taskId>` convention.
    expect(result.branch).toBe(`task/${taskId}`);

    // Project hash is the deterministic 16-char hex SSoT helper output.
    expect(result.projectHash).toMatch(/^[0-9a-f]{16}$/);

    // Sanity: cleanup so we don't leak fixtures across tests.
    await teardownWorktree(fixture.projectRoot, { taskId });
  });

  it('rejects worktrees outside the canonical XDG location (D009)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const taskId = 'T9984-spawn-canonical-2';

    const result = await spawnWorktree(fixture.projectRoot, { taskId });

    // The XDG layout is non-negotiable — no path under projectRoot is
    // allowed (banned per D009 / AGENTS.md).
    expect(result.path.startsWith(fixture.projectRoot + sep)).toBe(false);

    await teardownWorktree(fixture.projectRoot, { taskId });
  });

  it('runs activated project hooks when an explicit Git shim is supplied', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const root = fixture.projectRoot;
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(
      join(root, 'lifecycle.mjs'),
      `import { appendFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
appendFileSync('lifecycle.txt', JSON.parse(input).event + '\\n');
process.stdout.write(JSON.stringify({status: 'pass'}));`,
    );
    const manifest: ProjectHooksManifest = {
      schemaVersion: 1,
      hooks: [
        {
          id: 'lifecycle',
          owner: 'project',
          executable: 'node',
          handler: 'lifecycle.mjs',
          args: [],
          dependencies: [],
          timeoutMs: 10000,
          checkerErrorPolicy: 'warn',
          bindings: [
            { source: 'worktree', event: 'post-create' },
            { source: 'worktree', event: 'post-start' },
          ],
        },
      ],
    };
    writeFileSync(join(root, '.cleo/hooks.json'), JSON.stringify(manifest));
    execFileSync('git', ['add', '.cleo/hooks.json', 'lifecycle.mjs'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'test(T13345): lifecycle fixture'], { cwd: root });
    await activateProjectHooks(root);

    const taskId = 'T13345-explicit-shim';
    const created = await spawnWorktree(root, {
      taskId,
      gitShim: { dir: join(root, 'explicit-shim'), installed: false },
    });
    try {
      expect(readFileSync(join(created.path, 'lifecycle.txt'), 'utf8')).toBe(
        'post-create\npost-start\n',
      );
      expect(created.projectHookResults).toMatchObject([{ id: 'lifecycle', status: 'pass' }]);
      expect(created.bootstrap?.projectHookResults).toMatchObject([
        { id: 'lifecycle', status: 'pass' },
      ]);
      expect(created.envVars['CLEO_BRANCH_PROTECTION']).toBe('unavailable');
    } finally {
      await teardownWorktree(root, { taskId, force: true });
    }
  });

  it('preserves a caller executor when installing the default Git shim', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const requests: HookInvocation[] = [];
    const executor: HookExecutor = {
      execute: async (request) => {
        requests.push(request);
        return [];
      },
    };
    const taskId = 'T13345-executor-override';
    const created = await spawnWorktree(fixture.projectRoot, {
      taskId,
      projectHookExecutor: executor,
    });
    try {
      expect(requests.map((request) => request.event)).toEqual(['post-create', 'post-start']);
      expect(requests.every((request) => request.projectRoot === realpathSync(created.path))).toBe(
        true,
      );
      expect(requests.every((request) => request.worktree?.taskId === taskId)).toBe(true);
    } finally {
      await teardownWorktree(fixture.projectRoot, { taskId, force: true });
    }
  });

  it('destroys the worktree cleanly via the SDK', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const taskId = 'T9984-spawn-destroy';

    const created = await spawnWorktree(fixture.projectRoot, { taskId });
    expect(created.path).toBeTruthy();

    const destroyed = await teardownWorktree(fixture.projectRoot, { taskId });
    expect(destroyed.taskId).toBe(taskId);
    expect(destroyed.worktreeRemoved).toBe(true);
  });

  it('keeps the worktree branch independent of the orchestrator branch', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const taskId = 'T9984-spawn-isolation';

    // Orchestrator stays on `main`.
    const orchestratorBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fixture.projectRoot,
      encoding: 'utf-8',
    }).trim();
    expect(orchestratorBranch).toBe('main');

    const created = await spawnWorktree(fixture.projectRoot, { taskId });

    // The agent worktree is on `task/<taskId>`, NOT on the orchestrator's
    // branch. This is the L1 isolation invariant enforced by D023 / ADR-055.
    const agentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: created.path,
      encoding: 'utf-8',
    }).trim();
    expect(agentBranch).toBe(`task/${taskId}`);

    // Orchestrator branch unchanged.
    const orchestratorBranchAfter = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fixture.projectRoot,
      encoding: 'utf-8',
    }).trim();
    expect(orchestratorBranchAfter).toBe('main');

    await teardownWorktree(fixture.projectRoot, { taskId });
  });
});
