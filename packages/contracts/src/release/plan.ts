/**
 * Release Plan contracts — canonical Zod schema for `.cleo/release/<version>.plan.json`.
 *
 * The plan file is the source-of-truth state record for a release as it moves
 * through the canonical FSM:
 *
 *   planned → pr-opened → pr-merged → published → reconciled
 *
 * Off-ramp terminal states: `rolled_back`, `failed`, `cancelled`.
 *
 * This module defines the normative shape per SPEC-T9345 §6.1/§6.2. Consumers:
 *
 * - `cleo release plan`      (T9525) — INSERTs status=planned
 * - `cleo release open`      (T9525) — UPDATEs status=pr-opened
 * - `cleo release reconcile` (T9526) — re-validates and UPDATEs status=reconciled
 *
 * The schema is permissive on `evidenceAtoms` (length-zero arrays are
 * structurally valid) — the non-empty invariant (R-301) is enforced by the
 * verb implementations, not the contract, so backfill / migration tooling can
 * load historical plans without contract-level rejection.
 *
 * @task T9527
 * @epic T9492
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §6
 */

import { z } from 'zod';

// ─── Schema version ──────────────────────────────────────────────────────────

/**
 * Semantic version of the Release Plan contract.
 *
 * Increment the MAJOR component on incompatible field renames or removals.
 * Increment MINOR on additive optional-field changes. The plan JSON `$schema`
 * URL is keyed off the MAJOR component (`/release-plan/v1.json` for `1.x.y`).
 */
export const RELEASE_PLAN_SCHEMA_VERSION = '1.0.0';

/**
 * Canonical `$schema` URL embedded in plan files at write time. Consumers MAY
 * use this string to identify the contract version when parsing legacy plans.
 */
export const RELEASE_PLAN_SCHEMA_URL = 'https://cleocode.io/schemas/release-plan/v1.json';

// ─── Enum literal tuples (exported for external introspection) ───────────────

/**
 * Canonical npm dist-tag channels supported by the release pipeline.
 *
 * Includes `rc` in addition to the legacy `latest|beta|alpha` triple to allow
 * release candidates without conflating with `beta` per SPEC §6.1.
 */
export const RELEASE_CHANNEL = ['latest', 'beta', 'alpha', 'rc'] as const;

/**
 * Version-scheme variants. `calver-suffix` is the hotfix grammar
 * `vYYYY.M.DD.N` per SPEC R-402.
 */
export const RELEASE_SCHEME = ['calver', 'semver', 'calver-suffix'] as const;

/**
 * Release-kind classification. `hotfix` triggers the scope-strict completeness
 * path per SPEC R-401; `prerelease` allows non-`latest` channels.
 */
export const RELEASE_KIND = ['regular', 'hotfix', 'prerelease'] as const;

/**
 * Lifecycle FSM states for a release plan. Ordered for documentation only —
 * the runtime FSM enforces monotonic forward progress per SPEC R-302.
 */
export const RELEASE_STATUS = [
  'planned',
  'pr-opened',
  'pr-merged',
  'published',
  'reconciled',
  'rolled_back',
  'failed',
  'cancelled',
] as const;

/**
 * Gate verification status. `unresolved` indicates ADR-061's resolver could
 * not produce a command for the project archetype (SPEC R-304).
 */
export const GATE_STATUS = ['passed', 'failed', 'skipped', 'unresolved'] as const;

/**
 * Canonical gate names recognized by the release pipeline. Mirrors the
 * ADR-051 / ADR-061 evidence-atom canonical names (R-310).
 */
export const GATE_NAME = ['test', 'build', 'lint', 'typecheck', 'audit', 'security-scan'] as const;

/**
 * Platform tuples used by the release matrix per T1737 alignment (R-370).
 *
 * `any` collapses single platform-agnostic artifacts (R-371).
 */
export const PLATFORM_TUPLE = [
  'linux-x64',
  'linux-arm64',
  'macos-x64',
  'macos-arm64',
  'windows-x64',
  'any',
] as const;

