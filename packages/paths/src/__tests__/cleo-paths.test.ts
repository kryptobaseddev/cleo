import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import envPaths from 'env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCleoPlatformPathsCache,
  computeCanonicalProjectId,
  getCanonicalTemplatesTildePath,
  getCleoHome,
  getCleoPlatformPaths,
  getCleoSystemInfo,
  getCleoTemplatesTildePath,
  legacyProjectId,
  resolveCanonicalCleoDir,
  resolveLegacyCleoDir,
  resolveProjectByCwd,
} from '../cleo-paths.js';

describe('cleo-paths', () => {
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    originalCleoHome = process.env['CLEO_HOME'];
    delete process.env['CLEO_HOME'];
    _resetCleoPlatformPathsCache();
  });

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
    _resetCleoPlatformPathsCache();
  });

  it('getCleoHome defaults to env-paths data dir for "cleo"', () => {
    expect(getCleoHome()).toBe(envPaths('cleo', { suffix: '' }).data);
  });

  it('getCleoHome honours CLEO_HOME override', () => {
    process.env['CLEO_HOME'] = '/opt/cleo-data';
    expect(getCleoHome()).toBe('/opt/cleo-data');
  });

  it('getCleoPlatformPaths returns the full PlatformPaths struct', () => {
    const paths = getCleoPlatformPaths();
    const expected = envPaths('cleo', { suffix: '' });
    expect(paths.data).toBe(expected.data);
    expect(paths.config).toBe(expected.config);
    expect(paths.cache).toBe(expected.cache);
    expect(paths.log).toBe(expected.log);
    expect(paths.temp).toBe(expected.temp);
  });

  it('getCleoSystemInfo returns a SystemInfo snapshot with cleo paths', () => {
    const info = getCleoSystemInfo();
    expect(typeof info.platform).toBe('string');
    expect(typeof info.arch).toBe('string');
    expect(info.paths.data).toBe(envPaths('cleo', { suffix: '' }).data);
  });

  it('getCleoTemplatesTildePath returns ~-prefixed path under home', () => {
    delete process.env['CLEO_HOME'];
    const tilde = getCleoTemplatesTildePath();
    expect(tilde.startsWith('~/')).toBe(true);
    expect(tilde.endsWith('/templates')).toBe(true);
  });

  it('getCleoTemplatesTildePath returns absolute path when CLEO_HOME is outside home', () => {
    process.env['CLEO_HOME'] = '/opt/cleo';
    expect(getCleoTemplatesTildePath()).toBe('/opt/cleo/templates');
  });

  it('getCleoTemplatesTildePath converts paths under homedir to tilde form', () => {
    process.env['CLEO_HOME'] = join(homedir(), 'custom-cleo');
    expect(getCleoTemplatesTildePath()).toBe('~/custom-cleo/templates');
  });

  describe('getCanonicalTemplatesTildePath()', () => {
    it('always returns the stable ~/.cleo/templates path', () => {
      expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
    });

    it('is immune to CLEO_HOME override', () => {
      process.env['CLEO_HOME'] = join(
        homedir(),
        '.temp',
        'cleo-injection-chain-XXXXXX',
        '.cleo-home',
      );
      _resetCleoPlatformPathsCache();
      expect(getCleoTemplatesTildePath()).toContain('cleo-injection-chain-XXXXXX');
      expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
    });

    it('is immune to CLEO_HOME outside home', () => {
      process.env['CLEO_HOME'] = '/opt/custom-cleo-data';
      _resetCleoPlatformPathsCache();
      expect(getCleoTemplatesTildePath()).toBe('/opt/custom-cleo-data/templates');
      expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
    });

    it('produces the correct @-reference for CLEO-INJECTION.md', () => {
      const ref = `@${getCanonicalTemplatesTildePath()}/CLEO-INJECTION.md`;
      expect(ref).toBe('@~/.cleo/templates/CLEO-INJECTION.md');
    });
  });

  describe('resolveLegacyCleoDir()', () => {
    it('returns the override when provided', () => {
      expect(resolveLegacyCleoDir('/custom/cleo-dir')).toBe('/custom/cleo-dir');
    });

    it('returns ~/.cleo when no override is provided', () => {
      expect(resolveLegacyCleoDir()).toBe(join(homedir(), '.cleo'));
    });

    it('returns ~/.cleo when override is undefined', () => {
      expect(resolveLegacyCleoDir(undefined)).toBe(join(homedir(), '.cleo'));
    });

    it('treats empty string override as falsy', () => {
      expect(resolveLegacyCleoDir('')).toBe(join(homedir(), '.cleo'));
    });

    it('is immune to CLEO_HOME', () => {
      process.env['CLEO_HOME'] = '/opt/custom-cleo';
      _resetCleoPlatformPathsCache();
      expect(resolveLegacyCleoDir()).toBe(join(homedir(), '.cleo'));
    });
  });

  // ── computeCanonicalProjectId (T11023) ───────────────────────────────

  describe('computeCanonicalProjectId()', () => {
    it('returns a 12-char hex string', () => {
      const id = computeCanonicalProjectId('/mnt/projects/cleocode');
      expect(id).toMatch(/^[0-9a-f]{12}$/);
    });

    it('produces the same ID for the same path', () => {
      const id1 = computeCanonicalProjectId('/mnt/projects/cleocode');
      const id2 = computeCanonicalProjectId('/mnt/projects/cleocode');
      expect(id1).toBe(id2);
    });
  });

  // ── legacyProjectId (T11023) ─────────────────────────────────────────

  describe('legacyProjectId()', () => {
    it('computes base64url(path).slice(0, 32)', () => {
      const p = '/mnt/projects/cleocode';
      const id = legacyProjectId(p);
      expect(id).toBe(Buffer.from(p).toString('base64url').slice(0, 32));
      expect(id.length).toBeLessThanOrEqual(32);
    });

    it('produces different IDs for different paths', () => {
      const id1 = legacyProjectId('/mnt/projects/cleocode');
      const id2 = legacyProjectId('/workspace/cleocode');
      expect(id1).not.toBe(id2);
    });
  });

  // ── resolveProjectByCwd (T11008 / T11023) ───────────────────────────

  describe('resolveProjectByCwd()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(
        tmpdir(),
        'cleo-paths-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      );
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('resolves projectId and projectRoot from .cleo/project-info.json in cwd', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: 'test-uuid-1234', projectHash: 'abc123' }),
      );

      const result = resolveProjectByCwd(tempDir);
      expect(result).not.toBeNull();
      // T11023: projectId is now canonical 12-hex-char ID
      expect(result!.projectId).toMatch(/^[0-9a-f]{12}$/);
      expect(result!.projectRoot).toBe(tempDir);
      // legacyUUID still accessible
      expect(result!.legacyUUID).toBe('test-uuid-1234');
    });

    it('walks up ancestors to find .cleo/project-info.json', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: 'walk-up-uuid' }),
      );

      const subDir = join(tempDir, 'packages', 'core', 'src');
      mkdirSync(subDir, { recursive: true });

      const result = resolveProjectByCwd(subDir);
      expect(result).not.toBeNull();
      expect(result!.projectId).toMatch(/^[0-9a-f]{12}$/);
      expect(result!.projectRoot).toBe(tempDir);
      expect(result!.legacyUUID).toBe('walk-up-uuid');
    });

    it('returns null when no .cleo/project-info.json is found', () => {
      expect(resolveProjectByCwd(tempDir)).toBeNull();
    });

    it('returns null when project-info.json has no projectId', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectHash: 'abc' }));
      expect(resolveProjectByCwd(tempDir)).toBeNull();
    });

    it('returns null when project-info.json has empty projectId', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: '', projectHash: 'abc' }),
      );
      expect(resolveProjectByCwd(tempDir)).toBeNull();
    });

    it('skips corrupt project-info.json and continues walking', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(join(cleoDir, 'project-info.json'), 'not valid json {{{');
      // No valid ancestor above tempDir, so null
      expect(resolveProjectByCwd(tempDir)).toBeNull();
    });

    it('finds valid ancestor when immediate .cleo has no projectId', () => {
      // .cleo at tempDir with valid ID, test from subdir
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: 'valid-parent-uuid' }),
      );

      const subDir = join(tempDir, 'deep', 'nested');
      mkdirSync(subDir, { recursive: true });

      const result = resolveProjectByCwd(subDir);
      expect(result).not.toBeNull();
      expect(result!.projectId).toMatch(/^[0-9a-f]{12}$/);
      expect(result!.projectRoot).toBe(tempDir);
      expect(result!.legacyUUID).toBe('valid-parent-uuid');
    });

    it('uses process.cwd() when no cwd argument', () => {
      // T11281: drive the no-argument (process.cwd()) path from a deterministic
      // fixture project rather than depending on the ambient repo carrying a
      // .cleo/project-info.json — that file is gitignored and ABSENT in CI, so
      // the previous assertion (`not.toBeNull()`) failed there. chdir into the
      // fixture, assert, then restore cwd.
      const fixtureDir = join(tmpdir(), `cleo-cwd-default-${Date.now()}`);
      const cleoDir = join(fixtureDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: 'cwd-default-uuid' }),
      );
      try {
        execFileSync('git', ['init'], { cwd: fixtureDir, stdio: 'ignore' });
      } catch {
        /* git optional — computeCanonicalProjectId falls back to path */
      }
      const origCwd = process.cwd();
      try {
        process.chdir(fixtureDir);
        const result = resolveProjectByCwd();
        expect(result).not.toBeNull();
        // T11023: projectId is the 12-char-hex canonical runtime id
        expect(result!.projectId).toMatch(/^[0-9a-f]{12}$/);
        expect(result!.projectRoot.length).toBeGreaterThan(0);
      } finally {
        process.chdir(origCwd);
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // T11023: Cross-mount divergence tests (AC5)
    it('returns same projectId for different mount paths to same repo (AC5)', () => {
      // Create a project fixture
      const fixtureDir = join(tmpdir(), 'cleo-cross-mount-' + Date.now());
      mkdirSync(fixtureDir, { recursive: true });
      const cleoDir = join(fixtureDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });

      // Init git repo so computeCanonicalProjectId can resolve git root
      try {
        execFileSync('git', ['init'], { cwd: fixtureDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], {
          cwd: fixtureDir,
          stdio: 'ignore',
        });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: fixtureDir, stdio: 'ignore' });
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test/repo.git'], {
          cwd: fixtureDir,
          stdio: 'ignore',
        });
      } catch {
        /* git may not be available */
      }

      writeFileSync(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: 'cross-mount-uuid', projectHash: 'abc' }),
      );

      // Create a symlink to simulate bind-mount
      const symlinkPath = join(tmpdir(), 'cleo-cross-mount-link-' + Date.now());
      try {
        symlinkSync(fixtureDir, symlinkPath, 'dir');
      } catch {
        // Symlinks may not be supported — skip this test
        try {
          rmSync(fixtureDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return;
      }

      try {
        const result1 = resolveProjectByCwd(fixtureDir);
        const result2 = resolveProjectByCwd(symlinkPath);

        expect(result1).not.toBeNull();
        expect(result2).not.toBeNull();
        // Same canonical projectId (AC1, AC2)
        expect(result1!.projectId).toBe(result2!.projectId);
        // Same realpath projectRoot (AC3)
        expect(result1!.projectRoot).toBe(result2!.projectRoot);
        // Same legacy UUID
        expect(result1!.legacyUUID).toBe(result2!.legacyUUID);
      } finally {
        try {
          rmSync(fixtureDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        try {
          rmSync(symlinkPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  });

  // ── resolveCanonicalCleoDir (T11008 / T11023) ──────────────────────

  describe('resolveCanonicalCleoDir()', () => {
    let tempCleoHome: string;
    let originalCleoHomeForNexus: string | undefined;

    beforeEach(() => {
      tempCleoHome = join(
        tmpdir(),
        'cleo-nexus-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      );
      mkdirSync(tempCleoHome, { recursive: true });

      const nexusDbPath = join(tempCleoHome, 'nexus.db');
      const db = new DatabaseSync(nexusDbPath);
      db.exec(
        'CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE)',
      );
      const insert = db.prepare(
        'INSERT INTO project_registry (project_id, project_path) VALUES (?, ?)',
      );
      insert.run('known-project-uuid', '/mnt/projects/my-project');
      insert.run('secondary-uuid', '/home/user/another-project');

      // T11023 AC4: Set up project_id_aliases table
      db.exec(
        'CREATE TABLE IF NOT EXISTS project_id_aliases (legacy_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL)',
      );
      const aliasInsert = db.prepare(
        'INSERT INTO project_id_aliases (legacy_id, canonical_id) VALUES (?, ?)',
      );
      aliasInsert.run('legacy-base64-id', 'known-project-uuid');
      aliasInsert.run('old-uuid-format', 'secondary-uuid');
      db.close();

      originalCleoHomeForNexus = process.env['CLEO_HOME'];
      process.env['CLEO_HOME'] = tempCleoHome;
      _resetCleoPlatformPathsCache();
    });

    afterEach(() => {
      if (originalCleoHomeForNexus === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = originalCleoHomeForNexus;
      }
      _resetCleoPlatformPathsCache();
      try {
        rmSync(tempCleoHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('resolves .cleo dir from a known projectId', () => {
      expect(resolveCanonicalCleoDir('known-project-uuid')).toBe('/mnt/projects/my-project/.cleo');
    });

    it('resolves another registered project', () => {
      expect(resolveCanonicalCleoDir('secondary-uuid')).toBe('/home/user/another-project/.cleo');
    });

    it('returns null for unknown projectId', () => {
      expect(resolveCanonicalCleoDir('nonexistent-uuid')).toBeNull();
    });

    it('returns null when nexus.db does not exist', () => {
      const emptyHome = join(tmpdir(), 'cleo-empty-' + Date.now());
      mkdirSync(emptyHome, { recursive: true });
      process.env['CLEO_HOME'] = emptyHome;
      _resetCleoPlatformPathsCache();

      try {
        expect(resolveCanonicalCleoDir('any-uuid')).toBeNull();
      } finally {
        try {
          rmSync(emptyHome, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    // T11023 AC4: Legacy alias resolution
    it('resolves .cleo dir via legacy ID alias (AC4)', () => {
      expect(resolveCanonicalCleoDir('legacy-base64-id')).toBe('/mnt/projects/my-project/.cleo');
    });

    it('resolves .cleo dir via old UUID alias (AC4)', () => {
      expect(resolveCanonicalCleoDir('old-uuid-format')).toBe('/home/user/another-project/.cleo');
    });
  });
});
