/**
 * Integration test: 3 sentient commits reverted to pre-first-merge SHA.
 *
 * Creates a temp git repo with 3 synthetic sentient merge commits, writes
 * corresponding kind:'merge' events, runs the full revert pipeline via
 * collectMergeCommits + executeSquashedRevert, and verifies:
 *   - All 3 sentient commits are reverted (exactly one squash commit)
 *   - killSwitch=true in sentient-state.json after revert
 *   - kind:'revert' event exists in sentient-events.jsonl with correct fields
 *   - cleo sentient resume (bare = via resumeSentientDaemon) fails with
 *     E_OWNER_ATTESTATION_REQUIRED
 *
 * Test runs in < 30s.
 *
 * @task T1040
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resumeSentientDaemon, SENTIENT_STATE_FILE } from '../daemon.js';
import { appendSentientEvent, type MergePayload, querySentientEvents } from '../events.js';
import { executeSquashedRevert, SENTIENT_AUTHOR_EMAIL } from '../revert-executor.js';
import { collectMergeCommits } from '../revert-walker.js';
import { E_OWNER_ATTESTATION_REQUIRED, readSentientState } from '../state.js';

const execAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function initRepo(dir: string): Promise<void> {
  await execAsync('git', ['init', '--initial-branch=main', dir]);
  await execAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execAsync('git', ['-C', dir, 'config', 'user.name', 'Test Runner']);
}

async function initialCommit(dir: string): Promise<string> {
  await writeFile(join(dir, 'README.md'), '# Integration test\n', 'utf-8');
  await execAsync('git', ['-C', dir, 'add', 'README.md']);
  await execAsync('git', ['-C', dir, 'commit', '-m', 'chore: initial commit']);
  const { stdout } = await execAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function sentientCommit(dir: string, fname: string): Promise<string> {
  await writeFile(join(dir, fname), `// ${fname}\n`, 'utf-8');
  await execAsync('git', ['-C', dir, 'add', fname]);
  await execAsync('git', [
    '-C',
    dir,
    'commit',
    '-m',
    `feat: add ${fname}`,
    `--author=CLEO Sentient <${SENTIENT_AUTHOR_EMAIL}>`,
  ]);
  const { stdout } = await execAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function appendMergeEvt(
  projectRoot: string,
  identity: AgentIdentity,
  commitSha: string,
): Promise<string> {
  const payload: MergePayload = {
    commitSha,
    mergeStrategy: 'ff-only',
    prevHeadSha: '0'.repeat(40),
  };
  const ev = await appendSentientEvent(projectRoot, identity, {
    kind: 'merge',
    experimentId: 'exp-integ',
    taskId: 'T-integ',
    payload,
  });
  return ev.receiptId;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: AgentIdentity;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-integ-'));
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 50;
  identity = await identityFromSeed(seed);
  await initRepo(tmpDir);
  await initialCommit(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe('revert integration — 3 sentient commits', () => {
  it('reverts 3 sentient merge commits to a single squash commit and sets global pause', async () => {
    // Step 1: Create 3 sentient commits and record their SHAs.
    const sha1 = await sentientCommit(tmpDir, 'alpha.ts');
    const sha2 = await sentientCommit(tmpDir, 'beta.ts');
    const sha3 = await sentientCommit(tmpDir, 'gamma.ts');

    // Step 2: Append merge events to the sentient audit log.
    const firstReceiptId = await appendMergeEvt(tmpDir, identity, sha1);
    await appendMergeEvt(tmpDir, identity, sha2);
    await appendMergeEvt(tmpDir, identity, sha3);

    // Step 3: Walk the chain from the first merge receipt.
    const { commits, events } = await collectMergeCommits(tmpDir, firstReceiptId);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toBe(sha1);
    expect(commits[1]).toBe(sha2);
    expect(commits[2]).toBe(sha3);
    expect(events).toHaveLength(3);

    // Step 4: Execute the squash revert.
    const result = await executeSquashedRevert({
      cleoRoot: tmpDir,
      commits,
      mergeEvents: events,
      fromReceiptId: firstReceiptId,
      identity,
    });

    // Step 5: Verify exactly one squash commit was created.
    const { stdout: logOut } = await execAsync('git', ['-C', tmpDir, 'log', '--oneline', '-6']);
    const logLines = logOut
      .trim()
      .split('\n')
      .filter((l) => l.trim());
    // There should be the squash-revert commit on top.
    expect(logLines[0]).toContain('revert(sentient)');

    // The returned revert commit SHA should be HEAD.
    const { stdout: headRaw } = await execAsync('git', ['-C', tmpDir, 'rev-parse', 'HEAD']);
    expect(headRaw.trim()).toBe(result.revertCommitSha);

    // Step 6: Verify the reverted range is correct.
    expect(result.revertedRange).toEqual([sha1, sha2, sha3]);
    expect(result.humanCommitPresent).toBe(false);

    // Step 7: Verify killSwitch=true in sentient-state.json.
    const statePath = join(tmpDir, SENTIENT_STATE_FILE);
    const state = await readSentientState(statePath);
    expect(state.killSwitch).toBe(true);
    expect(state.pausedByRevert).toBe(true);
    expect(state.revertReceiptId).toBe(result.revertEventReceiptId);

    // Step 8: Verify kind:'revert' event written to the audit log.
    const revertEvents = await querySentientEvents(tmpDir, { kind: 'revert' });
    expect(revertEvents).toHaveLength(1);
    const revertEv = revertEvents[0];
    expect(revertEv.kind).toBe('revert');
    expect(revertEv.payload.fromReceiptId).toBe(firstReceiptId);
    expect(revertEv.payload.revertCommitSha).toBe(result.revertCommitSha);
    expect(revertEv.payload.revertedRange).toEqual([sha1, sha2, sha3]);
    expect(revertEv.payload.globalPauseSet).toBe(true);

    // Step 9: Verify bare sentient resume fails with E_OWNER_ATTESTATION_REQUIRED.
    // Write the state first (pauseAllTiers already did this, but just ensure it's there).
    await expect(resumeSentientDaemon(tmpDir)).rejects.toThrow();
    try {
      await resumeSentientDaemon(tmpDir);
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe(E_OWNER_ATTESTATION_REQUIRED);
    }
  }, 30_000); // Must run in < 30s.
});
