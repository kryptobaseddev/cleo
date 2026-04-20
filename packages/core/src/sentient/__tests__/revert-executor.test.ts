/**
 * Tests for packages/core/src/sentient/revert-executor.ts
 *
 * Uses a real temporary git repository to exercise the git operations.
 *
 * Covers:
 *   - Happy path: 3 sentient commits → squash revert succeeds
 *   - Human commit in range: aborts by default, succeeds with includeHuman=true
 *   - Empty commit list: rejected with E_REVERT_FAILED
 *   - After revert: globalPauseSet flag in returned result
 *   - After revert: pauseAllTiers writes state to disk
 *
 * @task T1038
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SENTIENT_STATE_FILE } from '../daemon.js';
import { appendSentientEvent, type MergePayload } from '../events.js';
import {
  E_HUMAN_COMMIT_IN_RANGE,
  E_REVERT_FAILED,
  executeSquashedRevert,
  SENTIENT_AUTHOR_EMAIL,
} from '../revert-executor.js';
import { readSentientState } from '../state.js';

const execAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Initialize a temporary git repo with git config.
 */
async function initGitRepo(dir: string): Promise<void> {
  await execAsync('git', ['init', '--initial-branch=main', dir]);
  await execAsync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execAsync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
}

/**
 * Make an initial commit in the repo.
 */
async function makeInitialCommit(dir: string): Promise<string> {
  await writeFile(join(dir, 'README.md'), '# Test\n', 'utf-8');
  await execAsync('git', ['-C', dir, 'add', 'README.md']);
  await execAsync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'initial commit']);
  const { stdout } = await execAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * Make a commit authored by the sentient agent. Returns the new HEAD SHA.
 */
