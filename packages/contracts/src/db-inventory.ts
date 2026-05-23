/**
 * CLEO Database Inventory — SSoT type contract + immutable constant.
 *
 * @remarks
 * This module exports the typed shape and the runtime constant for every
 * SQLite database that CLEO manages. The runtime data is sourced from the
 * canonical JSON inventory at `packages/core/src/store/db-inventory.json`
 * via ESM JSON import (`with { type: 'json' }`). The JSON file is the
 * single source of truth; this module re-exposes it with a typed contract.
 *
 * Downstream consumers:
 *
 * - **T10307 — Fleet survey** (`cleo doctor db-substrate`) iterates `DB_INVENTORY`
 *   to enumerate every DB on disk across project + global tiers.
 * - **T10310 — Pragma drift** validates that every open handle for each role
 *   applies the pragma SSoT (`specs/sqlite-pragmas.json`).
 * - **T10311 — Migration coverage** asserts that each entry's
 *   `migrationsDir` exists and contains a `0000_*` baseline.
 * - **T10312 — Doctor integrity** runs `PRAGMA integrity_check` against
 *   every entry whose tier resolves to a present file on disk.
 * - **T10320 — Cross-DB invariants** uses `ownerPackage` + `tier` to
 *   classify which DBs must agree on shared identifiers (project_id,
 *   agent_id, session_id, ...).
 *
 * Adding a new entry to the inventory is a charter amendment — update
 * `db-inventory.json` AND `.cleo/adrs/ADR-068-cleo-database-charter.md`
 * in the same PR (gated by `cleo check arch` Gate-4 SSoT-EXEMPT lint
 * once T10282 ships its drift check).
 *
 * @see ADR-068 — CLEO Database Charter (canonical narrative)
 * @see Saga T10281 — SG-BRAIN-DB-RESILIENCE (provenance)
 * @see Epic T10282 — E1-DB-INVENTORY (this artifact)
 * @see Research note `sg-brain-db-resilience-deep-audit-2026-05-23`
 *
 * @task T10305
 * @epic T10282
 * @saga T10281
 */

import dbInventoryData from '../../core/src/store/db-inventory.json' with { type: 'json' };

/**
 * Canonical role names for every SQLite database in the CLEO charter.
 *
 * @remarks
 * Mirrors the `openCleoDb('<role>', cwd)` chokepoint (ADR-068 §3) plus the
 * three audit-discovered roles (`global-brain`, `global-tasks`, `manifest`)
 * that exist on disk today but do not yet have a registered opener.
 *
 * - `tasks`              — project-tier task engine DB
 * - `brain`              — project-tier memory DB (PII)
 * - `conduit`            — project-tier agent message transport
 * - `manifest`           — project-tier derived blob index (rebuildable)
 * - `llmtxt`             — reserved project-tier llmtxt session store
 * - `nexus`              — global-tier cross-project knowledge graph (PII)
 * - `signaldock-project` — historical project-tier signaldock (post-ADR-037, merged into conduit)
 * - `signaldock-global`  — global-tier canonical agent identity registry
 * - `telemetry`          — global-tier opt-in command telemetry
 * - `skills`             — global-tier per-user skill registry
 * - `global-brain`       — global-tier brain.db observed on disk (audit §1.2 — provenance under investigation)
 * - `global-tasks`       — global-tier tasks.db observed on disk (audit §1.2 — provenance under investigation)
 *
 * @public
 */
export type DbRole =
  | 'tasks'
  | 'brain'
  | 'conduit'
  | 'manifest'
  | 'llmtxt'
  | 'nexus'
  | 'signaldock-project'
  | 'signaldock-global'
  | 'telemetry'
  | 'skills'
  | 'global-brain'
  | 'global-tasks';

/**
 * Lifecycle scope of a CLEO database.
 *
 * @remarks
 * - `project` — file lives under `<projectRoot>/.cleo/`; lifecycle bound to one CLEO project.
 * - `global`  — file lives under `$XDG_DATA_HOME/cleo/` (env-paths via `getCleoHome()`).
 * - `derived` — file lives under the project tier but is rebuildable from a
 *               non-DB source-of-truth (e.g. content-addressable blob store).
 *               MAY be excluded from backup-pack.
 *
 * @public
 */
export type DbTier = 'project' | 'global' | 'derived';

/**
 * Privacy classification governing backup + cloud-export rules.
 *
 * @remarks
 * - `local-only`               — never cloud-exported.
 * - `local-only-pii`           — never cloud-exported; PII-class — requires
 *                                explicit `cleo backup export --include-pii`.
 * - `cloud-exportable-opt-in`  — may be exported only after explicit opt-in
 *                                (e.g. `cleo diagnostics enable`).
 *
 * @public
 */
export type DbPrivacy = 'local-only' | 'local-only-pii' | 'cloud-exportable-opt-in';

