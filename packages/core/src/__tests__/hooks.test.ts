/** Public init/upgrade/doctor wrappers use the same real Git installation. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkGitHooks, ensureGitHooks, MANAGED_HOOKS } from '../hooks.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-hooks-wrappers-'));
  execFileSync('git', ['init', '-q', root]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('canonical Git hook wrappers', () => {
  it('installs and inspects all three checks', async () => {
    expect(MANAGED_HOOKS).toEqual(['commit-msg', 'pre-commit', 'pre-push']);
    expect((await ensureGitHooks(root)).action).toBe('created');
    expect((await checkGitHooks(root)).every((result) => result.installed && result.current)).toBe(
      true,
    );
  });
  it('reports missing/outdated files and preserves customized content on upgrade', async () => {
    expect((await checkGitHooks(root)).every((result) => !result.installed)).toBe(true);
    await ensureGitHooks(root);
    const file = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(file, readFileSync(file, 'utf8') + '# custom\n');
    expect(
      (await checkGitHooks(root)).find((result) => result.hook === 'pre-commit')?.current,
    ).toBe(false);
    expect((await ensureGitHooks(root, { force: true })).details).toContain('customized');
    expect(readFileSync(file, 'utf8')).toContain('# custom');
  });
  it('skips a directory that is not a Git repository', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'cleo-no-git-'));
    try {
      expect((await ensureGitHooks(folder)).action).toBe('skipped');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('follows the same configured hooksPath in installation and inspection', async () => {
    execFileSync('git', ['-C', root, 'config', 'core.hooksPath', 'team hooks']);
    await ensureGitHooks(root);
    const checks = await checkGitHooks(root);
    expect(checks.every((result) => result.current)).toBe(true);
    expect(checks[0]?.installedPath).toBe(join(root, 'team hooks', 'commit-msg'));
  });
});
