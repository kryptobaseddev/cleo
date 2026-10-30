/**
 * T14165 — the axiom T2698 sequence, end to end: claim, adopt a worktree on a
 * branch that names no task with `--task-id`, start, renew. Every write
 * succeeded and persisted, but `worktree list`, `cleo show` and the session
 * row read back null. Each read now returns what was written.
 *
 * @task T14165
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getSession } from '../../store/session-store.js';
import { startTask, stopTask } from '../../task-work/index.js';
import { taskClaim } from '../../tasks/engine-wrap-ops.js';
import { taskShow } from '../../tasks/show.js';
import { listWorktrees } from '../list.js';
import { adoptWorktree } from '../worktree-adopt.js';

const SESSION_ID = 'ses_20261030000001_t14165';
const TASK_ID = 'T2698';

/** Run git in `cwd` with a fixed identity. */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

/** An active session row for the bound caller. */
function session(): Session {
  return {
    id: SESSION_ID,
    name: 'axiom-repro',
    status: 'active',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: new Date().toISOString(),
  };
}

describe('T14165: adopt, claim and start read back what they wrote', () => {
  let env: TestDbEnv;
  let outside: string;
  let worktree: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_SESSION_ID', SESSION_ID);
    vi.stubEnv('CLEO_AGENT_ID', undefined);
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: TASK_ID, title: 'Axiom task', status: 'pending', priority: 'medium' },
    ]);
    await env.accessor.upsertSingleSession(session());
    // createTestDb leaves an empty .git/ marker; make it a real repository.
    git(env.tempDir, 'init', '-q');
    git(env.tempDir, 'commit', '-q', '--allow-empty', '-m', 'init');
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14165-wt-')));
    worktree = join(outside, 'wt');
    git(env.tempDir, 'worktree', 'add', '-q', '-b', 'feature-x', worktree);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await env.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it('worktree list, cleo show and the session row show the binding, the lease and the task', async () => {
    const claimed = await taskClaim(env.tempDir, { taskId: TASK_ID });
    expect(claimed.success).toBe(true);
    const adopted = await adoptWorktree({
      projectRoot: env.tempDir,
      worktreePath: worktree,
      taskId: TASK_ID,
      source: 'manual',
      actor: 'axiom-qa',
    });
    expect(adopted.success && adopted.data.taskId).toBe(TASK_ID);
    await startTask(TASK_ID, env.tempDir, env.accessor);
    const renewed = await taskClaim(env.tempDir, { taskId: TASK_ID, renew: true });
    expect(renewed.success).toBe(true);

    // worktree list: the adopted task wins over a branch that names none.
    const listed = await listWorktrees({ projectRoot: env.tempDir });
    if (!listed.success) throw new Error(listed.error.message);
    const entry = listed.data.worktrees.find((w) => w.path === worktree);
    expect(entry).toMatchObject({ branch: 'feature-x', taskId: TASK_ID, owningAgent: 'axiom-qa' });

    // cleo show: the lease claim wrote.
    const shown = await taskShow(env.tempDir, TASK_ID);
    if (!shown.success) throw new Error(shown.error.message);
    expect(shown.data.task.claim?.sessionId).toBe(SESSION_ID);

    // session show / status: the row agrees with `cleo current`.
    expect((await getSession(SESSION_ID, env.tempDir))?.taskWork.taskId).toBe(TASK_ID);
    await stopTask(env.tempDir, env.accessor);
    expect((await getSession(SESSION_ID, env.tempDir))?.taskWork.taskId).toBeNull();
  });
});
