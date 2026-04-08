/**
 * Unit tests for detectAndRemoveLegacyGlobalFiles().
 *
 * All filesystem interactions occur inside a fresh tmp directory per test.
 * The `cleoHomeOverride` parameter is used instead of mocking `getCleoHome()`
 * to keep tests hermetic and avoid global module state side-effects.
 *
 * @task T304
 * @epic T299
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectAndRemoveLegacyGlobalFiles } from '../cleanup-legacy.js';

// ---------------------------------------------------------------------------
// Logger mock — prevents pino from trying to open real log files during tests
// ---------------------------------------------------------------------------

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEGACY_NAMES = [
  'workspace.db',
  'workspace.db.bak-pre-rename',
  'workspace.db-shm',
  'workspace.db-shm-wal',
  'nexus-pre-cleo.db.bak',
] as const;

const LIVE_NAMES = ['nexus.db', 'signaldock.db', 'machine-key', 'config.json'] as const;

function createTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-cleanup-test-'));
}

function touchFile(dir: string, name: string): string {
  const fullPath = join(dir, name);
  writeFileSync(fullPath, 'placeholder');
  return fullPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectAndRemoveLegacyGlobalFiles', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = createTmpHome();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('deletes all legacy files when all are present', () => {
    // Create every legacy file
    for (const name of LEGACY_NAMES) {
      touchFile(tmpHome, name);
    }

    const result = detectAndRemoveLegacyGlobalFiles(tmpHome);

    expect(result.errors).toHaveLength(0);
    expect(result.removed).toHaveLength(LEGACY_NAMES.length);

    for (const name of LEGACY_NAMES) {
      expect(result.removed).toContain(name);
      expect(existsSync(join(tmpHome, name))).toBe(false);
    }
  });

  it('is a no-op when no legacy files are present', () => {
    // Empty directory — no legacy files
    const result = detectAndRemoveLegacyGlobalFiles(tmpHome);

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('deletes only the files that exist when a partial set is present', () => {
    const presentFiles = ['workspace.db', 'nexus-pre-cleo.db.bak'] as const;
    const absentFiles = LEGACY_NAMES.filter(
      (n) => !(presentFiles as readonly string[]).includes(n),
    );

    for (const name of presentFiles) {
      touchFile(tmpHome, name);
    }

    const result = detectAndRemoveLegacyGlobalFiles(tmpHome);

    expect(result.errors).toHaveLength(0);
    expect(result.removed).toHaveLength(presentFiles.length);

    for (const name of presentFiles) {
      expect(result.removed).toContain(name);
      expect(existsSync(join(tmpHome, name))).toBe(false);
    }

    for (const name of absentFiles) {
      expect(result.removed).not.toContain(name);
    }
  });

  it('does not touch live DB files or other non-legacy files', () => {
    // Create all legacy files AND all live files
    for (const name of LEGACY_NAMES) {
      touchFile(tmpHome, name);
    }
    for (const name of LIVE_NAMES) {
      touchFile(tmpHome, name);
    }
    // Create an extra unrelated file
    touchFile(tmpHome, 'some-other.txt');

    detectAndRemoveLegacyGlobalFiles(tmpHome);

    // Live files must still exist
    for (const name of LIVE_NAMES) {
      expect(existsSync(join(tmpHome, name))).toBe(true);
    }
    // Extra file must still exist
    expect(existsSync(join(tmpHome, 'some-other.txt'))).toBe(true);
  });

  it('is idempotent: second call returns empty removed array', () => {
    for (const name of LEGACY_NAMES) {
      touchFile(tmpHome, name);
    }

    const first = detectAndRemoveLegacyGlobalFiles(tmpHome);
    expect(first.removed).toHaveLength(LEGACY_NAMES.length);
    expect(first.errors).toHaveLength(0);

    // Second call — files are already gone
    const second = detectAndRemoveLegacyGlobalFiles(tmpHome);
    expect(second.removed).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
  });

  it('captures errors for files that cannot be deleted and continues', () => {
    // Create a directory with the legacy name to simulate an undeletable entry
    // (fs.unlinkSync on a directory throws EISDIR)
    const problemName = 'workspace.db';
    mkdirSync(join(tmpHome, problemName));
    // Also create a normal deletable legacy file
    touchFile(tmpHome, 'nexus-pre-cleo.db.bak');

    const result = detectAndRemoveLegacyGlobalFiles(tmpHome);

    // The directory-disguised file should appear in errors
    const errorFiles = result.errors.map((e) => e.file);
    expect(errorFiles).toContain(problemName);

    // The normal file should still be removed
    expect(result.removed).toContain('nexus-pre-cleo.db.bak');
    expect(existsSync(join(tmpHome, 'nexus-pre-cleo.db.bak'))).toBe(false);
  });
});
