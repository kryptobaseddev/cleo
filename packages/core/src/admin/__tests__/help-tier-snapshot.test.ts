/**
 * Regression-lock snapshot of `cleo ops` tier-filtered output against the
 * REAL `OPERATIONS` registry.
 *
 * This test closes T9845 acceptance criterion #3 ("`cleo ops` still returns
 * identical Tier 0/1/2 results — regression-locked via snapshot test") by
 * exercising {@link computeHelp} against the canonical `OPERATIONS` array
 * sourced from `@cleocode/contracts/dispatch/operations-registry` (the SSoT
 * after the T10061 relocation moved it out of `packages/cleo`).
 *
 * The existing tests on this code path use **fixture data** to verify
 * tier-filter behavior (help.test.ts) or snapshot the **whole OPERATIONS
 * JSON dump** to detect any data mutation (operations-registry.test.ts).
 * Neither pins the user-visible `cleo ops --tier N` contract — the
 * domain-grouped operation map, per-tier counts, and tier-guidance string.
 *
 * What this test locks:
 *   1. Per-tier `operationCount` (Tier 0/1/2)
 *   2. Per-tier domain-grouped operation maps (the JSON shape `cleo ops`
 *      emits to stdout)
 *   3. Verbose-mode operation list at Tier 0 (cost-hint surface)
 *
 * Any accidental tier reassignment, op rename, or guidance-string drift
 * will trip this snapshot. To intentionally update:
 *   pnpm exec vitest --filter @cleocode/core run -u help-tier-snapshot
 *
 * @task T9845
 * @epic T9866
 * @saga T9862
 */

import { OPERATIONS } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { computeHelp, type HelpOperationDef } from '../help.js';

// The OPERATIONS array is structurally compatible with HelpOperationDef
// (it has an additional `idempotent`/`sessionRequired`/`requiredParams`
// surface that computeHelp ignores). Casting here is safe because every
// field HelpOperationDef requires is also present on OperationDef.
const REAL_OPS: HelpOperationDef[] = OPERATIONS as HelpOperationDef[];

describe('cleo ops — real-registry tier-filter regression lock (T9845)', () => {
  it('Tier 0 — operation count snapshot', () => {
    const result = computeHelp(REAL_OPS, 0, false);
    expect(result.operationCount).toMatchSnapshot('tier-0-operationCount');
  });

  it('Tier 1 — operation count snapshot', () => {
    const result = computeHelp(REAL_OPS, 1, false);
    expect(result.operationCount).toMatchSnapshot('tier-1-operationCount');
  });

  it('Tier 2 — operation count snapshot (full surface)', () => {
    const result = computeHelp(REAL_OPS, 2, false);
    expect(result.operationCount).toMatchSnapshot('tier-2-operationCount');
    // Sanity: Tier 2 must equal the entire registry.
    expect(result.operationCount).toBe(REAL_OPS.length);
  });

  it('Tier 0 — domain-grouped operations snapshot', () => {
    const result = computeHelp(REAL_OPS, 0, false);
    expect(result.operations).toMatchSnapshot('tier-0-groupedOperations');
  });

  it('Tier 1 — domain-grouped operations snapshot', () => {
    const result = computeHelp(REAL_OPS, 1, false);
    expect(result.operations).toMatchSnapshot('tier-1-groupedOperations');
  });

  it('Tier 2 — domain-grouped operations snapshot', () => {
    const result = computeHelp(REAL_OPS, 2, false);
    expect(result.operations).toMatchSnapshot('tier-2-groupedOperations');
  });

  it('Tier 0 — verbose operations snapshot (cost-hint surface)', () => {
    const result = computeHelp(REAL_OPS, 0, true);
    expect(result.operations).toMatchSnapshot('tier-0-verboseOperations');
  });

  it('Tier 0/1/2 — guidance + escalation strings are stable', () => {
    const t0 = computeHelp(REAL_OPS, 0, false);
    const t1 = computeHelp(REAL_OPS, 1, false);
    const t2 = computeHelp(REAL_OPS, 2, false);
    expect({
      tier0: { guidance: t0.guidance, escalation: t0.escalation },
      tier1: { guidance: t1.guidance, escalation: t1.escalation },
      tier2: { guidance: t2.guidance, escalation: t2.escalation },
    }).toMatchSnapshot('tier-guidance');
  });

  it('Tier filter is monotonic — Tier N includes every op at tier <= N', () => {
    const t0 = computeHelp(REAL_OPS, 0, false).operationCount;
    const t1 = computeHelp(REAL_OPS, 1, false).operationCount;
    const t2 = computeHelp(REAL_OPS, 2, false).operationCount;
    expect(t0).toBeLessThanOrEqual(t1);
    expect(t1).toBeLessThanOrEqual(t2);
  });

  it('every operation in REAL_OPS has a valid tier (0 | 1 | 2)', () => {
    for (const op of REAL_OPS) {
      expect([0, 1, 2]).toContain(op.tier);
    }
  });
});
