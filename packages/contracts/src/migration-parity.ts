/**
 * Migration-parity contracts — the structured result of a generic
 * source→target SQLite migration equivalence check.
 *
 * These types describe the output of the reusable CORE `verifyMigration()`
 * primitive (T11551 · DHQ-045), the durable guard that prevents the exodus
 * dual-DB migration from silently losing rows ever again.
 *
 * ## Why a structured contract
 *
 * The exodus zero-loss campaign (T11531/46/47/48/49/T11550) lost ~805K rows
 * as-shipped because the original verify path returned a loose boolean and a
 * free-text error. A typed parity report makes each failure class
 * machine-inspectable:
 *
 *   - **Row-count parity** — per (source-table → target-table) row counts.
 *   - **Foreign-key integrity** — the `PRAGMA foreign_key_check` rows on the
 *     consolidated target (genuine data orphans, not copy-order artifacts).
 *   - **Content checksum** — an ordered canonical-JSON digest per table, over
 *     the intersection of source/target columns, so content drift is caught
 *     even when counts match.
 *   - **Enum/type drift** — values present in a source column that are NOT in
 *     the target column's CHECK enum. This is the exact failure class that
 *     `INSERT OR IGNORE` used to swallow silently.
 *
 * @task T11551 (DHQ-045 — exodus zero-loss durable guard)
 * @epic T10878
 * @saga T11242
 * @adr ADR-068, ADR-069
 * @public
 */

/**
 * Per-table row-count + content-checksum parity entry.
 *
 * Produced for every legacy source table that maps to a consolidated target
 * table. `countMatch` and `hashMatch` together decide whether the table copied
 * losslessly: a `false` on either is a parity failure.
 *
 * @public
 */
export interface MigrationTableParity {
  /** Physical table name in the legacy source DB. */
  readonly sourceTable: string;
  /** Physical table name in the consolidated target DB (after name-mapping). */
  readonly targetTable: string;
  /**
   * Logical scope label for the target table (`'project'` | `'global'` for
   * exodus; an opaque string for other migrations).
   */
  readonly scope: string;
  /** Row count in the source legacy table. */
  readonly sourceCount: number;
  /** Row count in the consolidated target table. */
  readonly targetCount: number;
  /** Ordered canonical-JSON SHA-256 digest (32 hex) of the source rows. */
  readonly sourceHash: string;
  /** Ordered canonical-JSON SHA-256 digest (32 hex) of the target rows. */
  readonly targetHash: string;
  /** `true` when `sourceCount === targetCount`. */
  readonly countMatch: boolean;
  /** `true` when `sourceHash === targetHash`. */
  readonly hashMatch: boolean;
}

/**
 * A single orphan row surfaced by `PRAGMA foreign_key_check` on the
 * consolidated target after migration.
 *
 * Each entry mirrors one row of the `PRAGMA foreign_key_check` result: the
 * child `table`, the offending `rowid`, the referenced `parent` table, and the
 * `fkid` (the index of the foreign-key constraint within that table).
 *
 * A non-empty list means the migrated data has genuine referential orphans —
 * NOT copy-order artifacts (the migration copies with `foreign_keys=OFF` and
 * checks afterward). The parity gate treats any orphan as a failure.
 *
 * @public
 */
export interface MigrationForeignKeyViolation {
  /** Child table containing the orphan row. */
  readonly table: string;
  /** `rowid` of the orphan row (or `null` for WITHOUT ROWID tables). */
  readonly rowid: number | null;
  /** Referenced parent table that has no matching row. */
  readonly parent: string;
  /** Index of the violated foreign-key constraint within `table`. */
  readonly fkid: number;
}

/**
 * An enum/type-drift finding — a value present in a source column that the
 * target column's CHECK constraint enum does NOT accept.
 *
 * This is the exact class that `INSERT OR IGNORE` silently dropped during the
 * un-hardened exodus migration. The migration layer normalises known drift
 * (legacy enum aliases, epoch→ISO timestamps) before insert; any value that
 * still cannot be coerced surfaces here so the gate fails loudly rather than
 * dropping rows.
 *
 * @public
 */
export interface MigrationEnumDrift {
  /** Physical target table name whose column has the CHECK enum. */
  readonly targetTable: string;
  /** Column name carrying the CHECK enum on the target. */
  readonly column: string;
  /**
   * Up to {@link MIGRATION_ENUM_DRIFT_SAMPLE_LIMIT} distinct source values that
   * are NOT members of the target enum. Truncated for legibility; `driftCount`
   * is the true total of out-of-enum source rows.
   */
  readonly offendingValues: readonly string[];
  /** The canonical enum members accepted by the target CHECK constraint. */
  readonly allowedValues: readonly string[];
  /** Total number of source rows whose value is outside the target enum. */
  readonly driftCount: number;
}

/**
 * Maximum number of distinct offending values captured per
 * {@link MigrationEnumDrift} entry, to keep the report bounded.
 *
 * @public
 */
export const MIGRATION_ENUM_DRIFT_SAMPLE_LIMIT = 20 as const;

/**
 * Aggregate result of {@link MigrationTableParity} / FK / enum-drift checks for
 * a single source→target migration verification pass.
 *
 * `ok === true` IFF every table has `countMatch && hashMatch`, the
 * `foreignKeyViolations` list is empty, AND no {@link MigrationEnumDrift} was
 * detected. When `ok === false`, `error` is ALWAYS populated with a
 * human-readable failure summary (the false-pass guard from T11531).
 *
 * @public
 */
export interface VerifyMigrationResult {
  /** `true` only when every parity, FK, and enum-drift check passed. */
  readonly ok: boolean;
  /** Per-table row-count + checksum parity entries. */
  readonly tables: readonly MigrationTableParity[];
  /** Orphan rows from `PRAGMA foreign_key_check` on the consolidated target. */
  readonly foreignKeyViolations: readonly MigrationForeignKeyViolation[];
  /** Enum/type-drift findings (source values outside the target CHECK enum). */
  readonly enumDrift: readonly MigrationEnumDrift[];
  /**
   * Human-readable failure summary, populated whenever `ok === false`.
   * `undefined` on success.
   */
  readonly error?: string;
}
