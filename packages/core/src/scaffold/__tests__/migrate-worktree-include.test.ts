/**
 * Unit tests for the worktree-include migration helper (T9983).
 *
 * @task T9983
 * @epic T9983
 * @saga T9977
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateWorktreeIncludeFile } from '../migrate-worktree-include.js';

function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `cleo-migrate-worktree-include-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  return dir;
}

describe('migrateWorktreeIncludeFile (T9983)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpProject();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns action=noop when neither canonical nor legacy file exists', async () => {
    const result = await migrateWorktreeIncludeFile(projectRoot);
    expect(result.action).toBe('noop');
    expect(result.backupPath).toBeUndefined();
  });

  it('returns action=noop when canonical file is the only one present', async () => {
    writeFileSync(join(projectRoot, '.worktreeinclude'), 'pnpm-lock.yaml\n');
    const result = await migrateWorktreeIncludeFile(projectRoot);
    expect(result.action).toBe('noop');
    // Canonical content is untouched.
    expect(readFileSync(join(projectRoot, '.worktreeinclude'), 'utf-8')).toBe('pnpm-lock.yaml\n');
  });

  it('returns action=dry-run without writing when dryRun=true', async () => {
    writeFileSync(join(projectRoot, '.cleo', 'worktree-include'), '.env.local\n');
    const result = await migrateWorktreeIncludeFile(projectRoot, { dryRun: true });
    expect(result.action).toBe('dry-run');
    // No filesystem mutation.
    expect(existsSync(join(projectRoot, '.worktreeinclude'))).toBe(false);
    expect(existsSync(join(projectRoot, '.cleo', 'worktree-include'))).toBe(true);
  });

  it('migrates legacy → canonical and backs up the legacy file', async () => {
    const legacyContent = '.env.local\nnode_modules/.pnpm\n';
    writeFileSync(join(projectRoot, '.cleo', 'worktree-include'), legacyContent);

    const result = await migrateWorktreeIncludeFile(projectRoot);

    expect(result.action).toBe('migrated');
    expect(result.backupPath).toBeDefined();
    // Canonical file has the legacy contents.
    expect(readFileSync(join(projectRoot, '.worktreeinclude'), 'utf-8')).toBe(legacyContent);
    // Legacy file is gone (moved to backup).
    expect(existsSync(join(projectRoot, '.cleo', 'worktree-include'))).toBe(false);
    // Backup exists with the legacy contents.
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(readFileSync(result.backupPath as string, 'utf-8')).toBe(legacyContent);
  });

  it('on conflict: canonical wins; legacy is backed up; no overwrite of canonical', async () => {
    const canonicalContent = 'canonical-only.txt\n';
    const legacyContent = 'legacy-only.txt\n';
    writeFileSync(join(projectRoot, '.worktreeinclude'), canonicalContent);
    writeFileSync(join(projectRoot, '.cleo', 'worktree-include'), legacyContent);

    const result = await migrateWorktreeIncludeFile(projectRoot);

    expect(result.action).toBe('conflict');
    expect(result.backupPath).toBeDefined();
    // Canonical file is UNCHANGED.
    expect(readFileSync(join(projectRoot, '.worktreeinclude'), 'utf-8')).toBe(canonicalContent);
    // Legacy file moved to backup (lossless).
    expect(existsSync(join(projectRoot, '.cleo', 'worktree-include'))).toBe(false);
    expect(readFileSync(result.backupPath as string, 'utf-8')).toBe(legacyContent);
  });
});
