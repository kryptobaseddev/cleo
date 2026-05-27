import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import envPaths from 'env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCleoPlatformPathsCache,
  getCanonicalTemplatesTildePath,
  getCleoHome,
  getCleoPlatformPaths,
  getCleoSystemInfo,
  getCleoTemplatesTildePath,
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
      process.env['CLEO_HOME'] = join(homedir(), '.temp', 'cleo-injection-chain-XXXXXX', '.cleo-home');
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

  // ── resolveProjectByCwd (T11008) ──────────────────────────────────────

  describe('resolveProjectByCwd()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), 'cleo-paths-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('resolves projectId and projectRoot from .cleo/project-info.json in cwd', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId: 'test-uuid-1234', projectHash: 'abc123' }));

      const result = resolveProjectByCwd(tempDir);
      expect(result).not.toBeNull();
      expect(result!.projectId).toBe('test-uuid-1234');
      expect(result!.projectRoot).toBe(tempDir);
    });

    it('walks up ancestors to find .cleo/project-info.json', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId: 'walk-up-uuid' }));

      const subDir = join(tempDir, 'packages', 'core', 'src');
      mkdirSync(subDir, { recursive: true });

      const result = resolveProjectByCwd(subDir);
      expect(result).not.toBeNull();
      expect(result!.projectId).toBe('walk-up-uuid');
      expect(result!.projectRoot).toBe(tempDir);
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
      writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId: '', projectHash: 'abc' }));
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
      writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId: 'valid-parent-uuid' }));

      const subDir = join(tempDir, 'deep', 'nested');
      mkdirSync(subDir, { recursive: true });

      const result = resolveProjectByCwd(subDir);
      expect(result).not.toBeNull();
      expect(result!.projectId).toBe('valid-parent-uuid');
      expect(result!.projectRoot).toBe(tempDir);
    });

    it('uses process.cwd() when no cwd argument', () => {
      const result = resolveProjectByCwd();
      expect(result).not.toBeNull();
      expect(typeof result!.projectId).toBe('string');
      expect(result!.projectId.length).toBeGreaterThan(0);
    });
  });

  // ── resolveCanonicalCleoDir (T11008) ──────────────────────────────────

  describe('resolveCanonicalCleoDir()', () => {
    let tempCleoHome: string;
    let originalCleoHomeForNexus: string | undefined;

    beforeEach(() => {
      tempCleoHome = join(tmpdir(), 'cleo-nexus-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      mkdirSync(tempCleoHome, { recursive: true });

      const nexusDbPath = join(tempCleoHome, 'nexus.db');
      const db = new DatabaseSync(nexusDbPath);
      db.exec('CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE)');
      const insert = db.prepare('INSERT INTO project_registry (project_id, project_path) VALUES (?, ?)');
      insert.run('known-project-uuid', '/mnt/projects/my-project');
      insert.run('secondary-uuid', '/home/user/another-project');
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
      try { rmSync(tempCleoHome, { recursive: true, force: true }); } catch { /* ignore */ }
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
        try { rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
});
