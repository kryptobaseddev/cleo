/**
 * Terminal-aware session start guard + SDK startSession binding (T12530 · epic T12497).
 *
 * Before T12530 `session start` refused whenever ANY session was active, so a
 * second terminal needed `--agent <handle>` although T12499 had already given
 * it an identity of its own. The guard now conflicts only with a session the
 * caller already owns (the same terminal key) or one no binding names.
 *
 * Proves:
 *  1. Two terminals with different keys each start a session without `--agent`
 *     (CLI engine and SDK), and each resolves its own.
 *  2. A second start from the SAME terminal still conflicts, naming the
 *     terminal's session and the ways out.
 *  3. An agent inside a human's tab starts its own session without `--agent`;
 *     the human's session is untouched.
 *  4. A session no terminal binding names still blocks (it may be the caller's).
 *  5. A caller with no identity at all keeps the single-session guard.
 *  6. SDK `startSession` writes the terminal binding.
 *
 * @task T12530
 * @epic T12497
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@cleocode/contracts';
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
import { sessionStart } from '../../session/engine-ops.js';
import {
  findSessionStartConflicts,
  getSession,
  resolveBoundSessionId,
  resolveTerminalBoundSession,
  unbindSessionTerminals,
} from '../../store/session-store.js';
import { startSession } from '../index.js';
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

const TAB_A = { TERM_SESSION_ID: 'w0t0p0:AAAA' };
const TAB_B = { TERM_SESSION_ID: 'w0t1p0:BBBB' };
const PANE_A = { TMUX: '/tmp/tmux-501/default,99,0', TMUX_PANE: '%1' };
const PANE_B = { TMUX: '/tmp/tmux-501/default,99,0', TMUX_PANE: '%2' };
const CLAUDE_1 = { CLAUDE_CODE_SESSION_ID: 'claude-1111' };
const CLAUDE_2 = { CLAUDE_CODE_SESSION_ID: 'claude-2222' };

let tempDir: string;

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  clearIdentityEnv();
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t12530-'));
  const cleoDir = join(tempDir, '.cleo');
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  await writeFile(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
    () => {},
  );
});

/** Start a session from a simulated terminal WITHOUT `--agent`; returns the engine result. */
function startFrom(vars: Record<string, string>, name: string) {
  return inTerminal(vars, () => sessionStart(tempDir, { scope: 'global', name }));
}

