/**
 * Integration test for `cleo doctor --migrate-worktree-include` (T9983).
 *
 * Exercises the core migration helper through the same code path the CLI
 * uses, with a temp-project fixture instead of a real CWD.
 *
 * @task T9983
 * @epic T9983
 * @saga T9977
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let projectRoot: string;

describe('doctor --migrate-worktree-include (T9983)', () => {
  beforeEach(() => {
    projectRoot = join(
      tmpdir(),
      `cleo-doctor-migrate-worktreeinclude-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('migrates legacy file to canonical and backs up the original', async () => {
    const legacy = '.env.local\nnode_modules/.pnpm\n';
    writeFileSync(join(projectRoot, '.cleo', 'worktree-include'), legacy);

    const { migrateWorktreeIncludeFile } = await import('@cleocode/core');
    const result = await migrateWorktreeIncludeFile(projectRoot);

    expect(result.action).toBe('migrated');
    expect(readFileSync(join(projectRoot, '.worktreeinclude'), 'utf-8')).toBe(legacy);
    expect(existsSync(join(projectRoot, '.cleo', 'worktree-include'))).toBe(false);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath as string)).toBe(true);
  });

  it('no-op when neither legacy nor canonical exists', async () => {
    const { migrateWorktreeIncludeFile } = await import('@cleocode/core');
    const result = await migrateWorktreeIncludeFile(projectRoot);
    expect(result.action).toBe('noop');
  });

  it('respects dry-run', async () => {
    writeFileSync(join(projectRoot, '.cleo', 'worktree-include'), '.npmrc\n');

    const { migrateWorktreeIncludeFile } = await import('@cleocode/core');
    const result = await migrateWorktreeIncludeFile(projectRoot, { dryRun: true });

    expect(result.action).toBe('dry-run');
    expect(existsSync(join(projectRoot, '.worktreeinclude'))).toBe(false);
    expect(existsSync(join(projectRoot, '.cleo', 'worktree-include'))).toBe(true);
  });
});
