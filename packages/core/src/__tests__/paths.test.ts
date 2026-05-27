/**
 * Tests for path resolution.
 * @epic T4454
 * @task T4458
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import envPaths from 'env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