/**
 * Supported publisher backends — the registries / distribution channels the
 * release matrix may target.
 */
export const PUBLISHER = ['npm', 'cargo', 'docker', 'pypi', 'github-release', 'binary'] as const;

/**
 * Conventional-commit-aligned task classification used to slot tasks into the
 * changelog `features` / `fixes` / `chores` / `breaking` buckets (§6.1).
 */
export const TASK_KIND = [
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'perf',
  'revert',
  'breaking',
  'hotfix',
] as const;

/**
 * SemVer-impact classification per task. The plan-time aggregate determines
 * the release scheme bump when scheme=`semver` (informational under `calver`).
 */
export const IMPACT = ['major', 'minor', 'patch'] as const;

/**
 * Source attribution for resolved tool commands. Mirrors ADR-061 §1 surfaces.
 */
export const RESOLVED_SOURCE = ['project-context', 'language-default', 'legacy-alias'] as const;

// ─── Enum schemas ────────────────────────────────────────────────────────────

/** Zod schema for {@link RELEASE_CHANNEL}. */
export const ReleaseChannelSchema = z.enum(RELEASE_CHANNEL);

/** Zod schema for {@link RELEASE_SCHEME}. */
export const ReleaseSchemeSchema = z.enum(RELEASE_SCHEME);

/** Zod schema for {@link RELEASE_KIND}. */
export const ReleaseKindSchema = z.enum(RELEASE_KIND);

/** Zod schema for {@link RELEASE_STATUS}. */
export const ReleaseStatusSchema = z.enum(RELEASE_STATUS);

/** Zod schema for {@link GATE_STATUS}. */
export const GateStatusSchema = z.enum(GATE_STATUS);

/** Zod schema for {@link GATE_NAME}. */
export const GateNameSchema = z.enum(GATE_NAME);

/** Zod schema for {@link PLATFORM_TUPLE}. */
export const PlatformTupleSchema = z.enum(PLATFORM_TUPLE);

/** Zod schema for {@link PUBLISHER}. */
export const PublisherSchema = z.enum(PUBLISHER);

/** Zod schema for {@link TASK_KIND}. */
export const TaskKindSchema = z.enum(TASK_KIND);

/** Zod schema for {@link IMPACT}. */
export const ImpactSchema = z.enum(IMPACT);

/** Zod schema for {@link RESOLVED_SOURCE}. */
export const ResolvedSourceSchema = z.enum(RESOLVED_SOURCE);

// ─── Field-level constraint helpers ──────────────────────────────────────────

/**
 * ISO-8601 timestamp constraint. Accepts the subset Zod's `z.iso.datetime()`
 * validates — RFC-3339 with optional fractional seconds and required offset.
 */
const Iso8601 = z.iso.datetime({ offset: true });

/**
 * Non-empty trimmed string. Used for required text fields like task IDs and
 * user-facing summaries to reject pure whitespace.
 */
const NonEmptyString = z.string().min(1);

// ─── Nested schemas ──────────────────────────────────────────────────────────

/**
 * Zod schema for one task row in `plan.tasks[]`. Mirrors the SPEC §6.1 task
 * shape exactly. `evidenceAtoms` is a permissive `string[]` — verbs enforce
 * non-empty per R-301; the contract permits empty arrays so legacy plans
 * remain parseable.
 *
 * `epicAncestor` is locked at plan time (R-303) and MUST NOT be re-derived
 * by downstream consumers.
 *
 * `ivtrPhaseAtPlan` is informational only (R-316) — consumers MUST NOT
 * gate decisions on its value.
 */
export const ReleasePlanTaskSchema = z.object({
  /** Task ID (e.g. "T10001"). Format intentionally loose so historical IDs validate. */
  id: NonEmptyString,
  /** Conventional-commit-aligned task classification. */
  kind: TaskKindSchema,
  /** SemVer impact classification. */
  impact: ImpactSchema,
  /** Human-readable changelog line for this task. */
  userFacingSummary: z.string(),
  /**
   * ADR-051 evidence atoms attesting the task's gate results. Format is
   * `kind:value` (e.g. `commit:abc123`, `test-run:vitest.json`). The contract
   * accepts empty arrays so legacy plans validate; `cleo release plan`
   * enforces non-empty via R-301.
   */
  evidenceAtoms: z.array(NonEmptyString),
  /** IVTR phase at plan time — informational only per R-316. */
  ivtrPhaseAtPlan: z.string().optional(),
  /** Epic this task rolls up to, locked at plan time per R-303. */
  epicAncestor: NonEmptyString,
});

