/**
 * Tests for session enforcement (gh#1194 / T12106).
 *
 * Covers the verify/complete session asymmetry reported in gh#1194:
 * - `requireActiveSession` (strict mode) throws E_CLEO_SESSION_REQUIRED whose
 *   `fix` names the exact remedy (`cleo session start`) and — for
 *   `tasks.complete` — states that gates already recorded via `cleo verify`
 *   are preserved and do NOT need re-verification.
 * - `warnIfNoActiveSession` emits a loud NON-fatal W_NO_ACTIVE_SESSION warning
 *   (envelope meta.warnings channel) for session-free writes under strict
 *   enforcement, and stays silent when a session is active.
 *
 * These tests NEED strict enforcement active — `getEnforcementMode`
 * short-circuits to 'none' while `process.env.VITEST` is set, so it is
 * temporarily cleared (same pattern as tasks/__tests__/epic-enforcement.test.ts).
 *
 * @task T12106
 * @gh 1194
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleoError } from '../../errors.js';
import { drainWarnings } from '../../output.js';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { completeTask } from '../../tasks/complete.js';
import { startSession } from '../index.js';
import { requireActiveSession, warnIfNoActiveSession } from '../session-enforcement.js';

const savedVitest = process.env.VITEST;
beforeAll(() => {
  delete process.env.VITEST;
});
afterAll(() => {
  if (savedVitest) process.env.VITEST = savedVitest;
});

/** Absolute project root for each test — recreated per test. */
let TEST_ROOT: string;

beforeEach(async () => {
  // Resolve each explicitly supplied fixture root, including independent projects.
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  drainWarnings();
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-session-enforcement-'));
  await mkdir(join(TEST_ROOT, '.cleo'), { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetDbState();
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe('requireActiveSession — E_CLEO_SESSION_REQUIRED remedy text (gh#1194)', () => {
  it('throws SESSION_REQUIRED naming cleo session start as the remedy', async () => {
    const err = await requireActiveSession('tasks.complete', TEST_ROOT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CleoError);
    const cleoErr = err as CleoError;
    expect(cleoErr.code).toBe(ExitCode.SESSION_REQUIRED);
    expect(cleoErr.message).toContain("Operation 'tasks.complete' requires an active session");
    expect(cleoErr.fix).toContain('cleo session start');
  });

  it('appends the operation-specific remedy note to the fix text', async () => {
    const note =
      'Verification gates already recorded via cleo verify are preserved — do NOT re-verify them.';
    const err = await requireActiveSession('tasks.complete', TEST_ROOT, note).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CleoError);
    const cleoErr = err as CleoError;
    expect(cleoErr.code).toBe(ExitCode.SESSION_REQUIRED);
    expect(cleoErr.fix).toContain('cleo session start');
    expect(cleoErr.fix).toContain(note);
  });

  it('does not throw when a session is active', async () => {
    await startSession(TEST_ROOT, { name: 'Active work', scope: 'global' });
    resetDbState();
    const result = await requireActiveSession('tasks.complete', TEST_ROOT);
    expect(result.allowed).toBe(true);
    expect(result.session).not.toBeNull();
  });
});

describe('completeTask — session guard names remedy, gates preserved (gh#1194)', () => {
  it('rejects with SESSION_REQUIRED whose fix says gates are preserved, re-run complete', async () => {
    const accessor = await createSqliteDataAccessor(TEST_ROOT);
    await seedTasks(accessor, [
      {
        id: 'T300',
        title: 'Task completed without a session',
        type: 'task',
        status: 'active',
        priority: 'medium',
      },
    ]);
    await accessor.close();
    resetDbState();

    const err = await completeTask({ taskId: 'T300' }, TEST_ROOT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CleoError);
    const cleoErr = err as CleoError;
    expect(cleoErr.code).toBe(ExitCode.SESSION_REQUIRED);
    // The recovery must be obvious: start a session, re-run complete.
    expect(cleoErr.fix).toContain('cleo session start');
    // And it must be clear this is NOT an evidence problem: recorded gates
    // survive and do not need re-verification.
    expect(cleoErr.fix).toContain('preserved');
    expect(cleoErr.fix).toContain('do NOT re-verify');
    expect(cleoErr.fix).toContain('re-run this cleo complete command');
  });
});

describe('warnIfNoActiveSession — loud non-fatal warning (gh#1194)', () => {
  it('returns true and pushes W_NO_ACTIVE_SESSION when no session is active', async () => {
    const warned = await warnIfNoActiveSession('check.gate.set', TEST_ROOT);
    expect(warned).toBe(true);

    const warnings = drainWarnings() ?? [];
    const hit = warnings.find((w) => w.code === 'W_NO_ACTIVE_SESSION');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('check.gate.set');
    expect(hit?.message).toContain('E_CLEO_SESSION_REQUIRED');
    expect(hit?.message).toContain('cleo session start');
    expect(hit?.message).toContain('preserved');
  });

  it('returns false and pushes nothing when a session is active', async () => {
    await startSession(TEST_ROOT, { name: 'Active work', scope: 'global' });
    resetDbState();
    drainWarnings();

    const warned = await warnIfNoActiveSession('check.gate.set', TEST_ROOT);
    expect(warned).toBe(false);

    const warnings = drainWarnings() ?? [];
    expect(warnings.find((w) => w.code === 'W_NO_ACTIVE_SESSION')).toBeUndefined();
  });
});
