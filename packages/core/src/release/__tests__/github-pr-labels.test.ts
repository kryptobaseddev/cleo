/**
 * Tests for PR label resolution and resilience.
 *
 * Validates the fix for the dogfooded `cleo release ship v2026.5.63` bug
 * where the engine passed `--label latest` to `gh pr create` without
 * checking that the `latest` label existed on the repo (it didn't), which
 * failed the entire PR step and forced manual recovery.
 *
 * The fix:
 *   1. Pre-flight existing labels via `gh label list`
 *   2. Auto-create CLEO-known labels (release/latest/beta/alpha) if missing
 *   3. Drop unknown labels with a warning rather than failing
 *   4. Retry once with no labels if `gh pr create` still rejects them
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));

const { createPullRequest, ensureCleoLabelsExist, listExistingLabels, resolvePRLabels } =
  await import('../github-pr.js');

beforeEach(() => {
  mocks.execFileSync.mockReset();
});

afterEach(() => {
  mocks.execFileSync.mockReset();
});

describe('listExistingLabels', () => {
  it('returns label names from gh label list --json name', () => {
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([{ name: 'bug' }, { name: 'release' }]);
      }
      throw new Error(`unexpected call: ${cmd}`);
    });
    expect(listExistingLabels('/tmp/x')).toEqual(['bug', 'release']);
  });

  it('returns empty array when gh CLI is missing', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('gh not found');
    });
    expect(listExistingLabels()).toEqual([]);
  });
});

describe('ensureCleoLabelsExist', () => {
  it('auto-creates CLEO-known labels that do not exist', () => {
    const created: string[] = [];
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([{ name: 'release' }]);
      }
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'create') {
        created.push(args[2] as string);
        return '';
      }
      throw new Error(`unexpected call: ${cmd}`);
    });

    const out = ensureCleoLabelsExist(['release', 'latest']);
    expect(out.ensured).toEqual(['release', 'latest']);
    expect(out.created).toEqual(['latest']);
    expect(out.missing).toEqual([]);
    expect(created).toEqual(['latest']);
  });

  it('returns missing for unknown labels not in CLEO palette', () => {
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([{ name: 'release' }]);
      }
      throw new Error(`unexpected call: ${cmd}`);
    });

    const out = ensureCleoLabelsExist(['release', 'totally-custom']);
    expect(out.ensured).toEqual(['release']);
    expect(out.missing).toEqual(['totally-custom']);
  });

  it('treats label-create failure as missing rather than throwing', () => {
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([]);
      }
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'create') {
        throw new Error('permission denied');
      }
      throw new Error(`unexpected call: ${cmd}`);
    });

    const out = ensureCleoLabelsExist(['latest']);
    expect(out.ensured).toEqual([]);
    expect(out.missing).toEqual(['latest']);
  });
});

describe('resolvePRLabels', () => {
  it('passes labels through when gh CLI is unavailable', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('no gh');
    });
    expect(resolvePRLabels(['release', 'latest'])).toEqual({
      labels: ['release', 'latest'],
      created: [],
      missing: [],
    });
  });

  it('returns empty resolution when no labels requested', () => {
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(resolvePRLabels([])).toEqual({ labels: [], created: [], missing: [] });
    expect(resolvePRLabels(undefined)).toEqual({ labels: [], created: [], missing: [] });
  });
});

describe('createPullRequest — label resilience', () => {
  it('drops missing custom labels and ships PR successfully', async () => {
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([{ name: 'release' }]);
      }
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'create') {
        return '';
      }
      if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        expect(args).not.toContain('totally-custom');
        expect(args).toContain('release');
        expect(args).toContain('latest');
        return 'https://github.com/owner/repo/pull/999\n';
      }
      throw new Error(`unexpected call: ${cmd} ${JSON.stringify(args)}`);
    });

    const result = await createPullRequest({
      base: 'main',
      head: 'release/v2026.5.63',
      title: 'Release v2026.5.63',
      body: 'body',
      labels: ['release', 'latest', 'totally-custom'],
      version: '2026.5.63',
      epicId: 'T9246',
    });

    expect(result.mode).toBe('created');
    expect(result.prNumber).toBe(999);
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/999');
  });

  it('retries without labels when gh rejects a label after pre-flight', async () => {
    let prCallCount = 0;
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([{ name: 'release' }, { name: 'latest' }]);
      }
      if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        prCallCount++;
        if (prCallCount === 1) {
          const err = new Error('failed') as NodeJS.ErrnoException & { stderr?: string };
          err.stderr = "could not add label: 'latest' not found";
          throw err;
        }
        expect(args).not.toContain('--label');
        return 'https://github.com/owner/repo/pull/1000\n';
      }
      throw new Error(`unexpected call: ${cmd} ${JSON.stringify(args)}`);
    });

    const result = await createPullRequest({
      base: 'main',
      head: 'release/v2026.5.63',
      title: 'Release v2026.5.63',
      body: 'body',
      labels: ['release', 'latest'],
      version: '2026.5.63',
    });

    expect(result.mode).toBe('created');
    expect(result.prNumber).toBe(1000);
    expect(result.instructions).toContain('PR created without labels');
    expect(prCallCount).toBe(2);
  });

  it('returns mode=skipped when PR already exists', async () => {
    mocks.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args?.[0] === '--version') return 'gh version 2.40.0\n';
      if (cmd === 'gh' && args?.[0] === 'label' && args?.[1] === 'list') {
        return JSON.stringify([{ name: 'release' }, { name: 'latest' }]);
      }
      if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        const err = new Error('failed') as NodeJS.ErrnoException & { stderr?: string };
        err.stderr =
          'a pull request for branch "release/v2026.5.63" against branch "main" already exists:\n  https://github.com/owner/repo/pull/55';
        throw err;
      }
      throw new Error(`unexpected call: ${cmd} ${JSON.stringify(args)}`);
    });

    const result = await createPullRequest({
      base: 'main',
      head: 'release/v2026.5.63',
      title: 'Release v2026.5.63',
      body: 'body',
      labels: ['release', 'latest'],
      version: '2026.5.63',
    });

    expect(result.mode).toBe('skipped');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/55');
  });
});
