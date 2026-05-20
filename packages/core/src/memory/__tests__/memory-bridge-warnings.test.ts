/**
 * Tests for T9771 — memory bridge stderr → LAFS meta.warnings migration.
 *
 * Verifies that bridge failures inside an active `withWarningCollector`
 * scope land in the collector as `W_BRIDGE_WRITE_FAILED` /
 * `W_BRIDGE_REFRESH_FAILED` warnings, and that NO output is emitted to
 * stdout or stderr.
 *
 * @task T9771
 * @epic T9763 (JSON-stream hygiene)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

/** Set up a project root with `.cleo/config.json` for mode=file, with the
 *  bridge file path BLOCKED by a directory so writeFileSync throws EISDIR. */
function setupBlockedProject(): { projectRoot: string; cleoDir: string } {
  const projectRoot = tempDir;
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({ brain: { memoryBridge: { mode: 'file' } } }),
    'utf-8',
  );
  // Block: place a directory where the bridge file should be written.
  mkdirSync(join(cleoDir, 'memory-bridge.md'));
  return { projectRoot, cleoDir };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-bridge-warn-'));
});

afterEach(async () => {
  try {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
  } catch {
    /* may not be loaded */
  }
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('T9771 — memory-bridge warnings → meta.warnings', () => {
  it('writeMemoryBridge: write failure pushes W_BRIDGE_WRITE_FAILED with zero stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { projectRoot } = setupBlockedProject();

    const collector = new WarningCollector();
    const { writeMemoryBridge } = await import('../memory-bridge.js');

    const result = await withWarningCollector(collector, async () =>
      writeMemoryBridge(projectRoot),
    );

    expect(result.written).toBe(false);

    const drained = collector.drain();
    expect(drained).toBeDefined();
    const warning = drained!.find((w) => w.code === 'W_BRIDGE_WRITE_FAILED');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warn');
    expect(warning!.context?.['bridge']).toBe('memory');
    expect(typeof warning!.context?.['error']).toBe('string');

    // Filter Node's own ExperimentalWarning chatter (SQLite preview) — it is
    // environmental and unrelated to bridge stderr discipline.
    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('refreshMemoryBridge: success path emits NO warnings (mode=cli)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // No .cleo/config.json — default mode is 'cli' which short-circuits the
    // write and the refresh succeeds with no work.
    const collector = new WarningCollector();
    const { refreshMemoryBridge } = await import('../memory-bridge.js');

    await withWarningCollector(collector, async () => {
      await refreshMemoryBridge(tempDir);
    });

    const drained = collector.drain();
    // No warnings expected — drain returns undefined.
    expect(drained).toBeUndefined();
    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('refreshMemoryBridge: write failure (mode=file, blocked path) does NOT touch stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { projectRoot } = setupBlockedProject();

    const collector = new WarningCollector();
    const { refreshMemoryBridge } = await import('../memory-bridge.js');

    await withWarningCollector(collector, async () => {
      await refreshMemoryBridge(projectRoot);
    });

    // The inner writeMemoryBridge will fail and emit W_BRIDGE_WRITE_FAILED.
    // refreshMemoryBridge itself does NOT catch (writeMemoryBridge already
    // swallows the throw) — but the key property is: zero stderr writes.
    const drained = collector.drain();
    expect(drained).toBeDefined();
    expect(drained!.some((w) => w.code === 'W_BRIDGE_WRITE_FAILED')).toBe(true);

    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('pushWarning outside a withWarningCollector scope is a silent no-op', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { projectRoot } = setupBlockedProject();
    const { writeMemoryBridge } = await import('../memory-bridge.js');

    // No withWarningCollector wrapper — the catch path should still run but
    // produce nothing on any sink (pushWarning silently no-ops when the ALS
    // store is empty).
    const result = await writeMemoryBridge(projectRoot);
    expect(result.written).toBe(false);

    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
