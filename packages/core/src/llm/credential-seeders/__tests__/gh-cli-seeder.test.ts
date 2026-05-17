/**
 * Unit tests for the GitHub CLI credential seeder (T9418).
 *
 * `node:child_process` is mocked so no real `gh` is invoked. ENOENT and
 * non-zero exit paths are exercised separately.
 *
 * @task T9418
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock node:child_process BEFORE the SUT loads so the seeder's
// `execFileSync` symbol resolves to the mock.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// SUT imports follow the mock so the mock is wired in time.
const { execFileSync } = await import('node:child_process');
const { GhCliSeeder, ghCliSeeder, readGhAuthToken } = await import('../gh-cli-seeder.js');

const execFileSyncMock = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

beforeEach(() => {
  execFileSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// readGhAuthToken (internal helper)
// ---------------------------------------------------------------------------

describe('readGhAuthToken', () => {
  it('returns the trimmed stdout on success', () => {
    execFileSyncMock.mockReturnValue('gho_abc123\n');
    expect(readGhAuthToken()).toEqual({ token: 'gho_abc123' });
  });

  it('returns null when gh is not installed (ENOENT)', () => {
    const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });
    expect(readGhAuthToken()).toEqual({ token: null });
  });

  it('returns null with a warning when gh exits non-zero', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command failed with exit code 1');
    });
    const result = readGhAuthToken();
    expect(result.token).toBeNull();
    expect(result.warning).toMatch(/gh-cli:.*gh auth token.*failed/);
  });

  it('returns null when stdout is empty', () => {
    execFileSyncMock.mockReturnValue('\n   \n');
    expect(readGhAuthToken()).toEqual({ token: null });
  });

  it('invokes execFileSync with the safe arg list (no shell metacharacters)', () => {
    execFileSyncMock.mockReturnValue('tok\n');
    readGhAuthToken();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 2000,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Seeder contract
// ---------------------------------------------------------------------------

describe('GhCliSeeder', () => {
  it('declares sourceId=gh-cli and provider=openai', () => {
    const seeder = new GhCliSeeder();
    expect(seeder.sourceId).toBe('gh-cli');
    expect(seeder.provider).toBe('openai');
  });

  it('exports a module-level singleton', () => {
    expect(ghCliSeeder).toBeInstanceOf(GhCliSeeder);
  });

  it('returns one OAuth entry when gh prints a token', async () => {
    execFileSyncMock.mockReturnValue('gho_live_token\n');
    const result = await ghCliSeeder.seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      provider: 'openai',
      label: 'gh-cli',
      authType: 'oauth',
      accessToken: 'gho_live_token',
      source: 'gh-cli',
    });
  });

  it('returns empty (no warning) when gh is not installed', async () => {
    const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });
    const result = await ghCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });

  it('returns empty WITH warning when gh exits non-zero', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command failed with exit code 1');
    });
    const result = await ghCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings?.length).toBe(1);
  });

  it('returns empty when gh prints whitespace only', async () => {
    execFileSyncMock.mockReturnValue('   \n');
    const result = await ghCliSeeder.seed();
    expect(result.entries).toEqual([]);
  });
});