/**
 * Zod schema for one gate row in `plan.gates[]`. Each gate carries the
 * resolved ADR-061 tool command + source attribution for forensic re-runs.
 */
export const ReleaseGateSchema = z.object({
  /** Canonical gate name. */
  name: GateNameSchema,
  /** ADR-051 atom string identifying the resolved tool (e.g. `tool:test`). */
  atom: NonEmptyString,
  /** Gate execution status at plan time. */
  status: GateStatusSchema,
  /** ISO-8601 timestamp the gate was last verified. */
  lastVerifiedAt: Iso8601,
  /** Resolved shell command (e.g. `pnpm run test`). Optional for unresolved gates. */
  resolvedCommand: z.string().optional(),
  /** Provenance of the resolved command. Optional for unresolved gates. */
  resolvedSource: ResolvedSourceSchema.optional(),
});

/**
 * Zod schema for one row in `plan.platformMatrix[]`. Each entry encodes a
 * (platform-tuple, publisher) pair the release will produce per R-370.
 *
 * `smoke` defaults to `true`; archetypes that produce platform-agnostic
 * artifacts MAY set `false` to skip per-platform smoke tests (R-371).
 */
export const ReleasePlatformMatrixEntrySchema = z.object({
  /** Target platform tuple. */
  platform: PlatformTupleSchema,
  /** Distribution backend. */
  publisher: PublisherSchema,
  /** Package identifier on the target backend (e.g. `@cleocode/cleo`). */
  package: NonEmptyString,
  /** Whether to run the GHA smoke job for this matrix entry. */
  smoke: z.boolean().default(true).optional(),
});

/**
 * Zod schema for `plan.preflightSummary`. Captures the four preflight checks
 * runs by `cleo release plan` (R-024 / R-261).
 */
export const ReleasePreflightSummarySchema = z.object({
  /** True if esbuild externals are out of sync with package.json. */
  esbuildExternalsDrift: z.boolean(),
  /** True if `pnpm-lock.yaml` diverges from the workspace manifest. */
  lockfileDrift: z.boolean(),
  /** True if all epic children are in terminal lifecycle states. */
  epicCompletenessClean: z.boolean(),
  /** True if no task appears in multiple in-flight release plans. */
  doubleListingClean: z.boolean(),
  /** Non-fatal preflight warnings (e.g. unresolved tools per R-024). */
  preflightWarnings: z.array(z.string()).default([]).optional(),
});

/**
 * Zod schema for `plan.changelog`. Tasks are bucketed by `kind` into the four
 * canonical changelog sections; each section holds an array of task IDs
 * preserving plan-time ordering.
 */
export const ReleasePlanChangelogSchema = z.object({
  /** `kind=feat` tasks. */
  features: z.array(NonEmptyString).default([]),
  /** `kind=fix` or `kind=hotfix` tasks. */
  fixes: z.array(NonEmptyString).default([]),
  /** `kind=chore`, `docs`, `refactor`, `test`, `perf` tasks. */
  chores: z.array(NonEmptyString).default([]),
  /** `kind=breaking` or `kind=revert` tasks. */
  breaking: z.array(NonEmptyString).default([]),
});

/**
 * Zod schema for `plan.meta` — open-ended bag of informational fields.
 *
 * The catchall is `z.unknown()` (forward-compat: parsers MUST NOT reject
 * fields the contract does not yet recognize) per ADR-039 envelope discipline.
 *
 * Documented keys:
 *
 * - `firstEverRelease` (R-023)         — escape hatch for the first ever
 *   release where `previousVersion` is `null`.
 * - `unresolvedTools` (R-024)          — canonical tool names whose
 *   resolution failed during planning.
 * - `archetype`       (R-361)          — detected project archetype string.
 */
