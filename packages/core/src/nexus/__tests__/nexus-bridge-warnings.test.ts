/**
 * Tests for T9771 — nexus bridge stderr → LAFS meta.warnings migration.
 *
 * Verifies that nexus bridge write failures inside an active
 * `withWarningCollector` scope land in the collector as
 * `W_NEXUS_BRIDGE_FAILED`, with zero stdout/stderr noise.
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

/** Set up a project root with mode=file config and a directory blocking the
 *  bridge file path so writeFileSync throws EISDIR. */
function setupBlockedProject(): string {
  const projectRoot = tempDir;
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({ brain: { memoryBridge: { mode: 'file' } } }),
    'utf-8',
  );
  // Block: place a directory where the bridge file should be written.
  mkdirSync(join(cleoDir, 'nexus-bridge.md'));
  return projectRoot;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-nexus-bridge-warn-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('T9771 — nexus-bridge warnings → meta.warnings', () => {
  it('writeNexusBridge: failure pushes W_NEXUS_BRIDGE_FAILED with zero stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const projectRoot = setupBlockedProject();

    const collector = new WarningCollector();
    const { writeNexusBridge } = await import('../nexus-bridge.js');

    const result = await withWarningCollector(collector, async () => writeNexusBridge(projectRoot));

    expect(result.written).toBe(false);

    const drained = collector.drain();
    expect(drained).toBeDefined();
    const warning = drained!.find((w) => w.code === 'W_NEXUS_BRIDGE_FAILED');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warn');
    expect(warning!.context?.['bridge']).toBe('nexus');
    expect(typeof warning!.context?.['error']).toBe('string');

    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('refreshNexusBridge: success path emits NO warnings (mode=cli)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // No config → mode=cli → write short-circuits.
    const collector = new WarningCollector();
    const { refreshNexusBridge } = await import('../nexus-bridge.js');

    await withWarningCollector(collector, async () => {
      await refreshNexusBridge(tempDir);
    });

    const drained = collector.drain();
    expect(drained).toBeUndefined();
    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('pushWarning outside withWarningCollector remains silent (no stderr)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const projectRoot = setupBlockedProject();
    const { writeNexusBridge } = await import('../nexus-bridge.js');

    const result = await writeNexusBridge(projectRoot);
    expect(result.written).toBe(false);

    expect(bridgeStderrCalls(stderrSpy)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
