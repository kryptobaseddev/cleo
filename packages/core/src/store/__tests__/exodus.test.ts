/**
 * Unit tests for the exodus migration subsystem.
 *
 * Tests the plan builder, status reporter, and type structure without opening
 * any real DBs (relies on tmp dirs so no live data is touched).
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveStagingDirName, sourcesPresent } from '../exodus/plan.js';
import { runExodusStatus } from '../exodus/status.js';
import type { ExodusPlan, LegacyDbDescriptor } from '../exodus/types.js';
import { EXODUS_TARGET_SCHEMA_VERSION } from '../exodus/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-exodus-test-'));
}

// ---------------------------------------------------------------------------
// deriveStagingDirName
// ---------------------------------------------------------------------------

describe('deriveStagingDirName', () => {
  it('returns a string starting with exodus-staging-', () => {
    const name = deriveStagingDirName();
    expect(name).toMatch(/^exodus-staging-/);
  });

  it('does not contain colons (shell-safe)', () => {
    const name = deriveStagingDirName();
    expect(name).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// sourcesPresent
// ---------------------------------------------------------------------------

describe('sourcesPresent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no source files exist', () => {
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: join(tmpDir, 'tasks.db'), targetScope: 'project' },
      { name: 'brain', path: join(tmpDir, 'brain.db'), targetScope: 'project' },
    ];
    expect(sourcesPresent(sources)).toBe(false);
  });

  it('returns true when at least one source file exists', () => {
    const dbPath = join(tmpDir, 'tasks.db');
    writeFileSync(dbPath, ''); // zero-byte file is enough for existence check
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: dbPath, targetScope: 'project' },
      { name: 'brain', path: join(tmpDir, 'brain.db'), targetScope: 'project' },
    ];
    expect(sourcesPresent(sources)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EXODUS_TARGET_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('EXODUS_TARGET_SCHEMA_VERSION', () => {
  it('is a non-empty string containing the expected epoch', () => {
    expect(typeof EXODUS_TARGET_SCHEMA_VERSION).toBe('string');
    expect(EXODUS_TARGET_SCHEMA_VERSION.length).toBeGreaterThan(0);
    expect(EXODUS_TARGET_SCHEMA_VERSION).toContain('drizzle-v1.0.0-rc.3');
  });
});

// ---------------------------------------------------------------------------
// runExodusStatus — pure filesystem reads, no DB required
// ---------------------------------------------------------------------------

describe('runExodusStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    // Simulate a minimal .cleo/ layout
    mkdirSync(join(tmpDir, '.cleo'));
    // Create a fake project-info.json so resolveCleoDir succeeds
    writeFileSync(
      join(tmpDir, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'test-exodus', projectRoot: tmpDir }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no staging and no target DBs for a fresh project', () => {
    // Point status at our tmp dir
    const result = runExodusStatus(tmpDir);

    expect(result.hasStaging).toBe(false);
    expect(result.stagingDir).toBeNull();
    expect(result.journal).toBeNull();
    expect(result.projectDbExists).toBe(false);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('detects a staging directory when one exists', () => {
    const stagingName = `exodus-staging-20260101T000000Z`;
    mkdirSync(join(tmpDir, '.cleo', stagingName));

    const result = runExodusStatus(tmpDir);

    expect(result.hasStaging).toBe(true);
    expect(result.stagingDir).toContain(stagingName);
  });

  it('reads a journal from an existing staging dir', () => {
    const stagingName = `exodus-staging-20260101T000000Z`;
    const stagingDir = join(tmpDir, '.cleo', stagingName);
    mkdirSync(stagingDir);

    const journal = {
      version: 1 as const,
      cleoVersion: '2026.5.0',
      targetSchemaVersion: EXODUS_TARGET_SCHEMA_VERSION,
      nodeVersion: process.version,
      sqliteVersion: '3.53.0',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tables: [],
    };
    writeFileSync(join(stagingDir, 'exodus-journal.json'), JSON.stringify(journal));

    const result = runExodusStatus(tmpDir);

    expect(result.journal).not.toBeNull();
    expect(result.journal?.version).toBe(1);
    expect(result.journal?.cleoVersion).toBe('2026.5.0');
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke test — ExodusPlan shape
// ---------------------------------------------------------------------------

describe('ExodusPlan type shape', () => {
  it('satisfies the required fields', () => {
    // Just ensure the type compiles with a minimal shape — no runtime assertion needed
    const plan: ExodusPlan = {
      sources: [],
      totalSourceBytes: 0,
      availableBytes: 1_000_000,
      diskPreflight: true,
      stagingDir: '/tmp/exodus-staging-20260101T000000Z',
      resumeFromStaging: false,
      projectDbPath: '/tmp/proj/.cleo/cleo.db',
      globalDbPath: '/home/user/.local/share/cleo/cleo.db',
    };
    expect(plan.diskPreflight).toBe(true);
    expect(plan.sources).toHaveLength(0);
  });
});