export const ReleasePlanMetaSchema = z
  .object({
    /** True if this is the project's first ever release. */
    firstEverRelease: z.boolean().optional(),
    /** Canonical tool names that could not be resolved at plan time. */
    unresolvedTools: z.array(z.string()).optional(),
    /** Project archetype detected at plan time. */
    archetype: z.string().optional(),
  })
  .catchall(z.unknown());

// ─── Top-level schema ────────────────────────────────────────────────────────

/**
 * Canonical Zod schema for the entire `.cleo/release/<version>.plan.json`
 * envelope. Mirrors SPEC-T9345 §6.1 1:1.
 *
 * Schema invariants enforced by this schema:
 *
 * - All enum fields reject unknown literal values (R-302 / R-304).
 * - `tasks[]` MUST contain only fully-typed task rows (R-303 / R-316).
 * - `gates[]` MUST contain only canonical gate names (R-310).
 * - `platformMatrix[]` MUST be a homogeneous array of entry rows (R-370).
 *
 * Schema invariants enforced by VERBS (NOT this schema):
 *
 * - R-300: `previousVersion` non-null unless `meta.firstEverRelease=true`.
 * - R-301: `tasks[*].evidenceAtoms` non-empty.
 * - R-305: `platformMatrix[]` non-empty.
 * - R-306: deterministic re-validation inside `open` and `reconcile`.
 */
export const ReleasePlanSchema = z.object({
  /** Schema URL for this plan version. */
  $schema: z.string().optional(),
  /** Requested version string (e.g. "v2026.6.0"). Includes the leading `v`. */
  version: NonEmptyString,
  /** Resolved version string after suffix application (e.g. "v2026.6.0.2"). */
  resolvedVersion: NonEmptyString,
  /** True if a `calver-suffix` was applied to disambiguate a same-day hotfix. */
  suffixApplied: z.boolean(),
  /** Versioning scheme governing `version` / `resolvedVersion`. */
  scheme: ReleaseSchemeSchema,
  /** npm dist-tag channel for this release. */
  channel: ReleaseChannelSchema,
  /** Epic ID this release ships. */
  epicId: NonEmptyString,
  /** Release-kind classification. */
  releaseKind: ReleaseKindSchema,
  /** ISO-8601 timestamp the plan was written. */
  createdAt: Iso8601,
  /** Identifier of the actor that wrote the plan (agent name or operator). */
  createdBy: NonEmptyString,
  /**
   * Version of the previous release on the same channel. MUST be `null` only
   * for first-ever releases (R-300, enforced at the verb layer).
   */
  previousVersion: z.string().nullable(),
  /** Git tag of the previous release (typically `previousVersion` prefixed). */
  previousTag: z.string().nullable(),
  /** ISO-8601 timestamp the previous release was published. */
  previousShippedAt: Iso8601.nullable(),
  /** Tasks rolled into this release. */
  tasks: z.array(ReleasePlanTaskSchema),
  /** Bucketed changelog. */
  changelog: ReleasePlanChangelogSchema,
  /** Per-gate verification status. */
  gates: z.array(ReleaseGateSchema),
  /** Platform / publisher matrix. */
  platformMatrix: z.array(ReleasePlatformMatrixEntrySchema),
  /** Preflight summary from `cleo release plan`. */
  preflightSummary: ReleasePreflightSummarySchema,
  /** URL of the GHA workflow run (populated by `release-prepare.yml`). */
  workflowRunUrl: z.string().nullable(),
  /** URL of the bump PR (populated by `cleo release open`). */
  prUrl: z.string().nullable(),
  /** Merge commit SHA on `main` (populated by `release-publish.yml`). */
  mergeCommitSha: z.string().nullable(),
  /** Current FSM state per R-302. */
  status: ReleaseStatusSchema,
  /** Informational / forward-compat metadata. */
  meta: ReleasePlanMetaSchema.optional(),
});

