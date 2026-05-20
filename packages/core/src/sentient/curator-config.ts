/**
 * Curator daemon configuration schema — Sphere B SG-CLEO-SKILLS foundation.
 *
 * Defines the `daemon.curator` config namespace consumed by the (future)
 * curator daemon under SG-CLEO-SKILLS that periodically sweeps `skills.db`
 * to mark stale rows and archive expired ones.
 *
 * Lives in `packages/core/src/sentient/` because the curator is a sentient
 * subsystem peer of the existing `propose-tick` / `dream-cycle` daemons —
 * it reads the global skills.db on a fixed cadence and emits proposals when
 * thresholds are crossed.
 *
 * ## Why a separate module (not contracts/src/config.ts)?
 *
 * The T9683 charter explicitly requires "NEW modules (NO edits to existing
 * public API except adding exports to index.ts)". The Zod schema lives here;
 * the (future) merge into the global {@link CleoConfig} interface will be
 * done in a downstream task that owns the contracts/config.ts touch.
 *
 * ## Validation invariants
 *
 * Beyond per-field type/range checks, the cross-field invariants enforced by
 * {@link curatorConfigSchema} are:
 *
 * 1. `staleAfterDays < archiveAfterDays` — archiving CANNOT happen before
 *    staleness is reached; reversing the order would silently archive rows
 *    that were never marked stale.
 * 2. `runEveryHours >= 1` — sub-hourly cadence is rejected to keep the
 *    daemon's CPU + IO footprint bounded on low-spec hosts (Pi v2/v3 ADR-035).
 *
 * @task T9683
 * @epic T9571
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §5/§6
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for `daemon.curator` configuration block.
 *
 * All keys are optional at the wire level so an empty `{}` parses to the
 * canonical defaults (`enabled=false`, `staleAfterDays=30`,
 * `archiveAfterDays=90`, `runEveryHours=24`).
 *
 * Cross-field validation runs via {@link z.object#superRefine} after per-key
 * parsing succeeds so the user gets a single, well-formed error per invalid
 * combination instead of a cascade.
 *
 * @task T9683
 */
export const curatorConfigSchema = z
  .object({
    /**
     * Whether the curator daemon should run at all.
     *
     * Defaults to `false` because Sphere B is opt-in per the architecture
     * §5 user-consent model — no background sweeps until the operator
     * explicitly opts in.
     */
    enabled: z.boolean().default(false),
    /**
     * Number of days a skill row may remain `active` without telemetry
     * before being marked `stale`.
     *
     * MUST be a positive integer and MUST be strictly less than
     * `archiveAfterDays`.
     */
    staleAfterDays: z.number().int().positive().default(30),
    /**
     * Number of days a skill row may remain `stale` before being archived.
     *
     * MUST be a positive integer and MUST be strictly greater than
     * `staleAfterDays`.
     */
    archiveAfterDays: z.number().int().positive().default(90),
    /**
     * Curator daemon tick cadence, expressed in whole hours.
     *
     * MUST be `>= 1`. Sub-hourly cadence is rejected to keep IO bounded on
     * the Pi harness (ADR-035).
     */
    runEveryHours: z.number().int().min(1).default(24),
  })
  .superRefine((value, ctx) => {
    if (value.staleAfterDays >= value.archiveAfterDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['archiveAfterDays'],
        message: `archiveAfterDays (${value.archiveAfterDays}) must be strictly greater than staleAfterDays (${value.staleAfterDays})`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Inferred type + default builder
// ---------------------------------------------------------------------------

/**
 * Parsed shape of `daemon.curator`. Inferred from {@link curatorConfigSchema}
 * so any schema edit propagates to the TS type without a manual sync step.
 */
export type CuratorConfig = z.infer<typeof curatorConfigSchema>;

/**
 * Build the canonical default {@link CuratorConfig} value.
 *
 * Equivalent to `curatorConfigSchema.parse({})` but returned as a fresh
 * object on every call so mutating the result is safe.
 *
 * @returns A new object with all four defaults populated.
 *
 * @task T9683
 */
export function getDefaultCuratorConfig(): CuratorConfig {
  return curatorConfigSchema.parse({});
}

/**
 * Parse an unknown blob into a validated {@link CuratorConfig}.
 *
 * Thin wrapper around {@link curatorConfigSchema.parse} that exposes a stable
 * import name (`parseCuratorConfig`) for downstream consumers — keeps the
 * Zod dependency localised to this module if we ever swap validators.
 *
 * @param input - Anything (typically a JSON blob from config.json).
 * @returns The validated, defaulted config object.
 * @throws {z.ZodError} If validation fails.
 *
 * @task T9683
 */
export function parseCuratorConfig(input: unknown): CuratorConfig {
  return curatorConfigSchema.parse(input);
}
