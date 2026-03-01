/**
 * Tests for git hook management utilities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../scaffold.js', () => ({
  getPackageRoot: vi.fn(),
}));

import { getPackageRoot } from '../scaffold.js';
import {
  MANAGED_HOOKS,
  ensureGitHooks,
  checkGitHooks,
} from '../hooks.js';

const mockedGetPackageRoot = vi.mocked(getPackageRoot);

describe('MANAGED_HOOKS', () => {
  it('contains commit-msg and pre-commit', () => {
    expect(MANAGED_HOOKS).toContain('commit-msg');
    expect(MANAGED_HOOKS).toContain('pre-commit');
    expect(MANAGED_HOOKS).toHaveLength(2);
  });
});

describe('ensureGitHooks', () => {
  let tempDir: string;
  let projectRoot: string;
  let packageRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-hooks-test-'));
    projectRoot = join(tempDir, 'project');
    packageRoot = join(tempDir, 'package');
    mockedGetPackageRoot.mockReturnValue(packageRoot);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('installs hooks from templates to .git/hooks/', async () => {
    // Set up .git dir and source templates
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'commit-msg'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(sourceDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');

    const result = await ensureGitHooks(projectRoot);

    expect(result.action).toBe('created');
    expect(result.details).toContain('2');

    const installed = await readFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), 'utf-8');
    expect(installed).toBe('#!/bin/sh\nexit 0\n');
  });

  it('sets executable permission on installed hooks', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'commit-msg'), '#!/bin/sh\nexit 0\n');

    await ensureGitHooks(projectRoot);

    const hookStat = await stat(join(projectRoot, '.git', 'hooks', 'commit-msg'));
    // Check that the file has executable bits set (0o755 = 493)
    // eslint-disable-next-line no-bitwise
    expect(hookStat.mode & 0o111).toBeTruthy();
  });

  it('skips when hooks already installed and current', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    const hookContent = '#!/bin/sh\nexit 0\n';
    await writeFile(join(sourceDir, 'commit-msg'), hookContent);
    await writeFile(join(sourceDir, 'pre-commit'), hookContent);
    // Pre-install hooks
    await writeFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), hookContent);
    await writeFile(join(projectRoot, '.git', 'hooks', 'pre-commit'), hookContent);

    const result = await ensureGitHooks(projectRoot);

    expect(result.action).toBe('skipped');
    expect(result.details).toContain('already installed');
  });

  it('returns skipped when no .git directory exists', async () => {
    // projectRoot exists but has no .git/
    await mkdir(projectRoot, { recursive: true });

    const result = await ensureGitHooks(projectRoot);

    expect(result.action).toBe('skipped');
    expect(result.details).toContain('No .git/');
  });

  it('returns skipped when no source templates directory exists', async () => {
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    // packageRoot exists but has no templates/git-hooks/

    const result = await ensureGitHooks(projectRoot);

    expect(result.action).toBe('skipped');
    expect(result.details).toContain('templates/git-hooks/ not found');
  });

  it('force mode overwrites existing hooks', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });

    const oldContent = '#!/bin/sh\n# old hook\n';
    const newContent = '#!/bin/sh\n# new hook\n';
    await writeFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), oldContent);
    await writeFile(join(sourceDir, 'commit-msg'), newContent);

    const result = await ensureGitHooks(projectRoot, { force: true });

    expect(result.action).toBe('created');
    const installed = await readFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), 'utf-8');
    expect(installed).toBe(newContent);
  });

  it('creates .git/hooks/ directory if it does not exist', async () => {
    // Only .git/ exists, not .git/hooks/
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'commit-msg'), '#!/bin/sh\nexit 0\n');

    const result = await ensureGitHooks(projectRoot);

    expect(result.action).toBe('created');
    const installed = await readFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), 'utf-8');
    expect(installed).toBe('#!/bin/sh\nexit 0\n');
  });
});

describe('checkGitHooks', () => {
  let tempDir: string;
  let projectRoot: string;
  let packageRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-hooks-check-'));
    projectRoot = join(tempDir, 'project');
    packageRoot = join(tempDir, 'package');
    mockedGetPackageRoot.mockReturnValue(packageRoot);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports all hooks installed when they match source', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    const content = '#!/bin/sh\nexit 0\n';
    await writeFile(join(sourceDir, 'commit-msg'), content);
    await writeFile(join(sourceDir, 'pre-commit'), content);
    await writeFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), content);
    await writeFile(join(projectRoot, '.git', 'hooks', 'pre-commit'), content);

    const results = await checkGitHooks(projectRoot);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.installed).toBe(true);
      expect(r.current).toBe(true);
    }
  });

  it('reports missing hooks', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'commit-msg'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(sourceDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    // No hooks installed in .git/hooks/

    const results = await checkGitHooks(projectRoot);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.installed).toBe(false);
      expect(r.current).toBe(false);
    }
  });

  it('reports outdated hooks when content differs from source', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'commit-msg'), '#!/bin/sh\n# v2\n');
    await writeFile(join(projectRoot, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\n# v1\n');

    const results = await checkGitHooks(projectRoot);

    const commitMsg = results.find((r) => r.hook === 'commit-msg')!;
    expect(commitMsg.installed).toBe(true);
    expect(commitMsg.current).toBe(false);
  });

  it('handles no .git directory gracefully', async () => {
    await mkdir(projectRoot, { recursive: true });
    const sourceDir = join(packageRoot, 'templates', 'git-hooks');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'commit-msg'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(sourceDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');

    const results = await checkGitHooks(projectRoot);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.installed).toBe(false);
      expect(r.current).toBe(false);
    }
  });

  it('handles no source templates gracefully', async () => {
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    // No templates directory at all

    const results = await checkGitHooks(projectRoot);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.installed).toBe(false);
      expect(r.current).toBe(false);
    }
  });
});
