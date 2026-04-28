/**
 * Tests for core/remote — .cleo/.git push/pull/remote operations.
 *
 * All git subprocess calls are mocked at the module level so no real
 * network I/O or git operations occur. Tests cover:
 *   - getCurrentBranch (success + no commits fallback)
 *   - addRemote (success + duplicate error)
 *   - removeRemote (success + error)
 *   - listRemotes (empty + populated)
 *   - push (fast-forward + rejection)
 *   - pull (up-to-date + conflict + fetch failure)
 *   - getSyncStatus (ahead/behind counts)
 *   - ensureCleoGitRepo guard (throws when .git not initialized)
 *
 * @task T1526
 * @epic T1520
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Module mocks — must come before the import under test
// --------------------------------------------------------------------------

// Mock git-checkpoint exports used by remote/index.ts
vi.mock('../../store/git-checkpoint.js', () => ({
  cleoGitCommand: vi.fn(),
  isCleoGitInitialized: vi.fn(),
  makeCleoGitEnv: vi.fn().mockReturnValue({}),
}));

// Mock paths.js — return a stable fake cleoDir
vi.mock('../../paths.js', () => ({
  getCleoDirAbsolute: vi.fn().mockReturnValue('/fake/.cleo'),
}));

// Mock node:child_process so cleoGitExec (execFileAsync) is controllable
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import * as childProcess from 'node:child_process';
import * as gitCheckpoint from '../../store/git-checkpoint.js';
import {
  addRemote,
  getCurrentBranch,
  getSyncStatus,
  listRemotes,
  pull,
  push,
  removeRemote,
} from '../index.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type MockExecFile = ReturnType<typeof vi.fn>;

/**
 * Make execFile call its callback with (null, stdout, stderr) so that
 * promisify(execFile) resolves with { stdout, stderr }.
 */
function mockExecFileSuccess(stdout: string, stderr = ''): void {
  (childProcess.execFile as unknown as MockExecFile).mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, out: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr });
    },
  );
}

/**
 * Make execFile call its callback with an Error so that promisify rejects.
 */
function mockExecFileError(message: string): void {
  (childProcess.execFile as unknown as MockExecFile).mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error(message));
    },
  );
}

type CleoGitCommandMock = ReturnType<typeof vi.fn>;

function mockCleoGitCommand(success: boolean, stdout = ''): void {
  (gitCheckpoint.cleoGitCommand as unknown as CleoGitCommandMock).mockResolvedValueOnce({
    success,
    stdout,
  });
}

// --------------------------------------------------------------------------
// Test lifecycle
// --------------------------------------------------------------------------

