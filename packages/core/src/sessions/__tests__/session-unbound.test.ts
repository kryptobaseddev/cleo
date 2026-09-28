/**
 * Unbound callers never act on the newest active session (T12500 · epic T12497).
 *
 * Proves:
 *  1. Two terminals each start a session; a THIRD, unbound terminal running
 *     `session end` gets `E_SESSION_UNBOUND` with binding instructions, and
 *     both sessions stay active. Decisions and assumptions refuse the same way.
 *  2. An explicit `--session <id>`, `session resume <id>`, or `CLEO_SESSION_ID`
 *     binds the caller, and the mutation then proceeds on THAT session.
 *  3. With no active session at all there is nothing ambiguous: the existing
 *     `E_SESSION_NOT_FOUND` behaviour is kept.
 *  4. Read-only status still shows the newest session to an unbound caller but
 *     labels it `unbound: true`; a bound caller sees its own session unlabelled.
 *  5. Safestop and switch from an unbound terminal end / suspend nothing.
 *  6. Spawn allocates the child's own session, never the orchestrator's, and
 *     refuses (E_SESSION_UNBOUND) rather than inheriting it when allocation fails.
 *
 * @task T12500
 * @epic T12497
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
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
import {
  sessionEnd,
  sessionRecordDecision,
  sessionResume,
  sessionStart,
  sessionStatus,
  sessionSwitch,
} from '../../session/engine-ops.js';
import { requireSpawnSession } from '../../spawn/agent-identity.js';
import {
  getSession,
  hasActiveSession,
  requireBoundSession,
  resolveBoundSession,
  resolveBoundSessionId,
  resolveSessionForRead,
  SESSION_LIVE_TTL_MS,
} from '../../store/session-store.js';
import { safestop } from '../../system/safestop.js';
import { endSession, startSession } from '../index.js';
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
/** A terminal that never ran `session start` — the P0 hazard. */
const TERMINAL_C = { TERM_SESSION_ID: 'w0t9p0:UNBOUND' };

describe('unbound callers (T12500)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    clearIdentityEnv();
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-session-unbound-'));
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

  async function statusOf(id: string): Promise<string | undefined> {
    return (await getSession(id, tempDir))?.status;
  }

  it('session end from a third, unbound terminal is refused and ends nobody', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');

    const res = await inTerminal(TERMINAL_C, () => sessionEnd(tempDir));

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_UNBOUND');
    expect(res.error?.fix).toContain('cleo session start');
    expect(res.error?.fix).toContain('CLEO_SESSION_ID');
    // Neither agent's session was touched — before T12500, B (newest) ended.
    expect(await statusOf(sessionA)).toBe('active');
    expect(await statusOf(sessionB)).toBe('active');
  });

  it('decisions from an unbound terminal are refused, not filed under the newest session', async () => {
    await startIn(TERMINAL_A, 'agent-a');
    await startIn(TERMINAL_B, 'agent-b');
    const res = await inTerminal(TERMINAL_C, () =>
      sessionRecordDecision(tempDir, { taskId: 'T1', decision: 'd', rationale: 'r' }),
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_UNBOUND');
  });

  it('requireBoundSession throws a typed SESSION_UNBOUND CleoError', async () => {
    await startIn(TERMINAL_A, 'agent-a');
    const err = await inTerminal(TERMINAL_C, () =>
      requireBoundSession('test', tempDir).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).toBeInstanceOf(CleoError);
    expect((err as CleoError).code).toBe(ExitCode.SESSION_UNBOUND);
    expect((err as CleoError).fix).toContain('cleo session start');
  });

  it('each bound terminal still ends its OWN session', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');
    const res = await inTerminal(TERMINAL_A, () => sessionEnd(tempDir));
    expect(res.success).toBe(true);
    expect(res.data?.sessionId).toBe(sessionA);
    expect(await statusOf(sessionA)).toBe('ended');
    expect(await statusOf(sessionB)).toBe('active');
  });

  it('an explicit session id or CLEO_SESSION_ID lets an unbound terminal act', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');

    const byEnv = await inTerminal({ ...TERMINAL_C, CLEO_SESSION_ID: sessionA }, () =>
      sessionEnd(tempDir),
    );
    expect(byEnv.success).toBe(true);
    expect(byEnv.data?.sessionId).toBe(sessionA);

    const explicit = await inTerminal(TERMINAL_C, () =>
      sessionEnd(tempDir, undefined, { sessionId: sessionB }),
    );
    expect(explicit.success).toBe(true);
    expect(explicit.data?.sessionId).toBe(sessionB);
  });

  it('session resume of an active session binds the resuming terminal', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    await startIn(TERMINAL_B, 'agent-b');
    const resumed = await inTerminal(TERMINAL_C, () => sessionResume(tempDir, sessionA));
    expect(resumed.success).toBe(true);
    const bound = await inTerminal(TERMINAL_C, () => resolveBoundSession(tempDir));
    expect(bound?.session.id).toBe(sessionA);
    expect(bound?.via).toBe('terminal');
  });

  it('keeps E_SESSION_NOT_FOUND when no session is active at all', async () => {
    const res = await inTerminal(TERMINAL_C, () => sessionEnd(tempDir));
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_NOT_FOUND');
  });

  it('read-only status shows the newest session to an unbound caller, labelled unbound', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');

    const unbound = await inTerminal(TERMINAL_C, () => sessionStatus(tempDir));
    expect(unbound.success).toBe(true);
    expect(unbound.data?.session?.id).toBe(sessionB);
    expect(unbound.data?.unbound).toBe(true);

    const bound = await inTerminal(TERMINAL_A, () => sessionStatus(tempDir));
    expect(bound.data?.session?.id).toBe(sessionA);
    expect(bound.data).not.toHaveProperty('unbound');

    const read = await inTerminal(TERMINAL_C, () => resolveSessionForRead(tempDir));
    expect(read).toMatchObject({ unbound: true });
  });

  it('safestop and switch from an unbound terminal end or suspend nobody', async () => {
    const sessionA = await startIn(TERMINAL_A, 'agent-a');
    const sessionB = await startIn(TERMINAL_B, 'agent-b');

    const stopped = await inTerminal(TERMINAL_C, () => safestop(tempDir, { reason: 'test' }));
    expect(stopped.sessionEnded).toBe(false);

    const switched = await inTerminal(TERMINAL_C, () => sessionSwitch(tempDir, sessionA));
    expect(switched.success).toBe(true);
    expect(await statusOf(sessionA)).toBe('active');
    expect(await statusOf(sessionB)).toBe('active');
  });
});

