/**
 * Contract types for `cleo skills migrate` — legacy XDG store → ~/.cleo/skills/.
 *
 * Wraps the pure migration helpers in `@cleocode/core/skills/migration.js`
 * with a stable, dispatch-layer request/response shape so the cleo citty
 * CLI, the orchestrator, and any future automation can drive the verb
 * without a runtime dependency on `@cleocode/core`.
 *
 * The migrate verb has three actions, selected by request flags:
 *   - `dry-run`  — preview the plan without writing anything (no backup).
 *   - `migrate`  — copy legacy → canonical, tar + gz the legacy tree,
 *                   write the `.MIGRATED-TO-CLEO` sentinel.
 *   - `rollback` — extract the most recent backup tarball over the legacy
 *                   tree and remove the sentinel.
 *
 * Mutually-exclusive flag combinations (e.g. both `dryRun` and `rollback`)
 * surface `E_INVALID_INPUT` at the dispatch boundary; this contract does
 * not encode that constraint at the type level so request validators stay
 * centralised in the engine-ops handler.
 *
 * @task T9742
 * @epic T9740
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §1
 */

// ---------------------------------------------------------------------------
// Enum mirrors (kept in sync with packages/core/src/skills/migration.ts)
// ---------------------------------------------------------------------------

/**
 * Action that was performed by a single migrate-verb invocation.
 *
 * Mirrors `MigrationOutcome.action` from
 * `packages/core/src/skills/migration.ts` so consumers can branch on the
 * action without a runtime dependency on `@cleocode/core`.
 */
export type SkillMigrateAction = 'migrate' | 'dry-run' | 'rollback' | 'no-op';

/**
 * Provenance bucket for a single migrated skill row.
 *
 * Mirrors the `MigratedSkillRecord.sourceType` field — the `agent-created`
 * bucket from the underlying schema is intentionally absent because the
 * migrator only lifts pre-existing legacy entries (which are by definition
 * either canonical, user-authored, or installed from a community source).
 */
export type SkillMigrateSourceType = 'canonical' | 'user' | 'community';

/**
 * Reason a single legacy directory was skipped during planning.
 *
 * Mirrors `SkippedSkillRecord.reason` from the underlying helper.
 */
export type SkillMigrateSkipReason = 'already-present' | 'not-a-directory';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Input parameters for the `cleo skills migrate` verb.
 *
 * All flags default to `false`. Passing both `dryRun=true` and
 * `rollback=true` is rejected with `E_INVALID_INPUT` at the dispatch
 * boundary — the dispatch handler enforces mutual exclusion so the
 * underlying CORE helpers stay flag-agnostic.
 */
export interface SkillMigrateRequest {
  /** When true, preview the plan without writing anything. */
  readonly dryRun?: boolean;
  /** When true, restore the legacy tree from the most recent backup. */
  readonly rollback?: boolean;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Provenance row for a single skill that was (or would be) copied across.
 *
 * Mirrors `MigratedSkillRecord` from
 * `packages/core/src/skills/migration.ts`.
 */
export interface SkillMigrateMigratedRow {
  /** Skill folder basename (matches `skills.name`). */
  readonly name: string;
  /** Resolved destination path under `~/.cleo/skills/`. */
  readonly installPath: string;
  /** Resolved source path under the legacy XDG store. */
  readonly legacyPath: string;
  /** Source-type bucket as classified by the manifest membership check. */
  readonly sourceType: SkillMigrateSourceType;
}

/**
 * Provenance row for a single skill that was SKIPPED during planning.
 *
 * Mirrors `SkippedSkillRecord` from
 * `packages/core/src/skills/migration.ts`.
 */
export interface SkillMigrateSkippedRow {
  /** Skill folder basename. */
  readonly name: string;
  /** Reason for skipping. */
  readonly reason: SkillMigrateSkipReason;
  /** Resolved legacy path that triggered the skip. */
  readonly legacyPath: string;
}

/**
 * Result envelope for `cleo skills migrate`.
 *
 * Wrapped in the standard LAFS `{success, data, meta}` envelope at the
 * dispatch boundary; this interface describes the `data` payload only.
 *
 * Mirrors `MigrationOutcome` from `packages/core/src/skills/migration.ts`.
 */
export interface SkillMigrateResponse {
  /** Action that was performed. */
  readonly action: SkillMigrateAction;
  /** Entries that were (or would be) copied across. */
  readonly migrated: readonly SkillMigrateMigratedRow[];
  /** Entries that were SKIPPED with reasons. */
  readonly skipped: readonly SkillMigrateSkippedRow[];
  /** Path to the produced backup archive, or `null` on dry-run / no-op. */
  readonly backupPath: string | null;
  /** Resolved legacy root the migrator was driven against. */
  readonly legacyRoot: string;
  /** Resolved destination root the migrator was driven against. */
  readonly canonicalRoot: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}
