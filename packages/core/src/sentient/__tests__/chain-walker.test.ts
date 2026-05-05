/**
 * Tests for packages/core/src/sentient/chain-walker.ts
 *
 * Covers:
 *   - verifyEventChain: intact chain → { broken: 0 }
 *   - verifyEventChain: mutated event line → { broken: N, firstBrokenAt }
 *   - verifyEventChain: empty/absent log → { total: 0, broken: 0 }
 *   - walkChainFrom: returns events from receiptId to HEAD
 *   - walkChainFrom: events are in chronological order
 *   - walkChainFrom: non-existent receiptId → throws E_RECEIPT_NOT_FOUND
 *   - walkChainFrom: absent log → throws E_RECEIPT_NOT_FOUND
 *
 * @task T1025
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { E_RECEIPT_NOT_FOUND, verifyEventChain, walkChainFrom } from '../chain-walker.js';
import {
  appendSentientEvent,
  type BaselinePayload,
  type MergePayload,
  SENTIENT_EVENTS_FILE,
  type VerifyPayload,
} from '../events.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASELINE_PAYLOAD: BaselinePayload = {
  commitSha: 'abc123def456abc123def456abc123def456abc1',
  baselineHash: 'deadbeef'.repeat(8),
  metricsJson: JSON.stringify({ testsPassed: 42 }),
  worktreeNotCreatedYet: true,
};

const VERIFY_PAYLOAD: VerifyPayload = {
  gate: 'testsPassed',
  evidenceAtoms: ['tool:pnpm-test'],
  passed: true,
};

const MERGE_PAYLOAD: MergePayload = {
  commitSha: 'cafebabe1234cafebabe1234cafebabe12345678',
  mergeStrategy: 'ff-only',
  prevHeadSha: 'abc123def456abc123def456abc123def456abc1',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: Awaited<ReturnType<typeof identityFromSeed>>;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-chain-walker-test-'));
  // Write .cleo/project-info.json so assertProjectInitialized() accepts this
  // temp dir as a valid project root (T1864 guard).
  await mkdir(join(tmpDir, '.cleo'), { recursive: true });
  await writeFile(
    join(tmpDir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'test-chain-walker', monorepoRoot: false }),
    'utf-8',
  );
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 7; // distinct from other tests
  identity = await identityFromSeed(seed);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyEventChain — intact chain
// ---------------------------------------------------------------------------

describe('verifyEventChain — intact chain', () => {
  it('returns { total:0, verified:0, broken:0 } for absent log', async () => {
    const result = await verifyEventChain(tmpDir);
    expect(result.total).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.broken).toBe(0);
    expect(result.signerNotInAllowlist).toBe(0);
  });

  it('returns { broken:0 } for a single-event chain', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const result = await verifyEventChain(tmpDir);
    expect(result.total).toBe(1);
    expect(result.broken).toBe(0);
    expect(result.verified).toBe(1);
    expect(result.firstBrokenAt).toBeUndefined();
  });

  it('returns { broken:0 } for a 5-event chain', async () => {
    for (let i = 0; i < 5; i++) {
      await appendSentientEvent(tmpDir, identity, {
        kind: 'verify',
        experimentId: 'exp-A',
        taskId: 'T0',
        payload: { ...VERIFY_PAYLOAD, gate: `gate-${i}` },
      });
    }
    const result = await verifyEventChain(tmpDir);
    expect(result.total).toBe(5);
    expect(result.broken).toBe(0);
    expect(result.verified).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// verifyEventChain — tampered chain
// ---------------------------------------------------------------------------

describe('verifyEventChain — tampered chain', () => {
  it('detects a mutated event payload and returns broken > 0', async () => {
    // Append 3 events.
    const ev1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: VERIFY_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: MERGE_PAYLOAD,
    });

    // Tamper: overwrite the first line's JSON so its content changes but
    // the subsequent event's parentHash no longer matches.
    const eventsPath = join(tmpDir, SENTIENT_EVENTS_FILE);
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    // Parse and mutate line 0.
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first['payload'] = {
      ...BASELINE_PAYLOAD,
      commitSha: 'tampered00000000000000000000000000000000',
    };
    lines[0] = JSON.stringify(first);

    await writeFile(eventsPath, lines.join('\n') + '\n', 'utf-8');

    const result = await verifyEventChain(tmpDir);
    expect(result.broken).toBeGreaterThan(0);
    // The second event's parentHash no longer matches the mutated first line.
    expect(result.firstBrokenAt).toBeDefined();

    // Sanity: the first event itself is still "valid" from the genesis
    // perspective (its own parentHash is the genesis hash which matches).
    // The break starts at event 2.
    const _ = ev1.receiptId; // referenced above
    void _;
  });

  it('detects a deleted middle line', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const ev2 = await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: VERIFY_PAYLOAD,
    });
    await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: MERGE_PAYLOAD,
    });

    // Delete line 1 (the verify event).
    const eventsPath = join(tmpDir, SENTIENT_EVENTS_FILE);
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    lines.splice(1, 1); // remove middle line
    await writeFile(eventsPath, lines.join('\n') + '\n', 'utf-8');

    const result = await verifyEventChain(tmpDir);
    // Total is now 2. The merge event's parentHash was computed from the
    // verify event's line — after deletion it won't match the baseline line.
    expect(result.total).toBe(2);
    expect(result.broken).toBeGreaterThan(0);

    const _v2 = ev2.receiptId;
    void _v2;
  });
});

// ---------------------------------------------------------------------------
// walkChainFrom — success path
// ---------------------------------------------------------------------------

describe('walkChainFrom — success', () => {
  it('returns only the anchor event when called with the last receiptId', async () => {
    const ev1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const ev2 = await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: VERIFY_PAYLOAD,
    });

    const walked = await walkChainFrom(tmpDir, ev2.receiptId);
    expect(walked).toHaveLength(1);
    expect(walked[0].receiptId).toBe(ev2.receiptId);

    const _ev1 = ev1.receiptId;
    void _ev1;
  });

  it('returns all events from anchor to HEAD in order', async () => {
    const ev1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const ev2 = await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: VERIFY_PAYLOAD,
    });
    const ev3 = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: MERGE_PAYLOAD,
    });

    // Walk from ev2 — should return ev2 + ev3.
    const walked = await walkChainFrom(tmpDir, ev2.receiptId);
    expect(walked).toHaveLength(2);
    expect(walked[0].receiptId).toBe(ev2.receiptId);
    expect(walked[1].receiptId).toBe(ev3.receiptId);

    // Walk from ev1 — should return all 3.
    const walkedAll = await walkChainFrom(tmpDir, ev1.receiptId);
    expect(walkedAll).toHaveLength(3);
    expect(walkedAll[0].receiptId).toBe(ev1.receiptId);
  });

  it('can filter the result for merge events (typical revert use case)', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });
    const anchor = await appendSentientEvent(tmpDir, identity, {
      kind: 'verify',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: VERIFY_PAYLOAD,
    });
    const merge1 = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-A',
      taskId: 'T0',
      payload: MERGE_PAYLOAD,
    });
    const merge2 = await appendSentientEvent(tmpDir, identity, {
      kind: 'merge',
      experimentId: 'exp-B',
      taskId: 'T1',
      payload: { ...MERGE_PAYLOAD, commitSha: 'abababababababababababababababababababababab' },
    });

    const walked = await walkChainFrom(tmpDir, anchor.receiptId);
    const mergeEvents = walked.filter((e) => e.kind === 'merge');

    expect(mergeEvents).toHaveLength(2);
    expect(mergeEvents[0].receiptId).toBe(merge1.receiptId);
    expect(mergeEvents[1].receiptId).toBe(merge2.receiptId);
  });
});

// ---------------------------------------------------------------------------
// walkChainFrom — error paths
// ---------------------------------------------------------------------------

describe('walkChainFrom — errors', () => {
  it('throws E_RECEIPT_NOT_FOUND for a non-existent receiptId', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    await expect(walkChainFrom(tmpDir, 'no-such-receipt-id')).rejects.toThrow(E_RECEIPT_NOT_FOUND);
  });

  it('throws E_RECEIPT_NOT_FOUND when the log does not exist', async () => {
    // tmpDir has no sentient-events.jsonl.
    await expect(walkChainFrom(tmpDir, 'any-id')).rejects.toThrow(E_RECEIPT_NOT_FOUND);
  });
});
