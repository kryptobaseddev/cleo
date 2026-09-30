/**
 * T12501 — ONE focus-key rule for every read and write.
 *
 * Two sessions in two terminals (different binding keys, no `CLEO_SESSION_ID`)
 * start different tasks. Each sees its own focus in `cleo current`, session
 * status, briefing, inject and bootstrap; neither overwrites the other, and
 * neither touches the legacy global key. A done task never reaches inject or
 * bootstrap as the current focus, even when the session row still names it
 * (T12731 item 4).
 *
 * @task T12501
 * @task T12731
 * @epic T12497
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, type TaskWorkState } from '@cleocode/contracts';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// session start refreshes GLOBAL provider instruction files; never touch the
// developer's real files from a test.
vi.mock('../../injection.js', () => ({
  refreshStaleGlobalInstructions: vi.fn().mockResolvedValue({
    status: 'skipped',
    stale: [],
    duplicates: [],
    updated: [],
  }),
}));

import { CleoError } from '../../errors.js';
import { injectTasks } from '../../inject/index.js';
import { buildBrainState } from '../../orchestration/bootstrap.js';
import { sessionStart, sessionStatus, taskStop } from '../../session/engine-ops.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { bindTerminalToSession, createSession } from '../../store/session-store.js';
import { generateInjection } from '../../system/inject-generate.js';
import { currentTask, startTask, stopTask } from '../../task-work/index.js';
import { computeBriefing } from '../briefing.js';
import {
  focusStateKey,
  LEGACY_FOCUS_STATE_KEY,
  readLiveFocus,
  resolveFocusSessionId,
  writeFocusState,
} from '../focus-state-store.js';
import { SESSION_ENV_KEY_PRECEDENCE } from '../session-id.js';
import { TERMINAL_KEY_SOURCES } from '../terminal-identity.js';

/** Every env var the resolvers read — cleared so the host terminal cannot leak in. */
const IDENTITY_ENV_VARS: readonly string[] = [
  ...SESSION_ENV_KEY_PRECEDENCE,
  ...TERMINAL_KEY_SOURCES.flatMap((s) =>
    s.qualifierEnvVar ? [s.envVar, s.qualifierEnvVar] : [s.envVar],
  ),
];

function clearIdentityEnv(): void {
  for (const name of IDENTITY_ENV_VARS) vi.stubEnv(name, undefined);
}

/** Run `fn` as if inside a terminal whose only identity is `vars`. */
async function inTerminal<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  clearIdentityEnv();
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  try {
    return await fn();
  } finally {
    clearIdentityEnv();
  }
}

const TERMINAL_A = { CLAUDE_CODE_SESSION_ID: 'claude-aaaa' };
const TERMINAL_B = { TMUX: '/tmp/tmux-501/default,99,0', TMUX_PANE: '%7' };

let root: string;

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  clearIdentityEnv();
  root = await mkdtemp(join(tmpdir(), 'cleo-t12501-'));
  const cleoDir = join(root, '.cleo');
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  await writeFile(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  await writeFile(
    join(cleoDir, 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t12501', projectHash: 'hash-t12501' }),
  );
  const acc = await getTaskAccessor(root);
  for (const id of ['T1', 'T2'])
    await acc.upsertSingleTask({
      id,
      title: `task ${id}`,
      description: 'T12501 fixture',
      status: 'pending',
      priority: 'medium',
      acceptance: ['first', 'second', 'third'],
      createdAt: '2026-09-29T00:00:00Z',
    });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
});

/** Start a session from a simulated terminal. */
async function startIn(
  vars: Record<string, string>,
  handle: string,
  firstTask?: string,
): Promise<string> {
  return inTerminal(vars, async () => {
    const res = await sessionStart(root, {
      scope: 'global',
      name: handle,
      agentHandle: handle,
      ...(firstTask ? { startTask: firstTask } : {}),
    });
    expect(res.success).toBe(true);
    return res.data!.id;
  });
}

