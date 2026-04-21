/**
 * Tests for the Nexus Bridge mode-gate (T999 · T1013).
 *
 * Verifies that `writeNexusBridge` honours `brain.memoryBridge.mode` the same
 * way its sibling `writeMemoryBridge` does:
 *   - `'cli'`  (default): MUST NOT write `.cleo/nexus-bridge.md`
 *   - `'file'` (legacy):  MUST write the file
 *
 * Mirrors the T999 mode-gate block in `memory-bridge.test.ts` so the two
 * bridges stay aligned. The earlier T999 ship only wired the gate in
 * memory-bridge; nexus-bridge silently wrote regardless of mode, which is the
 * drift this test locks down.
 *
 * @task T1013
 */

import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Write a minimal config.json with the given brain.memoryBridge.mode. */
function writeConfigWithMode(cleoDir: string, mode: 'cli' | 'file'): void {
  const configPath = join(cleoDir, 'config.json');
  const config = { brain: { memoryBridge: { mode } } };
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
}

let tempDir: string;
let cleoDir: string;
let cleoHomeDir: string;

describe('Nexus Bridge — mode gate (T1013)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-nexus-bridge-gate-'));
    cleoDir = join(tempDir, '.cleo');
    cleoHomeDir = join(tempDir, '.cleo-home');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(cleoHomeDir, { recursive: true });

    // CLEO_DIR scopes config.json lookup to the test project.
    // CLEO_HOME scopes nexus.db to the test home so we don't touch the real one.
    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_HOME'] = cleoHomeDir;

    // Reset nexus.db singleton so each test gets a fresh DB path.
    const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
    resetNexusDbState();
  });

  afterEach(async () => {
    try {
      const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
      resetNexusDbState();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_HOME'];
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('mode=cli (default, no config.json): writeNexusBridge does NOT write the file', async () => {
    const { writeNexusBridge } = await import('../nexus-bridge.js');

    // No config.json written — default is 'cli' per DEFAULT_CONFIG.
    const result = await writeNexusBridge(tempDir);

    expect(result.written).toBe(false);
    expect(existsSync(join(cleoDir, 'nexus-bridge.md'))).toBe(false);
  });

  it('mode=cli (explicit config): writeNexusBridge does NOT write the file', async () => {
    const { writeNexusBridge } = await import('../nexus-bridge.js');

    writeConfigWithMode(cleoDir, 'cli');

    const result = await writeNexusBridge(tempDir);

    expect(result.written).toBe(false);
    expect(existsSync(join(cleoDir, 'nexus-bridge.md'))).toBe(false);
  });

  it('mode=file: writeNexusBridge DOES write the file', async () => {
    const { writeNexusBridge } = await import('../nexus-bridge.js');

    writeConfigWithMode(cleoDir, 'file');

    const result = await writeNexusBridge(tempDir);

    expect(result.written).toBe(true);
    expect(result.path).toContain('nexus-bridge.md');
    expect(existsSync(result.path)).toBe(true);
  });

  it('mode=cli: refreshNexusBridge does NOT create the bridge file', async () => {
    const { refreshNexusBridge } = await import('../nexus-bridge.js');

    writeConfigWithMode(cleoDir, 'cli');
    await refreshNexusBridge(tempDir);

    expect(existsSync(join(cleoDir, 'nexus-bridge.md'))).toBe(false);
  });

  it('mode=file: refreshNexusBridge creates the bridge file', async () => {
    const { refreshNexusBridge } = await import('../nexus-bridge.js');

    writeConfigWithMode(cleoDir, 'file');
    await refreshNexusBridge(tempDir);

    expect(existsSync(join(cleoDir, 'nexus-bridge.md'))).toBe(true);
  });

  it('config defaults to cli when brain.memoryBridge.mode is absent', async () => {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(tempDir);
    expect(config.brain?.memoryBridge?.mode).toBe('cli');
  });
});
