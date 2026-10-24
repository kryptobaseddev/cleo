/**
 * T13962 (T13913 regression): a real bound session in a real store stays
 * active across two `cleo hook stop` runs, and the next mutation's session
 * gate passes without `cleo session resume`.
 *
 * @task T13962
 * @task T13913
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// session start refreshes GLOBAL provider instruction files; never touch the
// developer's real files from a test.
vi.mock('@cleocode/core/injection.js', () => ({
  refreshStaleGlobalInstructions: vi.fn().mockResolvedValue({
    status: 'skipped',
    stale: [],
    duplicates: [],
    updated: [],
  }),
}));

import { sessionStart } from '@cleocode/core/session/engine-ops.js';
import { SESSION_ENV_KEY_PRECEDENCE } from '@cleocode/core/sessions/session-id.js';
import { TERMINAL_KEY_SOURCES } from '@cleocode/core/sessions/terminal-identity.js';
import { getSession, requireBoundSession } from '@cleocode/core/store/session-store.js';
import { addTask } from '@cleocode/core/tasks/add.js';
import { type HookIo, runHookCli } from '../hook-entry.js';

/** Every env var the session resolvers read, cleared so the host terminal cannot leak in. */
const IDENTITY_ENV_VARS: readonly string[] = [
  ...SESSION_ENV_KEY_PRECEDENCE,
  ...TERMINAL_KEY_SOURCES.flatMap((s) =>
    s.qualifierEnvVar ? [s.envVar, s.qualifierEnvVar] : [s.envVar],
  ),
];

const TERMINAL = { CLAUDE_CODE_SESSION_ID: 'claude-t13962' };

describe('a turn end keeps the bound session (T13962)', () => {
  let project: string;
  let home: string;

  beforeEach(async () => {
    for (const name of IDENTITY_ENV_VARS) vi.stubEnv(name, undefined);
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    project = await mkdtemp(join(tmpdir(), 'cleo-t13962-'));
    home = await mkdtemp(join(tmpdir(), 'cleo-t13962-home-'));
    vi.stubEnv('CLEO_HOME', home);
    vi.stubEnv('HOME', home);
    await mkdir(join(project, '.cleo', 'backups', 'operational'), { recursive: true });
    await writeFile(
      join(project, '.cleo', 'config.json'),
      JSON.stringify({ lifecycle: { mode: 'off' }, verification: { enabled: false } }),
    );
    for (const [name, value] of Object.entries(TERMINAL)) vi.stubEnv(name, value);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      const { closeAllDatabases } = await import('@cleocode/core/store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* ignore */
    }
    await rm(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  it('two Stops leave the session active and the mutation gate passes without resume', async () => {
    const started = await sessionStart(project, {
      scope: 'global',
      name: 't13962',
      agentHandle: 't13962',
    });
    expect(started.success).toBe(true);
    const id = started.data?.id ?? '';

    const io: HookIo = {
      readStdin: async () => JSON.stringify({ session_id: 'claude-t13962', cwd: project }),
      writeStdout: () => {},
      writeStderr: () => {},
      env: { ...TERMINAL, CLEO_GOAL_TICK: 'off', CLEO_ASK_ENFORCE: 'off' },
      cwd: project,
    };
    expect(await runHookCli(['stop', '--provider', 'claude-code'], io)).toBe(0);
    expect(await runHookCli(['stop', '--provider', 'claude-code'], io)).toBe(0);

    expect((await getSession(id, project))?.status).toBe('active');
    // The gate every mutation goes through still finds this terminal's session,
    // and a real mutation succeeds without `cleo session resume`.
    expect((await requireBoundSession('test', project))?.id).toBe(id);
    const added = await addTask(
      {
        // A fresh project's first task must be a root saga (T11811).
        type: 'saga',
        title: 'Saga created after two turn ends',
        description: 'Proves the bound session survived two Stop hooks (T13962).',
        acceptance: [
          'AC1: created without a session resume',
          'AC2: the session is still active',
          'AC3: the terminal binding still resolves',
        ],
      },
      project,
    );
    expect(added.task.id).toMatch(/^T\d+$/);
  });
});
