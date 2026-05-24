/**
 * Unit tests for the nested-nexus disposition (ADR-086 / T10321 / Saga T10281).
 *
 * Two surfaces under test:
 *
 * 1. {@link detectAndWarnOnNestedNexus} in `nexus-sqlite.ts` — non-blocking
 *    runtime warning that fires exactly once per process when the install
 *    carries the nested-nexus structural bug.
 *
 * 2. `scripts/migrate-nested-nexus.mjs` — pure planning + execution helpers
 *    (`plan`, `execute`) exercised through the module's named exports.
 *
 * All filesystem interactions occur inside a fresh `mkdtempSync` directory
 * per test; the `CLEO_HOME` environment variable is overridden to point at
 * that temp directory for hermeticity (mirrors the pattern in
 * `cleanup-legacy.test.ts`).
 *
 * @task T10321
 * @adr ADR-086
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Logger spy — capture warn() calls without printing them
// ---------------------------------------------------------------------------

const warnSpy = vi.fn();

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Subject imports (after vi.mock so logger is intercepted)
// ---------------------------------------------------------------------------

// Import the migration script's pure helpers. The script lives at the repo
// root under `scripts/`; resolved relative to this test file:
// packages/core/src/store/__tests__/  →  ../../../../../scripts/
import {
  ALLOWED_FILES,
  ALLOWED_SUBDIRS,
  execute as migrateExecute,
  plan as migratePlan,
  // eslint-disable-next-line import/extensions -- .mjs is intentional
} from '../../../../../scripts/migrate-nested-nexus.mjs';
import {
  _resetNestedNexusWarningGate,
  detectAndWarnOnNestedNexus,
  getNestedNexusSentinelPath,
} from '../nexus-sqlite.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-nested-nexus-test-'));
}

function touchFile(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, name);
  writeFileSync(fullPath, 'placeholder');
  return fullPath;
}

function nestedPath(home: string): string {
  return join(home, 'nexus');
}

// ---------------------------------------------------------------------------
// detectAndWarnOnNestedNexus
// ---------------------------------------------------------------------------

describe('detectAndWarnOnNestedNexus (ADR-086 §2.2)', () => {
  let tmpHome: string;
  let prevCleoHome: string | undefined;

  beforeEach(() => {
    tmpHome = createTmpHome();
    prevCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tmpHome;
    warnSpy.mockClear();
    _resetNestedNexusWarningGate();
  });

  afterEach(() => {
    if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = prevCleoHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns false and emits no warning when the nested directory does not exist', () => {
    const fired = detectAndWarnOnNestedNexus();
    expect(fired).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns true and emits exactly one warning when the nested sentinel is present', () => {
    touchFile(nestedPath(tmpHome), 'nexus.db');

    const fired = detectAndWarnOnNestedNexus();
    expect(fired).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const [payload, message] = warnSpy.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      adr: 'ADR-086',
      task: 'T10321',
      migrationCommand: 'node scripts/migrate-nested-nexus.mjs',
    });
    expect(message).toContain('nested-nexus structural bug');
  });

  it('is one-shot per process for the same nested path (idempotent gate)', () => {
    touchFile(nestedPath(tmpHome), 'nexus.db');

    const first = detectAndWarnOnNestedNexus();
    const second = detectAndWarnOnNestedNexus();
    const third = detectAndWarnOnNestedNexus();

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes a sentinel-path helper that resolves under <cleoHome>/nexus/nexus.db', () => {
    const sentinel = getNestedNexusSentinelPath();
    expect(sentinel).toBe(join(tmpHome, 'nexus', 'nexus.db'));
  });
});

// ---------------------------------------------------------------------------
// migrate-nested-nexus.mjs — plan() + execute()
// ---------------------------------------------------------------------------

describe('scripts/migrate-nested-nexus.mjs plan() (ADR-086 §2.1 allowlist)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = createTmpHome();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reports no-op when the nested directory does not exist', () => {
    const result = migratePlan(tmpHome);
    expect(result.exists).toBe(false);
    expect(result.noOp).toBe(true);
    expect(result.filesToDelete).toEqual([]);
    expect(result.subdirsToRemove).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it('reports no-op when the nested directory is empty', () => {
    mkdirSync(nestedPath(tmpHome), { recursive: true });
    const result = migratePlan(tmpHome);
    expect(result.exists).toBe(true);
    expect(result.noOp).toBe(true);
  });

  it('queues all eight allowlisted files for deletion when present', () => {
    const nested = nestedPath(tmpHome);
    const allowlistedFiles = [
      'nexus.db',
      'nexus.db-shm',
      'nexus.db-wal',
      'nexus-pre-cleo.db.bak',
      'signaldock.db',
      'signaldock.db-shm',
      'signaldock.db-wal',
      'signaldock-pre-cleo.db.bak',
    ];
    for (const name of allowlistedFiles) {
      touchFile(nested, name);
    }

    const result = migratePlan(tmpHome);
    expect(result.exists).toBe(true);
    expect(result.noOp).toBe(false);
    expect(result.unexpected).toEqual([]);
    expect(result.filesToDelete.map((p: string) => p.replace(nested + '/', '')).sort()).toEqual(
      allowlistedFiles.sort(),
    );
  });

  it('queues an empty cache/ subdirectory for removal but refuses non-empty subdirs', () => {
    const nested = nestedPath(tmpHome);
    mkdirSync(join(nested, 'cache'), { recursive: true });

    const empty = migratePlan(tmpHome);
    expect(empty.subdirsToRemove.map((p: string) => p.replace(nested + '/', ''))).toEqual([
      'cache',
    ]);

    // Add a file inside cache/ and re-plan — should now be unexpected.
    touchFile(join(nested, 'cache'), 'something');
    const populated = migratePlan(tmpHome);
    expect(populated.subdirsToRemove).toEqual([]);
    expect(populated.unexpected.length).toBe(1);
    expect(populated.unexpected[0]).toContain('cache');
  });

  it('flags unknown files as unexpected without queuing them for deletion (defence-in-depth)', () => {
    const nested = nestedPath(tmpHome);
    touchFile(nested, 'nexus.db'); // allowed
    touchFile(nested, 'unknown-file.dat'); // unexpected
    touchFile(nested, 'random.log'); // unexpected

    const result = migratePlan(tmpHome);
    expect(result.filesToDelete.map((p: string) => p.replace(nested + '/', ''))).toEqual([
      'nexus.db',
    ]);
    expect(result.unexpected.length).toBe(2);
    expect(result.unexpected.map((p: string) => p.replace(nested + '/', '')).sort()).toEqual([
      'random.log',
      'unknown-file.dat',
    ]);
  });

  it('exports an allowlist that contains the eight expected file names', () => {
    expect(ALLOWED_FILES).toEqual(
      expect.arrayContaining([
        'nexus.db',
        'nexus.db-shm',
        'nexus.db-wal',
        'nexus-pre-cleo.db.bak',
        'signaldock.db',
        'signaldock.db-shm',
        'signaldock.db-wal',
        'signaldock-pre-cleo.db.bak',
      ]),
    );
    expect(ALLOWED_SUBDIRS).toEqual(['cache']);
  });
});

describe('scripts/migrate-nested-nexus.mjs execute() (ADR-086 §2.1)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = createTmpHome();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('deletes only allowlisted files and removes the nested root when the sweep is complete', () => {
    const nested = nestedPath(tmpHome);
    touchFile(nested, 'nexus.db');
    touchFile(nested, 'nexus-pre-cleo.db.bak');
    touchFile(nested, 'signaldock.db');
    mkdirSync(join(nested, 'cache'), { recursive: true });

    const planResult = migratePlan(tmpHome);
    const execResult = migrateExecute(planResult);

    expect(execResult.errors).toEqual([]);
    expect(execResult.deletedFiles).toBe(3);
    expect(execResult.removedSubdirs).toBe(1);
    expect(execResult.removedRoot).toBe(true);
    expect(existsSync(nested)).toBe(false);
  });

  it('leaves the nested root in place when unexpected entries remain', () => {
    const nested = nestedPath(tmpHome);
    touchFile(nested, 'nexus.db'); // allowed
    touchFile(nested, 'mystery.bin'); // unexpected

    const planResult = migratePlan(tmpHome);
    const execResult = migrateExecute(planResult);

    expect(execResult.deletedFiles).toBe(1);
    expect(execResult.removedRoot).toBe(false);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(nested, 'mystery.bin'))).toBe(true);
    expect(existsSync(join(nested, 'nexus.db'))).toBe(false);
  });

  it('is idempotent — running twice after a complete sweep is a clean no-op', () => {
    const nested = nestedPath(tmpHome);
    touchFile(nested, 'nexus.db');
    touchFile(nested, 'signaldock.db');

    const firstPlan = migratePlan(tmpHome);
    migrateExecute(firstPlan);
    expect(existsSync(nested)).toBe(false);

    const secondPlan = migratePlan(tmpHome);
    expect(secondPlan.noOp).toBe(true);
    expect(secondPlan.filesToDelete).toEqual([]);
    expect(secondPlan.subdirsToRemove).toEqual([]);

    // Re-execute on the empty plan — must report zero deletions, zero errors.
    const secondExec = migrateExecute(secondPlan);
    expect(secondExec.deletedFiles).toBe(0);
    expect(secondExec.removedSubdirs).toBe(0);
    expect(secondExec.removedRoot).toBe(false);
    expect(secondExec.errors).toEqual([]);
  });

  it('never touches flat-tier siblings or the cleoHome parent', () => {
    const nested = nestedPath(tmpHome);
    touchFile(nested, 'nexus.db');

    // Place sentinel flat-tier files that MUST be preserved.
    touchFile(tmpHome, 'nexus.db');
    touchFile(tmpHome, 'signaldock.db');
    touchFile(tmpHome, 'brain.db');

    const planResult = migratePlan(tmpHome);
    migrateExecute(planResult);

    expect(existsSync(join(tmpHome, 'nexus.db'))).toBe(true);
    expect(existsSync(join(tmpHome, 'signaldock.db'))).toBe(true);
    expect(existsSync(join(tmpHome, 'brain.db'))).toBe(true);
    expect(existsSync(tmpHome)).toBe(true);
    // The nested directory is gone.
    expect(readdirSync(tmpHome).sort()).toEqual(['brain.db', 'nexus.db', 'signaldock.db']);
  });
});
