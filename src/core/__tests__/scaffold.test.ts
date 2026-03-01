/**
 * Tests for core scaffold module.
 * Covers ensure*, check*, strip, and utility functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  fileExists,
  stripCLEOBlocks,
  removeCleoFromRootGitignore,
  generateProjectHash,
  getPackageRoot,
  getCleoVersion,
  getGitignoreContent,
  createDefaultConfig,
  ensureCleoStructure,
  ensureGitignore,
  ensureConfig,
  ensureProjectContext,
  ensureCleoGitRepo,
  checkCleoStructure,
  checkConfig,
  checkGitignore,
  checkSqliteDb,
  ensureSqliteDb,
  REQUIRED_CLEO_SUBDIRS,
  CLEO_GITIGNORE_FALLBACK,
} from '../scaffold.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return join(
    tmpdir(),
    `cleo-scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

// ── Test suites ──────────────────────────────────────────────────────

describe('fileExists', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for an existing readable file', async () => {
    const filePath = join(tmpDir, 'exists.txt');
    writeFileSync(filePath, 'hello');
    expect(await fileExists(filePath)).toBe(true);
  });

  it('returns false for a non-existent file', async () => {
    expect(await fileExists(join(tmpDir, 'nope.txt'))).toBe(false);
  });
});

describe('generateProjectHash', () => {
  it('produces a 12-character hex string', () => {
    const hash = generateProjectHash('/some/project');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic for the same input', () => {
    const a = generateProjectHash('/foo/bar');
    const b = generateProjectHash('/foo/bar');
    expect(a).toBe(b);
  });

  it('produces different hashes for different paths', () => {
    const a = generateProjectHash('/project/a');
    const b = generateProjectHash('/project/b');
    expect(a).not.toBe(b);
  });
});

describe('getPackageRoot', () => {
  it('resolves to a directory containing package.json', () => {
    const root = getPackageRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });
});

describe('getCleoVersion', () => {
  it('returns a non-zero version string from package.json', () => {
    const version = getCleoVersion();
    expect(version).toMatch(/^\d+/);
    expect(version).not.toBe('0.0.0');
  });
});

describe('getGitignoreContent', () => {
  it('returns non-empty gitignore content', () => {
    const content = getGitignoreContent();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('*.db');
  });
});

describe('createDefaultConfig', () => {
  it('returns config with expected shape', () => {
    const config = createDefaultConfig();
    expect(config).toHaveProperty('version');
    expect(config).toHaveProperty('output');
    expect(config).toHaveProperty('backup');
    expect(config).toHaveProperty('hierarchy');
    expect(config).toHaveProperty('session');
    expect(config).toHaveProperty('lifecycle');
  });
});

// ── ensureCleoStructure ──────────────────────────────────────────────

describe('ensureCleoStructure', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(tmpDir, { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .cleo/ and all required subdirs when none exist', async () => {
    const result = await ensureCleoStructure(tmpDir);
    expect(result.action).toBe('created');
    expect(result.path).toBe(join(tmpDir, '.cleo'));

    for (const subdir of REQUIRED_CLEO_SUBDIRS) {
      expect(existsSync(join(tmpDir, '.cleo', subdir))).toBe(true);
    }
  });

  it('returns skipped when .cleo/ already exists', async () => {
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    const result = await ensureCleoStructure(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('is idempotent: calling twice gives skipped the second time', async () => {
    const first = await ensureCleoStructure(tmpDir);
    expect(first.action).toBe('created');

    const second = await ensureCleoStructure(tmpDir);
    expect(second.action).toBe('skipped');
  });
});

// ── ensureGitignore ──────────────────────────────────────────────────

describe('ensureGitignore', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .cleo/.gitignore from template when missing', async () => {
    const result = await ensureGitignore(tmpDir);
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpDir, '.cleo', '.gitignore'))).toBe(true);
  });

  it('repairs when content has drifted from template', async () => {
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), 'old drifted content');
    const result = await ensureGitignore(tmpDir);
    expect(result.action).toBe('repaired');
  });

  it('skips when already current', async () => {
    const template = getGitignoreContent();
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), template);
    const result = await ensureGitignore(tmpDir);
    expect(result.action).toBe('skipped');
  });
});

// ── ensureConfig ─────────────────────────────────────────────────────

describe('ensureConfig', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates default config.json when missing', async () => {
    const result = await ensureConfig(tmpDir);
    // Note: source code checks existsSync after writing, so action is 'repaired' not 'created'
    expect(result.action).toBe('repaired');
    const configPath = join(tmpDir, '.cleo', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config).toHaveProperty('version');
  });

  it('skips when config already exists', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{"version":"1.0.0"}');
    const result = await ensureConfig(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('force overwrites existing config', async () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{"version":"old"}');
    const result = await ensureConfig(tmpDir, { force: true });
    // After force, it should have written a new config (action is 'repaired' since file existed)
    expect(result.action).toBe('repaired');
    const config = JSON.parse(readFileSync(join(tmpDir, '.cleo', 'config.json'), 'utf-8'));
    expect(config.version).toBe('2.10.0');
  });
});

// ── ensureProjectContext ─────────────────────────────────────────────

describe('ensureProjectContext', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates project-context.json when missing', async () => {
    const result = await ensureProjectContext(tmpDir);
    // Note: source code checks existsSync after writing, so action is 'repaired' not 'created'
    expect(result.action).toBe('repaired');
    const contextPath = join(tmpDir, '.cleo', 'project-context.json');
    expect(existsSync(contextPath)).toBe(true);
    const context = JSON.parse(readFileSync(contextPath, 'utf-8'));
    expect(context).toHaveProperty('detectedAt');
  });

  it('skips when fresh (not stale)', async () => {
    const contextPath = join(tmpDir, '.cleo', 'project-context.json');
    writeFileSync(
      contextPath,
      JSON.stringify({ type: 'node', detectedAt: new Date().toISOString() }),
    );
    const result = await ensureProjectContext(tmpDir);
    expect(result.action).toBe('skipped');
  });

  it('refreshes when stale (staleDays exceeded)', async () => {
    const contextPath = join(tmpDir, '.cleo', 'project-context.json');
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    writeFileSync(
      contextPath,
      JSON.stringify({ type: 'node', detectedAt: oldDate.toISOString() }),
    );
    const result = await ensureProjectContext(tmpDir, { staleDays: 30 });
    expect(result.action).toBe('repaired');
  });
});

// ── ensureCleoGitRepo ────────────────────────────────────────────────

describe('ensureCleoGitRepo', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('creates .cleo/.git when missing', async () => {
    const result = await ensureCleoGitRepo(tmpDir);
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpDir, '.cleo', '.git'))).toBe(true);
  });

  it('skips when .cleo/.git already exists (idempotent)', async () => {
    await ensureCleoGitRepo(tmpDir);
    const result = await ensureCleoGitRepo(tmpDir);
    expect(result.action).toBe('skipped');
  });
});

// ── checkCleoStructure ───────────────────────────────────────────────

describe('checkCleoStructure', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(tmpDir, { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns failed when .cleo/ does not exist', () => {
    const result = checkCleoStructure(tmpDir);
    expect(result.status).toBe('failed');
    expect(result.id).toBe('cleo_structure');
  });

  it('returns warning when subdirs are missing', () => {
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    const result = checkCleoStructure(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.details).toHaveProperty('missing');
  });

  it('returns passed when all subdirs exist', async () => {
    await ensureCleoStructure(tmpDir);
    const result = checkCleoStructure(tmpDir);
    expect(result.status).toBe('passed');
  });
});

// ── checkConfig ──────────────────────────────────────────────────────

describe('checkConfig', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns failed when config.json is missing', () => {
    const result = checkConfig(tmpDir);
    expect(result.status).toBe('failed');
  });

  it('returns failed when config.json is invalid JSON', () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), 'not json{{{');
    const result = checkConfig(tmpDir);
    expect(result.status).toBe('failed');
  });

  it('returns passed for valid JSON config', () => {
    writeFileSync(join(tmpDir, '.cleo', 'config.json'), '{"version":"2.10.0"}');
    const result = checkConfig(tmpDir);
    expect(result.status).toBe('passed');
  });
});

// ── checkGitignore ───────────────────────────────────────────────────

describe('checkGitignore', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns warning when .gitignore is missing', () => {
    const result = checkGitignore(tmpDir);
    expect(result.status).toBe('warning');
  });

  it('returns passed when .gitignore matches template', () => {
    const template = getGitignoreContent();
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), template);
    const result = checkGitignore(tmpDir);
    expect(result.status).toBe('passed');
  });

  it('returns warning when .gitignore has drifted', () => {
    writeFileSync(join(tmpDir, '.cleo', '.gitignore'), 'drifted content');
    const result = checkGitignore(tmpDir);
    expect(result.status).toBe('warning');
  });
});

// ── checkSqliteDb ────────────────────────────────────────────────────

describe('checkSqliteDb', () => {
  let tmpDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  it('returns failed when tasks.db does not exist', () => {
    const result = checkSqliteDb(tmpDir);
    expect(result.status).toBe('failed');
    expect(result.id).toBe('sqlite_db');
    expect(result.fix).toBe('cleo init');
  });

  it('returns warning when tasks.db is empty (0 bytes)', () => {
    writeFileSync(join(tmpDir, '.cleo', 'tasks.db'), '');
    const result = checkSqliteDb(tmpDir);
    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo upgrade');
  });

  it('returns passed when tasks.db exists and is non-empty', () => {
    writeFileSync(join(tmpDir, '.cleo', 'tasks.db'), 'SQLite format 3');
    const result = checkSqliteDb(tmpDir);
    expect(result.status).toBe('passed');
    expect(result.fix).toBeNull();
  });
});

// ── removeCleoFromRootGitignore ──────────────────────────────────────

describe('removeCleoFromRootGitignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns removed: false when no .gitignore exists', async () => {
    const result = await removeCleoFromRootGitignore(tmpDir);
    expect(result.removed).toBe(false);
  });

  it('returns removed: false when no .cleo entries found', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
    const result = await removeCleoFromRootGitignore(tmpDir);
    expect(result.removed).toBe(false);
  });

  it('removes .cleo/ entries from root .gitignore', async () => {
    writeFileSync(
      join(tmpDir, '.gitignore'),
      'node_modules/\n.cleo/\ndist/\n',
    );
    const result = await removeCleoFromRootGitignore(tmpDir);
    expect(result.removed).toBe(true);
    const content = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).not.toContain('.cleo');
    expect(content).toContain('node_modules/');
  });

  it('removes .cleo entry without trailing slash', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), '.cleo\nother\n');
    const result = await removeCleoFromRootGitignore(tmpDir);
    expect(result.removed).toBe(true);
    const content = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).not.toContain('.cleo');
  });
});

// ── stripCLEOBlocks ──────────────────────────────────────────────────

describe('stripCLEOBlocks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes CLEO:START/END blocks from a file', async () => {
    const filePath = join(tmpDir, 'AGENTS.md');
    writeFileSync(
      filePath,
      'before\n<!-- CLEO:START -->\ninjected stuff\n<!-- CLEO:END -->\nafter',
    );
    await stripCLEOBlocks(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('CLEO:START');
    expect(content).not.toContain('injected stuff');
    expect(content).toContain('before');
    expect(content).toContain('after');
  });

  it('leaves file unchanged when no blocks present', async () => {
    const filePath = join(tmpDir, 'plain.md');
    const original = '# Just a normal file\nNo blocks here.';
    writeFileSync(filePath, original);
    await stripCLEOBlocks(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe(original);
  });

  it('handles non-existent file gracefully', async () => {
    await expect(
      stripCLEOBlocks(join(tmpDir, 'nonexistent.md')),
    ).resolves.toBeUndefined();
  });
});
