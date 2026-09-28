/**
 * Terminal-bound session identity (T12499 · epic T12497).
 *
 * Proves:
 *  1. The provider/terminal key map resolves keys in precedence order, qualifies
 *     ambiguous pane ids, and falls back to the ppid chain (skipping launchers)
 *     only when no environment key is present.
 *  2. `session start` persists a terminal → session binding, and two terminals
 *     that each start a session each resolve their OWN session — even though
 *     the second one is the newest active row the legacy fallback would pick.
 *  3. An env session id with no row is rejected; the binding still wins.
 *  4. `session end` drops the binding.
 *
 * @task T12499
 * @epic T12497
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { sessionEnd, sessionStart } from '../../session/engine-ops.js';
import {
  bindTerminalToSession,
  resolveCurrentSessionId,
  resolveTerminalBoundSession,
} from '../../store/session-store.js';
import { SESSION_ENV_KEY_PRECEDENCE } from '../session-id.js';
import {
  type ProcessAncestor,
  readProcessEntry,
  resolveTerminalKeys,
  TERMINAL_KEY_SOURCES,
} from '../terminal-identity.js';

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

describe('resolveTerminalKeys — provider/terminal key map (T12499)', () => {
  it('orders provider keys before multiplexer and terminal keys', () => {
    const keys = resolveTerminalKeys({
      env: {
        TERM_SESSION_ID: 'w0t0p0:ABC',
        TMUX: '/tmp/tmux-501/default,123,0',
        TMUX_PANE: '%3',
        CLAUDE_CODE_SESSION_ID: 'claude-uuid',
      },
    });
    expect(keys.map((k) => k.source)).toEqual([
      'CLAUDE_CODE_SESSION_ID',
      'TMUX_PANE',
      'TERM_SESSION_ID',
    ]);
    expect(keys[0]).toEqual({
      key: 'env:CLAUDE_CODE_SESSION_ID=claude-uuid',
      source: 'CLAUDE_CODE_SESSION_ID',
      kind: 'provider',
    });
    // TMUX_PANE is qualified by the server socket so `%3` stays unique.
    expect(keys[1]?.key).toBe('env:TMUX_PANE=/tmp/tmux-501/default,123,0|%3');
  });

  it('recognises CODEX_THREAD_ID and WT_SESSION from the map', () => {
    const keys = resolveTerminalKeys({ env: { CODEX_THREAD_ID: 't-1', WT_SESSION: 'wt-1' } });
    expect(keys.map((k) => [k.source, k.kind])).toEqual([
      ['CODEX_THREAD_ID', 'provider'],
      ['WT_SESSION', 'terminal'],
    ]);
  });

  it('treats blank values as absent', () => {
    const lookup = vi.fn(() => null);
    expect(
      resolveTerminalKeys({ env: { TERM_SESSION_ID: '  ' }, ppid: 50, lookupProcess: lookup }),
    ).toEqual([]);
  });

  it('falls back to the nearest non-launcher ancestor when no env key is set', () => {
    const table: Record<number, ProcessAncestor> = {
      40: { pid: 40, ppid: 30, startedAt: 'Sat Sep 27 22:00:01 2026', command: 'pnpm' },
      30: { pid: 30, ppid: 20, startedAt: 'Sat Sep 27 22:00:00 2026', command: 'node' },
      20: { pid: 20, ppid: 10, startedAt: 'Sat Sep 27 21:00:00 2026', command: 'zsh' },
      10: { pid: 10, ppid: 1, startedAt: 'Sat Sep 27 20:00:00 2026', command: 'Terminal' },
    };
    const lookup = vi.fn((pid: number) => table[pid] ?? null);
    const keys = resolveTerminalKeys({ env: {}, ppid: 40, lookupProcess: lookup });
    expect(keys).toEqual([
      { key: 'ppid:20@Sat Sep 27 21:00:00 2026', source: 'ppid', kind: 'ppid' },
    ]);
    // Never climbs past the shell to the terminal emulator shared by every tab.
    expect(lookup).not.toHaveBeenCalledWith(10);
  });

  it('does not walk the process table when an env key identifies the terminal', () => {
    const lookup = vi.fn(() => null);
    resolveTerminalKeys({ env: { TERM_SESSION_ID: 'x' }, ppid: 40, lookupProcess: lookup });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('readProcessEntry — time-zone and locale independence (T12500)', () => {
  it.skipIf(process.platform === 'win32')(
    'derives the same start time (and ppid key) under TZ=UTC and TZ=America/Los_Angeles',
    () => {
      const pid = process.pid;
      vi.stubEnv('TZ', 'UTC');
      vi.stubEnv('LANG', 'de_DE.UTF-8');
      const utc = readProcessEntry(pid);
      vi.stubEnv('TZ', 'America/Los_Angeles');
      vi.stubEnv('LANG', 'en_US.UTF-8');
      const la = readProcessEntry(pid);
      vi.unstubAllEnvs();

      expect(utc).not.toBeNull();
      expect(la?.startedAt).toBe(utc?.startedAt);
      // …so the ppid-chain key built from it is identical too.
      const keyOf = (entry: ProcessAncestor | null) =>
        resolveTerminalKeys({
          env: {},
          ppid: pid,
          lookupProcess: () => (entry ? { ...entry, command: 'zsh' } : null),
        })[0]?.key;
      expect(keyOf(la)).toBe(keyOf(utc));
    },
  );
});

describe('terminal-bound session resolution (T12499)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    clearIdentityEnv();
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-terminal-binding-'));
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

  /** Start a session from a simulated terminal; the handle lets both coexist. */
  async function startIn(vars: Record<string, string>, handle: string): Promise<string> {
    return inTerminal(vars, async () => {
      const res = await sessionStart(tempDir, {
        scope: 'global',
        name: handle,
        agentHandle: handle,
      });
      expect(res.success).toBe(true);
      return res.data!.id;
    });
  }

  const TERMINAL_A = { CLAUDE_CODE_SESSION_ID: 'claude-aaaa' };
  const TERMINAL_B = { TMUX: '/tmp/tmux-501/default,99,0', TMUX_PANE: '%7' };

  it('two terminals that each start a session each resolve their own', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');
    expect(sessionA).not.toBe(sessionB);

    // B is now the newest active row — the legacy fallback would hand it to A.
    expect(await inTerminal(TERMINAL_A, () => resolveCurrentSessionId(tempDir))).toBe(sessionA);
    expect(await inTerminal(TERMINAL_B, () => resolveCurrentSessionId(tempDir))).toBe(sessionB);
    expect((await inTerminal(TERMINAL_A, () => resolveTerminalBoundSession(tempDir)))?.id).toBe(
      sessionA,
    );
  });

  it('rejects an env session id with no row and still resolves the terminal binding', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    await startIn(TERMINAL_B, 'agent-b');
    const resolved = await inTerminal(
      { ...TERMINAL_A, CLEO_SESSION_ID: 'ses_20990101000000_ffffff' },
      () => resolveCurrentSessionId(tempDir),
    );
    expect(resolved).toBe(sessionA);
  });

  it('an env session id WITH a row still outranks the terminal binding', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');
    const resolved = await inTerminal({ ...TERMINAL_A, CLEO_SESSION_ID: sessionB }, () =>
      resolveCurrentSessionId(tempDir),
    );
    expect(resolved).toBe(sessionB);
    expect(resolved).not.toBe(sessionA);
  });

  it('refuses to bind a session id that has no row', async () => {
    const bound = await bindTerminalToSession('ses_20990101000000_eeeeee', tempDir, [
      { key: 'env:TERM_SESSION_ID=x', source: 'TERM_SESSION_ID', kind: 'terminal' },
    ]);
    expect(bound).toEqual([]);
  });

  it('session end drops the binding so the terminal no longer resolves it', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const ended = await inTerminal(TERMINAL_A, () =>
      sessionEnd(tempDir, undefined, { sessionId: sessionA }),
    );
    expect(ended.success).toBe(true);
    expect(await inTerminal(TERMINAL_A, () => resolveTerminalBoundSession(tempDir))).toBeNull();
  });
});