describe('binding specificity, SDK end, harness env ids, stale sessions (T12500 review)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    clearIdentityEnv();
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-session-bind-'));
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

  const TAB = { TERM_SESSION_ID: 'w0t0p0:SHARED-TAB' };
  const TMUX = { TMUX: '/tmp/tmux-501/default,42,0' };
  const PANE_1 = { ...TAB, ...TMUX, TMUX_PANE: '%1' };
  const PANE_2 = { ...TAB, ...TMUX, TMUX_PANE: '%2' };
  const CLAUDE_1 = { ...TAB, CLAUDE_CODE_SESSION_ID: 'claude-one' };
  const CLAUDE_2 = { ...TAB, CLAUDE_CODE_SESSION_ID: 'claude-two' };

  async function start(vars: Record<string, string>, name: string): Promise<string> {
    return inTerminal(vars, async () => {
      const res = await sessionStart(tempDir, { scope: 'global', name, agentHandle: name });
      expect(res.success).toBe(true);
      return res.data!.id;
    });
  }

  it('a sibling tmux pane sharing the tab id cannot end the other pane’s session', async () => {
    const pane1 = await start(PANE_1, 'pane-1');

    const res = await inTerminal(PANE_2, () => sessionEnd(tempDir));

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_UNBOUND');
    expect((await getSession(pane1, tempDir))?.status).toBe('active');
    // Pane %1 itself still resolves and ends its own session.
    const own = await inTerminal(PANE_1, () => sessionEnd(tempDir));
    expect(own.data?.sessionId).toBe(pane1);
  });

  it('two Claude Code instances in one tab each own only their session', async () => {
    const one = await start(CLAUDE_1, 'claude-1');
    const two = await start(CLAUDE_2, 'claude-2');
    expect((await inTerminal(CLAUDE_1, () => resolveBoundSession(tempDir)))?.session.id).toBe(one);
    expect((await inTerminal(CLAUDE_2, () => resolveBoundSession(tempDir)))?.session.id).toBe(two);
    // A third instance in the same tab is unbound — the shared tab key is not bound at all.
    const three = await inTerminal({ ...TAB, CLAUDE_CODE_SESSION_ID: 'claude-three' }, () =>
      resolveBoundSession(tempDir),
    );
    expect(three).toBeNull();
  });

  it('a tab-started session is adopted by Claude Code in that tab (attribution + end)', async () => {
    const tabSession = await start(TAB, 'human-tab');

    // Attribution (what update/complete/observe stamp) resolves the tab session.
    expect(await inTerminal(CLAUDE_1, () => resolveBoundSessionId(tempDir))).toBe(tabSession);

    // Adoption bound the provider key: a NEW tab session does not move Claude.
    const newer = await start(TAB, 'human-tab-2');
    expect(newer).not.toBe(tabSession);
    expect(await inTerminal(CLAUDE_1, () => resolveBoundSessionId(tempDir))).toBe(tabSession);

    const ended = await inTerminal(CLAUDE_1, () => sessionEnd(tempDir));
    expect(ended.success).toBe(true);
    expect(ended.data?.sessionId).toBe(tabSession);
  });

  it('a restarted Claude (new provider id) still reaches the tab session via the tab', async () => {
    const tabSession = await start(TAB, 'human-tab');
    // First Claude adopts it…
    expect(await inTerminal(CLAUDE_1, () => resolveBoundSessionId(tempDir))).toBe(tabSession);
    // …then exits; the restarted instance has a new CLAUDE_CODE_SESSION_ID.
    expect(await inTerminal(CLAUDE_2, () => resolveBoundSessionId(tempDir))).toBe(tabSession);
  });

  it('a Claude-started session is ended by that Claude and is visible from the plain tab', async () => {
    const mine = await start(CLAUDE_1, 'claude-own');
    expect(await inTerminal(TAB, () => resolveBoundSessionId(tempDir))).toBe(mine);
    const ended = await inTerminal(CLAUDE_1, () => sessionEnd(tempDir));
    expect(ended.data?.sessionId).toBe(mine);
  });

  it('a Claude that starts its own session is not captured by the tab session', async () => {
    const tabSession = await start(TAB, 'human-tab');
    const mine = await start(CLAUDE_1, 'claude-own');
    expect(mine).not.toBe(tabSession);
    expect(await inTerminal(CLAUDE_1, () => resolveBoundSessionId(tempDir))).toBe(mine);
    // A second Claude in the tab does not adopt the first Claude's session.
    expect(await inTerminal(CLAUDE_2, () => resolveBoundSessionId(tempDir))).toBeNull();
  });

  it('SDK endSession from an unbound terminal throws SESSION_UNBOUND and ends nobody', async () => {
    const one = await inTerminal(CLAUDE_1, () =>
      startSession(tempDir, { name: 'sdk-one', scope: 'global' }),
    );
    const err = await inTerminal(CLAUDE_2, () =>
      endSession(tempDir, {}).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect((err as CleoError).code).toBe(ExitCode.SESSION_UNBOUND);
    expect((await getSession(one.id, tempDir))?.status).toBe('active');
    // The starting terminal ends its own session through the SDK.
    const ended = await inTerminal(CLAUDE_1, () => endSession(tempDir, {}));
    expect(ended.id).toBe(one.id);
  });

  it('a harness env id with no CLEO row still binds the terminal on start', async () => {
    const harness = { ...CLAUDE_1, CLAUDE_SESSION_ID: 'not-a-cleo-session' };
    const id = await start(harness, 'harness');
    const res = await inTerminal(harness, () => sessionEnd(tempDir));
    expect(res.success).toBe(true);
    expect(res.data?.sessionId).toBe(id);
  });

  it('a stale never-ended session does not make unbound calls ambiguous', async () => {
    const id = await start(CLAUDE_1, 'stale');
    expect(await hasActiveSession(tempDir)).toBe(true);
    const later = Date.now() + SESSION_LIVE_TTL_MS + 60_000;
    expect(await hasActiveSession(tempDir, later)).toBe(false);
    expect((await getSession(id, tempDir))?.status).toBe('active');
  });
});

