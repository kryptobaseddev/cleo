/**
 * Tests for packages/core/src/sentient/revert-walker.ts
 *
 * Covers:
 *   - collectMergeCommits: returns commits in chronological order (oldest first)
 *   - collectMergeCommits: skips non-merge events (baseline, verify, abort, etc.)
 *   - collectMergeCommits: throws E_RECEIPT_NOT_FOUND if fromReceiptId not in chain
 *   - collectMergeCommits: returns empty array if no merge events after receipt
 *   - collectMergeCommits: humanCommitDetected defaults to false (detection is executor's job)
 *
 * @task T1036
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { E_RECEIPT_NOT_FOUND } from '../chain-walker.js';
import {
  type AbortPayload,
  appendSentientEvent,
  type BaselinePayload,
  type MergePayload,
  type VerifyPayload,
} from '../events.js';
import { collectMergeCommits } from '../revert-walker.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASELINE_PAYLOAD: BaselinePayload = {
  commitSha: 'aaa0000000000000000000000000000000000001',
  baselineHash: 'deadbeef'.repeat(8),
  metricsJson: '{}',
  worktreeNotCreatedYet: true,
};

const VERIFY_PAYLOAD: VerifyPayload = {
  gate: 'testsPassed',
  evidenceAtoms: ['tool:pnpm-test'],
  passed: true,
};

const ABORT_PAYLOAD: AbortPayload = {
  abortReason: 'kill_switch',
  abortAtStep: 3,
  worktreeCleaned: true,
};

function makeMergePayload(commitSha: string, prevHeadSha = '0'.repeat(40)): MergePayload {
  return {
    commitSha,
    mergeStrategy: 'ff-only',
    prevHeadSha,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: AgentIdentity;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-rw-test-'));
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 5;
  identity = await identityFromSeed(seed);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectMergeCommits', () => {
  it('throws E_RECEIPT_NOT_FOUND if fromReceiptId is not in the log', async () => {
    // No events file at all → receipt cannot be found.
    await expect(collectMergeCommits(tmpDir, 'nonExistentReceiptId')).rejects.toThrow(
      E_RECEIPT_NOT_FOUND,
    );
  });

  it('throws E_RECEIPT_NOT_FOUND if receiptId not in a populated log', async () => {
    // Append some events but not with the target receiptId.
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await expect(collectMergeCommits(tmpDir, 'missingReceipt')).rejects.toThrow(
      E_RECEIPT_NOT_FOUND,
    );
  });

  it('returns empty arrays when no merge events exist after the receipt', async () => {
    // Append a baseline event and a verify event — no merges.
    const baseline = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-1',
      taskId: 'T1',
      payload: VERIFY_PAYLOAD,
    });

    const result = await collectMergeCommits(tmpDir, baseline.receiptId);
    expect(result.commits).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.humanCommitDetected).toBe(false);
  });

  it('skips non-merge events (baseline, verify, abort) — only collects merge events', async () => {
    const baseline = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-1',
      taskId: 'T1',
      payload: VERIFY_PAYLOAD,
    });
    const merge1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-1',
      taskId: 'T1',
      payload: makeMergePayload('aaa1111111111111111111111111111111111111'),
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'abort',
      experimentId: 'exp-2',
      taskId: 'T2',
      payload: ABORT_PAYLOAD,
    });

    const result = await collectMergeCommits(tmpDir, baseline.receiptId);

    // Only the one merge event should be collected.
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]).toBe('aaa1111111111111111111111111111111111111');
    expect(result.events[0].receiptId).toBe(merge1.receiptId);
  });

  it('returns merge commits in chronological order (oldest first)', async () => {
    const baseline = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const sha1 = 'bbb1111111111111111111111111111111111111';
    const sha2 = 'ccc2222222222222222222222222222222222222';
    const sha3 = 'ddd3333333333333333333333333333333333333';

    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-1',
      taskId: 'T1',
      payload: makeMergePayload(sha1),
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-2',
      taskId: 'T2',
      payload: makeMergePayload(sha2),
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-3',
      taskId: 'T3',
      payload: makeMergePayload(sha3),
    });

    const result = await collectMergeCommits(tmpDir, baseline.receiptId);

    expect(result.commits).toHaveLength(3);
    expect(result.commits[0]).toBe(sha1); // oldest first
    expect(result.commits[1]).toBe(sha2);
    expect(result.commits[2]).toBe(sha3);
    expect(result.events).toHaveLength(3);
  });

  it('collects only merge events AFTER the starting receipt (inclusive)', async () => {
    // Events before the starting receipt should be ignored.
    const earlyMergeSha = 'eee0000000000000000000000000000000000000';
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-pre',
      taskId: 'T-pre',
      payload: makeMergePayload(earlyMergeSha),
    });

    // This is our anchor receipt.
    const anchor = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const afterSha1 = 'fff1111111111111111111111111111111111111';
    const afterSha2 = 'fff2222222222222222222222222222222222222';
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-a',
      taskId: 'T-a',
      payload: makeMergePayload(afterSha1),
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-b',
      taskId: 'T-b',
      payload: makeMergePayload(afterSha2),
    });

    const result = await collectMergeCommits(tmpDir, anchor.receiptId);

    // Should NOT include the early merge before the anchor.
    expect(result.commits).toHaveLength(2);
    expect(result.commits).not.toContain(earlyMergeSha);
    expect(result.commits[0]).toBe(afterSha1);
    expect(result.commits[1]).toBe(afterSha2);
  });

  it('includes the anchor event itself if it is a merge event', async () => {
    // The anchor receipt itself is a merge event.
    const anchorSha = 'aaa1111111111111111111111111111111111111';
    const anchorMerge = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-anchor',
      taskId: 'T-anchor',
      payload: makeMergePayload(anchorSha),
    });

    const laterSha = 'bbb2222222222222222222222222222222222222';
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-later',
      taskId: 'T-later',
      payload: makeMergePayload(laterSha),
    });

    const result = await collectMergeCommits(tmpDir, anchorMerge.receiptId);

    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]).toBe(anchorSha);
    expect(result.commits[1]).toBe(laterSha);
  });
});
