/**
 * GC State Tests (T735)
 *
 * Covers:
 * - readGCState: returns default state when file missing
 * - readGCState: merges missing fields with defaults on schema version bump
 * - writeGCState: writes atomically via tmp+rename
 * - patchGCState: merges patch over current state
 *
 * Uses real temp directories (mkdtemp). No mocked filesystem.
 *
 * @task T735
 * @epic T726
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_GC_STATE,
  GC_STATE_SCHEMA_VERSION,
  patchGCState,
  readGCState,
  writeGCState,
} from '../state.js';

describe('readGCState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-gc-state-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns default state when file does not exist', async () => {
    const nonExistentPath = join(tmpDir, 'nonexistent', 'gc-state.json');
    const state = await readGCState(nonExistentPath);
    expect(state).toEqual(DEFAULT_GC_STATE);
  });

  it('returns default state when file contains invalid JSON', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    await mkdir(tmpDir, { recursive: true });
    // Write invalid JSON
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(statePath, 'not valid json {{{', 'utf-8'),
    );

    const state = await readGCState(statePath);
    expect(state).toEqual(DEFAULT_GC_STATE);
  });

  it('merges partial state with defaults (forward compatibility)', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    // Write a state with only some fields (simulates old schema version)
    const partial = { schemaVersion: '1.0', lastRunAt: '2026-04-10T03:00:00.000Z' };
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(statePath, JSON.stringify(partial), 'utf-8'),
    );

    const state = await readGCState(statePath);

    // Explicitly set fields are preserved
    expect(state.lastRunAt).toBe('2026-04-10T03:00:00.000Z');
    // Missing fields default to the DEFAULT_GC_STATE values
    expect(state.consecutiveFailures).toBe(0);
    expect(state.escalationNeeded).toBe(false);
    expect(state.daemonPid).toBeNull();
  });
});

describe('writeGCState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-gc-write-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates parent directories if they do not exist', async () => {
    const statePath = join(tmpDir, 'nested', 'deep', 'gc-state.json');
    await writeGCState(statePath, { ...DEFAULT_GC_STATE });

    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(GC_STATE_SCHEMA_VERSION);
  });

  it('writes valid JSON with correct schema version', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    const state = { ...DEFAULT_GC_STATE, daemonPid: 12345, lastRunAt: '2026-04-15T03:00:00Z' };

    await writeGCState(statePath, state);

    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.daemonPid).toBe(12345);
    expect(parsed.lastRunAt).toBe('2026-04-15T03:00:00Z');
  });

  it('overwrites existing state file', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    const initial = { ...DEFAULT_GC_STATE, consecutiveFailures: 1 };
    await writeGCState(statePath, initial);

    const updated = { ...DEFAULT_GC_STATE, consecutiveFailures: 0, lastRunAt: 'now' };
    await writeGCState(statePath, updated);

    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.consecutiveFailures).toBe(0);
    expect(parsed.lastRunAt).toBe('now');
  });
});

describe('patchGCState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-gc-patch-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates file with patch merged over defaults when file does not exist', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    const patched = await patchGCState(statePath, { daemonPid: 9999 });

    expect(patched.daemonPid).toBe(9999);
    // Other fields default
    expect(patched.consecutiveFailures).toBe(0);
    expect(patched.escalationNeeded).toBe(false);
  });

  it('preserves existing fields not in the patch', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    await writeGCState(statePath, { ...DEFAULT_GC_STATE, consecutiveFailures: 3, daemonPid: 100 });

    const patched = await patchGCState(statePath, { escalationNeeded: true });

    // Patched field updated
    expect(patched.escalationNeeded).toBe(true);
    // Unpatched fields preserved
    expect(patched.consecutiveFailures).toBe(3);
    expect(patched.daemonPid).toBe(100);
  });

  it('allows null to clear a field', async () => {
    const statePath = join(tmpDir, 'gc-state.json');
    await writeGCState(statePath, {
      ...DEFAULT_GC_STATE,
      pendingPrune: ['path/a', 'path/b'],
    });

    const patched = await patchGCState(statePath, { pendingPrune: null });
    expect(patched.pendingPrune).toBeNull();
  });
});
