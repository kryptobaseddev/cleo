/**
 * Unit tests for detectAndRemoveLegacyGlobalFiles() and
 * detectAndRemoveStrayProjectNexus().
 *
 * All filesystem interactions occur inside a fresh tmp directory per test.
 * The `cleoHomeOverride` / `projectRoot` parameters are used instead of
 * mocking `getCleoHome()` to keep tests hermetic and avoid global module
 * state side-effects.
 *
 * @task T304
 * @task T307
 * @epic T299
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectAndRemoveLegacyGlobalFiles,
  detectAndRemoveStrayProjectNexus,
} from '../cleanup-legacy.js';

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

// ---------------------------------------------------------------------------
// detectAndRemoveStrayProjectNexus (T307)
// ---------------------------------------------------------------------------

describe('detectAndRemoveStrayProjectNexus', () => {
  let tmpProjectRoot: string;

  beforeEach(() => {
    // Create a fake project root with a .cleo sub-directory
    tmpProjectRoot = mkdtempSync(join(tmpdir(), 'cleo-stray-nexus-test-'));
    mkdirSync(join(tmpProjectRoot, '.cleo'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpProjectRoot, { recursive: true, force: true });
  });

  it('removes the stray nexus.db when it is present', () => {
    const strayPath = join(tmpProjectRoot, '.cleo', 'nexus.db');
    writeFileSync(strayPath, ''); // zero-byte stray (mirrors the real incident)

    expect(existsSync(strayPath)).toBe(true);

    const result = detectAndRemoveStrayProjectNexus(tmpProjectRoot);

    expect(result.removed).toBe(true);
    expect(result.path).toBe(strayPath);
    expect(existsSync(strayPath)).toBe(false);
  });

  it('is a no-op when no stray nexus.db is present', () => {
    const strayPath = join(tmpProjectRoot, '.cleo', 'nexus.db');

    // Sanity: file does not exist
    expect(existsSync(strayPath)).toBe(false);

    const result = detectAndRemoveStrayProjectNexus(tmpProjectRoot);

    expect(result.removed).toBe(false);
    expect(result.path).toBe(strayPath);
    // Still does not exist
    expect(existsSync(strayPath)).toBe(false);
  });

  it('is idempotent: second call is a no-op after first removed the file', () => {
    const strayPath = join(tmpProjectRoot, '.cleo', 'nexus.db');
    writeFileSync(strayPath, '');

    const first = detectAndRemoveStrayProjectNexus(tmpProjectRoot);
    expect(first.removed).toBe(true);

    const second = detectAndRemoveStrayProjectNexus(tmpProjectRoot);
    expect(second.removed).toBe(false);
    expect(second.path).toBe(strayPath);
  });

  it('does not remove other .cleo files when removing the stray', () => {
    const strayPath = join(tmpProjectRoot, '.cleo', 'nexus.db');
    const tasksPath = join(tmpProjectRoot, '.cleo', 'tasks.db');
    const configPath = join(tmpProjectRoot, '.cleo', 'config.json');

    writeFileSync(strayPath, '');
    writeFileSync(tasksPath, 'placeholder');
    writeFileSync(configPath, '{}');

    detectAndRemoveStrayProjectNexus(tmpProjectRoot);

    expect(existsSync(strayPath)).toBe(false);
    // Sibling live files must be untouched
    expect(existsSync(tasksPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });

  it('returns removed: false when the stray exists as a directory (non-fatal)', () => {
    // Create a directory named nexus.db to simulate an unlinkSync EISDIR failure
    const strayPath = join(tmpProjectRoot, '.cleo', 'nexus.db');
    mkdirSync(strayPath);

    const result = detectAndRemoveStrayProjectNexus(tmpProjectRoot);

    // Cannot unlink a directory — should return removed: false without throwing
    expect(result.removed).toBe(false);
    expect(result.path).toBe(strayPath);
    // The directory is still there (we didn't rmdir)
    expect(existsSync(strayPath)).toBe(true);
  });
});