beforeEach(() => {
  // Default: repo is initialized
  (gitCheckpoint.isCleoGitInitialized as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------------
// ensureCleoGitRepo guard
// --------------------------------------------------------------------------

describe('ensureCleoGitRepo guard', () => {
  it('throws when .cleo/.git is not initialized', async () => {
    (gitCheckpoint.isCleoGitInitialized as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    await expect(getCurrentBranch()).rejects.toThrow('.cleo/.git not initialized');
  });
});

// --------------------------------------------------------------------------
// getCurrentBranch
// --------------------------------------------------------------------------

describe('getCurrentBranch', () => {
  it('returns the branch name from git rev-parse', async () => {
    mockCleoGitCommand(true, 'main');
    const branch = await getCurrentBranch();
    expect(branch).toBe('main');
  });

  it('returns "main" when rev-parse fails (no commits yet)', async () => {
    mockCleoGitCommand(false, '');
    const branch = await getCurrentBranch();
    expect(branch).toBe('main');
  });

  it('returns "main" when stdout is empty', async () => {
    mockCleoGitCommand(true, '');
    const branch = await getCurrentBranch();
    expect(branch).toBe('main');
  });
});

// --------------------------------------------------------------------------
// addRemote
// --------------------------------------------------------------------------

describe('addRemote', () => {
  it('adds a remote successfully', async () => {
    // remote get-url returns failure (remote does not exist)
    mockCleoGitCommand(false, '');
    // execFile for git remote add
    mockExecFileSuccess('');

    await expect(addRemote('https://github.com/org/repo.git')).resolves.toBeUndefined();
  });

  it('throws when the remote already exists', async () => {
    // remote get-url returns success (remote already exists)
    mockCleoGitCommand(true, 'https://github.com/org/repo.git');

    await expect(addRemote('https://github.com/org/repo.git')).rejects.toThrow(
      "Remote 'origin' already exists",
    );
  });

  it('throws when git remote add fails', async () => {
    mockCleoGitCommand(false, '');
    mockExecFileError('fatal: remote origin already exists');

    await expect(addRemote('https://github.com/org/repo.git')).rejects.toThrow(
      "Failed to add remote 'origin'",
    );
  });

  it('uses custom name when provided', async () => {
    mockCleoGitCommand(false, '');
    mockExecFileSuccess('');

    await expect(addRemote('https://example.com/repo.git', 'upstream')).resolves.toBeUndefined();

    // execFile should have been called with 'remote add upstream ...'
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['remote', 'add', 'upstream']),
      expect.anything(),
      expect.any(Function),
    );
  });
});

// --------------------------------------------------------------------------
// removeRemote
// --------------------------------------------------------------------------

describe('removeRemote', () => {
  it('removes a remote successfully', async () => {
    mockExecFileSuccess('');
    await expect(removeRemote()).resolves.toBeUndefined();
  });

  it('throws when git remote remove fails', async () => {
    mockExecFileError('error: No such remote: origin');
    await expect(removeRemote()).rejects.toThrow("Failed to remove remote 'origin'");
  });
});

// --------------------------------------------------------------------------
// listRemotes
// --------------------------------------------------------------------------

describe('listRemotes', () => {
  it('returns empty array when no remotes configured', async () => {
    mockCleoGitCommand(true, '');
    const remotes = await listRemotes();
    expect(remotes).toEqual([]);
  });

  it('returns empty array when git remote -v fails', async () => {
    mockCleoGitCommand(false, '');
    const remotes = await listRemotes();
    expect(remotes).toEqual([]);
  });

  it('parses fetch and push URLs for a single remote', async () => {
    const remoteOutput = [
      'origin\thttps://github.com/org/repo.git (fetch)',
      'origin\thttps://github.com/org/repo.git (push)',
    ].join('\n');
    mockCleoGitCommand(true, remoteOutput);

    const remotes = await listRemotes();
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toEqual({
      name: 'origin',
      fetchUrl: 'https://github.com/org/repo.git',
      pushUrl: 'https://github.com/org/repo.git',
    });
  });

  it('parses multiple remotes', async () => {
    const remoteOutput = [
      'origin\thttps://github.com/org/repo.git (fetch)',
      'origin\thttps://github.com/org/repo.git (push)',
      'upstream\thttps://github.com/upstream/repo.git (fetch)',
      'upstream\thttps://github.com/upstream/repo.git (push)',
    ].join('\n');
    mockCleoGitCommand(true, remoteOutput);

    const remotes = await listRemotes();
    expect(remotes).toHaveLength(2);
    expect(remotes.map((r) => r.name)).toEqual(['origin', 'upstream']);
  });
});

// --------------------------------------------------------------------------
// push
// --------------------------------------------------------------------------

describe('push', () => {
  it('returns success on fast-forward push', async () => {
    // getCurrentBranch call
    mockCleoGitCommand(true, 'main');
    // execFile for push
    mockExecFileSuccess('', 'To https://github.com/org/repo.git\n   abc123..def456  main -> main');

    const result = await push();
    expect(result.success).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.remote).toBe('origin');
  });

  it('returns failure with rejection message on non-fast-forward', async () => {
    mockCleoGitCommand(true, 'main');
    mockExecFileError('error: failed to push some refs — non-fast-forward');

    const result = await push();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Push rejected');
  });

  it('returns failure with rejection message on "rejected" keyword', async () => {
    mockCleoGitCommand(true, 'main');
    mockExecFileError('! [rejected] main -> main (fetch first)');

    const result = await push();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Push rejected');
  });

  it('returns generic failure for other errors', async () => {
    mockCleoGitCommand(true, 'main');
    mockExecFileError('Connection timed out');

    const result = await push();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Push failed');
  });

  it('includes --force flag when force option is set', async () => {
    mockCleoGitCommand(true, 'feature-branch');
    mockExecFileSuccess('');

    await push('origin', { force: true });

    expect(childProcess.execFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--force']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('includes -u flag when setUpstream option is set', async () => {
    mockCleoGitCommand(true, 'feature-branch');
    mockExecFileSuccess('');

    await push('origin', { setUpstream: true });

    expect(childProcess.execFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-u']),
      expect.anything(),
      expect.any(Function),
    );
  });
});

// --------------------------------------------------------------------------
// pull
// --------------------------------------------------------------------------

describe('pull', () => {
  it('returns "nothing to pull" when remote branch does not exist', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch
    mockExecFileSuccess('');
    // rev-parse --verify remote/main — fails (no remote branch)
    mockCleoGitCommand(false, '');

    const result = await pull();
    expect(result.success).toBe(true);
    expect(result.message).toContain('Nothing to pull');
  });

  it('returns success when merge completes cleanly', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch
    mockExecFileSuccess('');
    // rev-parse --verify — succeeds
    mockCleoGitCommand(true, 'abc123');
    // merge
    mockExecFileSuccess('Already up to date.');

    const result = await pull();
    expect(result.success).toBe(true);
    expect(result.hasConflicts).toBe(false);
  });

  it('returns conflict info when merge has conflicts', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch
    mockExecFileSuccess('');
    // rev-parse --verify — succeeds
    mockCleoGitCommand(true, 'abc123');
    // merge — fails with conflict
    mockExecFileError(
      'Automatic merge failed; fix conflicts and then commit the result.\nCONFLICT (content): Merge conflict in tasks.db',
    );
    // diff --name-only --diff-filter=U
    mockCleoGitCommand(true, 'tasks.db\nconfig.json');

    const result = await pull();
    expect(result.success).toBe(false);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictFiles).toEqual(['tasks.db', 'config.json']);
  });

  it('returns fetch failure when fetch fails', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch — fails
    mockExecFileError('fatal: unable to access remote');

    const result = await pull();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Fetch failed');
  });

  it('returns generic pull failure for unknown errors', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch
    mockExecFileSuccess('');
    // rev-parse --verify
    mockCleoGitCommand(true, 'abc123');
    // merge — fails with unknown error
    mockExecFileError('Something unexpected went wrong');

    const result = await pull();
    expect(result.success).toBe(false);
    expect(result.hasConflicts).toBe(false);
    expect(result.message).toContain('Pull failed');
  });
});

// --------------------------------------------------------------------------
// getSyncStatus
// --------------------------------------------------------------------------

describe('getSyncStatus', () => {
  it('returns 0/0 when rev-list fails', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch (silent — cleoGitCommand)
    mockCleoGitCommand(true, '');
    // rev-list
    mockCleoGitCommand(false, '');

    const status = await getSyncStatus();
    expect(status).toEqual({ ahead: 0, behind: 0, branch: 'main', remote: 'origin' });
  });

  it('parses ahead and behind counts', async () => {
    // getCurrentBranch
    mockCleoGitCommand(true, 'main');
    // fetch
    mockCleoGitCommand(true, '');
    // rev-list
    mockCleoGitCommand(true, '3\t1');

    const status = await getSyncStatus();
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(1);
    expect(status.branch).toBe('main');
  });

  it('returns 0/0 when stdout is empty', async () => {
    mockCleoGitCommand(true, 'main');
    mockCleoGitCommand(true, '');
    mockCleoGitCommand(true, '');

    const status = await getSyncStatus();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });
});
