/**
 * Zod schemas + helper types for the `pr:<number>` evidence atom.
 *
 * Closes the release-verb dogfood gap (T9764 / T9838): tasks that ship via the
 * standard PR + admin-merge flow lacked a zero-friction way to record
 * `implemented` / `testsPassed` / `qaPassed` evidence retroactively. The
 * release-verb
 * pipeline (`cleo release plan --epic <id>`) requires evidence atoms for
 * every child task before a plan can be built. `tool:test` is overkill
 * for one-line tasks (it re-runs the entire monorepo suite), and `note:`
 * is rejected for hard gates on critical verifications.
 *
 * A `pr:<number>` atom proves the work shipped by interrogating GitHub
 * directly: it resolves via `gh pr view <num> --json
 * statusCheckRollup,mergeable,state,mergedAt,headRefOid` and accepts the
 * atom IFF the PR was merged with all required-workflow checks green.
 *
 * @task T9764
 * @epic T9762
 * @saga T9758
 */

import { z } from 'zod';

/**
 * Parsed `pr:<number>` atom before GitHub validation.
 *
 * Emitted by the evidence parser when the user supplies `--evidence
 * "pr:357"`. The number is restricted to positive integers because
 * GitHub PR numbers cannot be zero or negative.
 *
 * T9838 introduced the optional explicit-form modifier
 * `pr:<num>;state:MERGED`. The `state` modifier is intent-documenting
 * (the resolver always demands state === 'MERGED') and is consumed at
 * parse time without being emitted as a separate atom. See
 * {@link prEvidenceStateModifierSchema}.
 *
 * @task T9764
 * @task T9838
 */
export interface ParsedPrEvidenceAtom {
  /** Discriminant — always `'pr'`. */
  readonly kind: 'pr';
  /** PR number (positive integer). */
  readonly prNumber: number;
}

/**
 * Zod schema for {@link ParsedPrEvidenceAtom}.
 *
 * Used by the verify pipeline (`packages/core/src/tasks/evidence.ts`) to
 * validate the parser output before invoking `gh`. Exported so downstream
 * packages can compose it (e.g. a future provenance-graph schema).
 *
 * @task T9764
 */
export const parsedPrEvidenceAtomSchema = z.object({
  kind: z.literal('pr'),
  prNumber: z.number().int().positive(),
}) satisfies z.ZodType<ParsedPrEvidenceAtom>;

/**
 * Zod schema for the optional `state:MERGED` modifier that may follow a
 * `pr:<num>` atom in the evidence string (T9838).
 *
 * The modifier is intent-documenting: the resolver always demands
 * `state === 'MERGED'`, so emitting `state:MERGED` explicitly is a
 * no-op assertion that proves the caller knows the contract. Only the
 * literal string `"MERGED"` is accepted — `OPEN`, `CLOSED`, or any other
 * value is rejected at parse time because no other state can satisfy any
 * gate the `pr:` atom is allowed to back.
 *
 * The parser consumes the modifier in-place (it does NOT emit a separate
 * atom) so downstream code never sees a free-standing `state` atom. The
 * schema exists so external producers (e.g. a future provenance importer)
 * can validate the literal payload before passing it to `parseEvidence`.
 *
 * @task T9838
 */
export const prEvidenceStateModifierSchema = z.object({
  kind: z.literal('state'),
  value: z.literal('MERGED'),
});

/**
 * Inferred type for the explicit `state:MERGED` modifier emitted alongside
 * a `pr:<num>` atom. See {@link prEvidenceStateModifierSchema}.
 *
 * @task T9838
 */
export type PrEvidenceStateModifier = z.infer<typeof prEvidenceStateModifierSchema>;

/**
 * Raw shape returned by `gh pr view <num> --json
 * statusCheckRollup,mergeable,state,mergedAt,headRefOid`.
 *
 * Kept permissive (`.passthrough()`) because GitHub adds fields without
 * breaking us — we only consume what we need.
 *
 * @task T9764
 */
export const ghPrViewSchema = z
  .object({
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    mergedAt: z.string().nullable(),
    headRefOid: z.string().optional(),
    mergeable: z.string().optional(),
    statusCheckRollup: z
      .array(
        z
          .object({
            __typename: z.string().optional(),
            name: z.string().optional(),
            workflowName: z.string().optional(),
            conclusion: z.string().nullable().optional(),
            status: z.string().optional(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  })
  .passthrough();

/**
 * Inferred TypeScript type for the `gh pr view` JSON payload.
 *
 * @task T9764
 */
export type GhPrViewPayload = z.infer<typeof ghPrViewSchema>;

/**
 * Default required-workflow names enforced by `pr:<number>` validation.
 *
 * Mirrors the canonical branch-protection list documented in
 * `docs/release/branch-protection-setup.md`. Override via
 * {@link PR_REQUIRED_WORKFLOWS_ENV_VAR} when projects deviate (e.g. an
 * out-of-tree consumer with different gating workflows).
 *
 * @task T9764
 */
export const PR_REQUIRED_WORKFLOWS: readonly string[] = Object.freeze([
  'CI',
  'Lockfile Check',
  'Contracts Dep Lint',
]);

/**
 * Name of the env var that overrides {@link PR_REQUIRED_WORKFLOWS}.
 *
 * Format: comma-separated workflow names (e.g.
 * `"CI,Lockfile Check,MyExtraGate"`). Whitespace around commas is
 * trimmed.
 *
 * @task T9764
 */
export const PR_REQUIRED_WORKFLOWS_ENV_VAR = 'CLEO_PR_REQUIRED_WORKFLOWS' as const;
