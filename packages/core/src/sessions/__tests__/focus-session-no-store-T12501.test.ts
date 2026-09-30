/**
 * A focus READ never creates the project store (T12501 review of #1749).
 *
 * `resolveFocusSessionId` → `resolveBoundSession` used to open the project
 * store to look for a binding, and opening it runs `mkdir <root>/.cleo`. On a
 * fresh or foreign directory that created a store as a side effect of a read,
 * and where the caller may not write (a read-only parent, a Linux runner's `/`)
 * it failed with EACCES instead of reporting "unbound". With no `cleo.db`
 * there is no session row to bind, so the caller is unbound — before anything
 * is opened.
 *
 * @task T12501
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBoundSession } from '../../store/session-store.js';
import { resolveFocusSessionId } from '../focus-state-store.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let base: string;

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_SESSION_ID', 'ses_20260930000000_c0c0c0');
  base = await mkdtemp(join(tmpdir(), 'cleo-t12501-nostore-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await chmod(base, 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

describe('focus reads without a project store (T12501)', () => {
  it('returns null and does not create <cwd>/.cleo', async () => {
    const project = join(base, 'fresh');
    await mkdir(project);
    expect(await resolveFocusSessionId(project)).toBeNull();
    expect(await resolveBoundSession(project)).toBeNull();
    expect(existsSync(join(project, '.cleo'))).toBe(false);
  });

  it.skipIf(isRoot || process.platform === 'win32')(
    'returns null (not EACCES) when <cwd>/.cleo cannot be created',
    async () => {
      const project = join(base, 'readonly');
      await mkdir(project);
      await chmod(project, 0o555); // mkdir <project>/.cleo would fail with EACCES
      expect(await resolveFocusSessionId(project)).toBeNull();
      expect(existsSync(join(project, '.cleo'))).toBe(false);
    },
  );
});