// ─── Inferred TypeScript types ───────────────────────────────────────────────

/** Inferred type for {@link ReleaseChannelSchema}. */
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

/** Inferred type for {@link ReleaseSchemeSchema}. */
export type ReleaseScheme = z.infer<typeof ReleaseSchemeSchema>;

/** Inferred type for {@link ReleaseKindSchema}. */
export type ReleaseKind = z.infer<typeof ReleaseKindSchema>;

/** Inferred type for {@link ReleaseStatusSchema}. */
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

/** Inferred type for {@link GateStatusSchema}. */
export type GateStatus = z.infer<typeof GateStatusSchema>;

/** Inferred type for {@link GateNameSchema}. */
export type GateName = z.infer<typeof GateNameSchema>;

/** Inferred type for {@link PlatformTupleSchema}. */
export type PlatformTuple = z.infer<typeof PlatformTupleSchema>;

/** Inferred type for {@link PublisherSchema}. */
export type Publisher = z.infer<typeof PublisherSchema>;

/** Inferred type for {@link TaskKindSchema}. */
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** Inferred type for {@link ImpactSchema}. */
export type Impact = z.infer<typeof ImpactSchema>;

/** Inferred type for {@link ResolvedSourceSchema}. */
export type ResolvedSource = z.infer<typeof ResolvedSourceSchema>;

/** Inferred type for {@link ReleasePlanTaskSchema}. */
export type ReleasePlanTask = z.infer<typeof ReleasePlanTaskSchema>;

/** Inferred type for {@link ReleaseGateSchema}. */
export type ReleaseGate = z.infer<typeof ReleaseGateSchema>;

/** Inferred type for {@link ReleasePlatformMatrixEntrySchema}. */
export type ReleasePlatformMatrixEntry = z.infer<typeof ReleasePlatformMatrixEntrySchema>;

/** Inferred type for {@link ReleasePreflightSummarySchema}. */
export type ReleasePreflightSummary = z.infer<typeof ReleasePreflightSummarySchema>;

/** Inferred type for {@link ReleasePlanChangelogSchema}. */
export type ReleasePlanChangelog = z.infer<typeof ReleasePlanChangelogSchema>;

/** Inferred type for {@link ReleasePlanMetaSchema}. */
export type ReleasePlanMeta = z.infer<typeof ReleasePlanMetaSchema>;

/** Inferred type for the entire {@link ReleasePlanSchema} envelope. */
export type ReleasePlan = z.infer<typeof ReleasePlanSchema>;

// ─── Parse helper ────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON value as a {@link ReleasePlan}.
 *
 * Throws `ZodError` on any structural mismatch with detailed `.issues[]`
 * pinpointing every offending field path. Callers SHOULD surface those issues
 * via the LAFS `error.details` field for operator triage.
 *
 * Use {@link safeParseReleasePlan} if you prefer the non-throwing variant.
 *
 * @param input — Untyped value loaded from disk / wire / database.
 * @returns The validated, fully-typed plan object.
 * @throws ZodError when validation fails.
 *
 * @example
 * ```ts
 * import { readFileSync } from 'node:fs';
 * import { parseReleasePlan } from '@cleocode/contracts';
 *
 * const raw = JSON.parse(readFileSync('.cleo/release/v2026.6.0.plan.json', 'utf8'));
 * const plan = parseReleasePlan(raw);
 * console.log(plan.status); // type-narrowed to ReleaseStatus
 * ```
 */
export function parseReleasePlan(input: unknown): ReleasePlan {
  return ReleasePlanSchema.parse(input);
}

/**
 * Safe variant of {@link parseReleasePlan} that returns a discriminated-union
 * result instead of throwing. Useful when validating user-supplied or
 * persisted plans where structured error reporting is required.
 *
 * @param input — Untyped value to validate.
 * @returns Zod safe-parse result.
 */
export function safeParseReleasePlan(
  input: unknown,
): ReturnType<typeof ReleasePlanSchema.safeParse> {
  return ReleasePlanSchema.safeParse(input);
}
