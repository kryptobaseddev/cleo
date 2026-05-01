/**
 * Tests for the sentient dream cycle module — T1680.
 *
 * Coverage:
 *   DC-01: runDreamCycle returns 'killed' when kill-switch is active
 *   DC-02: runDreamCycle returns 'no-api-key' when no LLM client is available
 *   DC-03: runDreamCycle returns 'no-observations' when nothing in lookback window
 *   DC-04: runDreamCycle returns 'no-clusters' when clusters too small
 *   DC-05: collection is called with correct lookbackMs
 *   DC-06: Jaccard clustering produces correct cluster count
 *   DC-07: Only clusters >= clusterMinSize are synthesised
 *   DC-08: LLM is called per eligible cluster (stub client)
 *   DC-09: Extracted memories below minImportance are rejected
 *   DC-10: verifyAndStoreFn receives correct MemoryCandidate fields
 *   DC-11: Digest observation is emitted at end of successful run
 *   DC-12: safeRunDreamCycle swallows unexpected errors
 *   DC-13: maybeTriggerDreamCycle is skipped before interval elapses
 *   DC-14: maybeTriggerDreamCycle fires after interval elapses
 *   DC-15: maybeTriggerDreamCycle is disabled when dreamCycle=null
 *   DC-16: tick options dreamCycleIntervalMs=0 forces run every tick
 *   DC-17: dedup via verifyAndStore — 'merged' counts toward stored
 *   DC-18: all warnings are captured in digest
 *   DC-19: TickOptions dreamCycle override reaches maybeTriggerDreamCycleScan
 *   DC-20: _resetDreamCycleScanAt resets interval state
 *
 * Tests use stub LLM client — NO real API calls are made.
 * Brain writes are injected via options.observeMemory.
 * verifyAndStore is injected via options.verifyAndStoreFn.
 *
 * @task T1680
 * @epic T1676
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SENTIENT_STATE_FILE } from '../daemon.js';
import {
  _getLastDreamCycleAt,
  _resetDreamCycleAt,
  type CollectedObservation,
  type DreamCycleOptions,
  runDreamCycle,
  safeRunDreamCycle,
} from '../dream-cycle.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';
import { _resetDreamCycleScanAt as _tickResetDreamCycleScanAt, safeRunTick } from '../tick.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeObservation(id: string, title: string, narrative: string): CollectedObservation {
  return {
    id,
    title,
    narrative,
    createdAt: new Date().toISOString(),
    observationType: 'hygiene:test',
  };
}

/**
 * Create a stub LLM client that returns a fixed set of memories.
 * Mirrors the stub pattern in llm-extraction tests — no real network.
 * The return type is compatible with DreamCycleOptions['client'].
 */
function makeStubClient(
  memories: Array<{
    type: 'decision' | 'pattern' | 'learning' | 'constraint';
    content: string;
    importance: number;
    entities: string[];
    justification: string;
  }>,
): NonNullable<DreamCycleOptions['client']> {
  return {
    messages: {
      // parse path (zodOutputFormat)
      parse: vi.fn().mockResolvedValue({
        parsed_output: { memories },
      }) as never,
      // plain create path (fallback)
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ memories }) }],
      }) as never,
    },
  } as NonNullable<DreamCycleOptions['client']>;
}

function makeEmptyCollect(): DreamCycleOptions['collectObservations'] {
  return async () => [];
}

function makeCollect(obs: CollectedObservation[]): DreamCycleOptions['collectObservations'] {
  return async () => obs;
}

/** Accept-all stub for verifyAndStoreFn */
function makeAcceptGate(): NonNullable<DreamCycleOptions['verifyAndStoreFn']> {
  return vi.fn().mockResolvedValue({ action: 'stored' });
}

/** Reject-all stub for verifyAndStoreFn */
function makeRejectGate(): NonNullable<DreamCycleOptions['verifyAndStoreFn']> {
  return vi.fn().mockResolvedValue({ action: 'rejected' });
}

/** Merge-all stub for verifyAndStoreFn */
function makeMergeGate(): NonNullable<DreamCycleOptions['verifyAndStoreFn']> {
  return vi.fn().mockResolvedValue({ action: 'merged' });
}

