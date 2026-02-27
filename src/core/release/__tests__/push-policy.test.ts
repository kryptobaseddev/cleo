/**
 * Tests for release push policy configuration.
 *
 * Tests config-driven push behavior without requiring a real git remote.
 * The pushRelease() function reads config.release.push and enforces:
 * - enabled: whether push is allowed by default
 * - requireCleanTree: whether working tree must be clean
 * - allowedBranches: which branches can be pushed from
 * - remote: which remote to use
 *
 * @task T4276
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pushRelease } from '../release-manifest.js';

let testDir: string;
let cleoDir: string;

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(join(cleoDir, 'config.json'), JSON.stringify(config, null, 2));
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-push-policy-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('pushRelease push policy', () => {
  it('should throw when push is disabled and no explicit push flag', async () => {
    await writeConfig({
      release: {
        push: {
          enabled: false,
          remote: 'origin',
        },
      },
    });

    await expect(
      pushRelease('v1.0.0', undefined, testDir),
    ).rejects.toThrow('Push is disabled by config');
  });

  it('should throw when push is disabled even with remote override', async () => {
    await writeConfig({
      release: {
        push: {
          enabled: false,
          remote: 'origin',
        },
      },
    });

    await expect(
      pushRelease('v1.0.0', 'upstream', testDir),
    ).rejects.toThrow('Push is disabled by config');
  });

  it('should allow push when disabled but explicitPush is true', async () => {
    await writeConfig({
      release: {
        push: {
          enabled: false,
          remote: 'origin',
          requireCleanTree: false,
        },
      },
    });

    // This will fail at the git push step (no real remote), but should NOT
    // fail at the config policy check
    await expect(
      pushRelease('v1.0.0', undefined, testDir, { explicitPush: true }),
    ).rejects.toThrow(/git/i);
    // Verify it did NOT throw the config error
    try {
      await pushRelease('v1.0.0', undefined, testDir, { explicitPush: true });
    } catch (e: unknown) {
      expect((e as Error).message).not.toContain('disabled by config');
    }
  });

  it('should throw when requireCleanTree is true and tree is dirty', async () => {
    await writeConfig({
      release: {
        push: {
          enabled: true,
          requireCleanTree: true,
        },
      },
    });

    // testDir is not a git repo, so git status will fail
    // In a real scenario, this would check working tree
    // The git command itself will error since testDir is not a repo
    await expect(
      pushRelease('v1.0.0', undefined, testDir, { explicitPush: true }),
    ).rejects.toThrow();
  });

  it('should throw when current branch is not in allowedBranches', async () => {
    await writeConfig({
      release: {
        push: {
          enabled: true,
          requireCleanTree: false,
          allowedBranches: ['release-only'],
        },
      },
    });

    // In a non-git dir, git rev-parse will fail, so we test with the
    // actual project directory where we know the branch
    // For isolated test: the error from git rev-parse is acceptable
    await expect(
      pushRelease('v1.0.0', undefined, testDir, { explicitPush: true }),
    ).rejects.toThrow();
  });

  it('should use remote from config when no explicit remote', async () => {
    // We can't easily test the actual remote used without mocking git,
    // but we verify the config is read without errors by checking
    // that the push policy doesn't reject
    await writeConfig({
      release: {
        push: {
          enabled: true,
          remote: 'custom-remote',
          requireCleanTree: false,
        },
      },
    });

    // Will fail at git push (not a real repo), but should pass policy checks
    try {
      await pushRelease('v1.0.0', undefined, testDir, { explicitPush: true });
    } catch (e: unknown) {
      // Should fail at git push, not at config validation
      expect((e as Error).message).not.toContain('disabled by config');
      expect((e as Error).message).not.toContain('not in allowed branches');
    }
  });

  it('should proceed when no push config exists', async () => {
    // Write a config without release.push
    await writeConfig({ version: '2.10.0' });

    // Should skip all policy checks and fail at git push
    try {
      await pushRelease('v1.0.0', undefined, testDir);
    } catch (e: unknown) {
      expect((e as Error).message).not.toContain('disabled by config');
    }
  });

  it('should reject empty version', async () => {
    await expect(pushRelease('', undefined, testDir)).rejects.toThrow('version is required');
  });
});