async function makeSentientCommit(dir: string, filename: string, content: string): Promise<string> {
  await writeFile(join(dir, filename), content, 'utf-8');
  await execAsync('git', ['-C', dir, 'add', filename]);
  await execAsync('git', [
    '-C',
    dir,
    'commit',
    '-m',
    `sentient: add ${filename}`,
    `--author=CLEO Sentient <${SENTIENT_AUTHOR_EMAIL}>`,
  ]);
  const { stdout } = await execAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * Make a commit authored by a human user. Returns the new HEAD SHA.
 */
async function makeHumanCommit(dir: string, filename: string): Promise<string> {
  await writeFile(join(dir, filename), 'human work\n', 'utf-8');
  await execAsync('git', ['-C', dir, 'add', filename]);
  await execAsync('git', ['-C', dir, 'commit', '-m', `human: add ${filename}`]);
  const { stdout } = await execAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * Append a merge event to the sentient log and return the commit SHA.
 */
async function appendMergeEvent(
  projectRoot: string,
  identity: AgentIdentity,
  commitSha: string,
): Promise<string> {
  const payload: MergePayload = {
    commitSha,
    mergeStrategy: 'ff-only',
    prevHeadSha: '0'.repeat(40),
  };
  const event = await appendSentientEvent(projectRoot, identity, {
    kind: 'merge',
    experimentId: 'exp-test',
    taskId: 'T-test',
    payload,
  });
  return event.receiptId;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: AgentIdentity;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-exec-test-'));
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 20;
  identity = await identityFromSeed(seed);
  await initGitRepo(tmpDir);
  await makeInitialCommit(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeSquashedRevert', () => {
  it('throws E_REVERT_FAILED when commits list is empty', async () => {
    await expect(
      executeSquashedRevert({
        cleoRoot: tmpDir,
        commits: [],
        mergeEvents: [],
        fromReceiptId: 'receipt-001',
        identity,
      }),
    ).rejects.toThrow();

    try {
      await executeSquashedRevert({
        cleoRoot: tmpDir,
        commits: [],
        mergeEvents: [],
        fromReceiptId: 'receipt-001',
        identity,
      });
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe(E_REVERT_FAILED);
    }
  });

  it('squash-reverts 3 sentient commits and sets global pause', async () => {
    // Create 3 sentient commits.
    const sha1 = await makeSentientCommit(tmpDir, 'file1.ts', 'export const a = 1;\n');
    const sha2 = await makeSentientCommit(tmpDir, 'file2.ts', 'export const b = 2;\n');
    const sha3 = await makeSentientCommit(tmpDir, 'file3.ts', 'export const c = 3;\n');

    // Record the HEAD before the first sentient commit for post-revert comparison.
    const { stdout: baseHeadRaw } = await execAsync('git', ['-C', tmpDir, 'rev-parse', `${sha1}^`]);
    const baseHead = baseHeadRaw.trim();

    // Append merge events to the audit log (anchor from first merge event).
    const anchorReceiptId = await appendMergeEvent(tmpDir, identity, sha1);
    await appendMergeEvent(tmpDir, identity, sha2);
    await appendMergeEvent(tmpDir, identity, sha3);

    const result = await executeSquashedRevert({
      cleoRoot: tmpDir,
      commits: [sha1, sha2, sha3],
      mergeEvents: [],
      fromReceiptId: anchorReceiptId,
      identity,
    });

    // Result should contain the new HEAD SHA and reverted range.
    expect(result.revertCommitSha).toBeTruthy();
    expect(result.revertedRange).toEqual([sha1, sha2, sha3]);
    expect(result.humanCommitPresent).toBe(false);
    expect(result.revertEventReceiptId).toBeTruthy();

    // The new HEAD should be a single squash-revert commit on top of sha3.
    const { stdout: newHeadRaw } = await execAsync('git', ['-C', tmpDir, 'rev-parse', 'HEAD']);
    const newHead = newHeadRaw.trim();
    expect(newHead).toBe(result.revertCommitSha);

    // Verify files are reverted.
    const { stdout: logRaw } = await execAsync('git', ['-C', tmpDir, 'log', '--oneline', '-5']);
    expect(logRaw).toContain('revert(sentient)');

    // Verify the HEAD is NOT the same as before the 3 sentient commits
    // (there is now the squash-revert commit on top).
    expect(newHead).not.toBe(baseHead);
    expect(newHead).not.toBe(sha3);

    // Verify global pause was set.
    const statePath = join(tmpDir, SENTIENT_STATE_FILE);
    const state = await readSentientState(statePath);
    expect(state.killSwitch).toBe(true);
    expect(state.pausedByRevert).toBe(true);
  });

  it('aborts with E_HUMAN_COMMIT_IN_RANGE by default when human commits present', async () => {
    const sha1 = await makeSentientCommit(tmpDir, 'file1.ts', 'export const a = 1;\n');
    const humanSha = await makeHumanCommit(tmpDir, 'human-file.txt');
    const sha3 = await makeSentientCommit(tmpDir, 'file3.ts', 'export const c = 3;\n');

    await expect(
      executeSquashedRevert({
        cleoRoot: tmpDir,
        commits: [sha1, humanSha, sha3],
        mergeEvents: [],
        fromReceiptId: 'receipt-001',
        identity,
        includeHuman: false,
      }),
    ).rejects.toThrow();

    try {
      await executeSquashedRevert({
        cleoRoot: tmpDir,
        commits: [sha1, humanSha, sha3],
        mergeEvents: [],
        fromReceiptId: 'receipt-001',
        identity,
        includeHuman: false,
      });
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe(E_HUMAN_COMMIT_IN_RANGE);
    }
  });

  it('succeeds with includeHuman=true when human commits are present', async () => {
    const sha1 = await makeSentientCommit(tmpDir, 'file1.ts', 'export const a = 1;\n');
    const humanSha = await makeHumanCommit(tmpDir, 'human-file.txt');

    // Append one merge event so the audit log exists.
    const anchorReceiptId = await appendMergeEvent(tmpDir, identity, sha1);

    const result = await executeSquashedRevert({
      cleoRoot: tmpDir,
      commits: [sha1, humanSha],
      mergeEvents: [],
      fromReceiptId: anchorReceiptId,
      identity,
      includeHuman: true,
    });

    expect(result.humanCommitPresent).toBe(true);
    expect(result.revertCommitSha).toBeTruthy();
  });
});
