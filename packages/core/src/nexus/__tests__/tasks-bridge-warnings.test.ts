/**
 * Tests for T9771 — tasks-bridge stderr → LAFS meta.warnings migration.
 *
 * Verifies that task-symbol bridge failures surface as
 * `W_TASKS_BRIDGE_FAILED` warnings in the active `WarningCollector` and
 * never touch stdout/stderr.
 *
 * @task T9771
 * @epic T9763 (JSON-stream hygiene)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

let tempDir: string;

/**
 * Extract calls from a stderr spy that originate from CLEO bridge code,
 * filtering out unrelated Node-level chatter (e.g. the SQLite
 * `ExperimentalWarning` that Node emits unconditionally on first import).
 */
function bridgeStderrCalls(spy: MockInstance<typeof process.stderr.write>): unknown[][] {
  return spy.mock.calls.filter((call) => {
    const first = call[0];
    const text = typeof first === 'string' ? first : '';
    if (text.includes('ExperimentalWarning')) return false;
    if (text.includes('Use `node --trace-warnings')) return false;
    return true;
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-tasks-bridge-warn-'));
  // Isolate brain/nexus state in this temp dir so other tests don't leak.
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
});

afterEach(async () => {
  try {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
  } catch {
    /* may not be loaded */
  }
  try {
    const { closeNexusDb } = await import('../../store/nexus-sqlite.js');
    closeNexusDb();
  } catch {
    /* may not be loaded */
  }
  delete process.env['CLEO_DIR'];
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('T9771 — tasks-bridge warnings → meta.warnings', () => {
  it('runGitLogTaskLinker on a non-git directory pushes W_TASKS_BRIDGE_FAILED with zero stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const collector = new WarningCollector();
    const { runGitLogTaskLinker } = await import('../tasks-bridge.js');

    // tempDir is NOT a git repo → git log fails inside the inner try-catch.
    const result = await withWarningCollector(collector, async () => runGitLogTaskLinker(tempDir));

    // Result is the empty linker payload.
    expect(result.linked).toBe(0);
    expect(result.tasksFound).toBe(0);

    const drained = collector.drain();
    expect(drained).toBeDefined();
    const warning = drained!.find((w) => w.code === 'W_TASKS_BRIDGE_FAILED');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warn');
    expect(warning!.context?.['bridge']).toBe('tasks');
    expect(warning!.context?.['operation']).toBe('runGitLogTaskLinker');

    // Zero noise on every sink (filtering out Node's SQLite experimental
    // banner that lands once-per-process on first DB import).
    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('linkTaskToSymbols with malformed filesJson returns empty result without warnings', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const collector = new WarningCollector();
    const { linkTaskToSymbols } = await import('../tasks-bridge.js');

    // Malformed JSON → files=[] → early return with linked=0 — no warning path.
    const result = await withWarningCollector(collector, async () =>
      linkTaskToSymbols('T0001', '{not-json', tempDir),
    );

    expect(result.linked).toBe(0);
    expect(result.taskId).toBe('T0001');
    // Empty files → no warning fired.
    expect(collector.drain()).toBeUndefined();

    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('runGitLogTaskLinker outside withWarningCollector stays silent on git failure', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { runGitLogTaskLinker } = await import('../tasks-bridge.js');

    // No collector binding — pushWarning is a no-op, but ZERO stderr must be
    // observed regardless.
    const result = await runGitLogTaskLinker(tempDir);
    expect(result.linked).toBe(0);

    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
