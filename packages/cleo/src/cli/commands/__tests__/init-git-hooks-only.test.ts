/** Real Git fixture for the explicit, narrow hooksPath opt-in (T13349). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderer = vi.hoisted(() => ({ cliOutput: vi.fn(), cliError: vi.fn() }));
vi.mock('../../renderers/index.js', () => renderer);

import { initCommand } from '../init.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-git-only-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'core.hooksPath', '.husky']);
  mkdirSync(join(root, '.cleo'));
  writeFileSync(join(root, '.cleo', 'config.json'), '{"preserved":true}');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  renderer.cliError.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('init --git-hooks-only', () => {
  it('defaults to preserving an in-worktree destination in an initialized project', async () => {
    await runCommand(initCommand, { rawArgs: ['--git-hooks-only'] });
    expect(renderer.cliError).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.husky'))).toBe(false);
    expect(readFileSync(join(root, '.cleo', 'config.json'), 'utf8')).toBe('{"preserved":true}');
  });
  it('installs with explicit opt-in while preserving every other init setting', async () => {
    await runCommand(initCommand, { rawArgs: ['--git-hooks-only', '--allow-tracked-hooks-path'] });
    expect(renderer.cliError).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.husky', 'pre-push'))).toBe(true);
    expect(readFileSync(join(root, '.cleo', 'config.json'), 'utf8')).toBe('{"preserved":true}');
    expect(existsSync(join(root, '.cleo', 'backups'))).toBe(false);
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(false);
  });
});
