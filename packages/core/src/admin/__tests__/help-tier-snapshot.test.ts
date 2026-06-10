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
 * will trip this snapshot. To intentionally update, use the discoverable
 * regen verb (T11957 / DHQ-074):
 *   pnpm --filter @cleocode/core run gen:tier-snapshot
 * (equivalently `pnpm run gen:tier-snapshot` from the repo root). The
 * companion `gen:tier-snapshot:check` runs this test read-only and prints the
 * fix command on drift, so adding an operation no longer silently breaks CI
 * with a cryptic "obsolete snapshot" message.
 *
 * @task T9845
 * @epic T9866
 * @saga T9862
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { computeHelp, type HelpOperationDef } from '../help.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo-root-relative path to the core package manifest. */
const CORE_PKG_JSON = resolve(__dirname, '..', '..', '..', 'package.json');
/** Repo-root-relative path to the root workspace manifest. */
const ROOT_PKG_JSON = resolve(__dirname, '..', '..', '..', '..', '..', 'package.json');

/** One-shot regen command surfaced to devs/agents when the snapshot drifts. */
const REGEN_HINT =
  'tier snapshot drifted — regenerate with `pnpm --filter @cleocode/core run gen:tier-snapshot`';

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

  // ---------------------------------------------------------------------------
  // Self-healing / discoverability regression lock (T11957 · DHQ-074).
  //
  // The snapshots above are the SAFETY NET; these tests guard the ESCAPE HATCH.
  // Adding an operation to the registry legitimately re-tiers the counts above,
  // and historically agents discovered the resulting break only in CI and then
  // had to reverse-engineer the regen incantation. We now ship a discoverable
  // `gen:tier-snapshot` verb (mirroring `gen:sdk`); these tests fail loudly —
  // with the regen hint baked into the assertion message — if that verb (and
  // its CI `:check` gate) ever silently disappears, which would re-open the
  // exact stall point DHQ-074 describes.
  // ---------------------------------------------------------------------------
  describe('tier-snapshot self-healing path is wired (T11957)', () => {
    it('@cleocode/core exposes gen:tier-snapshot + gen:tier-snapshot:check verbs', () => {
      const pkg = JSON.parse(readFileSync(CORE_PKG_JSON, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      expect(
        scripts['gen:tier-snapshot'],
        `core package.json must define a gen:tier-snapshot regen verb — ${REGEN_HINT}`,
      ).toBeDefined();
      expect(
        scripts['gen:tier-snapshot:check'],
        'core package.json must define a gen:tier-snapshot:check CI drift gate',
      ).toBeDefined();
      // The check verb must run the SAME generator in --check mode.
      expect(scripts['gen:tier-snapshot:check']).toContain('--check');
    });

    it('root workspace re-exports the gen:tier-snapshot verbs (discoverable from repo root)', () => {
      const pkg = JSON.parse(readFileSync(ROOT_PKG_JSON, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      expect(scripts['gen:tier-snapshot']).toBeDefined();
      expect(scripts['gen:tier-snapshot:check']).toBeDefined();
      expect(scripts['gen:tier-snapshot']).toContain('@cleocode/core');
    });

    it('the regen generator script exists on disk', () => {
      const genScript = join(dirname(CORE_PKG_JSON), 'scripts', 'gen-tier-snapshot.mjs');
      // readFileSync throws ENOENT if the script was removed — that is the
      // regression we want to catch (the verb pointing at a missing file).
      const source = readFileSync(genScript, 'utf8');
      expect(source).toContain('--check');
      expect(source).toContain('help-tier-snapshot.test.ts');
    });
  });
});
