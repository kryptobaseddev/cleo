/**
 * Tests for packages/core/src/sentient/events.ts
 *
 * Covers:
 *   - All 8 event kinds: correct shape validated at append + query time
 *   - appendSentientEvent: sign + persist + return full event
 *   - appendSentientEvent: Merkle chain (parentHash links)
 *   - querySentientEvents: filter by kind, experimentId, after timestamp, limit
 *   - querySentientEvents: missing file → empty array
 *   - verifySentientEventSignature: valid event → true; tampered event → false
 *
 * @task T1022
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AbortPayload,
  BaselinePayload,
  MergePayload,
  PatchProposedPayload,
  RevertPayload,
  SandboxSpawnPayload,
  SentientEvent,
  SignPayload,
  VerifyPayload,
} from '../events.js';
import {
  appendSentientEvent,
  querySentientEvents,
  SENTIENT_EVENTS_FILE,
  verifySentientEventSignature,
} from '../events.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_EXPERIMENT_ID = 'exp-test-0001';
const TEST_TASK_ID = 'T9999';

const BASELINE_PAYLOAD: BaselinePayload = {
  commitSha: 'abc123def456abc123def456abc123def456abc1',
  baselineHash: 'deadbeef'.repeat(8),
  metricsJson: JSON.stringify({ testsPassed: 100, testsFailed: 0 }),
  worktreeNotCreatedYet: true,
};

const SANDBOX_SPAWN_PAYLOAD: SandboxSpawnPayload = {
  experimentId: TEST_EXPERIMENT_ID,
  dockerImage: 'cleo-sandbox/sentient-agent:local',
  worktreePath: '/mnt/experiments/exp-test-0001',
  experimentType: 'code-patch',
};

const PATCH_PROPOSED_PAYLOAD: PatchProposedPayload = {
  taskId: TEST_TASK_ID,
  patchFiles: ['packages/core/src/sentient/kms.ts'],
  patchSummary: 'Add KMS adapter for Ed25519 signing',
};

const VERIFY_PAYLOAD: VerifyPayload = {
  gate: 'testsPassed',
  evidenceAtoms: ['tool:pnpm-test'],
  passed: true,
};

const SIGN_PAYLOAD: SignPayload = {
  gates: ['implemented', 'testsPassed', 'qaPassed'],
  allPassed: true,
};

const MERGE_PAYLOAD: MergePayload = {
  commitSha: 'cafebabe1234cafebabe1234cafebabe12345678',
  mergeStrategy: 'ff-only',
  prevHeadSha: 'abc123def456abc123def456abc123def456abc1',
};

const ABORT_PAYLOAD: AbortPayload = {
  abortReason: 'kill_switch',
  abortAtStep: 6,
  worktreeCleaned: true,
};

const REVERT_PAYLOAD: RevertPayload = {
  fromReceiptId: 'receiptABC',
  revertCommitSha: '11111111222222223333333344444444aaaabbbb',
  revertedRange: ['cafebabe1234cafebabe1234cafebabe12345678'],
  globalPauseSet: true,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: AgentIdentity;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-events-test-'));
  // Generate a fresh identity for each test.
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 1;
  identity = await identityFromSeed(seed);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendSentientEvent — all 8 kinds
// ---------------------------------------------------------------------------

describe('appendSentientEvent — event shapes', () => {
  it('appends a "baseline" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    expect(event.kind).toBe('baseline');
    expect(event.receiptId).toHaveLength(21);
    expect(event.parentHash).toHaveLength(64);
    expect(event.sig).toHaveLength(128); // 64-byte Ed25519 sig → 128 hex chars
    expect(event.pub).toHaveLength(64); // 32-byte pubkey → 64 hex chars
    expect(event.payload).toEqual(BASELINE_PAYLOAD);
  });

  it('appends a "sandbox.spawn" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'sandbox.spawn',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: SANDBOX_SPAWN_PAYLOAD,
    });
    expect(event.kind).toBe('sandbox.spawn');
    expect(event.payload.experimentId).toBe(TEST_EXPERIMENT_ID);
    expect(event.payload.dockerImage).toBe('cleo-sandbox/sentient-agent:local');
  });

  it('appends a "patch.proposed" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'patch.proposed',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: PATCH_PROPOSED_PAYLOAD,
    });
    expect(event.kind).toBe('patch.proposed');
    expect(event.payload.taskId).toBe(TEST_TASK_ID);
    expect(event.payload.patchFiles).toHaveLength(1);
  });

  it('appends a "verify" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: VERIFY_PAYLOAD,
    });
    expect(event.kind).toBe('verify');
    expect(event.payload.gate).toBe('testsPassed');
    expect(event.payload.passed).toBe(true);
  });

  it('appends a "sign" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'sign',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: SIGN_PAYLOAD,
    });
    expect(event.kind).toBe('sign');
    expect(event.payload.allPassed).toBe(true);
    expect(event.payload.gates).toHaveLength(3);
  });

  it('appends a "merge" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: MERGE_PAYLOAD,
    });
    expect(event.kind).toBe('merge');
    expect(event.payload.mergeStrategy).toBe('ff-only');
    expect(event.payload.commitSha).toBe(MERGE_PAYLOAD.commitSha);
  });

  it('appends an "abort" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'abort',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: ABORT_PAYLOAD,
    });
    expect(event.kind).toBe('abort');
    expect(event.payload.abortReason).toBe('kill_switch');
    expect(event.payload.abortAtStep).toBe(6);
    expect(event.payload.worktreeCleaned).toBe(true);
  });

  it('appends a "revert" event with correct shape', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'revert',
      experimentId: '',
      taskId: '',
      payload: REVERT_PAYLOAD,
    });
    expect(event.kind).toBe('revert');
    expect(event.payload.globalPauseSet).toBe(true);
    expect(event.payload.fromReceiptId).toBe('receiptABC');
  });
});

// ---------------------------------------------------------------------------
// Merkle chain linkage
// ---------------------------------------------------------------------------

describe('appendSentientEvent — Merkle chain', () => {
  it('first event has genesis parentHash (64 zeros)', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    expect(event.parentHash).toBe('0'.repeat(64));
  });

  it('second event parentHash equals SHA-256 of first event line', async () => {
    const crypto = await import('node:crypto');

    const event1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const event2 = await appendSentientEvent(tmpDir, identity, {
      kind: 'sandbox.spawn',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: SANDBOX_SPAWN_PAYLOAD,
    });

    // Re-read the file to get the exact bytes that were written.
    const raw = await readFile(join(tmpDir, SENTIENT_EVENTS_FILE), 'utf-8');
    const firstLine = raw.split('\n')[0];
    const expectedHash = crypto.createHash('sha256').update(firstLine, 'utf-8').digest('hex');

    expect(event2.parentHash).toBe(expectedHash);
    // Also verify event1 and event2 are distinct events.
    expect(event2.receiptId).not.toBe(event1.receiptId);
  });

  it('builds a 3-event chain with correct linkage', async () => {
    const crypto = await import('node:crypto');

    const ev1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const ev2 = await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: VERIFY_PAYLOAD,
    });
    const ev3 = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: MERGE_PAYLOAD,
    });

    const raw = await readFile(join(tmpDir, SENTIENT_EVENTS_FILE), 'utf-8');
    const [line1, line2] = raw.split('\n');

    const hash1 = crypto.createHash('sha256').update(line1, 'utf-8').digest('hex');
    const hash2 = crypto.createHash('sha256').update(line2, 'utf-8').digest('hex');

    expect(ev1.parentHash).toBe('0'.repeat(64));
    expect(ev2.parentHash).toBe(hash1);
    expect(ev3.parentHash).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// querySentientEvents
// ---------------------------------------------------------------------------

describe('querySentientEvents', () => {
  it('returns empty array when no events file exists', async () => {
    const events = await querySentientEvents(tmpDir);
    expect(events).toEqual([]);
  });

  it('returns all events when no filter is supplied', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'sandbox.spawn',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: SANDBOX_SPAWN_PAYLOAD,
    });

    const events = await querySentientEvents(tmpDir);
    expect(events).toHaveLength(2);
  });

  it('filters by kind', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: VERIFY_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: MERGE_PAYLOAD,
    });

    const mergeEvents = await querySentientEvents(tmpDir, { kind: 'merge' });
    expect(mergeEvents).toHaveLength(1);
    expect(mergeEvents[0].kind).toBe('merge');
  });

  it('filters by experimentId', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'sandbox.spawn',
      experimentId: 'exp-A',
      taskId: 'T1',
      payload: SANDBOX_SPAWN_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'sandbox.spawn',
      experimentId: 'exp-B',
      taskId: 'T2',
      payload: { ...SANDBOX_SPAWN_PAYLOAD, experimentId: 'exp-B' },
    });

    const expA = await querySentientEvents(tmpDir, { experimentId: 'exp-A' });
    expect(expA).toHaveLength(1);
    expect(expA[0].experimentId).toBe('exp-A');
  });

  it('filters by "after" timestamp', async () => {
    const before = new Date(Date.now() - 10000).toISOString();

    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    // Small delay to ensure second event has later timestamp.
    await new Promise((r) => setTimeout(r, 10));

    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: TEST_EXPERIMENT_ID,
      taskId: TEST_TASK_ID,
      payload: MERGE_PAYLOAD,
    });

    const recent = await querySentientEvents(tmpDir, { after: before });
    expect(recent.length).toBeGreaterThanOrEqual(1);
    for (const ev of recent) {
      expect(ev.timestamp > before).toBe(true);
    }
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await appendSentientEvent(tmpDir, identity, {
        kind: 'abort',
        experimentId: `exp-${i}`,
        taskId: TEST_TASK_ID,
        payload: ABORT_PAYLOAD,
      });
    }

    const limited = await querySentientEvents(tmpDir, { limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// verifySentientEventSignature
// ---------------------------------------------------------------------------

describe('verifySentientEventSignature', () => {
  it('returns true for a freshly appended event', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const valid = await verifySentientEventSignature(event);
    expect(valid).toBe(true);
  });

  it('returns false when the sig is tampered', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    // Flip first byte of the hex signature.
    const tamperedSig = `0000${event.sig.slice(4)}`;
    const tampered: SentientEvent = { ...event, sig: tamperedSig } as SentientEvent;
    const valid = await verifySentientEventSignature(tampered);
    expect(valid).toBe(false);
  });

  it('returns false when the payload is tampered', async () => {
    const event = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    // Tamper with the commit SHA in the payload.
    const tamperedEvent = {
      ...event,
      payload: {
        ...BASELINE_PAYLOAD,
        commitSha: 'tampered000000000000000000000000000000',
      },
    } as SentientEvent;

    const valid = await verifySentientEventSignature(tamperedEvent);
    expect(valid).toBe(false);
  });
});
