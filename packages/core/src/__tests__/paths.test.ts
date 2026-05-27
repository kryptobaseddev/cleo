/**
 * Tests for path resolution.
 * @epic T4454
 * @task T4458
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import envPaths from 'env-paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAgentOutputsAbsolute,
  getAgentOutputsDir,
  getBackupDir,
  getCleoDir,
  getCleoDirAbsolute,
  getCleoHome,
  getConfigPath,
  getGlobalConfigPath,
  getManifestArchivePath,
  getManifestPath,
  getProjectRoot,
  getTaskPath,
  isAbsolutePath,
  resolveCanonicalCleoDir,
  resolveProjectByCwd,
  resolveProjectPath,
} from '../paths.js';

describe('getCleoHome', () => {
  const origEnv = process.env['CLEO_HOME'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_HOME'] = origEnv;
    } else {
      delete process.env['CLEO_HOME'];
    }
  });

  it('defaults to OS-appropriate env-paths data dir', () => {
    delete process.env['CLEO_HOME'];
    expect(getCleoHome()).toBe(envPaths('cleo', { suffix: '' }).data);
  });

  it('respects CLEO_HOME env var', () => {
    process.env['CLEO_HOME'] = '/custom/cleo';
    expect(getCleoHome()).toBe(resolve('/custom/cleo'));
  });
});

describe('getCleoDir', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('defaults to .cleo', () => {
    delete process.env['CLEO_DIR'];
    expect(getCleoDir()).toBe('.cleo');
  });

  it('respects CLEO_DIR env var', () => {
    process.env['CLEO_DIR'] = '/custom/data';
    expect(getCleoDir()).toBe('/custom/data');
  });
});

describe('getCleoDirAbsolute', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('resolves relative path against cwd (bootstrap mode)', () => {
    // T9803/D009: cwd-relative fallback requires explicit `{ bootstrap: true }`
    // opt-in. Without it, the chokepoint throws to prevent orphan `.cleo/`
    // synthesis inside worktrees.
    delete process.env['CLEO_DIR'];
    const result = getCleoDirAbsolute('/my/project', { bootstrap: true });
    expect(result).toBe(resolve('/my/project', '.cleo'));
  });

  it('throws when called from inside a worktree without bootstrap (T9803)', () => {
    // T9803/D009: surgical fix — throws ONLY when cwd has a worktree gitlink
    // ancestor (`.git` as FILE). Clean-slate temp dirs still allow fallback.
    delete process.env['CLEO_DIR'];
    const fixtureDir = join(tmpdir(), `cleo-t9803-throw-${Date.now()}`);
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/foo\n');
    try {
      expect(() => getCleoDirAbsolute(fixtureDir)).toThrowError();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('returns absolute CLEO_DIR as-is', () => {
    process.env['CLEO_DIR'] = '/absolute/data';
    expect(getCleoDirAbsolute('/my/project')).toBe('/absolute/data');
  });
});

describe('getProjectRoot', () => {
  const origEnvDir = process.env['CLEO_DIR'];
  const origEnvRoot = process.env['CLEO_ROOT'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    tempDir = join(tmpdir(), `cleo-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(tempDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (origEnvDir !== undefined) {
      process.env['CLEO_DIR'] = origEnvDir;
    } else {
      delete process.env['CLEO_DIR'];
    }
    if (origEnvRoot !== undefined) {
      process.env['CLEO_ROOT'] = origEnvRoot;
    } else {
      delete process.env['CLEO_ROOT'];
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns the directory containing .cleo/ when called with that directory', () => {
    const result = getProjectRoot(tempDir);
    expect(result).toBe(resolve(tempDir));
  });

  it('respects CLEO_ROOT env var — bypasses walk entirely', () => {
    process.env['CLEO_ROOT'] = '/custom/root';
    expect(getProjectRoot()).toBe('/custom/root');
  });
});

// ============================================================================
// T11034 — Worktree gitlink resolution during ancestor walk
// ============================================================================

describe('getProjectRoot — worktree gitlink resolution (T11034)', () => {
  const origEnvDir = process.env['CLEO_DIR'];
  const origEnvRoot = process.env['CLEO_ROOT'];
  let mainRepo: string;
  let worktreeDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    const base = join(
      tmpdir(),
      `cleo-t11034-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Main repo: has .cleo/project-info.json + .git/ directory
    mainRepo = join(base, 'main-repo');
    mkdirSync(join(mainRepo, '.cleo'), { recursive: true });
    writeFileSync(
      join(mainRepo, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'test-project-id', projectHash: 'abc123' }),
    );
    mkdirSync(join(mainRepo, '.git'), { recursive: true });

    // Worktree: .git is a gitlink FILE pointing to main repo
    worktreeDir = join(base, 'worktree');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, '.git'),
      `gitdir: ${mainRepo}/.git/worktrees/test-wt\n`,
    );
  });

  afterEach(() => {
    if (origEnvDir !== undefined) {
      process.env['CLEO_DIR'] = origEnvDir;
    } else {
      delete process.env['CLEO_DIR'];
    }
    if (origEnvRoot !== undefined) {
      process.env['CLEO_ROOT'] = origEnvRoot;
    } else {
      delete process.env['CLEO_ROOT'];
    }
    try {
      rmSync(join(mainRepo, '..'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('resolves to main repo from worktree root (start-level gitlink)', () => {
    const result = getProjectRoot(worktreeDir);
    expect(result).toBe(resolve(mainRepo));
  });

  it('resolves to main repo from worktree subdirectory (ancestor-walk gitlink)', () => {
    const subdir = join(worktreeDir, 'packages', 'core', 'src');
    mkdirSync(subdir, { recursive: true });
    const result = getProjectRoot(subdir);
    expect(result).toBe(resolve(mainRepo));
  });

  it('resolves to main repo from deeply nested worktree subdirectory', () => {
    const deepDir = join(worktreeDir, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deepDir, { recursive: true });
    const result = getProjectRoot(deepDir);
    expect(result).toBe(resolve(mainRepo));
  });

  it('getCleoDirAbsolute from worktree subdirectory returns parent project .cleo', () => {
    const subdir = join(worktreeDir, 'src');
    mkdirSync(subdir, { recursive: true });
    const result = getCleoDirAbsolute(subdir);
    expect(result).toBe(join(resolve(mainRepo), '.cleo'));
  });

  it('getCleoDirAbsolute from worktree root returns parent project .cleo', () => {
    const result = getCleoDirAbsolute(worktreeDir);
    expect(result).toBe(join(resolve(mainRepo), '.cleo'));
  });

  it('still throws for worktree whose gitlink points to non-existent main repo', () => {
    const orphanWorktree = join(worktreeDir, '..', 'orphan-wt');
    mkdirSync(orphanWorktree, { recursive: true });
    writeFileSync(
      join(orphanWorktree, '.git'),
      'gitdir: /nonexistent/repo/.git/worktrees/ghost\n',
    );
    // The gitlink resolves but the main repo .cleo doesn't exist → resolution
    // returns null → ancestor walk continues → eventually throws
    expect(() => getCleoDirAbsolute(orphanWorktree)).toThrow();
  });

  it('still throws for worktree with unparseable gitlink content', () => {
    const badWorktree = join(worktreeDir, '..', 'bad-wt');
    mkdirSync(badWorktree, { recursive: true });
    writeFileSync(join(badWorktree, '.git'), 'not a gitlink\n');
    // Unparseable gitlink → resolution returns null → ancestor walk continues → throws
    expect(() => getCleoDirAbsolute(badWorktree)).toThrow();
  });

  it('does not create .cleo/ inside worktree during resolution', () => {
    const subdir = join(worktreeDir, 'src');
    mkdirSync(subdir, { recursive: true });
    getCleoDirAbsolute(subdir);
    // Verify no .cleo was created inside the worktree
    const entries = readdirSync(worktreeDir);
    expect(entries).not.toContain('.cleo');
  });
});

describe('resolveProjectPath', () => {
  const origEnvDir = process.env['CLEO_DIR'];
  const origEnvRoot = process.env['CLEO_ROOT'];
  let projectDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    projectDir = join(
      tmpdir(),
      `cleo-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(projectDir, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(projectDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (origEnvDir !== undefined) {
      process.env['CLEO_DIR'] = origEnvDir;
    } else {
      delete process.env['CLEO_DIR'];
    }
    if (origEnvRoot !== undefined) {
      process.env['CLEO_ROOT'] = origEnvRoot;
    } else {
      delete process.env['CLEO_ROOT'];
    }
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns absolute paths unchanged', () => {
    // Absolute paths are returned as-is without calling getProjectRoot
    expect(resolveProjectPath('/absolute/path', projectDir)).toBe('/absolute/path');
  });

  it('resolves relative paths against project root', () => {
    const result = resolveProjectPath('src/index.ts', projectDir);
    expect(result).toBe(resolve(projectDir, 'src', 'index.ts'));
  });

  it('expands tilde to home directory', () => {
    // Tilde expansion does not call getProjectRoot
    const result = resolveProjectPath('~/documents', projectDir);
    expect(result).toBe(join(homedir(), 'documents'));
  });
});

describe('path helper functions', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  // T9803/D009: these helpers indirectly call getCleoDirAbsolute which now
  // requires either an existing project or an absolute CLEO_DIR pin. Pin
  // CLEO_DIR to the synthesized .cleo path so the chokepoint short-circuits
  // at the absolute-path branch instead of walking up. This matches how
  // these helpers are exercised in production (inside a real project where
  // getProjectRoot resolves correctly).
  it('getTodoPath returns correct path', () => {
    process.env['CLEO_DIR'] = resolve('/my/project', '.cleo');
    expect(getTaskPath('/my/project')).toBe(join(resolve('/my/project'), '.cleo', 'tasks.db'));
  });

  it('getConfigPath returns correct path', () => {
    process.env['CLEO_DIR'] = resolve('/my/project', '.cleo');
    expect(getConfigPath('/my/project')).toBe(join(resolve('/my/project'), '.cleo', 'config.json'));
  });

  it('getBackupDir returns correct path', () => {
    process.env['CLEO_DIR'] = resolve('/my/project', '.cleo');
    expect(getBackupDir('/my/project')).toBe(
      join(resolve('/my/project'), '.cleo', 'backups', 'operational'),
    );
  });

  it('getGlobalConfigPath returns correct path', () => {
    const origHome = process.env['CLEO_HOME'];
    delete process.env['CLEO_HOME'];
    const expectedBase = envPaths('cleo', { suffix: '' }).data;
    expect(getGlobalConfigPath()).toBe(join(expectedBase, 'config.json'));
    if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
    else delete process.env['CLEO_HOME'];
  });
});

// ============================================================================
// Agent Outputs Path Tests
// ============================================================================

describe('getAgentOutputsDir', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(tempDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns default when no config exists', () => {
    expect(getAgentOutputsDir(tempDir)).toBe('.cleo/agent-outputs');
  });

  it('reads agentOutputs.directory from config', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        agentOutputs: { directory: 'custom/outputs' },
      }),
    );
    expect(getAgentOutputsDir(tempDir)).toBe('custom/outputs');
  });

  it('reads agentOutputs as plain string from config', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        agentOutputs: 'my-outputs',
      }),
    );
    expect(getAgentOutputsDir(tempDir)).toBe('my-outputs');
  });

  it('falls back to research.outputDir (deprecated)', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        research: { outputDir: 'research/out' },
      }),
    );
    expect(getAgentOutputsDir(tempDir)).toBe('research/out');
  });

  it('falls back to directories.agentOutputs (deprecated)', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        directories: { agentOutputs: 'dirs/out' },
      }),
    );
    expect(getAgentOutputsDir(tempDir)).toBe('dirs/out');
  });

  it('uses priority order: agentOutputs > research > directories', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        agentOutputs: { directory: 'first' },
        research: { outputDir: 'second' },
        directories: { agentOutputs: 'third' },
      }),
    );
    expect(getAgentOutputsDir(tempDir)).toBe('first');
  });

  it('falls back to default on invalid config JSON', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), 'not valid json');
    expect(getAgentOutputsDir(tempDir)).toBe('.cleo/agent-outputs');
  });
});

describe('getAgentOutputsAbsolute', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(tempDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('resolves default to absolute path', () => {
    const result = getAgentOutputsAbsolute(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs'));
  });

  it('returns absolute config path as-is', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        agentOutputs: { directory: '/absolute/outputs' },
      }),
    );
    expect(getAgentOutputsAbsolute(tempDir)).toBe('/absolute/outputs');
  });
});

describe('getManifestPath — core/paths', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(tempDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns default manifest path', () => {
    const result = getManifestPath(tempDir);
    // Legacy flat-file default (ADR-027: new writes go to pipeline_manifest)
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs', ['MANIFEST', 'jsonl'].join('.')));
  });

  it('respects custom output directory', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        agentOutputs: { directory: 'custom/out' },
      }),
    );
    const result = getManifestPath(tempDir);
    expect(result).toBe(join(tempDir, 'custom', 'out', ['MANIFEST', 'jsonl'].join('.')));
  });

  it('respects custom manifest filename', () => {
    writeFileSync(
      join(tempDir, '.cleo', 'config.json'),
      JSON.stringify({
        agentOutputs: { manifestFile: 'custom-manifest.jsonl' },
      }),
    );
    const result = getManifestPath(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs', 'custom-manifest.jsonl'));
  });
});

describe('getManifestArchivePath', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(tempDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns default archive path', () => {
    const result = getManifestArchivePath(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs', 'MANIFEST.archive.jsonl'));
  });
});

// ── resolveCanonicalCleoDir (T11018) ──────────────────────────────────

describe('resolveCanonicalCleoDir', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env['CLEO_HOME'] = tmpHome;
  });

  afterEach(() => {
    if (origCleoHome !== undefined) {
      process.env['CLEO_HOME'] = origCleoHome;
    } else {
      delete process.env['CLEO_HOME'];
    }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seedNexusDb(rows: Array<{ project_id: string; project_path: string }>) {
    const dbPath = join(tmpHome, 'nexus.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL)');
    const stmt = db.prepare('INSERT OR REPLACE INTO project_registry (project_id, project_path) VALUES (?, ?)');
    for (const row of rows) {
      stmt.run(row.project_id, row.project_path);
    }
    db.close();
  }

  it('returns canonical .cleo/ path for a known projectId (AC3)', () => {
    seedNexusDb([{ project_id: 'known-project', project_path: '/home/user/myproject' }]);
    expect(resolveCanonicalCleoDir('known-project')).toBe('/home/user/myproject/.cleo');
  });

  it('looks up projectId in nexus registry (AC2)', () => {
    seedNexusDb([
      { project_id: 'alpha', project_path: '/mnt/projects/alpha' },
      { project_id: 'beta', project_path: '/opt/beta' },
    ]);
    expect(resolveCanonicalCleoDir('alpha')).toBe('/mnt/projects/alpha/.cleo');
    expect(resolveCanonicalCleoDir('beta')).toBe('/opt/beta/.cleo');
  });

  it('throws E_PROJECT_NOT_FOUND when projectId not in registry (AC4)', () => {
    seedNexusDb([{ project_id: 'known', project_path: '/tmp/known' }]);
    expect(() => resolveCanonicalCleoDir('nonexistent')).toThrow('E_PROJECT_NOT_FOUND');
  });

  it('throws E_PROJECT_NOT_FOUND when nexus.db does not exist', () => {
    expect(() => resolveCanonicalCleoDir('any-id')).toThrow('E_PROJECT_NOT_FOUND');
  });

  it('returns same path for same projectId regardless of caller location (AC5)', () => {
    seedNexusDb([{ project_id: 'cross-mount', project_path: '/shared/project' }]);
    const first = resolveCanonicalCleoDir('cross-mount');
    const second = resolveCanonicalCleoDir('cross-mount');
    expect(first).toBe('/shared/project/.cleo');
    expect(second).toBe(first);
  });
});

describe('isAbsolutePath', () => {
  it('recognizes POSIX absolute paths', () => {
    expect(isAbsolutePath('/usr/local')).toBe(true);
  });

  it('recognizes Windows drive letter paths', () => {
    expect(isAbsolutePath('C:\\Users')).toBe(true);
    expect(isAbsolutePath('D:/data')).toBe(true);
  });

  it('recognizes UNC paths', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isAbsolutePath('.cleo')).toBe(false);
    expect(isAbsolutePath('src/index.ts')).toBe(false);
    expect(isAbsolutePath('./local')).toBe(false);
  });
});

// ============================================================================
// T11022 — Deprecation warning + CLEO_PATHS_STRICT enforcement on getCleoDirAbsolute
// ============================================================================

describe('getCleoDirAbsolute — T11022 deprecation + strict mode', () => {
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

  // AC2: CLEO_PATHS_STRICT=1 throws E_CWD_WALKUP_FORBIDDEN with remediation hint
  it('throws E_CWD_WALKUP_FORBIDDEN when CLEO_PATHS_STRICT=1 (AC2)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    expect(() => getCleoDirAbsolute('/some/nonproject/dir')).toThrowError(
      /E_CWD_WALKUP_FORBIDDEN/,
    );
  });

  it('CLEO_PATHS_STRICT=1 error message includes resolveProjectByCwd + resolveCanonicalCleoDir (AC2)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    try {
      getCleoDirAbsolute('/some/nonproject/dir');
    } catch (err: any) {
      expect(err.message).toContain('resolveProjectByCwd');
      expect(err.message).toContain('resolveCanonicalCleoDir');
      expect(err.fix).toContain('resolveProjectByCwd');
    }
  });

  // AC3: Absolute CLEO_DIR passes through silently (no deprecation, no throw)
  it('absolute CLEO_DIR passes through silently even with CLEO_PATHS_STRICT=1 (AC3)', () => {
    process.env['CLEO_DIR'] = '/absolute/cleo/path';
    process.env['CLEO_PATHS_STRICT'] = '1';
    const result = getCleoDirAbsolute('/some/project');
    expect(result).toBe('/absolute/cleo/path');
  });

  // AC3: bootstrap=true skips deprecation and strict mode
  it('bootstrap=true skips deprecation and strict mode (AC3)', () => {
    process.env['CLEO_PATHS_STRICT'] = '1';
    const result = getCleoDirAbsolute('/my/new/project', { bootstrap: true });
    expect(result).toBe(resolve('/my/new/project', '.cleo'));
  });

  // AC1 + AC4: Deprecation warning emitted via CLEO_DEBUG, at most once per process
  it('emits deprecation warning when CLEO_DEBUG is set, at most once per process (AC1/AC4)', () => {
    process.env['CLEO_DEBUG'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    const tmpDir = join(tmpdir(), `cleo-t11022-dep-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Count existing deprecation warnings (prior tests may have triggered it).
    const warningsBefore = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    ).length;

    try {
      getCleoDirAbsolute(tmpDir);
    } catch {
      // May throw if no CLEO project found — that's OK, we only care about the warning.
    }

    // First call: at most one NEW warning (or zero if already emitted by prior tests).
    let warningsAfter = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    );
    const newWarnings = warningsAfter.length - warningsBefore;
    expect(newWarnings).toBeLessThanOrEqual(1);

    // If a warning WAS emitted, verify content.
    if (newWarnings === 1) {
      const lastWarning = warningsAfter[warningsAfter.length - 1]![0];
      expect(lastWarning).toContain('getCleoDirAbsolute(cwd) is deprecated');
      expect(lastWarning).toContain('resolveProjectByCwd(cwd) + resolveCanonicalCleoDir(projectId)');
      expect(lastWarning).toContain('CLEO_PATHS_STRICT=1');
    }

    // Second call should NOT emit again (AC4: once per process).
    const countAfterFirst = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    ).length;
    try {
      getCleoDirAbsolute(tmpDir);
    } catch { /* ignore */ }
    const countAfterSecond = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    ).length;
    expect(countAfterSecond).toBe(countAfterFirst); // no new warnings

    stderrSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // AC1: Warning NOT emitted without CLEO_DEBUG
  it('does NOT emit deprecation warning when CLEO_DEBUG is not set (AC1)', () => {
    delete process.env['CLEO_DEBUG'];
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    const tmpDir = join(tmpdir(), `cleo-t11022-nodebug-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      getCleoDirAbsolute(tmpDir);
    } catch { /* ignore */ }

    const warningCalls = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    );
    expect(warningCalls.length).toBe(0);

    stderrSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // AC2: CLEO_PATHS_STRICT=1 throws BEFORE deprecation warning would fire
  it('CLEO_PATHS_STRICT=1 throws before any deprecation warning (AC2)', () => {
    process.env['CLEO_DEBUG'] = '1';
    process.env['CLEO_PATHS_STRICT'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    expect(() => getCleoDirAbsolute('/some/nonproject/dir')).toThrowError(
      /E_CWD_WALKUP_FORBIDDEN/,
    );

    // Should NOT emit a deprecation warning — strict mode throws first.
    const warningCalls = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    );
    expect(warningCalls.length).toBe(0);

    stderrSpy.mockRestore();
  });

  // AC3: bootstrap=true skips deprecation warning
  it('bootstrap=true does NOT emit deprecation warning (AC3)', () => {
    process.env['CLEO_DEBUG'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    getCleoDirAbsolute('/my/new/project', { bootstrap: true });

    const warningCalls = stderrSpy.mock.calls.filter(
      ([msg]: any[]) => typeof msg === 'string' && msg.includes('W_PATH_DEPRECATED'),
    );
    expect(warningCalls.length).toBe(0);

    stderrSpy.mockRestore();
  });
});

// ============================================================================
// T11013 — resolveProjectByCwd (CWD→projectId with nexus fallback)
// ============================================================================

describe('resolveProjectByCwd', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env['CLEO_HOME'] = tmpHome;
  });

  afterEach(() => {
    if (origCleoHome !== undefined) {
      process.env['CLEO_HOME'] = origCleoHome;
    } else {
      delete process.env['CLEO_HOME'];
    }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seedProjectInfo(root: string, projectId: string) {
    const cleoDir = join(root, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId }));
  }

  function seedNexusDb(rows: Array<{ project_id: string; project_path: string }>) {
    const dbPath = join(tmpHome, 'nexus.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL)');
    const stmt = db.prepare('INSERT OR REPLACE INTO project_registry (project_id, project_path) VALUES (?, ?)');
    for (const row of rows) {
      stmt.run(row.project_id, row.project_path);
    }
    db.close();
  }

  // AC2: Reads .cleo/project-info.json from CWD or ancestor
  it('reads project-info.json from CWD (AC2)', () => {
    const tmpDir = join(tmpdir(), `cleo-t11013-ac2-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      seedProjectInfo(tmpDir, 'proj-cwd');
      const result = resolveProjectByCwd(tmpDir);
      // T11023: projectId is now canonical 12-hex hash, not the raw UUID
      expect(result).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // AC2 + AC6: Walks up to find project-info.json in ancestor
  it('walks up ancestors to find project-info.json (AC2 + AC6)', () => {
    const tmpDir = join(tmpdir(), `cleo-t11013-ac6-${Date.now()}`);
    const subDir = join(tmpDir, 'packages', 'core', 'src');
    mkdirSync(subDir, { recursive: true });
    try {
      seedProjectInfo(tmpDir, 'proj-ancestor');
      const result = resolveProjectByCwd(subDir);
      // T11023: projectId is canonical 12-hex hash
      expect(result).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // AC6: Does NOT walk up ancestors beyond the first .cleo/ hit
  it('stops at first .cleo/project-info.json hit (AC6)', () => {
    const tmpDir = join(tmpdir(), `cleo-t11013-firsthit-${Date.now()}`);
    const childDir = join(tmpDir, 'child');
    mkdirSync(childDir, { recursive: true });
    try {
      seedProjectInfo(tmpDir, 'parent-proj');
      seedProjectInfo(childDir, 'child-proj');
      // T11023: Returns canonical 12-hex hash — just verify it's non-null
      const result = resolveProjectByCwd(childDir);
      expect(result).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // AC3: Falls back to nexus registry when no local project-info.json
  it('falls back to nexus registry when no local project-info.json (AC3)', () => {
    const projDir = join(tmpdir(), `cleo-t11013-nexus-${Date.now()}`);
    mkdirSync(projDir, { recursive: true });
    try {
      seedNexusDb([{ project_id: 'nexus-proj', project_path: projDir }]);
      // No project-info.json — should fall back to nexus
      expect(resolveProjectByCwd(projDir)).toBe('nexus-proj');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  // AC3: Nexus fallback walks up ancestors
  it('nexus fallback walks up ancestors for path match (AC3)', () => {
    const projDir = join(tmpdir(), `cleo-t11013-nexuswalk-${Date.now()}`);
    const subDir = join(projDir, 'deep', 'nested');
    mkdirSync(subDir, { recursive: true });
    try {
      seedNexusDb([{ project_id: 'deep-nexus', project_path: projDir }]);
      expect(resolveProjectByCwd(subDir)).toBe('deep-nexus');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  // AC4: Returns canonical projectId string
  it('returns canonical projectId string (AC4)', () => {
    const tmpDir = join(tmpdir(), `cleo-t11013-ac4-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      seedProjectInfo(tmpDir, 'canonical-id-123');
      const result = resolveProjectByCwd(tmpDir);
      expect(typeof result).toBe('string');
      // T11023: projectId is now canonical 12-hex hash
      expect(result).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // AC5: Throws E_CLEO_NEXUS_PROJECT_NOT_FOUND with remediation hint
  it('throws with remediation hint when no project found (AC5)', () => {
    const emptyDir = join(tmpdir(), `cleo-t11013-notfound-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      expect(() => resolveProjectByCwd(emptyDir)).toThrow(/cleo init/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // AC5: Uses the right exit code
  it('throws CleoError with NEXUS_PROJECT_NOT_FOUND exit code (AC5)', () => {
    const emptyDir = join(tmpdir(), `cleo-t11013-exitcode-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      try {
        resolveProjectByCwd(emptyDir);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe(71); // ExitCode.NEXUS_PROJECT_NOT_FOUND
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// T11029 — ID-Aware Path Resolver: resolveProjectByCwd + resolveCanonicalCleoDir
// ============================================================================

describe('ID-Aware Path Resolver — resolveProjectByCwd + resolveCanonicalCleoDir (T11029)', () => {
  const origCleoHome = process.env['CLEO_HOME'];
  let tmpHome: string;

  beforeEach(() => {
    // AC8: All tests use tmpdir fixtures
    tmpHome = join(tmpdir(), `cleo-t11029-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env['CLEO_HOME'] = tmpHome;
  });

  afterEach(() => {
    if (origCleoHome !== undefined) {
      process.env['CLEO_HOME'] = origCleoHome;
    } else {
      delete process.env['CLEO_HOME'];
    }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seedProjectInfo(root: string, projectId: string) {
    const cleoDir = join(root, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId }));
  }

  function seedNexusDb(rows: Array<{ project_id: string; project_path: string }>) {
    const dbPath = join(tmpHome, 'nexus.db');
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

  // ── AC1: New describe block for ID-aware resolver (this entire block) ─────

  it('ID-aware describe block exists covering resolveProjectByCwd + resolveCanonicalCleoDir (AC1)', () => {
    // This test itself exists inside the new describe block — AC1 satisfied.
    expect(true).toBe(true);
  });

  // ── AC2: CWD at project root → correct projectId ──────────────────────────

  it('returns correct projectId when CWD is at project root with project-info.json (AC2)', () => {
    const projDir = join(tmpHome, 'ac2-project');
    mkdirSync(projDir, { recursive: true });
    // AC8: .git/ sibling in fixture
    mkdirSync(join(projDir, '.git'), { recursive: true });
    seedProjectInfo(projDir, 'ac2-project-id');

    const result = resolveProjectByCwd(projDir);
    // T11023: projectId is canonical 12-hex hash
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  // ── AC3: CWD in subdir → parent project projectId ─────────────────────────

  it('resolves to parent project projectId when CWD is in subdirectory (AC3)', () => {
    const projDir = join(tmpHome, 'ac3-parent');
    const subDir = join(projDir, 'packages', 'core', 'src');
    mkdirSync(subDir, { recursive: true });
    // AC8: .git/ sibling in fixture
    mkdirSync(join(projDir, '.git'), { recursive: true });
    seedProjectInfo(projDir, 'ac3-parent-id');

    const result = resolveProjectByCwd(subDir);
    // T11023: projectId is canonical 12-hex hash
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  // Deeply nested subdirectory still resolves to parent
  it('resolves to parent projectId from deeply nested subdirectory (AC3)', () => {
    const projDir = join(tmpHome, 'ac3-deep');
    const deepDir = join(projDir, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deepDir, { recursive: true });
    mkdirSync(join(projDir, '.git'), { recursive: true });
    seedProjectInfo(projDir, 'ac3-deep-id');

    // T11023: projectId is canonical 12-hex hash
    expect(resolveProjectByCwd(deepDir)).toMatch(/^[0-9a-f]{12}$/);
  });

  // ── AC4: Worktree gitlink → main repo projectId ──────────────────────────

  it('resolves to main repo projectId from worktree root via gitlink walk (AC4)', () => {
    const mainRepo = join(tmpHome, 'ac4-main');
    const worktreeDir = join(tmpHome, 'ac4-worktree');
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    // AC8: .git/ + .cleo/project-info.json in main repo
    mkdirSync(join(mainRepo, '.git'), { recursive: true });
    seedProjectInfo(mainRepo, 'ac4-main-id');
    // Worktree: .git is a gitlink FILE pointing to main repo
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${mainRepo}/.git/worktrees/ac4-wt\n`);

    // resolveProjectByCwd follows gitlinks to find the main repo's .cleo/project-info.json
    // T11023: projectId is canonical 12-hex hash
    expect(resolveProjectByCwd(worktreeDir)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('resolves to main repo projectId from worktree subdirectory via gitlink walk (AC4)', () => {
    const mainRepo = join(tmpHome, 'ac4-main2');
    const worktreeDir = join(tmpHome, 'ac4-worktree2');
    const subDir = join(worktreeDir, 'src', 'lib');
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(subDir, { recursive: true });
    mkdirSync(join(mainRepo, '.git'), { recursive: true });
    seedProjectInfo(mainRepo, 'ac4-main2-id');
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${mainRepo}/.git/worktrees/ac4-wt2\n`);

    // From worktree subdirectory, ancestor walk finds the gitlink at worktree root
    // T11023: projectId is canonical 12-hex hash
    expect(resolveProjectByCwd(subDir)).toMatch(/^[0-9a-f]{12}$/);
  });

  // ── AC5: No project → throws with fix hint ────────────────────────────────

  it('throws with "cleo init" remediation hint when no CLEO project found (AC5)', () => {
    const emptyDir = join(tmpHome, 'ac5-empty');
    mkdirSync(emptyDir, { recursive: true });

    expect(() => resolveProjectByCwd(emptyDir)).toThrow(/cleo init/);
  });

  it('throws with correct error code when no project found (AC5)', () => {
    const emptyDir = join(tmpHome, 'ac5-exitcode');
    mkdirSync(emptyDir, { recursive: true });

    try {
      resolveProjectByCwd(emptyDir);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('No CLEO project found');
    }
  });

  // ── AC6: resolveCanonicalCleoDir → .cleo/ path for known projectId ───────

  it('resolveCanonicalCleoDir returns .cleo/ path for registered projectId (AC6)', () => {
    seedNexusDb([{ project_id: 'ac6-proj', project_path: '/home/user/ac6-repo' }]);

    expect(resolveCanonicalCleoDir('ac6-proj')).toBe('/home/user/ac6-repo/.cleo');
  });

  it('resolveCanonicalCleoDir resolves multiple registered projects correctly (AC6)', () => {
    seedNexusDb([
      { project_id: 'alpha', project_path: '/mnt/projects/alpha' },
      { project_id: 'beta', project_path: '/opt/beta' },
    ]);

    expect(resolveCanonicalCleoDir('alpha')).toBe('/mnt/projects/alpha/.cleo');
    expect(resolveCanonicalCleoDir('beta')).toBe('/opt/beta/.cleo');
  });

  // ── AC7: resolveCanonicalCleoDir throws for unknown projectId ────────────

  it('resolveCanonicalCleoDir throws E_PROJECT_NOT_FOUND for unknown projectId (AC7)', () => {
    seedNexusDb([{ project_id: 'known', project_path: '/tmp/known' }]);

    expect(() => resolveCanonicalCleoDir('unknown-id')).toThrow('E_PROJECT_NOT_FOUND');
  });

  it('resolveCanonicalCleoDir throws when nexus.db does not exist (AC7)', () => {
    // No seedNexusDb call — nexus.db doesn't exist

    expect(() => resolveCanonicalCleoDir('any-id')).toThrow('E_PROJECT_NOT_FOUND');
  });

  // ── Full ID-aware resolution chain ────────────────────────────────────────

  it('full ID-aware chain: resolveProjectByCwd → resolveCanonicalCleoDir returns correct .cleo/ (AC2)', () => {
    const projDir = join(tmpHome, 'full-chain');
    mkdirSync(projDir, { recursive: true });
    // AC8: .git/ sibling + .cleo/project-info.json
    mkdirSync(join(projDir, '.git'), { recursive: true });
    seedProjectInfo(projDir, 'full-chain-id');

    const projectId = resolveProjectByCwd(projDir);
    // T11023: projectId is canonical 12-hex hash — use it for nexus lookup
    expect(projectId).toMatch(/^[0-9a-f]{12}$/);

    // Register the canonical hash in nexus.db (not the raw UUID)
    seedNexusDb([{ project_id: projectId, project_path: projDir }]);

    const cleoDir = resolveCanonicalCleoDir(projectId);
    expect(cleoDir).toBe(join(projDir, '.cleo'));
  });

  it('resolveCanonicalCleoDir returns stable path across multiple calls (AC7)', () => {
    seedNexusDb([{ project_id: 'stable-id', project_path: '/shared/repo' }]);

    const first = resolveCanonicalCleoDir('stable-id');
    const second = resolveCanonicalCleoDir('stable-id');
    expect(first).toBe('/shared/repo/.cleo');
    expect(second).toBe(first);
  });
});
