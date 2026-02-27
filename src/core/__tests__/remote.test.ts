/**
 * Tests for remote module (.cleo/.git push/pull).
 * @task T4884
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  addRemote,
  removeRemote,
  listRemotes,
  getCurrentBranch,
  push,
  pull,
} from '../remote/index.js';

describe('remote', () => {
  let tempDir: string;
  let cleoDir: string;
  let bareRemote: string;
  const origDir = process.env['CLEO_DIR'];
  const origRoot = process.env['CLEO_ROOT'];
  const origHome = process.env['CLEO_HOME'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-remote-test-'));
    cleoDir = join(tempDir, '.cleo');
    bareRemote = join(tempDir, 'remote.git');
    await mkdir(cleoDir, { recursive: true });

    // Initialize .cleo/.git as isolated repo
    execFileSync('git', ['init'], {
      cwd: cleoDir,
      env: {
        ...process.env,
        GIT_DIR: join(cleoDir, '.git'),
        GIT_WORK_TREE: cleoDir,
      },
    });

    // Configure git user for test commits
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: cleoDir,
      env: {
        ...process.env,
        GIT_DIR: join(cleoDir, '.git'),
        GIT_WORK_TREE: cleoDir,
      },
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: cleoDir,
      env: {
        ...process.env,
        GIT_DIR: join(cleoDir, '.git'),
        GIT_WORK_TREE: cleoDir,
      },
    });

    // Create initial commit
    await writeFile(join(cleoDir, 'config.json'), '{"version":"2.10.0"}');
    execFileSync('git', ['add', 'config.json'], {
      cwd: cleoDir,
      env: {
        ...process.env,
        GIT_DIR: join(cleoDir, '.git'),
        GIT_WORK_TREE: cleoDir,
      },
    });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], {
      cwd: cleoDir,
      env: {
        ...process.env,
        GIT_DIR: join(cleoDir, '.git'),
        GIT_WORK_TREE: cleoDir,
      },
    });

    // Create bare remote repo
    execFileSync('git', ['init', '--bare', bareRemote]);

    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_ROOT'] = tempDir;
    process.env['CLEO_HOME'] = join(tempDir, 'global');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
    if (origRoot !== undefined) process.env['CLEO_ROOT'] = origRoot;
    else delete process.env['CLEO_ROOT'];
    if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
    else delete process.env['CLEO_HOME'];
  });

  describe('getCurrentBranch', () => {
    it('returns the current branch name', async () => {
      const branch = await getCurrentBranch(tempDir);
      // Git default branch is 'master' or 'main' depending on config
      expect(['main', 'master']).toContain(branch);
    });
  });

  describe('addRemote / removeRemote / listRemotes', () => {
    it('adds, lists, and removes a remote', async () => {
      // Initially no remotes
      let remotes = await listRemotes(tempDir);
      expect(remotes).toHaveLength(0);

      // Add remote
      await addRemote(bareRemote, 'origin', tempDir);

      // List remotes
      remotes = await listRemotes(tempDir);
      expect(remotes).toHaveLength(1);
      expect(remotes[0].name).toBe('origin');
      expect(remotes[0].fetchUrl).toBe(bareRemote);

      // Remove remote
      await removeRemote('origin', tempDir);
      remotes = await listRemotes(tempDir);
      expect(remotes).toHaveLength(0);
    });

    it('rejects duplicate remote name', async () => {
      await addRemote(bareRemote, 'origin', tempDir);
      await expect(addRemote(bareRemote, 'origin', tempDir)).rejects.toThrow('already exists');
    });
  });

  describe('push / pull', () => {
    it('pushes to and pulls from a bare remote', async () => {
      // Add remote
      await addRemote(bareRemote, 'origin', tempDir);

      // Push initial state
      const pushResult = await push('origin', { setUpstream: true }, tempDir);
      expect(pushResult.success).toBe(true);
      expect(pushResult.remote).toBe('origin');

      // Modify a file and commit
      await writeFile(join(cleoDir, 'config.json'), '{"version":"2.11.0"}');
      const gitEnv = {
        ...process.env,
        GIT_DIR: join(cleoDir, '.git'),
        GIT_WORK_TREE: cleoDir,
      };
      execFileSync('git', ['add', 'config.json'], { cwd: cleoDir, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'update config', '--no-verify'], { cwd: cleoDir, env: gitEnv });

      // Push again
      const pushResult2 = await push('origin', {}, tempDir);
      expect(pushResult2.success).toBe(true);

      // Simulate another contributor by resetting local back one commit
      execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: cleoDir, env: gitEnv });

      // Pull should bring back the update
      const pullResult = await pull('origin', tempDir);
      expect(pullResult.success).toBe(true);
      expect(pullResult.hasConflicts).toBe(false);
    });
  });
});
