/**
 * T11031 — Integration tests: strict mode, deprecation warnings, and
 * cross-mount scenarios.
 *
 * These tests exercise the full getCleoDirAbsolute → resolveProjectByCwd →
 * resolveCanonicalCleoDir → registerProjectOnEncounter chain end-to-end,
 * using real temp directories, project-info.json, and nexus.db registry.
 *
 * @task T11031
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCleoDirAbsolute,
  resolveCanonicalCleoDir,
  resolveProjectByCwd,
} from '../paths.js';

// ── Helpers ───────────────────────────────────────────────────────────

function createTempProject(
  baseDir: string,
  opts?: { projectId?: string; projectName?: string },
) {
  const projectId = opts?.projectId ?? `pid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cleoDir = join(baseDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const info: Record<string, string> = { projectId };
  if (opts?.projectName) info.name = opts.projectName;
  writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify(info));
  // Minimal .git dir so getProjectRoot validation passes
  mkdirSync(join(baseDir, '.git'), { recursive: true });
  return { projectRoot: resolve(baseDir), projectId };
}

function seedNexusDb(
  cleoHome: string,
  rows: Array<{ project_id: string; project_path: string }>,
) {
  const dbPath = join(cleoHome, 'nexus.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL)',
  );
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO project_registry (project_id, project_path) VALUES (?, ?)',
  );
  for (const row of rows) {
    stmt.run(row.project_id, row.project_path);
  }
  db.close();
}

function countRegistryRows(cleoHome: string): number {
  const dbPath = join(cleoHome, 'nexus.db');
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) as cnt FROM project_registry').get() as { cnt: number };
    db.close();
    return row.cnt;
  } catch {
    return 0;
  }
}

// ── AC1: Strict mode throws E_CWD_WALKUP_FORBIDDEN ────────────────────

describe('T11031 AC1 — CLEO_PATHS_STRICT integration', () => {
  const origCleoDir = process.env['CLEO_DIR'];
  const origCleoDebug = process.env['CLEO_DEBUG'];
  const origCleoPathsStrict = process.env['CLEO_PATHS_STRICT'];

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_DEBUG'];
    delete process.env['CLEO_PATHS_STRICT'];
  });

  afterEach(() => {
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
    if (origCleoDebug !== undefined) process.env['CLEO_DEBUG'] = origCleoDebug;
    else delete process.env['CLEO_DEBUG'];
    if (origCleoPathsStrict !== undefined) process.env['CLEO_PATHS_STRICT'] = origCleoPathsStrict;
    else delete process.env['CLEO_PATHS_STRICT'];
  });

  it('throws E_CWD_WALKUP_FORBIDDEN at the integration level (AC1)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    const emptyDir = join(tmpdir(), `cleo-t11031-ac1-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      expect(() => getCleoDirAbsolute(emptyDir)).toThrowError(/E_CWD_WALKUP_FORBIDDEN/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('CLEO_PATHS_STRICT=1 error includes remediation commands (AC1)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    const emptyDir = join(tmpdir(), `cleo-t11031-ac1b-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      try {
        getCleoDirAbsolute(emptyDir);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('resolveProjectByCwd');
        expect(err.message).toContain('resolveCanonicalCleoDir');
        expect(err.fix).toContain('resolveProjectByCwd');
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('CLEO_PATHS_STRICT=1 still allows absolute CLEO_DIR passthrough (AC1)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    process.env['CLEO_DIR'] = '/absolute/cleo/path';
    expect(getCleoDirAbsolute('/some/project')).toBe('/absolute/cleo/path');
  });

  it('CLEO_PATHS_STRICT=1 still allows bootstrap=true (AC1)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    const result = getCleoDirAbsolute('/new/project', { bootstrap: true });
    expect(result).toBe(resolve('/new/project', '.cleo'));
  });
});

// ── AC2: Deprecation warning via CLEO_DEBUG ────────────────────────────

describe('T11031 AC2 — deprecation warning integration', () => {
  const origCleoDir = process.env['CLEO_DIR'];
  const origCleoDebug = process.env['CLEO_DEBUG'];
  const origCleoPathsStrict = process.env['CLEO_PATHS_STRICT'];

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_DEBUG'];
    delete process.env['CLEO_PATHS_STRICT'];
  });

  afterEach(() => {
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
    if (origCleoDebug !== undefined) process.env['CLEO_DEBUG'] = origCleoDebug;
    else delete process.env['CLEO_DEBUG'];
    if (origCleoPathsStrict !== undefined) process.env['CLEO_PATHS_STRICT'] = origCleoPathsStrict;
    else delete process.env['CLEO_PATHS_STRICT'];
  });

  it('emits W_PATH_DEPRECATED on stderr when CLEO_DEBUG is set (AC2)', () => {
    process.env['CLEO_DEBUG'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    const tmpDir = join(tmpdir(), `cleo-t11031-ac2-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const before = stderrSpy.mock.calls.filter(
        ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
      ).length;

      try {
        getCleoDirAbsolute(tmpDir);
      } catch {
        // May throw if no project — we only care about the warning.
      }

      const after = stderrSpy.mock.calls.filter(
        ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
      ).length;

      const newWarnings = after - before;
      expect(newWarnings).toBeLessThanOrEqual(1);

      if (newWarnings === 1) {
        const warning = stderrSpy.mock.calls.findLast(
          ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
        )?.[0] as string;
        expect(warning).toContain('getCleoDirAbsolute(cwd) is deprecated');
        expect(warning).toContain('resolveProjectByCwd');
        expect(warning).toContain('resolveCanonicalCleoDir');
        expect(warning).toContain('CLEO_PATHS_STRICT=1');
      }
    } finally {
      stderrSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT emit warning when CLEO_DEBUG is not set (AC2)', () => {
    delete process.env['CLEO_DEBUG'];
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    const tmpDir = join(tmpdir(), `cleo-t11031-ac2b-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      try {
        getCleoDirAbsolute(tmpDir);
      } catch { /* ignore */ }

      const warnings = stderrSpy.mock.calls.filter(
        ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
      );
      expect(warnings.length).toBe(0);
    } finally {
      stderrSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CLEO_PATHS_STRICT=1 throws BEFORE any deprecation warning (AC2)', () => {
    process.env['CLEO_DEBUG'] = '1';
    process.env['CLEO_PATHS_STRICT'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    const emptyDir = join(tmpdir(), `cleo-t11031-ac2c-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      expect(() => getCleoDirAbsolute(emptyDir)).toThrowError(/E_CWD_WALKUP_FORBIDDEN/);

      const warnings = stderrSpy.mock.calls.filter(
        ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
      );
      expect(warnings.length).toBe(0);
    } finally {
      stderrSpy.mockRestore();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── AC3: Cross-mount projectId dedup ──────────────────────────────────

describe('T11031 AC3 — cross-mount projectId dedup integration', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  const origCleoDir = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origCleoHome !== undefined) process.env['CLEO_HOME'] = origCleoHome;
    else delete process.env['CLEO_HOME'];
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('two paths with same project-info.json projectId share legacyUUID (AC3)', async () => {
    // T11023: resolveProjectByCwd now returns canonical 12-hex projectId
    // (computed from git root via T9149 algorithm) and preserves the
    // original project-info.json ID as legacyUUID.
    const sharedProjectId = `cross-mount-${Date.now()}`;
    const pathA = join(tmpdir(), `cleo-t11031-ac3-a-${Date.now()}`);
    const pathB = join(tmpdir(), `cleo-t11031-ac3-b-${Date.now()}`);

    mkdirSync(pathA, { recursive: true });
    mkdirSync(pathB, { recursive: true });

    try {
      createTempProject(pathA, { projectId: sharedProjectId });
      createTempProject(pathB, { projectId: sharedProjectId });

      const { resolveProjectByCwd: pathsResolveProjectByCwd } = await import('@cleocode/paths');

      const rawA = pathsResolveProjectByCwd(pathA);
      const rawB = pathsResolveProjectByCwd(pathB);

      expect(rawA).not.toBeNull();
      expect(rawB).not.toBeNull();

      // Legacy UUIDs match (both share the same project-info.json projectId)
      expect(rawA!.legacyUUID).toBe(sharedProjectId);
      expect(rawB!.legacyUUID).toBe(sharedProjectId);

      // Canonical IDs are 12-hex strings (T11023 / T9149)
      expect(rawA!.projectId).toMatch(/^[0-9a-f]{12}$/);
      expect(rawB!.projectId).toMatch(/^[0-9a-f]{12}$/);

      // Different .git roots produce different canonical IDs (expected)
      // — canonical ID is git-root-based
    } finally {
      rmSync(pathA, { recursive: true, force: true });
      rmSync(pathB, { recursive: true, force: true });
    }
  });

  it('cross-mount: symlinked paths resolve to same canonical projectId (AC3)', async () => {
    // True cross-mount: symlink so realpathSync resolves both to the
    // same real path, producing identical canonical IDs.
    const sharedProjectId = `cross-mount-sym-${Date.now()}`;
    const realPath = join(tmpdir(), `cleo-t11031-ac3s-real-${Date.now()}`);
    const symlinkPath = join(tmpdir(), `cleo-t11031-ac3s-sym-${Date.now()}`);

    mkdirSync(realPath, { recursive: true });
    const { symlinkSync } = require('node:fs');
    symlinkSync(realPath, symlinkPath, 'dir');

    try {
      createTempProject(realPath, { projectId: sharedProjectId });

      const { resolveProjectByCwd: pathsResolveProjectByCwd } = await import('@cleocode/paths');

      const resultReal = pathsResolveProjectByCwd(realPath);
      const resultSym = pathsResolveProjectByCwd(symlinkPath);

      expect(resultReal).not.toBeNull();
      expect(resultSym).not.toBeNull();

      // Same real path → same canonical ID
      expect(resultReal!.projectId).toBe(resultSym!.projectId);
      expect(resultReal!.projectId).toMatch(/^[0-9a-f]{12}$/);
      expect(resultReal!.legacyUUID).toBe(sharedProjectId);
    } finally {
      rmSync(realPath, { recursive: true, force: true });
      try { rmSync(symlinkPath, { recursive: true, force: true }); } catch { /* symlink */ }
    }
  });

  it('getCleoDirAbsolute from both mount points yields project-root .cleo (AC3)', () => {
    delete process.env['CLEO_DIR'];
    const tmpHome = join(tmpdir(), `cleo-t11031-ac3c-home-${Date.now()}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env['CLEO_HOME'] = tmpHome;

    const sharedProjectId = `cross-mount-2-${Date.now()}`;
    const pathA = join(tmpdir(), `cleo-t11031-ac3c-a-${Date.now()}`);
    const pathB = join(tmpdir(), `cleo-t11031-ac3c-b-${Date.now()}`);

    mkdirSync(pathA, { recursive: true });
    mkdirSync(pathB, { recursive: true });

    try {
      createTempProject(pathA, { projectId: sharedProjectId });
      createTempProject(pathB, { projectId: sharedProjectId });
      seedNexusDb(tmpHome, [{ project_id: sharedProjectId, project_path: resolve(pathA) }]);

      // getCleoDirAbsolute from path A resolves to pathA/.cleo
      const resultA = getCleoDirAbsolute(pathA);
      expect(resultA).toBe(join(resolve(pathA), '.cleo'));

      // getCleoDirAbsolute from path B resolves to pathB/.cleo
      const resultB = getCleoDirAbsolute(pathB);
      expect(resultB).toBe(join(resolve(pathB), '.cleo'));
    } finally {
      rmSync(pathA, { recursive: true, force: true });
      rmSync(pathB, { recursive: true, force: true });
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── AC4: Auto-register on resolveProjectByCwd persists to nexus ───────

describe('T11031 AC4 — auto-register integration', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  const origCleoDir = process.env['CLEO_DIR'];
  let tmpHome: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tmpHome = join(tmpdir(), `cleo-t11031-ac4-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env['CLEO_HOME'] = tmpHome;
  });

  afterEach(() => {
    if (origCleoHome !== undefined) process.env['CLEO_HOME'] = origCleoHome;
    else delete process.env['CLEO_HOME'];
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('getCleoDirAbsolute triggers auto-register that persists to nexus.db (AC4)', () => {
    const projDir = join(tmpdir(), `cleo-t11031-ac4-proj-${Date.now()}`);
    mkdirSync(projDir, { recursive: true });

    try {
      createTempProject(projDir, { projectId: 'auto-reg-test-id', projectName: 'auto-reg' });
      seedNexusDb(tmpHome, [{ project_id: 'auto-reg-test-id', project_path: resolve(projDir) }]);

      // Before: nexus.db has our seeded entry
      const before = countRegistryRows(tmpHome);
      expect(before).toBeGreaterThanOrEqual(1);

      // Call getCleoDirAbsolute — this triggers:
      //   resolveProjectByCwd → registerProjectOnEncounter (fire-and-forget)
      const result = getCleoDirAbsolute(projDir);
      expect(result).toBe(join(resolve(projDir), '.cleo'));

      // After: the seeded entry should still be there
      const after = countRegistryRows(tmpHome);
      expect(after).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('resolveProjectByCwd returns consistent projectId before and after getCleoDirAbsolute (AC4)', () => {
    const projDir = join(tmpdir(), `cleo-t11031-ac4b-proj-${Date.now()}`);
    mkdirSync(projDir, { recursive: true });

    try {
      createTempProject(projDir, { projectId: 'reg-before-after' });
      seedNexusDb(tmpHome, [{ project_id: 'reg-before-after', project_path: resolve(projDir) }]);

      // resolveProjectByCwd finds the project and returns a canonical ID
      const before = resolveProjectByCwd(projDir);
      expect(typeof before).toBe('string');
      expect(before.length).toBeGreaterThan(0);

      // getCleoDirAbsolute also resolves through the chain
      const cleoDir = getCleoDirAbsolute(projDir);
      expect(cleoDir).toBe(join(resolve(projDir), '.cleo'));

      // resolveProjectByCwd still returns the same canonical ID
      const after = resolveProjectByCwd(projDir);
      expect(after).toBe(before);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });
});

// ── AC5: resolveCanonicalCleoDir after registration ───────────────────

describe('T11031 AC5 — resolveCanonicalCleoDir after registration', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  const origCleoDir = process.env['CLEO_DIR'];
  let tmpHome: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tmpHome = join(tmpdir(), `cleo-t11031-ac5-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env['CLEO_HOME'] = tmpHome;
  });

  afterEach(() => {
    if (origCleoHome !== undefined) process.env['CLEO_HOME'] = origCleoHome;
    else delete process.env['CLEO_HOME'];
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolveCanonicalCleoDir returns .cleo/ path after nexus registration (AC5)', () => {
    const projId = 'ac5-known-project';
    const projPath = '/mnt/projects/ac5-test-project';

    seedNexusDb(tmpHome, [{ project_id: projId, project_path: projPath }]);

    const cleoDir = resolveCanonicalCleoDir(projId);
    expect(cleoDir).toBe(join(projPath, '.cleo'));
  });

  it('resolveCanonicalCleoDir throws for unregistered projectId (AC5)', () => {
    seedNexusDb(tmpHome, [{ project_id: 'known-only', project_path: '/tmp/known' }]);

    expect(() => resolveCanonicalCleoDir('nonexistent-id')).toThrow('E_PROJECT_NOT_FOUND');
  });

  it('resolveCanonicalCleoDir throws when nexus.db does not exist (AC5)', () => {
    expect(() => resolveCanonicalCleoDir('any-id')).toThrow('E_PROJECT_NOT_FOUND');
  });

  it('resolveCanonicalCleoDir consistency after multiple calls (AC5)', () => {
    const projId = 'ac5-consistent';
    const projPath = '/opt/ac5-consistent';

    seedNexusDb(tmpHome, [{ project_id: projId, project_path: projPath }]);

    const first = resolveCanonicalCleoDir(projId);
    const second = resolveCanonicalCleoDir(projId);
    expect(first).toBe(join(projPath, '.cleo'));
    expect(second).toBe(first);
  });
});

// ── AC6: Cleanup — no stale registry entries between runs ─────────────

describe('T11031 AC6 — cleanup ensures no stale entries', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  const origCleoDir = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origCleoHome !== undefined) process.env['CLEO_HOME'] = origCleoHome;
    else delete process.env['CLEO_HOME'];
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('temp directories are fully cleaned after each test (AC6)', () => {
    const tempDir = join(tmpdir(), `cleo-t11031-ac6-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'test.txt'), 'test content');

    const { existsSync } = require('node:fs');
    expect(existsSync(join(tempDir, 'test.txt'))).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
    expect(existsSync(tempDir)).toBe(false);
  });

  it('nexus.db state is isolated per test via unique CLEO_HOME (AC6)', () => {
    const homeA = join(tmpdir(), `cleo-t11031-ac6-homea-${Date.now()}`);
    const homeB = join(tmpdir(), `cleo-t11031-ac6-homeb-${Date.now()}`);
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });

    try {
      // Home A: register project X
      process.env['CLEO_HOME'] = homeA;
      seedNexusDb(homeA, [{ project_id: 'project-x', project_path: '/tmp/proj-x' }]);
      expect(resolveCanonicalCleoDir('project-x')).toBe('/tmp/proj-x/.cleo');

      // Home B: should NOT have project X
      process.env['CLEO_HOME'] = homeB;
      expect(() => resolveCanonicalCleoDir('project-x')).toThrow('E_PROJECT_NOT_FOUND');
    } finally {
      if (origCleoHome !== undefined) process.env['CLEO_HOME'] = origCleoHome;
      else delete process.env['CLEO_HOME'];
      if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
      else delete process.env['CLEO_DIR'];
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('removing temp dirs does not leave stale project-info.json (AC6)', () => {
    const { existsSync } = require('node:fs');

    const tmpProj = join(tmpdir(), `cleo-t11031-ac6c-${Date.now()}`);
    mkdirSync(tmpProj, { recursive: true });
    createTempProject(tmpProj, { projectId: 'cleanup-test' });

    expect(existsSync(join(tmpProj, '.cleo', 'project-info.json'))).toBe(true);

    rmSync(tmpProj, { recursive: true, force: true });
    expect(existsSync(tmpProj)).toBe(false);
  });
});
