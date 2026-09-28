/**
 * Table classification contracts — the replication class of every physical
 * table in the project and global `cleo.db` (Gate A).
 *
 * Before any byte leaves a device, every table must carry exactly one class.
 * The registry that assigns them lives in core
 * (`packages/core/src/store/table-classification.ts`); this module holds only
 * the shapes, so the registry, the Gate A test, and any future snapshot or
 * journal writer agree on one vocabulary.
 *
 * The registry keys on PHYSICAL table names as `sqlite_master` reports them,
 * never on the Drizzle schema: the runtime often writes the bare legacy twin
 * rather than the prefixed table, so a schema-keyed registry would classify
 * the frozen copy and miss the live one.
 *
 * Types only (arch gate 10): no runtime values are exported from here.
 *
 * @task T12332
 * @epic T12322
 * @module table-classification
 */

/**
 * Which `cleo.db` a table lives in.
 *
 * @task T12332
 */
export type TableScope = 'project' | 'global';

/**
 * The replication class of a table.
 *
 * - `portable-project` — project knowledge shared with every collaborator on
 *   the project (tasks, ACs, lifecycle, ADRs, docs metadata).
 * - `portable-personal` — the owner's own history; syncs across the owner's
 *   devices and is never shared with collaborators (sessions, memories).
 * - `portable-secret` — credentials; travel only sealed end-to-end.
 * - `local-only` — meaningful on this device alone (leases, queues, pids,
 *   paths, locations, fs-keyed caches, frozen legacy twins).
 * - `derived` — deliberately narrow: only what is rebuilt deterministically,
 *   cheaply and without an LLM (FTS5/sqlite-vec shadow tables and the nexus
 *   code graph). Embeddings and LLM or sleep-cycle output are NOT derived.
 *
 * Every class is backed up (tier 1); the class decides only whether a table
 * also syncs across devices (tier 2).
 *
 * @task T12332
 */
export type TableClass =
  | 'portable-project'
  | 'portable-personal'
  | 'portable-secret'
  | 'local-only'
  | 'derived';

/**
 * How settled a classification is.
 *
 * - `draft` — proposed in the classification draft and not disputed.
 * - `resolved` — ruled by the core owner (draft §F).
 * - `needs-owner-call` — classified provisionally; the owner still has to
 *   rule. A snapshot writer must treat the class as provisional.
 * - `frozen-legacy` — a bare legacy twin the runtime no longer reads; kept
 *   `local-only` until the twin-collapse migration drops it (see
 *   {@link TableRegistryEntry.dropTask}).
 * - `optional-transient` — created at runtime or by recovery and may be
 *   absent from a store; its absence is not a stale registry entry.
 *
 * @task T12332
 */
export type TableClassificationStatus =
  | 'draft'
  | 'resolved'
  | 'needs-owner-call'
  | 'frozen-legacy'
  | 'optional-transient';

/**
 * The class of one column when it differs from its table's class.
 *
 * - `portable-secret` — a credential inside an otherwise non-secret table;
 *   sealed or blanked before the row leaves the device.
 * - `local-only` — a device-specific value (an absolute path, a pid, a
 *   heartbeat counter); kept on the device, never overwritten by a peer.
 * - `strip` — dropped from outgoing ops and recomputed on the receiver.
 *
 * @task T12332
 */
export type ColumnClass = 'portable-secret' | 'local-only' | 'strip';

/**
 * A per-column exception to a table's class.
 *
 * @task T12332
 */
export interface ColumnOverride {
  /** Physical column name. */
  readonly column: string;
  /** The column's own class. */
  readonly class: ColumnClass;
  /**
   * JSONPath inside a JSON text column when only part of the value is
   * affected (for example evidence `resolvedPath` inside `verification_json`).
   * Absent when the whole column is affected.
   */
  readonly jsonPath?: string;
  /** Why the column differs from its table. */
  readonly reason: string;
}

/**
 * A per-row class switch: a column whose value moves a row between classes.
 *
 * @task T12332
 */
export interface RowRouting {
  /** Physical column whose value routes the row. */
  readonly column: string;
  /** Column value → class for that row. Values not listed use the table class. */
  readonly routes: Readonly<Record<string, TableClass>>;
  /** Why rows of this table are routed individually. */
  readonly reason: string;
}

/**
 * The classification of one physical table.
 *
 * @task T12332
 */
export interface TableRegistryEntry {
  /** The table's class. */
  readonly class: TableClass;
  /** How settled the class is. */
  readonly status: TableClassificationStatus;
  /** Where the decision comes from (draft section, owner ruling, task). */
  readonly source: string;
  /** Optional note on the decision. */
  readonly note?: string;
  /** For a bare legacy twin: the prefixed table the runtime writes instead. */
  readonly liveTwin?: string;
  /** For a `frozen-legacy` table: the task that drops it. */
  readonly dropTask?: string;
  /** Columns whose class differs from the table's. */
  readonly columns?: readonly ColumnOverride[];
  /** Row-level class switch, when rows of one table land in different classes. */
  readonly rowRouting?: RowRouting;
}

/**
 * A class assigned by name pattern, for families of tables that SQLite
 * creates on its own (FTS5 shadow tables, sqlite-vec chunk tables).
 *
 * @task T12332
 */
export interface TablePatternRule {
  /** Regular-expression source matched against the full physical name. */
  readonly match: string;
  /** Class for every matching table without an explicit entry. */
  readonly class: TableClass;
  /** Why the family gets this class. */
  readonly reason: string;
}

/**
 * A table the registry knows exists but deliberately does NOT classify: the
 * owner must rule on it. Pending tables are never portable; a snapshot writer
 * must skip them. Gate A allows zero pending tables, so this is a working
 * state that cannot reach CI.
 *
 * @task T12332
 */
export interface PendingTableClassification {
  /** Physical table name. */
  readonly table: string;
  /** The question the owner has to answer. */
  readonly question: string;
  /** The task or migration that introduced the table. */
  readonly source: string;
}

/**
 * The full classification of one scope.
 *
 * @task T12332
 */
export interface TableScopeRegistry {
  /** The scope this registry covers. */
  readonly scope: TableScope;
  /** Explicit classifications, keyed by physical table name. */
  readonly tables: Readonly<Record<string, TableRegistryEntry>>;
  /** Pattern rules, consulted only when no explicit entry matches. */
  readonly patterns: readonly TablePatternRule[];
  /** Tables awaiting an owner ruling; they have no class. */
  readonly pending: readonly PendingTableClassification[];
}

/**
 * The result of classifying one physical table name.
 *
 * - `entry` — an explicit registry entry.
 * - `pattern` — a pattern rule (FTS/vec shadow families).
 * - `pending` — listed as awaiting an owner ruling; no class.
 * - `unclassified` — unknown to the registry. Gate A fails on this.
 *
 * @task T12332
 */
export type TableClassification =
  | {
      readonly kind: 'entry';
      readonly scope: TableScope;
      readonly table: string;
      readonly class: TableClass;
      readonly entry: TableRegistryEntry;
    }
  | {
      readonly kind: 'pattern';
      readonly scope: TableScope;
      readonly table: string;
      readonly class: TableClass;
      readonly rule: TablePatternRule;
    }
  | {
      readonly kind: 'pending';
      readonly scope: TableScope;
      readonly table: string;
      readonly pending: PendingTableClassification;
    }
  | {
      readonly kind: 'unclassified';
      readonly scope: TableScope;
      readonly table: string;
    };
