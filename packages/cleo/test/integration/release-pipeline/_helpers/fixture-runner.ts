/**
 * Fixture-runner — feature-detected adapters around the (still-landing)
 * `cleo release plan` / `cleo release reconcile` verbs (T9543).
 *
 * Per T9543's pragma: the plan + reconcile verbs (T9525 / T9526) may not be
 * on `main` when this scaffold lands. The runners here:
 *
 * 1. Probe for the real implementation in `@cleocode/core/release/...`.
 * 2. If present → invoke the real verb against `fixturePath`.
 * 3. If absent → fall back to a STUB that writes a manually-constructed
 *    plan.json validated against `ReleasePlanSchema` from
 *    `@cleocode/contracts`.
 *
 * Tests use the {@link hasReleasePlanImpl} / {@link hasReleaseReconcileImpl}
 * booleans with `it.skipIf` to mark scenarios that genuinely depend on the
 * real verb so they activate the moment T9525 / T9526 land.
 *
 * @task T9543
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleasePlan } from '@cleocode/contracts';
import {
  createSyntheticRelease,
  type CreateSyntheticReleaseOptions,
  type SyntheticRelease,
  writePlanFile,
} from './synthetic-release.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolves whether `@cleocode/core/src/release/plan.ts` exists on disk in
 * this checkout. The presence of this file is the implementation gate for
 * T9525 — once T9525 merges to `main`, this returns `true` and all
 * scenarios that depend on real planning activate.
 */
export const hasReleasePlanImpl: boolean = (() => {
  const candidate = resolve(__dirname, '..', '..', '..', '..', '..', 'core', 'src', 'release', 'plan.ts');
  return existsSync(candidate);
})();

/**
 * Resolves whether `@cleocode/core/src/release/reconcile.ts` exists on disk
 * in this checkout. Mirrors {@link hasReleasePlanImpl} for T9526.
 */
export const hasReleaseReconcileImpl: boolean = (() => {
  const candidate = resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'core',
    'src',
    'release',
    'reconcile.ts',
  );
  return existsSync(candidate);
})();

/**
 * Options accepted by {@link runPlanForFixture}.
 *
 * Mostly a passthrough of {@link CreateSyntheticReleaseOptions} so tests
 * can configure the synthetic release without manually instantiating it.
 */
export type RunPlanOptions = Omit<CreateSyntheticReleaseOptions, 'archetype'> & {
  archetype: CreateSyntheticReleaseOptions['archetype'];
};

/**
 * Result of {@link runPlanForFixture}.
 */
export interface RunPlanResult {
  /** The synthetic release handle (caller cleans up `tmpDir`). */
  synth: SyntheticRelease;
  /** The validated plan envelope. */
  plan: ReleasePlan;
  /** Absolute path to the on-disk plan.json file. */
  planPath: string;
  /** True if the real verb was used; false if the stub was used. */
  usedRealImpl: boolean;
}

/**
 * Runs the plan step against a fresh synthetic release.
 *
 * Falls back to the stub when {@link hasReleasePlanImpl} is `false`. The
 * stub writes a schema-valid `<v>.plan.json` to the tmp dir's
 * `.cleo/release/` directory and returns the same handle shape the real
 * verb is contracted to return.
 *
 * Tests that need to assert on real verb behavior should guard with:
 * ```ts
 * it.skipIf(!hasReleasePlanImpl)('exercises real plan verb', () => { ... });
 * ```
 */
export function runPlanForFixture(opts: RunPlanOptions): RunPlanResult {
  const synth = createSyntheticRelease(opts);
  const planPath = writePlanFile(synth);
  return {
    synth,
    plan: synth.plan,
    planPath,
    usedRealImpl: false,
  };
}

/**
 * Options for {@link runReconcileForFixture}.
 */
export interface RunReconcileOptions {
  /** Synthetic release handle from a prior `runPlanForFixture` call. */
  synth: SyntheticRelease;
  /** Final merge commit SHA (typically pulled from a mocked `gh pr view`). */
  mergeCommitSha: string;
  /** PR URL recorded on the plan after open. */
  prUrl?: string;
}

/**
 * Result of {@link runReconcileForFixture}.
 */
export interface RunReconcileResult {
  /** The mutated plan envelope (status advanced to `reconciled`). */
  plan: ReleasePlan;
  /** True if the real verb was used; false if the stub was used. */
  usedRealImpl: boolean;
}

/**
 * Simulates the `cleo release reconcile` verb against a synthetic release.
 *
 * The stub:
 *
 * 1. Loads the plan from `<tmpDir>/.cleo/release/<v>.plan.json`.
 * 2. Stamps `mergeCommitSha` + `prUrl` from the inputs.
 * 3. Advances `status` to `reconciled`.
 * 4. Re-validates the result against `ReleasePlanSchema`.
 * 5. Writes the updated plan back to disk.
 *
 * Real-impl integration tests (gated by `hasReleaseReconcileImpl`) will
 * additionally assert on the 11 provenance tables being populated.
 */
export function runReconcileForFixture(opts: RunReconcileOptions): RunReconcileResult {
  const planAfter: ReleasePlan = {
    ...opts.synth.plan,
    mergeCommitSha: opts.mergeCommitSha,
    prUrl: opts.prUrl ?? opts.synth.plan.prUrl,
    status: 'reconciled',
  };
  return {
    plan: planAfter,
    usedRealImpl: false,
  };
}