describe('session start guard is per terminal (T12530)', () => {
  it('two tabs each start a session without --agent and each resolve their own', async () => {
    const a = await startFrom(TAB_A, 'tab-a');
    expect(a.success).toBe(true);
    const b = await startFrom(TAB_B, 'tab-b');
    expect(b.error?.message).toBeUndefined();
    expect(b.success).toBe(true);
    expect(b.data!.id).not.toBe(a.data!.id);

    expect(await inTerminal(TAB_A, () => resolveBoundSessionId(tempDir))).toBe(a.data!.id);
    expect(await inTerminal(TAB_B, () => resolveBoundSessionId(tempDir))).toBe(b.data!.id);
    // Neither start touched the other terminal's session.
    expect((await getSession(a.data!.id, tempDir))?.status).toBe('active');
  });

  it('two tmux panes and two Claude Code instances each start without --agent', async () => {
    const ids: string[] = [];
    for (const [vars, name] of [
      [PANE_A, 'pane-a'],
      [PANE_B, 'pane-b'],
      [CLAUDE_1, 'claude-1'],
      [CLAUDE_2, 'claude-2'],
    ] as const) {
      const res = await startFrom(vars, name);
      expect(res.error?.message).toBeUndefined();
      expect(res.success).toBe(true);
      ids.push(res.data!.id);
    }
    expect(new Set(ids).size).toBe(4);
    expect(await inTerminal(PANE_A, () => resolveBoundSessionId(tempDir))).toBe(ids[0]);
    expect(await inTerminal(CLAUDE_2, () => resolveBoundSessionId(tempDir))).toBe(ids[3]);
  });

  it('a second start from the SAME terminal still conflicts, with a clear message', async () => {
    const first = await startFrom(TAB_A, 'first');
    expect(first.success).toBe(true);
    // Another terminal's session must not change the verdict or the message.
    expect((await startFrom(TAB_B, 'other')).success).toBe(true);

    const second = await startFrom(TAB_A, 'second');
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('E_SESSION_CONFLICT');
    expect(second.error?.message).toContain(
      `This terminal already has an active session (${first.data!.id})`,
    );
    expect(second.error?.message).toContain("'cleo session end'");
    expect(second.error?.message).toContain("'--agent <handle>'");
    expect(second.error?.details?.activeSessionId).toBe(first.data!.id);
    expect(second.error?.details?.heldVia).toBe('terminal');
    // The terminal is still bound to its first session.
    expect(await inTerminal(TAB_A, () => resolveBoundSessionId(tempDir))).toBe(first.data!.id);
  });

  it('the same Claude Code instance cannot start a second session either', async () => {
    const first = await startFrom(CLAUDE_1, 'c1');
    expect(first.success).toBe(true);
    const again = await startFrom(CLAUDE_1, 'c1-again');
    expect(again.error?.code).toBe('E_SESSION_CONFLICT');
    expect(again.error?.details?.activeSessionId).toBe(first.data!.id);
  });

  it('an agent in a human tab starts its own session; the human keeps theirs', async () => {
    const human = await startFrom(TAB_A, 'human');
    expect(human.success).toBe(true);
    const agent = await startFrom({ ...TAB_A, ...CLAUDE_1 }, 'agent');
    expect(agent.error?.message).toBeUndefined();
    expect(agent.success).toBe(true);
    expect(await inTerminal(TAB_A, () => resolveBoundSessionId(tempDir))).toBe(human.data!.id);
    expect(await inTerminal({ ...TAB_A, ...CLAUDE_1 }, () => resolveBoundSessionId(tempDir))).toBe(
      agent.data!.id,
    );
  });

  it('a session no terminal binding names still blocks, with resume advice', async () => {
    const orphan = await startFrom(TAB_A, 'orphan');
    expect(orphan.success).toBe(true);
    await unbindSessionTerminals(orphan.data!.id, tempDir);

    const res = await startFrom(TAB_B, 'b');
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_CONFLICT');
    expect(res.error?.message).toContain(`'cleo session resume ${orphan.data!.id}'`);
    expect(res.error?.message).not.toContain('session end');
  });

  it('a caller with no identity at all keeps the single-session guard', async () => {
    const a = await startFrom(TAB_A, 'a');
    expect(a.success).toBe(true);
    const active = [(await getSession(a.data!.id, tempDir)) as Session];
    const verdict = await inTerminal({}, () => findSessionStartConflicts(active, tempDir, []));
    expect(verdict.identified).toBe(false);
    expect(verdict.blocking.map((s) => s.id)).toEqual([a.data!.id]);
  });
});

describe('SDK startSession (T12530)', () => {
  it('writes the terminal binding', async () => {
    const session = await inTerminal(TAB_A, () =>
      startSession(tempDir, { name: 'sdk', scope: 'global' }),
    );
    expect((await inTerminal(TAB_A, () => resolveTerminalBoundSession(tempDir)))?.id).toBe(
      session.id,
    );
    expect(await inTerminal(TAB_B, () => resolveTerminalBoundSession(tempDir))).toBeNull();
  });

  it('two terminals each start a same-scope session; the same terminal conflicts', async () => {
    const a = await inTerminal(TAB_A, () => startSession(tempDir, { name: 'a', scope: 'global' }));
    const b = await inTerminal(TAB_B, () => startSession(tempDir, { name: 'b', scope: 'global' }));
    expect(b.id).not.toBe(a.id);

    const again = inTerminal(TAB_A, () => startSession(tempDir, { name: 'a2', scope: 'global' }));
    await expect(again).rejects.toBeInstanceOf(CleoError);
    await expect(
      inTerminal(TAB_A, () => startSession(tempDir, { name: 'a3', scope: 'global' })),
    ).rejects.toThrow(`Active session already exists for scope global: ${a.id}`);
  });
});
