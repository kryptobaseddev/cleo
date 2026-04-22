/**
 * Tests for .cleo/worktree-include pattern loading and application.
 *
 * @task T1161
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyIncludePatterns, loadWorktreeIncludePatterns } from '../worktree-include.js';

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadWorktreeIncludePatterns', () => {
  it('returns empty array when .cleo/worktree-include does not exist', () => {
    const dir = makeTmpDir('no-include');
    const patterns = loadWorktreeIncludePatterns(dir);
    expect(patterns).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  it('parses simple patterns', () => {
    const dir = makeTmpDir('simple-patterns');
    mkdirSync(join(dir, '.cleo'), { recursive: true });
    writeFileSync(join(dir, '.cleo', 'worktree-include'), 'node_modules/.pnpm\n.env.local\n');
    const patterns = loadWorktreeIncludePatterns(dir);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({ pattern: 'node_modules/.pnpm', negated: false });
    expect(patterns[1]).toEqual({ pattern: '.env.local', negated: false });
    rmSync(dir, { recursive: true });
  });

  it('strips comments and blank lines', () => {
    const dir = makeTmpDir('comments');
    mkdirSync(join(dir, '.cleo'), { recursive: true });
    writeFileSync(
      join(dir, '.cleo', 'worktree-include'),
      '# This is a comment\n\nnode_modules/.pnpm\n  \n# Another comment\n.env\n',
    );
    const patterns = loadWorktreeIncludePatterns(dir);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].pattern).toBe('node_modules/.pnpm');
    expect(patterns[1].pattern).toBe('.env');
    rmSync(dir, { recursive: true });
  });

  it('parses negated patterns', () => {
    const dir = makeTmpDir('negated');
    mkdirSync(join(dir, '.cleo'), { recursive: true });
    writeFileSync(join(dir, '.cleo', 'worktree-include'), 'node_modules\n!node_modules/.cache\n');
    const patterns = loadWorktreeIncludePatterns(dir);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({ pattern: 'node_modules', negated: false });
    expect(patterns[1]).toEqual({ pattern: 'node_modules/.cache', negated: true });
    rmSync(dir, { recursive: true });
  });
});

describe('applyIncludePatterns', () => {
  it('creates symlinks for matched source paths', () => {
    const projectRoot = makeTmpDir('project');
    const worktreePath = makeTmpDir('worktree');

    // Create a file in the project root
    const sourceFile = join(projectRoot, 'shared-config.json');
    writeFileSync(sourceFile, '{}');

    const patterns = [{ pattern: 'shared-config.json', negated: false }];
    const applied = applyIncludePatterns(patterns, projectRoot, worktreePath);

    expect(applied).toHaveLength(1);
    expect(applied[0].pattern).toBe('shared-config.json');
    expect(existsSync(join(worktreePath, 'shared-config.json'))).toBe(true);

    rmSync(projectRoot, { recursive: true });
    rmSync(worktreePath, { recursive: true });
  });

  it('skips negated patterns (no symlink created)', () => {
    const projectRoot = makeTmpDir('project');
    const worktreePath = makeTmpDir('worktree');

    const sourceFile = join(projectRoot, '.env.production');
    writeFileSync(sourceFile, 'SECRET=x');

    const patterns = [{ pattern: '.env.production', negated: true }];
    const applied = applyIncludePatterns(patterns, projectRoot, worktreePath);

    expect(applied).toHaveLength(0);
    expect(existsSync(join(worktreePath, '.env.production'))).toBe(false);

    rmSync(projectRoot, { recursive: true });
    rmSync(worktreePath, { recursive: true });
  });

  it('skips patterns where source does not exist', () => {
    const projectRoot = makeTmpDir('project');
    const worktreePath = makeTmpDir('worktree');

    const patterns = [{ pattern: 'nonexistent.txt', negated: false }];
    const applied = applyIncludePatterns(patterns, projectRoot, worktreePath);

    expect(applied).toHaveLength(0);

    rmSync(projectRoot, { recursive: true });
    rmSync(worktreePath, { recursive: true });
  });

  it('skips patterns where target already exists in worktree', () => {
    const projectRoot = makeTmpDir('project');
    const worktreePath = makeTmpDir('worktree');

    writeFileSync(join(projectRoot, 'config.json'), '{}');
    writeFileSync(join(worktreePath, 'config.json'), '{"existing":true}');

    const patterns = [{ pattern: 'config.json', negated: false }];
    const applied = applyIncludePatterns(patterns, projectRoot, worktreePath);

    // Should skip because target already exists
    expect(applied).toHaveLength(0);

    rmSync(projectRoot, { recursive: true });
    rmSync(worktreePath, { recursive: true });
  });
});
