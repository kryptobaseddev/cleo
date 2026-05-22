/**
 * Characterization tests for scaffold.ts — T10066 (T9834c Saga T9831).
 *
 * These tests lock the observable behavior of the 15 ensure/check pairs
 * BEFORE the file is split into 8 sibling modules. They must pass both
 * before and after the decomposition.
 *
 * Covered pairs:
 *   ensure: CleoStructure, Gitignore, WorktreeInclude, Config,
 *           ProjectInfo, ProjectContext, CleoGitRepo, SqliteDb, BrainDb
 *   check:  CleoStructure, Gitignore, Config, ProjectInfo,
 *           ProjectContext, SqliteDb
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkCleoStructure,
  checkConfig,
  checkGitignore,
  checkProjectContext,
  checkProjectInfo,
  checkSqliteDb,
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureConfig,
  ensureGitignore,
  ensureProjectContext,
  ensureProjectInfo,
  ensureSqliteDb,
  ensureWorktreeInclude,
  getGitignoreContent,
  getWorktreeIncludeContent,
  REQUIRED_CLEO_SUBDIRS,
} from '../scaffold.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return join(tmpdir(), `cleo-charact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeProjectDir(): string {
  const dir = makeTmpDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeProjectWithCleo(): string {
  const dir = makeProjectDir();
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  return dir;
}

// ── ensureCleoStructure ───────────────────────────────────────────────

describe('characterization: ensureCleoStructure', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectDir();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .cleo/ with action=created on first call', async () => {
    const result = await ensureCleoStructure(tmpDir);
    expect(result.action).toBe('created');
    expect(result.path).toBe(join(tmpDir, '.cleo'));
    expect(existsSync(join(tmpDir, '.cleo'))).toBe(true);
  });

  it('creates all REQUIRED_CLEO_SUBDIRS', async () => {
    await ensureCleoStructure(tmpDir);
    for (const subdir of REQUIRED_CLEO_SUBDIRS) {
      expect(existsSync(join(tmpDir, '.cleo', subdir))).toBe(true);
    }
  });

  it('returns action=skipped when .cleo/ already exists', async () => {
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    const result = await ensureCleoStructure(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('is fully idempotent (second call skips)', async () => {
    await ensureCleoStructure(tmpDir);
    const result2 = await ensureCleoStructure(tmpDir);
    expect(result2.action).toBe('skipped');
  });
});

// ── ensureGitignore ───────────────────────────────────────────────────

describe('characterization: ensureGitignore', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .cleo/.gitignore when missing with action=created', async () => {
    const result = await ensureGitignore(tmpDir);
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpDir, '.cleo', '.gitignore'))).toBe(true);
  });

  it('returns action=skipped when content matches template', async () => {
    const template = getGitignoreContent();
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), template);
    const result = await ensureGitignore(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('returns action=repaired when content has drifted', async () => {
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), 'drifted content');
    const result = await ensureGitignore(tmpDir);
    expect(result.action).toBe('repaired');
  });
});

// ── ensureWorktreeInclude ─────────────────────────────────────────────

describe('characterization: ensureWorktreeInclude', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .worktreeinclude at the project root when missing (T9983)', async () => {
    const result = await ensureWorktreeInclude(tmpDir);
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpDir, '.worktreeinclude'))).toBe(true);
  });

  it('returns action=skipped when canonical content matches template', async () => {
    const template = getWorktreeIncludeContent();
    writeFileSync(join(tmpDir, '.worktreeinclude'), template);
    const result = await ensureWorktreeInclude(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('returns action=repaired when canonical content has drifted', async () => {
    writeFileSync(join(tmpDir, '.worktreeinclude'), 'old content');
    const result = await ensureWorktreeInclude(tmpDir);
    expect(result.action).toBe('repaired');
  });

  it('returns action=skipped when only the legacy .cleo/worktree-include exists (T9983 — no in-place overwrite)', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'worktree-include'), 'legacy content');
    const result = await ensureWorktreeInclude(tmpDir);
    expect(result.action).toBe('skipped');
    // Canonical file MUST NOT be auto-created here — migration is explicit.
    expect(existsSync(join(tmpDir, '.worktreeinclude'))).toBe(false);
    // Legacy file MUST be preserved verbatim.
    expect(existsSync(join(tmpDir, '.cleo', 'worktree-include'))).toBe(true);
  });
});

// ── ensureConfig ──────────────────────────────────────────────────────

describe('characterization: ensureConfig', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates config.json when missing', async () => {
    const result = await ensureConfig(tmpDir);
    expect(['created', 'repaired']).toContain(result.action);
    expect(existsSync(join(tmpDir, '.cleo', 'config.json'))).toBe(true);
  });

  it('returns action=skipped when config exists (no force)', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{"version":"1.0.0"}');
    const result = await ensureConfig(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('overwrites with force=true', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{"version":"old"}');
    const result = await ensureConfig(tmpDir, { force: true });
    expect(['created', 'repaired']).toContain(result.action);
  });

  it('written config has version field', async () => {
    await ensureConfig(tmpDir);
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(join(tmpDir, '.cleo', 'config.json'), 'utf-8'));
    expect(config).toHaveProperty('version');
    expect(typeof config.version).toBe('string');
  });
});

// ── ensureProjectInfo ─────────────────────────────────────────────────

describe('characterization: ensureProjectInfo', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates project-info.json when missing with action=created', async () => {
    const result = await ensureProjectInfo(tmpDir);
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpDir, '.cleo', 'project-info.json'))).toBe(true);
  });

  it('returns action=skipped when file exists and has projectId', async () => {
    writeFileSync(
      join(tmpDir, '.cleo', 'project-info.json'),
      JSON.stringify({
        projectId: 'abc-123',
        projectHash: 'x',
        cleoVersion: '1',
        lastUpdated: new Date().toISOString(),
      }),
    );
    const result = await ensureProjectInfo(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('returns action=repaired when projectId is missing', async () => {
    writeFileSync(
      join(tmpDir, '.cleo', 'project-info.json'),
      JSON.stringify({ projectHash: 'x', cleoVersion: '1', lastUpdated: new Date().toISOString() }),
    );
    const result = await ensureProjectInfo(tmpDir);
    expect(result.action).toBe('repaired');
    expect(result.details).toContain('projectId');
  });

  it('written file contains projectHash and cleoVersion', async () => {
    await ensureProjectInfo(tmpDir);
    const { readFileSync } = await import('node:fs');
    const info = JSON.parse(readFileSync(join(tmpDir, '.cleo', 'project-info.json'), 'utf-8'));
    expect(info).toHaveProperty('projectHash');
    expect(info).toHaveProperty('cleoVersion');
  });
});

// ── ensureProjectContext ──────────────────────────────────────────────

describe('characterization: ensureProjectContext', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates project-context.json when missing', async () => {
    const result = await ensureProjectContext(tmpDir);
    expect(['created', 'repaired']).toContain(result.action);
    expect(existsSync(join(tmpDir, '.cleo', 'project-context.json'))).toBe(true);
  });

  it('returns action=skipped when file is fresh', async () => {
    writeFileSync(
      join(tmpDir, '.cleo', 'project-context.json'),
      JSON.stringify({ detectedAt: new Date().toISOString() }),
    );
    const result = await ensureProjectContext(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('refreshes when file is stale', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(tmpDir, '.cleo', 'project-context.json'),
      JSON.stringify({ detectedAt: old }),
    );
    const result = await ensureProjectContext(tmpDir, { staleDays: 30 });
    expect(result.action).toBe('repaired');
  });
});

// ── ensureCleoGitRepo ─────────────────────────────────────────────────

describe('characterization: ensureCleoGitRepo', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .cleo/.git with action=created', async () => {
    const result = await ensureCleoGitRepo(tmpDir);
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpDir, '.cleo', '.git'))).toBe(true);
  });

  it('returns action=skipped when .cleo/.git already exists', async () => {
    await ensureCleoGitRepo(tmpDir);
    const result2 = await ensureCleoGitRepo(tmpDir);
    expect(result2.action).toBe('skipped');
  });
});

// ── ensureSqliteDb ────────────────────────────────────────────────────

describe('characterization: ensureSqliteDb', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns action=skipped when tasks.db already exists', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'tasks.db'), 'SQLite format 3');
    const result = await ensureSqliteDb(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('path in result points to tasks.db', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'tasks.db'), 'SQLite format 3');
    const result = await ensureSqliteDb(tmpDir);
    expect(result.path).toContain('tasks.db');
  });
});

// ── ensureBrainDb ─────────────────────────────────────────────────────

describe('characterization: ensureBrainDb', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns action=skipped when brain.db already exists', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'brain.db'), 'SQLite format 3');
    const result = await ensureBrainDb(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('result path points to brain.db', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'brain.db'), 'SQLite format 3');
    const result = await ensureBrainDb(tmpDir);
    expect(result.path).toContain('brain.db');
  });
});

// ── checkCleoStructure ────────────────────────────────────────────────

describe('characterization: checkCleoStructure', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectDir();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns status=failed when .cleo/ does not exist', () => {
    const result = checkCleoStructure(tmpDir);
    expect(result.status).toBe('failed');
    expect(result.id).toBe('cleo_structure');
    expect(result.category).toBe('scaffold');
    expect(result.fix).toBe('cleo init');
  });

  it('returns status=warning when subdirs are missing', () => {
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    const result = checkCleoStructure(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.details).toHaveProperty('missing');
  });

  it('returns status=passed when all subdirs exist', async () => {
    await ensureCleoStructure(tmpDir);
    const result = checkCleoStructure(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });
});

// ── checkGitignore ────────────────────────────────────────────────────

describe('characterization: checkGitignore', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns status=warning when .gitignore is missing', () => {
    const result = checkGitignore(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.id).toBe('cleo_gitignore');
    expect(result.fix).toBe('cleo init --force');
  });

  it('returns status=passed when .gitignore matches template', () => {
    const template = getGitignoreContent();
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), template);
    const result = checkGitignore(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });

  it('returns status=warning when .gitignore has drifted', () => {
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), 'drifted');
    const result = checkGitignore(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo upgrade');
  });
});

// ── checkConfig ───────────────────────────────────────────────────────

describe('characterization: checkConfig', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns status=failed when config.json is missing', () => {
    const result = checkConfig(tmpDir);
    expect(result.status).toBe('failed');
    expect(result.id).toBe('cleo_config');
    expect(result.fix).toBe('cleo init');
  });

  it('returns status=failed when config.json is invalid JSON', () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{not-json}');
    const result = checkConfig(tmpDir);
    expect(result.status).toBe('failed');
    expect(result.fix).toBe('cleo init --force');
  });

  it('returns status=passed for valid JSON config', () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{"version":"2.10.0"}');
    const result = checkConfig(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });
});

// ── checkProjectInfo ──────────────────────────────────────────────────

describe('characterization: checkProjectInfo', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns status=warning when file is missing', () => {
    const result = checkProjectInfo(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.id).toBe('cleo_project_info');
    expect(result.fix).toBe('cleo init');
  });

  it('returns status=warning when required fields are missing', () => {
    writeFileSync(join(tmpDir, '.cleo', 'project-info.json'), '{}');
    const result = checkProjectInfo(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo init --force');
  });

  it('returns status=passed when all required fields are present', () => {
    writeFileSync(
      join(tmpDir, '.cleo', 'project-info.json'),
      JSON.stringify({
        projectHash: 'abc',
        cleoVersion: '1.0',
        lastUpdated: new Date().toISOString(),
      }),
    );
    const result = checkProjectInfo(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });

  it('returns status=failed on invalid JSON', () => {
    writeFileSync(join(tmpDir, '.cleo', 'project-info.json'), '{broken}');
    const result = checkProjectInfo(tmpDir);
    expect(result.status).toBe('failed');
  });
});

// ── checkProjectContext ───────────────────────────────────────────────

describe('characterization: checkProjectContext', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns status=warning when file is missing', () => {
    const result = checkProjectContext(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.id).toBe('cleo_project_context');
    expect(result.fix).toBe('cleo init --detect');
  });

  it('returns status=passed when file is fresh', () => {
    writeFileSync(
      join(tmpDir, '.cleo', 'project-context.json'),
      JSON.stringify({ detectedAt: new Date().toISOString() }),
    );
    const result = checkProjectContext(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });

  it('returns status=warning when file is stale', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(tmpDir, '.cleo', 'project-context.json'),
      JSON.stringify({ detectedAt: old }),
    );
    const result = checkProjectContext(tmpDir, 30);
    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo init --detect');
  });

  it('returns status=failed on invalid JSON', () => {
    writeFileSync(join(tmpDir, '.cleo', 'project-context.json'), '{broken}');
    const result = checkProjectContext(tmpDir);
    expect(result.status).toBe('failed');
  });
});

// ── checkSqliteDb ─────────────────────────────────────────────────────

describe('characterization: checkSqliteDb', () => {
  let tmpDir: string;
  const origCleoDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeProjectWithCleo();
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origCleoDir !== undefined) process.env['CLEO_DIR'] = origCleoDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns status=failed when tasks.db is missing', () => {
    const result = checkSqliteDb(tmpDir);
    expect(result.status).toBe('failed');
    expect(result.id).toBe('sqlite_db');
    expect(result.fix).toBe('cleo init');
  });

  it('returns status=warning when tasks.db is 0 bytes', () => {
    writeFileSync(join(tmpDir, '.cleo', 'tasks.db'), '');
    const result = checkSqliteDb(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo upgrade');
  });

  it('returns status=passed when tasks.db exists and is non-empty', () => {
    writeFileSync(join(tmpDir, '.cleo', 'tasks.db'), 'SQLite format 3');
    const result = checkSqliteDb(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });
});