describe('one focus-key rule across two terminals (T12501)', () => {
  it('each terminal-bound session reads and writes only its own focus key', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');

    // The single resolver maps each terminal to its own session — no env id.
    expect(await inTerminal(TERMINAL_A, () => resolveFocusSessionId(root))).toBe(sessionA);
    expect(await inTerminal(TERMINAL_B, () => resolveFocusSessionId(root))).toBe(sessionB);

    await inTerminal(TERMINAL_A, () => startTask('T1', root));
    await inTerminal(TERMINAL_B, () => startTask('T2', root));

    // `cleo current`
    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBe('T1');
    expect((await inTerminal(TERMINAL_B, () => currentTask(root))).currentTask).toBe('T2');

    // session status
    const statusA = await inTerminal(TERMINAL_A, () => sessionStatus(root));
    const statusB = await inTerminal(TERMINAL_B, () => sessionStatus(root));
    expect(statusA.data?.taskWork?.currentTask).toBe('T1');
    expect(statusB.data?.taskWork?.currentTask).toBe('T2');

    // briefing
    const briefA = await inTerminal(TERMINAL_A, () => computeBriefing(root));
    const briefB = await inTerminal(TERMINAL_B, () => computeBriefing(root));
    expect(briefA.currentTask?.id).toBe('T1');
    expect(briefB.currentTask?.id).toBe('T2');

    // inject (MVI) and inject --focused-only
    const mviA = await inTerminal(TERMINAL_A, () => generateInjection(root));
    const mviB = await inTerminal(TERMINAL_B, () => generateInjection(root));
    expect(mviA.injection).toContain('| Focus | `T1` |');
    expect(mviB.injection).toContain('| Focus | `T2` |');
    const injA = (await inTerminal(TERMINAL_A, () =>
      injectTasks({ focusedOnly: true, cwd: root }),
    )) as { tasks: Array<{ id: string }> };
    expect(injA.tasks.map((t) => t.id)).toEqual(['T1']);

    // bootstrap
    const brainA = await inTerminal(TERMINAL_A, () => buildBrainState(root, { speed: 'fast' }));
    const brainB = await inTerminal(TERMINAL_B, () => buildBrainState(root, { speed: 'fast' }));
    expect(brainA.currentTask?.id).toBe('T1');
    expect(brainB.currentTask?.id).toBe('T2');

    // Stored keys: one per session, and the legacy global key never written.
    const acc = await getTaskAccessor(root);
    expect((await acc.getMetaValue<TaskWorkState>(focusStateKey(sessionA)))?.currentTask).toBe(
      'T1',
    );
    expect((await acc.getMetaValue<TaskWorkState>(focusStateKey(sessionB)))?.currentTask).toBe(
      'T2',
    );
    expect(await acc.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();

    // `cleo stop` in A leaves B's focus alone.
    await inTerminal(TERMINAL_A, () => stopTask(root));
    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBeNull();
    expect((await inTerminal(TERMINAL_B, () => currentTask(root))).currentTask).toBe('T2');
    expect(await acc.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();
  });

  it('a bound session never reads the legacy key as its own focus', async () => {
    const acc = await getTaskAccessor(root);
    // An unbound caller's focus from before this session existed.
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, { currentTask: 'T2' });
    const sessionA = await startIn(TERMINAL_A, 'agent-a');

    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBeNull();
    expect((await readLiveFocus(acc, sessionA)).currentTask).toBeNull();
    // The unbound caller still reads its legacy focus.
    expect((await inTerminal({}, () => currentTask(root))).currentTask).toBe('T2');
  });
});