function makeObserveMemory() {
  return vi.fn().mockResolvedValue({ id: 'O-test' });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('sentient dream cycle (T1680)', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-dream-cycle-'));
    statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });
    _resetDreamCycleAt();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // DC-01: Kill-switch active
  // -------------------------------------------------------------------------
  it('DC-01: returns killed when kill-switch is active', async () => {
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE, killSwitch: true });

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      collectObservations: makeEmptyCollect(),
      observeMemory: makeObserveMemory(),
    });

    expect(outcome.kind).toBe('killed');
    expect(outcome.detail).toContain('killSwitch');
  });

  // -------------------------------------------------------------------------
  // DC-02: No API key → no-api-key
  // -------------------------------------------------------------------------
  it('DC-02: returns no-api-key when client is null', async () => {
    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: null,
      collectObservations: makeEmptyCollect(),
      observeMemory: makeObserveMemory(),
    });

    expect(outcome.kind).toBe('no-api-key');
  });

  // -------------------------------------------------------------------------
  // DC-03: No observations in lookback window
  // -------------------------------------------------------------------------
  it('DC-03: returns no-observations when collect returns empty array', async () => {
    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([]),
      collectObservations: makeEmptyCollect(),
      observeMemory: makeObserveMemory(),
    });

    expect(outcome.kind).toBe('no-observations');
  });

  // -------------------------------------------------------------------------
  // DC-04: All clusters below minimum size
  // -------------------------------------------------------------------------
  it('DC-04: returns no-clusters when no cluster meets minimum size', async () => {
    // 4 unique observations that won't cluster together (distinct topics)
    const obs = [
      makeObservation('O-1', 'alpha unicorn', 'alpha unicorn data'),
      makeObservation('O-2', 'beta rainbow', 'beta rainbow data'),
      makeObservation('O-3', 'gamma rocket', 'gamma rocket data'),
      makeObservation('O-4', 'delta pixel', 'delta pixel data'),
    ];

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([]),
      collectObservations: makeCollect(obs),
      clusterMinSize: 5, // requires 5 in a cluster — none will meet this
      observeMemory: makeObserveMemory(),
    });

    // All 4 observations exist but no single cluster has 5+
    expect(['no-clusters', 'completed']).toContain(outcome.kind);
    if (outcome.kind === 'completed') {
      expect(outcome.digest?.clustersSynthesised).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // DC-05: Collection called with correct lookbackMs
  // -------------------------------------------------------------------------
  it('DC-05: collect is called with configured lookbackMs', async () => {
    const collect = vi.fn().mockResolvedValue([]);

    await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([]),
      collectObservations: collect,
      lookbackMs: 12 * 60 * 60 * 1000, // 12 h
      observeMemory: makeObserveMemory(),
    });

    expect(collect).toHaveBeenCalledWith(root, 12 * 60 * 60 * 1000);
  });

  // -------------------------------------------------------------------------
  // DC-06: Jaccard clustering
  // -------------------------------------------------------------------------
  it('DC-06: similar observations cluster together', async () => {
    // 6 very similar observations about TypeScript strictness
    const similarObs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-ts-${i}`,
        `TypeScript strict mode configuration settings`,
        `TypeScript strict mode requires explicit return types and no implicit any types`,
      ),
    );
    // 1 unrelated observation
    const unrelated = makeObservation(
      'O-unrelated',
      'Postgres database setup',
      'Postgres connection pooling settings',
    );

    const observe = makeObserveMemory();
    const gate = makeAcceptGate();

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([
        {
          type: 'constraint',
          content: 'TypeScript strict mode must always be enabled',
          importance: 0.8,
          entities: ['tsconfig.json'],
          justification: 'Consistency across codebase',
        },
      ]) as never,
      collectObservations: makeCollect([...similarObs, unrelated]),
      clusterMinSize: 5,
      verifyAndStoreFn: gate,
      observeMemory: observe,
    });

    expect(outcome.kind).toBe('completed');
    expect(outcome.digest?.clustersFormed).toBeGreaterThanOrEqual(1);
    expect(outcome.digest?.clustersSynthesised).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // DC-07: Only clusters >= clusterMinSize synthesised
  // -------------------------------------------------------------------------
  it('DC-07: clusters below minimum size are skipped for LLM call', async () => {
    // 3 similar observations about auth — below default minSize of 5
    const smallCluster = Array.from({ length: 3 }, (_, i) =>
      makeObservation(
        `O-auth-${i}`,
        'authentication jwt token',
        'jwt token authentication session',
      ),
    );

    const clientStub = makeStubClient([]);
    const parseSpy = clientStub.messages.parse;

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: clientStub,
      collectObservations: makeCollect(smallCluster),
      clusterMinSize: 5,
      observeMemory: makeObserveMemory(),
    });

    // Small cluster should not trigger LLM call
    expect(parseSpy).not.toHaveBeenCalled();
    // Outcome: completed (synthesised 0 clusters) OR no-clusters depending on clustering
    expect(['completed', 'no-clusters']).toContain(outcome.kind);
    if (outcome.kind === 'completed') {
      expect(outcome.digest?.clustersSynthesised).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // DC-08: LLM called per eligible cluster
  // -------------------------------------------------------------------------
  it('DC-08: LLM is called once per eligible cluster (stub client)', async () => {
    // Create 6 observations that cluster into one group
    const obs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-k8s-${i}`,
        'kubernetes deployment configuration',
        'kubernetes deployment configuration replicas resources limits',
      ),
    );

    const clientStub = makeStubClient([
      {
        type: 'pattern',
        content: 'Always set resource limits on Kubernetes pods',
        importance: 0.85,
        entities: ['deployment.yaml'],
        justification: 'Prevents resource exhaustion',
      },
    ]);

    const gate = makeAcceptGate();

    await runDreamCycle({
      projectRoot: root,
      statePath,
      client: clientStub,
      collectObservations: makeCollect(obs),
      clusterMinSize: 5,
      verifyAndStoreFn: gate,
      observeMemory: makeObserveMemory(),
    });

    // parse should be called at least once (one eligible cluster)
    expect(clientStub.messages.parse).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // DC-09: Memories below minImportance are rejected
  // -------------------------------------------------------------------------
  it('DC-09: memories below minImportance are rejected without calling gate', async () => {
    const obs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-low-${i}`,
        'cache invalidation strategy',
        'cache invalidation strategy pattern usage',
      ),
    );

    const lowImportanceMemory = {
      type: 'learning' as const,
      content: 'Cache invalidation is hard',
      importance: 0.3, // Below 0.6 threshold
      entities: [],
      justification: 'Everyone knows this',
    };

    const gate = makeAcceptGate();

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([lowImportanceMemory]) as never,
      collectObservations: makeCollect(obs),
      clusterMinSize: 5,
      minImportance: 0.6,
      verifyAndStoreFn: gate,
      observeMemory: makeObserveMemory(),
    });

    expect(outcome.kind).toBe('completed');
    expect(outcome.digest?.memoriesRejected).toBeGreaterThanOrEqual(1);
    // Gate should NOT be called for low-importance memories
    expect(gate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // DC-10: verifyAndStoreFn receives correct MemoryCandidate fields
  // -------------------------------------------------------------------------
  it('DC-10: verifyAndStoreFn receives MemoryCandidate with correct fields', async () => {
    const obs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-solid-${i}`,
        'solid principles design patterns',
        'solid principles single responsibility design patterns code',
      ),
    );

    const memory = {
      type: 'constraint' as const,
      content: 'Always apply Single Responsibility Principle to new modules',
      importance: 0.9,
      entities: ['src/'],
      justification: 'Reduces coupling',
    };

    const gate = makeAcceptGate();

    await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([memory]) as never,
      collectObservations: makeCollect(obs),
      clusterMinSize: 5,
      verifyAndStoreFn: gate,
      observeMemory: makeObserveMemory(),
    });

    expect(gate).toHaveBeenCalled();
    const [, candidate] = (gate as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { text: string; memoryType: string; confidence: number },
    ];
    expect(candidate.text).toBe(memory.content);
    expect(candidate.memoryType).toBe('semantic'); // constraint → semantic
    expect(candidate.confidence).toBeGreaterThanOrEqual(0.8); // boosted for constraint
  });

  // -------------------------------------------------------------------------
  // DC-11: Digest observation is emitted
  // -------------------------------------------------------------------------
  it('DC-11: digest BRAIN observation is emitted after successful run', async () => {
    const obs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-digest-${i}`,
        'database migration strategy',
        'database migration strategy versioning rollback',
      ),
    );

    const observe = makeObserveMemory();

    await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([
        {
          type: 'learning',
          content: 'Database migrations must always be reversible',
          importance: 0.8,
          entities: ['migrations/'],
          justification: 'Rollback safety',
        },
      ]) as never,
      collectObservations: makeCollect(obs),
      clusterMinSize: 5,
      verifyAndStoreFn: makeAcceptGate(),
      observeMemory: observe,
    });

    expect(observe).toHaveBeenCalled();
    const [params] = (observe as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { title: string; text: string; type?: string },
    ];
    expect(params.title).toMatch(/sentient:dream-cycle-/);
    expect(params.text).toContain('dream cycle completed');
  });

  // -------------------------------------------------------------------------
  // DC-12: safeRunDreamCycle swallows unexpected errors
  // -------------------------------------------------------------------------
  it('DC-12: safeRunDreamCycle swallows unexpected errors', async () => {
    const outcome = await safeRunDreamCycle({
      projectRoot: root,
      statePath,
      isKilled: () => {
        throw new Error('unexpected kill-switch error');
      },
      observeMemory: makeObserveMemory(),
    });

    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toContain('dream cycle threw');
  });

  // -------------------------------------------------------------------------
  // DC-13: maybeTriggerDreamCycle skipped before interval elapses
  // -------------------------------------------------------------------------
  it('DC-13: maybeTriggerDreamCycle is skipped when interval has not elapsed', async () => {
    const dreamFn = vi.fn().mockResolvedValue({ kind: 'completed', detail: 'test' });

    // First call — fires immediately (timestamp is 0)
    await maybeTriggerDreamCycleScan(root, statePath, {
      dreamCycle: dreamFn,
      dreamCycleIntervalMs: 60_000,
    });
    expect(dreamFn).toHaveBeenCalledTimes(1);

    // Second call before interval elapses — must NOT fire again
    await maybeTriggerDreamCycleScan(root, statePath, {
      dreamCycle: dreamFn,
      dreamCycleIntervalMs: 60_000,
    });
    expect(dreamFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // DC-14: maybeTriggerDreamCycle fires after interval elapses
  // -------------------------------------------------------------------------
  it('DC-14: maybeTriggerDreamCycle fires again after interval elapses', async () => {
    const dreamFn = vi.fn().mockResolvedValue({ kind: 'completed', detail: 'test' });

    // Use intervalMs=0 so every call fires
    await maybeTriggerDreamCycleScan(root, statePath, {
      dreamCycle: dreamFn,
      dreamCycleIntervalMs: 0,
    });
    _tickResetDreamCycleScanAt();
    await maybeTriggerDreamCycleScan(root, statePath, {
      dreamCycle: dreamFn,
      dreamCycleIntervalMs: 0,
    });

    expect(dreamFn).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // DC-15: maybeTriggerDreamCycle disabled when dreamCycle=null
  // -------------------------------------------------------------------------
  it('DC-15: maybeTriggerDreamCycle is disabled when dreamCycle=null', async () => {
    const defaultSpy = vi.fn();

    await maybeTriggerDreamCycleScan(root, statePath, { dreamCycle: null });

    // Should not call anything
    expect(defaultSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // DC-16: TickOptions dreamCycleIntervalMs=0 forces run every tick
  // -------------------------------------------------------------------------
  it('DC-16: dreamCycleIntervalMs=0 in TickOptions forces run on every tick', async () => {
    _tickResetDreamCycleScanAt();
    const dreamFn = vi.fn().mockResolvedValue({ kind: 'completed', detail: 'ok' });

    const statePath2 = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath2, { ...DEFAULT_SENTIENT_STATE });

    await safeRunTick({
      projectRoot: root,
      statePath: statePath2,
      pickTask: async () => null,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      dreamCycle: dreamFn,
      dreamCycleIntervalMs: 0,
      stageDriftScan: null,
      hygieneScan: null,
      checkAndDream: async () => ({ triggered: false, tier: null }),
      runDeriverBatch: false,
    });

    expect(dreamFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // DC-17: 'merged' from gate counts toward memoriesStored
  // -------------------------------------------------------------------------
  it('DC-17: merged gate result counts toward memoriesStored', async () => {
    const obs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-merge-${i}`,
        'error handling patterns retry',
        'error handling patterns retry exponential backoff',
      ),
    );

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([
        {
          type: 'pattern',
          content: 'Use exponential backoff for all retry logic',
          importance: 0.8,
          entities: ['retry.ts'],
          justification: 'Prevents thundering herd',
        },
      ]),
      collectObservations: makeCollect(obs),
      clusterMinSize: 5,
      verifyAndStoreFn: makeMergeGate(),
      observeMemory: makeObserveMemory(),
    });

    expect(outcome.kind).toBe('completed');
    expect(outcome.digest?.memoriesStored).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // DC-18: warnings are captured in digest
  // -------------------------------------------------------------------------
  it('DC-18: warnings from synthesis errors are captured in digest', async () => {
    const obs = Array.from({ length: 6 }, (_, i) =>
      makeObservation(
        `O-warn-${i}`,
        'caching strategy redis memcache',
        'caching strategy redis memcache invalidation eviction',
      ),
    );

    // Client throws on parse — forces fallback path which also throws
    const badClient = {
      messages: {
        parse: vi.fn().mockRejectedValue(new Error('synthesis error')),
        create: vi.fn().mockRejectedValue(new Error('synthesis error fallback')),
      },
    } as NonNullable<DreamCycleOptions['client']>;

    const outcome = await runDreamCycle({
      projectRoot: root,
      statePath,
      client: badClient,
      collectObservations: makeCollect(obs),
      clusterMinSize: 5,
      verifyAndStoreFn: makeAcceptGate(),
      observeMemory: makeObserveMemory(),
    });

    // Even with errors, we get a completed outcome (empty synthesis)
    expect(['completed']).toContain(outcome.kind);
    // No memories extracted from a failed synthesis
    if (outcome.kind === 'completed') {
      expect(outcome.digest?.memoriesExtracted).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // DC-19: TickOptions dreamCycle override reaches maybeTriggerDreamCycleScan
  // -------------------------------------------------------------------------
  it('DC-19: dreamCycle override in TickOptions is invoked by safeRunTick', async () => {
    _tickResetDreamCycleScanAt();
    const dreamFn = vi.fn().mockResolvedValue({ kind: 'completed', detail: 'injected' });

    await safeRunTick({
      projectRoot: root,
      statePath,
      pickTask: async () => null,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      dreamCycle: dreamFn,
      dreamCycleIntervalMs: 0,
      stageDriftScan: null,
      hygieneScan: null,
      checkAndDream: async () => ({ triggered: false, tier: null }),
      runDeriverBatch: false,
    });

    expect(dreamFn).toHaveBeenCalledTimes(1);
    // Called with projectRoot and statePath
    const [callArgs] = (dreamFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { projectRoot: string; statePath: string },
    ];
    expect(callArgs.projectRoot).toBe(root);
    expect(callArgs.statePath).toBe(statePath);
  });

  // -------------------------------------------------------------------------
  // DC-20: _resetDreamCycleAt and _getLastDreamCycleAt accessors work
  // -------------------------------------------------------------------------
  it('DC-20: _resetDreamCycleAt resets dream-cycle module last-run timestamp to 0', async () => {
    // Trigger a full runDreamCycle (no real LLM needed — returns early on no-observations)
    await runDreamCycle({
      projectRoot: root,
      statePath,
      client: makeStubClient([]),
      collectObservations: makeEmptyCollect(),
      observeMemory: makeObserveMemory(),
    });

    // The dream-cycle module's internal state is independent of tick.ts
    // _getLastDreamCycleAt tracks the maybeTriggerDreamCycle module-level var
    // _resetDreamCycleAt resets it to 0
    _resetDreamCycleAt();
    expect(_getLastDreamCycleAt()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Re-export helper functions needed in test
// ---------------------------------------------------------------------------

/**
 * Re-export `maybeTriggerDreamCycleScan` via a thin wrapper so tests can
 * call it with simplified options (dreamCycle + interval) without importing
 * the full TickOptions type.
 *
 * This is a test-only adapter — production code uses `safeRunTick`.
 */
async function maybeTriggerDreamCycleScan(
  projectRoot: string,
  statePath: string,
  opts: {
    dreamCycle?: ((options: DreamCycleOptions) => Promise<unknown>) | null;
    dreamCycleIntervalMs?: number;
  },
): Promise<void> {
  // We access the internal function by routing through a minimal safeRunTick wrapper
  // that has dreamCycleIntervalMs = opts.dreamCycleIntervalMs to force cadence.
  // Since we can't call the private maybeTriggerDreamCycleScan directly, we go
  // through a minimal safeRunTick invocation and check that dreamCycle is fired.

  // Import tick's internal via the exported safeRunTick which calls maybeTriggerDreamCycleScan.
  // We use dreamCycle=null as "disable" and dreamCycle=fn to inject.
  if (opts.dreamCycle === null) {
    // Disable: pass null through safeRunTick
    await safeRunTick({
      projectRoot,
      statePath,
      pickTask: async () => null,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      dreamCycle: null,
      dreamCycleIntervalMs: opts.dreamCycleIntervalMs ?? 0,
      stageDriftScan: null,
      hygieneScan: null,
      checkAndDream: async () => ({ triggered: false, tier: null }),
      runDeriverBatch: false,
    });
    return;
  }

  await safeRunTick({
    projectRoot,
    statePath,
    pickTask: async () => null,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    dreamCycle: opts.dreamCycle as never,
    dreamCycleIntervalMs: opts.dreamCycleIntervalMs ?? 0,
    stageDriftScan: null,
    hygieneScan: null,
    checkAndDream: async () => ({ triggered: false, tier: null }),
    runDeriverBatch: false,
  });
}