/**
 * Concurrency model for the database.
 *
 * @remarks
 * Every CLEO database today is `single-writer` (WAL mode with in-process
 * serialization via the `openCleoDb` singleton). The field is enumerated so
 * a future read-replica or multi-writer DB MUST be declared explicitly.
 *
 * @public
 */
export type DbConcurrency = 'single-writer' | 'multi-writer';

/**
 * One row in the CLEO database charter.
 *
 * @remarks
 * Every field is required (no `null` placeholders) EXCEPT `drizzleSchemaPath`
 * and `migrationsDir` — those MAY be `null` for:
 *
 * - `derived` databases whose schema is owned by an upstream library (e.g.
 *   `manifest.db` is owned by `llmtxt/blob`'s `BlobFsAdapter` contract).
 * - `reserved` roles whose opener throws `not yet implemented` (e.g.
 *   `llmtxt.db`).
 *
 * Path templates use the substitution tokens:
 *
 * - `<projectRoot>`   — resolved at runtime from `CLEO_ROOT` env var or
 *                       `process.cwd()` via `getCleoProjectDir()`.
 * - `$XDG_DATA_HOME`  — resolved via env-paths through `getCleoHome()`.
 *                       Linux: `~/.local/share/cleo/`; macOS:
 *                       `~/Library/Application Support/cleo/`.
 *
 * @public
 */
export interface DbInventoryEntry {
  /** Canonical role identifier used by `openCleoDb` and audit tooling. */
  readonly role: DbRole;
  /** Lifecycle scope — project, global, or derived. */
  readonly tier: DbTier;
  /**
   * Filesystem path template with `<projectRoot>` / `$XDG_DATA_HOME` tokens.
   * Substitution convention is documented on {@link DbInventoryEntry}.
   */
  readonly filePathTemplate: string;
  /**
   * Repo-relative path to the Drizzle schema TypeScript file. `null` when
   * the schema is owned by an upstream library or the role is reserved.
   */
  readonly drizzleSchemaPath: string | null;
  /**
   * Repo-relative path to the Drizzle migrations directory (with trailing
   * slash). `null` for `derived` rows or reserved roles. The path MUST
   * exist on disk when non-null — enforced by the contracts test suite.
   */
  readonly migrationsDir: string | null;
  /** npm package that owns the open + lifecycle for this database. */
  readonly ownerPackage: string;
  /**
   * Human-readable description of HOW the database is opened. Typically
   * a code excerpt like `openCleoDb('tasks', cwd)`. For databases without
   * a registered opener, describes provenance / status.
   */
  readonly openedVia: string;
  /** Concurrency model — see {@link DbConcurrency}. */
  readonly concurrency: DbConcurrency;
  /** Privacy classification — see {@link DbPrivacy}. */
  readonly privacy: DbPrivacy;
  /**
   * Canonical backup path template. For `derived` rows this is the
   * sentinel string `rebuildable-from-blob-store` (or similar) and the
   * row is excluded from backup-pack staging.
   */
  readonly backupPath: string;
  /**
   * Provenance pointers — ADR row, related task IDs, audit section
   * references. Comma-or-semicolon separated string of references.
   */
  readonly documentedIn: string;
}

/**
 * Shape of the raw JSON SSoT — a header plus the typed entry array.
 *
 * @internal
 */
interface DbInventoryFile {
  readonly $schemaNote: string;
  readonly $pathTokens: Readonly<Record<string, string>>;
  readonly entries: readonly DbInventoryEntry[];
}

// Narrow the raw JSON to the typed shape. The runtime parity test
// (`db-inventory.test.ts`) asserts every field is valid for every entry.
const rawInventory = dbInventoryData as DbInventoryFile;

/**
 * Immutable canonical inventory of every CLEO SQLite database.
 *
 * @remarks
 * Sourced from `packages/core/src/store/db-inventory.json` — the SSoT.
 * Adding a new entry is a charter amendment per ADR-068 §"How to add a
 * new database". The {@link db-inventory.test.ts} suite asserts:
 *
 * 1. Every `role` is unique across the array.
 * 2. Every `drizzleSchemaPath` (when non-null) exists on disk.
 * 3. Every `migrationsDir` (when non-null) exists on disk.
 * 4. Every `tier` is a member of the {@link DbTier} union.
 *
 * @example Iterate every project-tier database
 * ```typescript
 * import { DB_INVENTORY } from '@cleocode/contracts';
 *
 * const projectDbs = DB_INVENTORY.filter((entry) => entry.tier === 'project');
 * for (const entry of projectDbs) {
 *   console.log(entry.role, entry.filePathTemplate);
 * }
 * ```
 *
 * @public
 */
export const DB_INVENTORY: readonly DbInventoryEntry[] = rawInventory.entries;