describe('unbound callers never write the legacy focus key (T12501 AC2)', () => {
  const UNBOUND_X = { TERM_SESSION_ID: 'w0t5p0:XXXX' };
  const UNBOUND_Y = { TERM_SESSION_ID: 'w0t6p0:YYYY' };

  it('two unbound terminals: start and stop are refused and overwrite nothing', async () => {
    // A bound session exists elsewhere — it must not be guessed either.
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const acc = await getTaskAccessor(root);

    const refusedX = await inTerminal(UNBOUND_X, () => startTask('T1', root)).catch((e) => e);
    const refusedY = await inTerminal(UNBOUND_Y, () => startTask('T2', root)).catch((e) => e);
    for (const err of [refusedX, refusedY]) {
      expect(err).toBeInstanceOf(CleoError);
      expect((err as CleoError).code).toBe(ExitCode.SESSION_UNBOUND);
      expect((err as CleoError).message).toContain('no session is bound to this terminal');
      expect((err as CleoError).fix).toContain('cleo session start');
    }
    expect(refusedX.message).toContain('Cannot start work on T1');

    const stopX = await inTerminal(UNBOUND_X, () => stopTask(root)).catch((e) => e);
    expect((stopX as CleoError).code).toBe(ExitCode.SESSION_UNBOUND);

    // Nothing was written: no legacy key, no claim, and A's focus is untouched.
    expect(await acc.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();
    expect((await acc.loadSingleTask('T1'))?.claim).toBeUndefined();
    expect((await acc.loadSingleTask('T2'))?.claim).toBeUndefined();
    expect(await acc.getMetaValue(focusStateKey(sessionA))).toMatchObject({ currentTask: null });
  });

  it('refuses even when no session exists at all (there is still no key to write)', async () => {
    const acc = await getTaskAccessor(root);
    const err = await inTerminal(UNBOUND_X, () => startTask('T1', root)).catch((e) => e);
    expect((err as CleoError).code).toBe(ExitCode.SESSION_UNBOUND);
    expect(await acc.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();
  });

  it('taskStop (the `cleo stop` engine op) reports E_SESSION_UNBOUND, not E_NOT_INITIALIZED', async () => {
    const res = await inTerminal(UNBOUND_X, () => taskStop(root));
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_UNBOUND');
    expect(res.error?.message).toContain('Cannot stop work');
  });

  it('taskStop resolves the session from projectRoot, not the process cwd', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a', 'T1');
    // cwd is the repo running the tests, not `root`: resolution must use root.
    const res = await inTerminal(TERMINAL_A, () => taskStop(root));
    expect(res.success).toBe(true);
    expect(res.data?.previousTask).toBe('T1');
    const acc = await getTaskAccessor(root);
    expect(await acc.getMetaValue(focusStateKey(sessionA))).toMatchObject({ currentTask: null });
  });

  it('a shell whose only identity is the ppid fallback is told to use CLEO_SESSION_ID', async () => {
    const err = await inTerminal({}, () => startTask('T1', root)).catch((e) => e);
    expect((err as CleoError).code).toBe(ExitCode.SESSION_UNBOUND);
    expect((err as CleoError).message).toContain(
      'this shell has no stable terminal identity; prefix commands with CLEO_SESSION_ID=<id> (see `cleo session status`)',
    );
  });

  it('writeFocusState refuses an empty session id at runtime', async () => {
    const acc = await getTaskAccessor(root);
    await expect(writeFocusState(acc, '', { currentTask: 'T1' })).rejects.toMatchObject({
      code: ExitCode.SESSION_UNBOUND,
    });
    expect(await acc.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();
  });

  it('writeFocusState declares a non-nullable session id, so tsc rejects a null writer', () => {
    // Source code is typechecked (tests are not): with `sessionId: string`,
    // any writer that passes a possibly-null id fails `tsc`. Pin the signature.
    const path = fileURLToPath(new URL('../focus-state-store.ts', import.meta.url));
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = source.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === 'writeFocusState',
    );
    const param = fn?.parameters[1];
    expect(param?.name.getText(source)).toBe('sessionId');
    expect(param?.questionToken).toBeUndefined();
    expect(param?.type?.kind).toBe(ts.SyntaxKind.StringKeyword);
  });
});

describe('a done task is never the current focus through inject or bootstrap (T12731)', () => {
  it('ignores a done focus pointer and the session row taskWork', async () => {
    // The session row records T1 as its task (session start --start-task).
    await startIn(TERMINAL_A, 'agent-a', 'T1');
    await inTerminal(TERMINAL_A, () => startTask('T1', root));
    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBe('T1');

    // T1 finishes without the completion clearing this session's key.
    const acc = await getTaskAccessor(root);
    await acc.updateTaskFields('T1', { status: 'done', pipelineStage: 'contribution' });

    const mvi = await inTerminal(TERMINAL_A, () => generateInjection(root));
    expect(mvi.injection).toContain('| Focus | none |');
    expect(mvi.injection).not.toContain('`T1`');

    const brain = await inTerminal(TERMINAL_A, () => buildBrainState(root, { speed: 'fast' }));
    expect(brain.currentTask).toBeUndefined();

    const inj = (await inTerminal(TERMINAL_A, () =>
      injectTasks({ focusedOnly: true, cwd: root }),
    )) as { tasks: Array<{ id: string }> };
    expect(inj.tasks.map((t) => t.id)).not.toContain('T1');
  });
});

/**
 * A session that predates per-session focus: a row and a terminal binding,
 * but no `focus_state:<id>` key (session start would write a fresh one).
 */
async function preUpgradeSessionIn(vars: Record<string, string>, id: string): Promise<void> {
  await createSession(
    {
      id,
      name: id,
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    },
    root,
  );
  await inTerminal(vars, () => bindTerminalToSession(id, root));
}

describe('upgrade: a bound session adopts the legacy focus once (T12501)', () => {
  const SES_A = 'ses_20260929000001_aaaaaa';
  const SES_B = 'ses_20260929000002_bbbbbb';

  it('adopts a live legacy pointer once; a second session cannot adopt it', async () => {
    const acc = await getTaskAccessor(root);
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, { currentTask: 'T1', sessionNote: 'pre' });
    await preUpgradeSessionIn(TERMINAL_A, SES_A);
    await preUpgradeSessionIn(TERMINAL_B, SES_B);

    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBe('T1');
    const own = await acc.getMetaValue<TaskWorkState>(focusStateKey(SES_A));
    expect(own).toMatchObject({ currentTask: 'T1', sessionNote: 'pre' });
    expect((await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY))?.currentTask).toBeNull();

    // B finds no pointer left to adopt, and A keeps its focus.
    expect((await inTerminal(TERMINAL_B, () => currentTask(root))).currentTask).toBeNull();
    expect(await acc.getMetaValue(focusStateKey(SES_B))).toBeNull();
    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBe('T1');
  });

  it('does not adopt a legacy pointer at a done task', async () => {
    const acc = await getTaskAccessor(root);
    await acc.updateTaskFields('T1', { status: 'done', pipelineStage: 'contribution' });
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, { currentTask: 'T1' });
    await preUpgradeSessionIn(TERMINAL_A, SES_A);

    expect((await inTerminal(TERMINAL_A, () => currentTask(root))).currentTask).toBeNull();
    expect(await acc.getMetaValue(focusStateKey(SES_A))).toBeNull();
    expect((await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY))?.currentTask).toBe('T1');
  });

  it('a bound stop clears a legacy pointer to the stopped task', async () => {
    const acc = await getTaskAccessor(root);
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    await inTerminal(TERMINAL_A, () => startTask('T1', root));
    // A pre-upgrade pointer to the same task, left in the legacy key.
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, { currentTask: 'T1' });

    await inTerminal(TERMINAL_A, () => stopTask(root));
    expect(
      (await acc.getMetaValue<TaskWorkState>(focusStateKey(sessionA)))?.currentTask,
    ).toBeNull();
    expect((await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY))?.currentTask).toBeNull();
  });
});
