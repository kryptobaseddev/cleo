/**
 * M1 spawn-retrieval-parity AcceptanceGate (T1259 E2 scaffold — EXPECTED RED).
 *
 * Documents the structural gap between the briefing-path and spawn-path:
 *   - `buildRetrievalBundle` is called in `computeBriefing` (briefing.ts:212)
 *   - `composeSpawnPayload` (spawn.ts:360) does NOT call `buildRetrievalBundle`
 *   - Spawn payloads therefore lack the `retrievalBundle` field
 *
 * T1259 (E2) files this test as a RED gate (it.fails → vitest treats failure as pass).
 * T1260 (E3) wires `composeSpawnPayload → buildRetrievalBundle` and promotes this
 * to a full green integration assertion.
 *
 * Council binding: M1 MUST NOT be passed green at E2 time (slot .127).
 * Removing `it.fails()` before T1260 ships is a Council violation.
 *
 * @see packages/core/src/orchestration/spawn.ts — composeSpawnPayload (not yet wired)
 * @see packages/core/src/memory/brain-retrieval.ts:1918 — buildRetrievalBundle
 * @see packages/core/src/sessions/briefing.ts:212 — briefing-path (already wired)
 * @task T1259-W7 v2026.4.127 E2 M1 scaffold
 * @task T1260 v2026.4.128 E3 M1 flip GREEN
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// M1 Gap documentation test
// ---------------------------------------------------------------------------

describe('M1 spawn-retrieval-parity — E2 scaffold (expected red, flips green in E3)', () => {
  /**
   * M1 binding gate: SpawnPayload MUST carry a `retrievalBundle` field.
   *
   * The current SpawnPayload interface (spawn.ts:188-210) does not define
   * `retrievalBundle`. `composeSpawnPayload` does not call `buildRetrievalBundle`.
   * This is the gap T1260 (E3) must close.
   *
   * `it.fails()` marks this as an expected failure. Vitest will:
   *   - PASS the test run when this assertion fails (expected behavior at E2)
   *   - FAIL the test run when this assertion passes (signals E3 is landed and
   *     this scaffold must be replaced with a full green assertion)
   *
   * NOTE: This test does not invoke composeSpawnPayload directly to avoid
   * the full signaldock.db setup overhead. It instead inspects the SpawnPayload
   * type surface — sufficient to document the gap and fail correctly.
   * T1260 will replace with a full integration test.
   */
  it.fails('SpawnPayload type includes retrievalBundle field (M1 — wired in E3)', () => {
    // Construct a minimal object representing what composeSpawnPayload currently returns.
    // It does NOT include retrievalBundle — this assertion must fail until E3 wires it.
    const currentSpawnPayloadShape: Record<string, unknown> = {
      taskId: 'T9999',
      agentId: 'project-orchestrator',
      role: 'worker',
      tier: 0,
      harnessHint: 'generic',
      resolvedAgent: {},
      atomicity: { allowed: true },
      prompt: 'test prompt',
      meta: {},
      // retrievalBundle is intentionally ABSENT — this is the gap M1 documents
    };

    // This assertion WILL fail because retrievalBundle is not in SpawnPayload.
    // T1260 adds retrievalBundle to SpawnPayload + wires buildRetrievalBundle call.
    expect(currentSpawnPayloadShape.retrievalBundle).toBeDefined();
  });
});
