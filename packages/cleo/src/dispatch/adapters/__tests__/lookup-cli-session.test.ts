/**
 * `lookupCliSession` identity rules (T12499 · epic T12497).
 *
 * The CLI used to return `CLEO_SESSION_ID` verbatim, so a stale or mistyped id
 * was stamped onto every request as a phantom identity. It now shares core's
 * `resolveCurrentSessionId` precedence: an env id is honoured only when its
 * session row exists.
 *
 * @task T12499
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The domain-handler graph is irrelevant to session lookup and pulls in
// packages that need a build; the real core session store stays unmocked.
vi.mock('../../domains/index.js', () => ({ createDomainHandlers: () => new Map() }));

import { lookupCliSession } from '../cli.js';

/** Identity env vars that could leak in from the terminal running the suite. */
const IDENTITY_ENV_VARS = [
  'CLEO_SESSION_ID',
  'CLEO_SESSION',
  'CLAUDE_SESSION_ID',
  'AIDER_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'GEMINI_SESSION_ID',
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ_PANE_ID',
  'WEZTERM_PANE',
  'WT_SESSION',
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'KITTY_WINDOW_ID',
  'GNOME_TERMINAL_SCREEN',
  'KONSOLE_DBUS_SESSION',
];

describe('lookupCliSession (T12499)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-lookup-cli-session-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({ enforcement: { session: { requiredForMutate: false } } }),
    );
    for (const name of IDENTITY_ENV_VARS) vi.stubEnv(name, undefined);
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', cleoDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      const { closeAllDatabases } = await import('@cleocode/core/internal');
      await closeAllDatabases();
    } catch {
      /* ignore */
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects an env session id that has no session row', async () => {
    vi.stubEnv('CLEO_SESSION_ID', 'ses_20990101000000_ffffff');
    expect(await lookupCliSession()).toBeNull();
  });

  it('honours an env session id whose row exists', async () => {
    const id = 'ses_20260927000000_abcdef';
    await createSession(
      {
        id,
        name: 'lookup-fixture',
        status: 'active',
        scope: { type: 'global' },
        taskWork: { taskId: null, setAt: null },
        startedAt: new Date().toISOString(),
      },
      tempDir,
    );
    vi.stubEnv('CLEO_SESSION_ID', id);
    expect(await lookupCliSession()).toBe(id);
  });
});