describe('spawn session allocation (T12500)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    clearIdentityEnv();
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-spawn-session-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
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

  it('allocates the child its own explicit session, not the orchestrator’s', async () => {
    const orchestrator = await inTerminal(TERMINAL_A, async () => {
      const res = await sessionStart(tempDir, { scope: 'global', name: 'orchestrator' });
      expect(res.success).toBe(true);
      return res.data!.id;
    });

    const spawned = await inTerminal({ ...TERMINAL_A, CLEO_SESSION_ID: orchestrator }, () =>
      requireSpawnSession(tempDir, 'T4242'),
    );

    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.identity.sessionId).not.toBe(orchestrator);
    const child = await getSession(spawned.identity.sessionId, tempDir);
    expect(child?.status).toBe('active');
    expect(child?.agentHandle).toBe('agent-t4242');
  });

  it('refuses with the REAL allocation error instead of inheriting when allocation fails', async () => {
    const orchestrator = await inTerminal(TERMINAL_A, async () => {
      const res = await sessionStart(tempDir, { scope: 'global', name: 'orchestrator' });
      return res.data!.id;
    });

    const spawned = await inTerminal(TERMINAL_A, () =>
      requireSpawnSession(tempDir, 'T4243', async () => {
        throw new Error('store locked');
      }),
    );

    expect(spawned.ok).toBe(false);
    if (spawned.ok) return;
    // A store failure is reported as itself, never relabelled E_SESSION_UNBOUND.
    expect(spawned.code).toBe('E_INTERNAL');
    expect(spawned.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(spawned.cause).toBe('store locked');
    expect(JSON.stringify(spawned)).not.toContain(orchestrator);
  });

  it('keeps a CleoError allocation failure’s own catalog code', async () => {
    const spawned = await requireSpawnSession(tempDir, 'T4244', async () => {
      throw new CleoError(ExitCode.LOCK_TIMEOUT, 'lock held');
    });
    expect(spawned.ok).toBe(false);
    if (spawned.ok) return;
    expect(spawned.code).not.toBe('E_SESSION_UNBOUND');
    expect(spawned.exitCode).toBe(ExitCode.LOCK_TIMEOUT);
  });
});
