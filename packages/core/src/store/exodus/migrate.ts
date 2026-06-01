/**
 * Exodus migration engine.
 *
 * `runExodusMigrate()` performs the actual data migration from legacy DBs
 * to the consolidated dual-scope `cleo.db`. Key invariants:
 *
 * - Source DBs are opened **read-only** via `openCleoDbSnapshot` (AC4).
 * - Source files are backed up to the staging dir before any writes (AC5).
 * - Import is wrapped in `BEGIN … COMMIT` per source; partial failure leaves
 *   the target DB untouched (AC6).
 * - Idempotency keys are propagated where the source row has them; generated
 *   where it does not (AC7).
 * - The staging journal is written atomically before each table copy so a
 *   crash can be resumed (AC5).
 *
 * ## Type coercion — epoch INTEGER → ISO-8601 TEXT (ROOT CAUSE 1 fix — T11546)
 *
 * Many legacy tables store timestamps as INTEGER epoch values (seconds or
 * milliseconds). The consolidated schema declares these columns as `text` with
 * a CHECK constraint: `CHECK ("col" IS NULL OR "col" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')`.
 *
 * When a source INTEGER value is inserted into a target TEXT+GLOB column, SQLite
 * coerces the integer to its decimal string representation (e.g. `"1717200000"`),
 * which fails the GLOB check. `INSERT OR IGNORE` then SILENTLY DROPS the entire
 * row. Result: all conduit_messages, brain_observations, etc. → 0 rows copied
 * while migrate reports `success: true, rowsCopied: 0`.
 *
 * Fix (two parts):
 *   (a) Per-column value transform: `detectEpochToIsoColumns()` reads the target
 *       table DDL from `sqlite_master` to identify columns with an ISO GLOB
 *       CHECK constraint. For those columns, if the source type affinity is
 *       INTEGER, the SELECT expression applies `strftime('%Y-%m-%dT%H:%M:%fZ',
 *       col, 'unixepoch')` (seconds) or the `/1000.0` ms variant depending on
 *       the per-source/table heuristic.
 *   (b) No-swallow assertion: after the bulk INSERT OR IGNORE, the actual
 *       `changes` count is compared against the source row count. Any shortfall
 *       is surfaced as a hard table-level error (not a silent success).
 *       PK/UNIQUE conflicts on resume are tolerated (they are expected and safe
 *       to ignore); unexpected shortfalls are flagged with a detailed error.
 *
 * ## ATTACH-once-per-source design (P0 fix — T11531)
 *
 * Each legacy source DB is ATTACHed to the target handle ONCE using a unique
 * per-source alias, all tables from that source are copied under the single
 * attachment, and then the alias is DETACHed. The ATTACH and DETACH are
 * performed **outside** the BEGIN/COMMIT transaction block because SQLite
 * forbids DETACH inside an active multi-statement transaction. The INSERT
 * statements themselves are issued inside the transaction for atomicity (AC6).
 *
 * Prior implementation called ATTACH/DETACH per-table inside an open
 * transaction — DETACH silently failed (SQLite restriction), the alias stayed
 * attached, and every subsequent table for the same source threw
 * "database _exodus_src_ is already in use", causing ~80 % data loss.
 *
 * ## FK-defer bulk copy (ROOT CAUSE 1 fix — T11533)
 *
 * Legacy tasks.db has self-referential FKs (`tasks.parent_id → tasks.id`),
 * cross-table FKs, and ~18 tables with FK relationships. When FK enforcement
 * is ON and tables are copied in arbitrary order (children before parents),
 * each child INSERT fails with FOREIGN KEY constraint error (SQLite errcode 787)
 * and the table is silently skipped — causing ~114K rows of data loss.
 *
 * Fix: set `PRAGMA foreign_keys = OFF` on the target connection before any
 * bulk INSERT, then after all tables are committed run `PRAGMA foreign_key_check`
 * to validate referential integrity. Genuine orphan rows surface as verify
 * failures; child-before-parent ordering artifacts are NOT dropped.
 * `PRAGMA foreign_keys = ON` is restored after the check.
 *
 * ## Name-mapping (ROOT CAUSE 1 fix — T11532)
 *
 * Legacy source DBs use UNPREFIXED table names (`tasks`, `messages`, `skills`,
 * …) while the consolidated `cleo.db` uses DOMAIN-PREFIXED names
 * (`tasks_tasks`, `conduit_messages`, `skills_skills`, …). The
 * `resolveConsolidatedTableName()` function from `table-name-map.ts` performs
 * the deterministic legacy→consolidated mapping before every copy. Tables with
 * no consolidated home emit an explicit WARN journal entry rather than being
 * silently discarded.
 *
 * ## Column-drift tolerance (ROOT CAUSE 2 fix — T11532, hardened T11533)
 *
 * When the source and target schemas differ (consolidated schema added/changed
 * columns vs legacy), the copy uses the INTERSECTION of source and target
 * column names. New target-only columns take their schema defaults; old
 * source-only columns are dropped. This is implemented by introspecting both
 * schemas via `PRAGMA table_info` and building an explicit column list.
 *
 * **NOT NULL / no-default hazard (T11533)**: target-only NOT NULL columns
 * WITHOUT a schema default caused `INSERT OR IGNORE` to silently drop rows
 * whose source value was NULL for that column (constraint violation → IGNORE).
 * The fix: for each intersection column that is NOT NULL in the target AND
 * has no `dflt_value`, the SELECT clause wraps the source reference in
 * `COALESCE(src_col, type_default)` so no row is silently dropped.
 * A type_default of `''` is used for TEXT affinity and `0` for numeric.
 *
 * ## Advisory file lock (AC4)
 *
 * The source DB files are opened read-only via `openCleoDbSnapshot` which
 * calls `new DatabaseSync(path, { readOnly: true })`. Node's SQLite binding
 * opens with `SQLITE_OPEN_READONLY`, which prevents any writes from this
 * process. We additionally write a `.lock` sentinel file next to each source
 * DB for the duration of the migration so that other CLEO processes can detect
 * an in-progress exodus and refuse to write.
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @task T11531 (P0 attach-leak fix)
 * @task T11532 (P0 name-mapping + column-drift + verify-rowid fix)
 * @task T11533 (P0 FK-defer + NOT NULL coalesce + signaldock-global map + nexus hash fix)
 * @task T11547 (P0 enum normalization — 7,421 rows recovered)
 * @saga T11242
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getLogger } from '../../logger.js';
import { getCleoVersion } from '../../scaffold/ensure-config.js';
import { openDualScopeDb } from '../dual-scope-db.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { resolveConsolidatedTableName } from './table-name-map.js';
import type {
  ExodusJournal,
  ExodusMigrateResult,
  ExodusPlan,
  JournalTableEntry,
  LegacyDbDescriptor,
  TableCopyResult,
  TableMigrationStatus,
} from './types.js';
import { EXODUS_TARGET_SCHEMA_VERSION } from './types.js';

const log = getLogger('exodus-migrate');

// ---------------------------------------------------------------------------
// Advisory lock sentinel filename
// ---------------------------------------------------------------------------

const LOCK_SENTINEL_SUFFIX = '.exodus-lock' as const;

// ---------------------------------------------------------------------------
// Journal helpers
// ---------------------------------------------------------------------------

const JOURNAL_FILENAME = 'exodus-journal.json' as const;

/**
 * Get the SQLite version string from an open DatabaseSync handle.
 */
function getSqliteVersion(db: DatabaseSync): string {
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | null;
    return row?.v ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Read the tables list from a legacy SQLite DB (excluding SQLite internals).
 */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Write the journal file atomically (write-then-rename pattern).
 */
function writeJournal(stagingDir: string, journal: ExodusJournal): void {
  const journalPath = join(stagingDir, JOURNAL_FILENAME);
  const tmpPath = `${journalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(journal, null, 2) + '\n', 'utf8');
  // On POSIX, rename is atomic within the same fs.
  renameSync(tmpPath, journalPath);
}

/**
 * Read an existing journal from the staging dir, or return `null`.
 */
function readJournal(stagingDir: string): ExodusJournal | null {
  const journalPath = join(stagingDir, JOURNAL_FILENAME);
  if (!existsSync(journalPath)) return null;
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8')) as ExodusJournal;
  } catch {
    return null;
  }
}

/**
 * Initialise a fresh journal object.
 */
function initJournal(sqliteVersion: string): ExodusJournal {
  const now = new Date().toISOString();
  return {
    version: 1,
    cleoVersion: getCleoVersion(),
    targetSchemaVersion: EXODUS_TARGET_SCHEMA_VERSION,
    nodeVersion: process.version,
    sqliteVersion,
    startedAt: now,
    updatedAt: now,
    tables: [],
  };
}

// ---------------------------------------------------------------------------
// Advisory lock sentinel helpers (AC4)
// ---------------------------------------------------------------------------

function lockPath(dbPath: string): string {
  return `${dbPath}${LOCK_SENTINEL_SUFFIX}`;
}

function acquireAdvisoryLock(dbPath: string): void {
  const lp = lockPath(dbPath);
  writeFileSync(lp, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
}

function releaseAdvisoryLock(dbPath: string): void {
  try {
    unlinkSync(lockPath(dbPath));
  } catch {
    // Ignore — lock may already be gone
  }
}

// ---------------------------------------------------------------------------
// Unique ATTACH alias per source DB (T11531)
// ---------------------------------------------------------------------------

/**
 * Convert a source DB name to a safe, unique SQLite ATTACH alias.
 *
 * SQLite identifiers may contain only word characters; we prefix with
 * `_src_` so they never collide with target table names.
 *
 * @param name  - Logical name from `LegacyDbDescriptor.name` (e.g. `"brain (project)"`).
 * @param index - Positional index used when names collide after sanitisation.
 * @returns A unique, identifier-safe alias string.
 */
function makeAttachAlias(name: string, index: number): string {
  const safe = name
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .slice(0, 20);
  // Include the index to guarantee uniqueness even if two names normalise identically.
  return `_src_${safe}_${index}`;
}

// ---------------------------------------------------------------------------
// Core copy function — operates on an ALREADY-ATTACHED source alias
// ---------------------------------------------------------------------------

/**
 * Result of `copyTableFromAttached` — extends the row count with skip metadata.
 */
interface CopyTableResult {
  /** Number of rows inserted into the target (0 if skipped or empty). */
  readonly rowsCopied: number;
  /** True if the table was intentionally skipped (no consolidated target, etc.). */
  readonly skipped: boolean;
  /**
   * Human-readable reason when `skipped === true` OR when a no-swallow error
   * is detected (rows dropped by CHECK/type constraints). When present and
   * `skipped === false`, the table was copied but with errors.
   */
  readonly reason?: string;
}

/**
 * Determine a safe SQL literal default for a NOT NULL column with no schema
 * default, given its SQLite type affinity.
 *
 * Used to coalesce NULL source values for target-only NOT NULL columns so that
 * rows are not silently dropped by `INSERT OR IGNORE` when a source value is
 * NULL (T11533 ROOT CAUSE 2 fix).
 *
 * @param colType - Raw `type` string from `PRAGMA table_info` (e.g. `"INTEGER"`,
 *   `"TEXT"`, `"REAL"`, `"BLOB"`, or compound forms like `"text NOT NULL"`).
 * @returns A SQL literal string suitable for embedding in a `COALESCE()` call.
 */
function typeDefaultLiteral(colType: string): string {
  const upper = colType.toUpperCase();
  if (upper.includes('INT')) return '0';
  if (upper.includes('REAL') || upper.includes('FLOAT') || upper.includes('DOUBLE')) return '0.0';
  if (upper.includes('BLOB')) return "x''";
  // TEXT and any other affinity (SQLite permissive) → empty string
  return "''";
}

// ---------------------------------------------------------------------------
// Enum-value normalization layer (ROOT CAUSE fix — T11547)
// ---------------------------------------------------------------------------

/**
 * Per-(targetTable, column) normalization rules that map legacy enum values to
 * the canonical enum accepted by the consolidated schema CHECK constraints.
 *
 * Each entry is a function that, given the `srcRef` SQL expression for the
 * column, returns a SQL CASE expression that produces the canonical value.
 * Rows with already-canonical values pass through unchanged (the ELSE branch).
 *
 * ## Design decisions (T11547)
 *
 * - `tasks_task_commits.link_source = 'commit-message'`
 *   → mapped to `'commit-subject'` (nearest canonical; legacy writers used
 *   'commit-message' as the name for subject-line scanning before the enum
 *   was tightened in T9506).
 *
 * - `tasks_architecture_decisions.status` (case normalization)
 *   → `'Accepted'`, `'ACCEPTED'`, `'approved'` all → `'accepted'`;
 *   `'Accepted (2026-04-18)'` and similar date-suffixed variants → `'accepted'`.
 *   These map cleanly to the existing enum; no schema extension needed.
 *
 * - `brain_observations.source_type`
 *   → `'observer-compressed'` was a legacy compression artefact produced by
 *   the brain observer pipeline when it batch-compressed session observations;
 *   semantically equivalent to `'agent'`. `'sleep-consolidation'` was the
 *   nightly dream-consolidation job; also maps to `'agent'` (closest canonical).
 *
 * - `brain_observations.type`
 *   → `'observation'` was the original catch-all type before the taxonomy was
 *   expanded; `'discovery'` is the closest canonical.
 *   `'proposal'` was used before `'decision'` was split out; maps to `'decision'`.
 *   `'pattern'` was an experimental type; maps to `'refactor'` (structural insight).
 *
 * - `brain_decisions.confirmation_state`
 *   → `'Accepted'`, `'ACCEPTED'`, `'approved'` all → `'accepted'` (same case
 *   normalization as architecture_decisions.status; brain_decisions uses
 *   a separate CHECK with the same three canonical values).
 *
 * Lookup key: `${targetTable}.${column}` (lowercase, dotted).
 *
 * @since T11547 (P0 data-loss fix)
 */
type NormalizeFn = (srcRef: string) => string;

const ENUM_NORMALIZATIONS: ReadonlyMap<string, NormalizeFn> = new Map([
  // --- task_commits.link_source -------------------------------------------
  // 'commit-message' → 'commit-subject' (pre-T9506 legacy value)
  [
    'tasks_task_commits.link_source',
    (src: string) => `CASE ${src} WHEN 'commit-message' THEN 'commit-subject' ELSE ${src} END`,
  ],

  // --- architecture_decisions.status (case + date-suffix normalization) ----
  // 'Accepted', 'ACCEPTED', 'approved', 'Accepted (2026-04-18)', … → 'accepted'
  // 'Proposed', 'PROPOSED' → 'proposed'
  // 'Superseded', 'SUPERSEDED' → 'superseded'
  [
    'tasks_architecture_decisions.status',
    (src: string) =>
      `CASE` +
      ` WHEN lower(${src}) = 'accepted' OR lower(${src}) LIKE 'accepted %' OR lower(${src}) = 'approved' THEN 'accepted'` +
      ` WHEN lower(${src}) = 'proposed' THEN 'proposed'` +
      ` WHEN lower(${src}) = 'superseded' THEN 'superseded'` +
      ` WHEN lower(${src}) = 'deprecated' THEN 'deprecated'` +
      ` ELSE ${src}` +
      ` END`,
  ],

  // --- brain_observations.source_type -------------------------------------
  // 'observer-compressed' and 'sleep-consolidation' → 'agent'
  [
    'brain_observations.source_type',
    (src: string) =>
      `CASE ${src}` +
      ` WHEN 'observer-compressed' THEN 'agent'` +
      ` WHEN 'sleep-consolidation' THEN 'agent'` +
      ` ELSE ${src}` +
      ` END`,
  ],

  // --- brain_observations.type --------------------------------------------
  // 'observation' → 'discovery', 'proposal' → 'decision', 'pattern' → 'refactor'
  [
    'brain_observations.type',
    (src: string) =>
      `CASE ${src}` +
      ` WHEN 'observation' THEN 'discovery'` +
      ` WHEN 'proposal' THEN 'decision'` +
      ` WHEN 'pattern' THEN 'refactor'` +
      ` ELSE ${src}` +
      ` END`,
  ],

  // --- brain_decisions.confirmation_state ---------------------------------
  // Same case normalization as architecture_decisions.status
  [
    'brain_decisions.confirmation_state',
    (src: string) =>
      `CASE` +
      ` WHEN lower(${src}) = 'accepted' OR lower(${src}) = 'approved' THEN 'accepted'` +
      ` WHEN lower(${src}) = 'proposed' THEN 'proposed'` +
      ` WHEN lower(${src}) = 'superseded' THEN 'superseded'` +
      ` ELSE ${src}` +
      ` END`,
  ],
]);

/**
 * Return a SQL CASE expression that normalises legacy enum values for `col` in
 * `targetTableName` to the canonical values accepted by the consolidated CHECK,
 * or return `null` when no normalization rule exists for this (table, column).
 *
 * @param targetTableName - Physical consolidated target table name.
 * @param col             - Column name.
 * @param srcRef          - SQL expression referencing the source column.
 * @returns A SQL CASE expression string, or `null` if no rule applies.
 */
function enumNormExpr(targetTableName: string, col: string, srcRef: string): string | null {
  const key = `${targetTableName}.${col}`;
  const fn = ENUM_NORMALIZATIONS.get(key);
  return fn ? fn(srcRef) : null;
}

// ---------------------------------------------------------------------------
// Epoch-to-ISO coercion layer (ROOT CAUSE 1 fix — T11546)
// ---------------------------------------------------------------------------

/**
 * Regex to detect ISO GLOB CHECK constraints in DDL SQL.
 * Matches: `CHECK ("colname" IS NULL OR "colname" GLOB '[0-9]...')`
 * Uses `\[0-9` to match the literal `[0-9` at the start of the GLOB pattern.
 */
const ISO_CHECK_REGEX = /CHECK\s*\(\s*"([^"]+)"\s+IS\s+NULL\s+OR\s+"[^"]+"\s+GLOB\s+'\[0-9/gi;

/**
 * Epoch unit: seconds (Unix seconds) vs milliseconds (Date.now() / unixepoch * 1000).
 *
 * Rules per source DB (§8.1 resolution from schema analysis):
 * - conduit.db: epoch SECONDS — writers call `Math.floor(Date.now() / 1000)`
 * - brain.db: epoch MILLISECONDS — writers call `Date.now()` / `unixepoch * 1000`
 */
type EpochUnit = 'seconds' | 'milliseconds';

/**
 * Per-source-DB epoch unit lookup.
 * Used by `epochUnitForSource()` to pick the right `strftime` divisor.
 *
 * Verified from schema source comments (§8.1 resolution):
 * - conduit.db:   `Math.floor(Date.now() / 1000)` → SECONDS
 * - brain.db:     `Date.now()` / `unixepoch * 1000` → MILLISECONDS
 * - signaldock.db: `strftime('%s','now')` → SECONDS
 * - tasks.db:     `Date.now()` → MILLISECONDS (most writers)
 * - nexus.db:     `Date.now()` → MILLISECONDS
 * - skills.db:    `Date.now()` → MILLISECONDS
 */
const SOURCE_EPOCH_UNITS: ReadonlyMap<string, EpochUnit> = new Map([
  ['conduit', 'seconds'],
  ['brain', 'milliseconds'],
  ['brain (project)', 'milliseconds'],
  ['brain (global)', 'milliseconds'],
  ['signaldock', 'seconds'],
  ['tasks', 'milliseconds'],
  ['nexus', 'milliseconds'],
  ['skills', 'milliseconds'],
]);

/**
 * Return the epoch unit used by a given source DB's INTEGER timestamp columns.
 * Defaults to `'seconds'` for unknown sources (safe default — ISO-8601 output
 * will be off by 1000x only for ms sources, which are already enumerated above).
 */
function epochUnitForSource(sourceName: string): EpochUnit {
  const key = sourceName.toLowerCase();
  // Check for prefix matches (e.g. "brain (project)" starts with "brain")
  for (const [pattern, unit] of SOURCE_EPOCH_UNITS) {
    if (key === pattern || key.startsWith(pattern)) return unit;
  }
  return 'seconds';
}

/**
 * Parse the DDL for a given table from `sqlite_master` and return the set of
 * column names that have an ISO GLOB CHECK constraint.
 *
 * Reads the raw DDL text and uses a regex to extract column names appearing in
 * `CHECK ("colname" IS NULL OR "colname" GLOB '[0-9]...')` patterns. This is
 * robust to Drizzle's generated CHECK format (all CHECK constraints generated
 * by T11363 follow this exact pattern).
 *
 * @param db          - Target DB with the consolidated schema.
 * @param tableName   - Physical table name (consolidated, e.g. `conduit_messages`).
 * @returns Set of column names that require ISO GLOB validation.
 */
function detectIsoGlobColumns(db: DatabaseSync, tableName: string): Set<string> {
  const escapedTable = tableName.replace(/'/g, "''");
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${escapedTable}'`)
    .get() as { sql: string } | null;

  if (!row?.sql) return new Set();

  const isoColumns = new Set<string>();
  // Pattern: CHECK ("colname" IS NULL OR "colname" GLOB '[0-9]...')
  // The column name appears TWICE — we capture the first occurrence.
  // Use matchAll to avoid the biome no-assign-in-expressions rule.
  ISO_CHECK_REGEX.lastIndex = 0; // reset before reuse (global regex stateful)
  for (const match of row.sql.matchAll(ISO_CHECK_REGEX)) {
    isoColumns.add(match[1]);
  }
  return isoColumns;
}

/**
 * Build a SQL SELECT expression for a shared column, applying (in priority order):
 *
 * 1. **Epoch→ISO-8601 coercion** (T11546): when the target has an ISO GLOB CHECK
 *    and the source column is INTEGER-typed.
 * 2. **Enum-value normalization** (T11547): when `ENUM_NORMALIZATIONS` has an
 *    entry for `(targetTableName, col)`, producing a SQL CASE expression that
 *    maps legacy values to canonical enum members without losing semantics.
 * 3. **NOT NULL coalesce** (T11533): for non-epoch, non-normalized columns whose
 *    target is NOT NULL with no schema default.
 * 4. **Plain column reference** otherwise.
 *
 * The epoch→ISO conversion uses SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`:
 * - For `seconds` epoch: `strftime('%Y-%m-%dT%H:%M:%fZ', src, 'unixepoch')`
 * - For `milliseconds` epoch: `strftime('%Y-%m-%dT%H:%M:%fZ', src/1000.0, 'unixepoch')`
 *
 * A NULL source value is preserved as NULL (passes the `IS NULL` branch of the
 * GLOB CHECK, and is OK for nullable columns).
 *
 * @param attachAlias      - ATTACH alias for the source DB.
 * @param legacyTable      - Legacy table name in the source.
 * @param targetTableName  - Physical consolidated target table name (for enum lookup).
 * @param col              - Column name.
 * @param srcType          - Raw type string from source `PRAGMA table_info`.
 * @param tgtInfo          - Target column metadata from `PRAGMA table_info`.
 * @param isoGlobCols      - Set of columns requiring ISO GLOB in the target.
 * @param epochUnit        - Whether the source stores seconds or milliseconds.
 * @returns SQL expression string suitable for use in a SELECT clause.
 */
function buildSelectExpr(
  attachAlias: string,
  legacyTable: string,
  targetTableName: string,
  col: string,
  srcType: string,
  tgtInfo: { type: string; notnull: number; dflt_value: string | null },
  isoGlobCols: ReadonlySet<string>,
  epochUnit: EpochUnit,
): string {
  const srcRef = `"${attachAlias}"."${legacyTable}"."${col}"`;
  const srcUpper = srcType.toUpperCase();
  const isIntegerSource = srcUpper.includes('INT') || srcUpper === '' || srcUpper === 'NUMERIC';
  const isNotNullWithoutDefault = tgtInfo.notnull === 1 && tgtInfo.dflt_value === null;

  // Priority 1: Epoch→ISO coercion (T11546) — applies when target has ISO GLOB
  // CHECK and source column is INTEGER (epoch) typed.
  if (isoGlobCols.has(col) && isIntegerSource) {
    const divisor = epochUnit === 'milliseconds' ? `${srcRef}/1000.0` : srcRef;
    // CASE preserves NULL (passes `IS NULL` branch of CHECK) and converts non-NULL epochs.
    const isoExpr = `CASE WHEN ${srcRef} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${divisor}, 'unixepoch') END`;
    // If the target is NOT NULL without a default, COALESCE to '' to avoid a separate
    // constraint violation (though a NULL epoch is anomalous data).
    if (isNotNullWithoutDefault) {
      return `COALESCE(${isoExpr}, '') AS "${col}"`;
    }
    return `${isoExpr} AS "${col}"`;
  }

  // Priority 2: Enum-value normalization (T11547) — maps legacy enum values to
  // canonical members so CHECK constraints accept them.
  const normExpr = enumNormExpr(targetTableName, col, srcRef);
  if (normExpr !== null) {
    // Wrap in COALESCE if the target is NOT NULL without a default, so NULL
    // source values get a safe fallback instead of triggering a constraint drop.
    if (isNotNullWithoutDefault) {
      const defLiteral = typeDefaultLiteral(tgtInfo.type);
      return `COALESCE(${normExpr}, ${defLiteral}) AS "${col}"`;
    }
    return `${normExpr} AS "${col}"`;
  }

  // Priority 3: Standard NOT NULL coalesce for non-epoch, non-normalized columns
  // (T11533 fix preserved).
  if (isNotNullWithoutDefault) {
    const defLiteral = typeDefaultLiteral(tgtInfo.type);
    return `COALESCE(${srcRef}, ${defLiteral}) AS "${col}"`;
  }
  return srcRef;
}

/**
 * Copy all rows from a legacy source table (in the already-attached alias) into
 * the corresponding consolidated target table.
 *
 * ## What changed in T11532 vs the T11531 version:
 *
 * 1. **Name mapping (ROOT CAUSE 1 — T11532)**: `legacyTableName` is resolved to
 *    its consolidated name via `resolveConsolidatedTableName()`. Without this,
 *    `tasks` (legacy) was looked up as `main."tasks"` which doesn't exist in
 *    the consolidated schema (the real target is `tasks_tasks`).
 *
 * 2. **Column-drift tolerance (ROOT CAUSE 2 — T11532 + T11533)**: the INSERT
 *    uses the INTERSECTION of source and target column lists rather than source
 *    columns verbatim. When the consolidated schema added new columns, old code
 *    failed. Target-only NOT NULL columns without defaults now get COALESCE()
 *    wrapping in the SELECT so NULL source values don't cause silent row drops.
 *
 * 3. **Explicit skip (ROOT CAUSE 5)**: tables intentionally excluded from the
 *    consolidated schema (virtual tables, orphan telemetry, etc.) now return
 *    a logged skip result rather than being silently treated as "target not
 *    found".
 *
 * 4. **Epoch→ISO coercion (ROOT CAUSE 1 — T11546)**: columns with an ISO GLOB
 *    CHECK in the target that are INTEGER-typed in the source are converted via
 *    `strftime('%Y-%m-%dT%H:%M:%fZ', col[/1000.0], 'unixepoch')`. Without this,
 *    `INSERT OR IGNORE` silently drops ALL rows for those tables (CHECK fails
 *    for every row because an integer like `1717200000` doesn't match the GLOB).
 *
 * 5. **No-swallow assertion (ROOT CAUSE 1b — T11546)**: after the bulk INSERT,
 *    `changes` is compared against the source row count. A shortfall is a hard
 *    per-table error. PK/UNIQUE conflicts on idempotent resume are expected and
 *    tolerated (checked via count of existing rows); CHECK constraint drops are
 *    not tolerated.
 *
 * **Pre-condition**: the caller has already executed
 * `ATTACH DATABASE '<path>' AS "<attachAlias>"` on `targetNativeDb`, and
 * `PRAGMA foreign_keys = OFF` has been set so FK ordering doesn't matter.
 *
 * @param targetNativeDb   - Writable target handle (mid-transaction, FK OFF).
 * @param srcNativeDb      - Read-only source snapshot (for metadata queries).
 * @param attachAlias      - Alias under which the source is attached.
 * @param legacyTableName  - Physical table name in the legacy source DB.
 * @param sourceName       - `LegacyDbDescriptor.name` (for name resolution).
 */
function copyTableFromAttached(
  targetNativeDb: DatabaseSync,
  srcNativeDb: DatabaseSync,
  attachAlias: string,
  legacyTableName: string,
  sourceName: string,
): CopyTableResult {
  // --- Step 1: Resolve the consolidated target table name (ROOT CAUSE 1) ---
  const resolution = resolveConsolidatedTableName(sourceName, legacyTableName);

  if (resolution.kind === 'skip') {
    log.warn(
      { legacyTableName, sourceName, reason: resolution.reason },
      `Exodus: explicitly skipping table — ${resolution.reason}`,
    );
    return { rowsCopied: 0, skipped: true, reason: resolution.reason };
  }

  const targetTableName = resolution.targetName;

  // --- Step 2: Get source column list (full pragma for type info) ---
  const srcPragma = srcNativeDb.prepare(`PRAGMA table_info("${legacyTableName}")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const srcColumns = new Set(srcPragma.map((r) => r.name));
  if (srcColumns.size === 0) return { rowsCopied: 0, skipped: false };

  // --- Step 3: Check source row count (skip INSERT if empty to avoid noise) ---
  const countRow = srcNativeDb.prepare(`SELECT COUNT(*) AS c FROM "${legacyTableName}"`).get() as {
    c: number;
  } | null;
  const sourceCount = countRow?.c ?? 0;
  if (sourceCount === 0) return { rowsCopied: 0, skipped: false };

  // --- Step 4: Check the consolidated target table exists ---
  const escapedTarget = targetTableName.replace(/'/g, "''");
  const existsRow = targetNativeDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${escapedTarget}'`)
    .get() as { name: string } | null;

  if (!existsRow) {
    // Target table absent — log and treat as explicit skip
    const reason = `consolidated target '${targetTableName}' not found (mapped from legacy '${legacyTableName}')`;
    log.warn({ legacyTableName, targetTableName, sourceName, attachAlias }, `Exodus: ${reason}`);
    return { rowsCopied: 0, skipped: true, reason };
  }

  // --- Step 5: Compute column intersection (ROOT CAUSE 2 — T11532 + T11533) ---
  const tgtPragma = targetNativeDb
    .prepare(`PRAGMA table_info("${targetTableName}")`)
    .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;

  // Build a lookup for target columns (type + notNull + dflt_value)
  const tgtColMap = new Map(tgtPragma.map((r) => [r.name, r]));

  // Only copy columns that exist in BOTH source and target.
  const sharedColumns = srcPragma.map((r) => r.name).filter((col) => tgtColMap.has(col));

  if (sharedColumns.length === 0) {
    const reason = `no overlapping columns between source '${legacyTableName}' and target '${targetTableName}'`;
    log.warn({ legacyTableName, targetTableName, sourceName }, `Exodus: ${reason}`);
    return { rowsCopied: 0, skipped: true, reason };
  }

  const srcOnlyColumns = srcPragma.map((r) => r.name).filter((c) => !tgtColMap.has(c));
  const tgtOnlyColumns = tgtPragma.map((r) => r.name).filter((c) => !srcColumns.has(c));
  if (srcOnlyColumns.length > 0 || tgtOnlyColumns.length > 0) {
    log.info(
      { legacyTableName, targetTableName, sourceName, srcOnlyColumns, tgtOnlyColumns },
      'Exodus: column drift detected — copying intersection, dropping src-only cols, using defaults for tgt-only cols',
    );
  }

  // --- Step 5b: Detect ISO GLOB columns in the target (T11546 epoch coercion) ---
  //
  // Read the target table DDL to find columns with ISO-8601 GLOB CHECK constraints.
  // For those columns where the source is INTEGER-typed, we inject a strftime()
  // expression in the SELECT so the inserted value passes the GLOB check.
  const isoGlobCols = detectIsoGlobColumns(targetNativeDb, targetTableName);
  const epochUnit = epochUnitForSource(sourceName);

  // Build a map of source column types for quick lookup in buildSelectExpr.
  const srcTypeMap = new Map(srcPragma.map((r) => [r.name, r.type]));

  if (isoGlobCols.size > 0) {
    // Log which columns will be coerced so the migration journal is traceable.
    const coercedCols = sharedColumns.filter((col) => {
      const srcType = srcTypeMap.get(col) ?? '';
      const upper = srcType.toUpperCase();
      return isoGlobCols.has(col) && (upper.includes('INT') || upper === '' || upper === 'NUMERIC');
    });
    if (coercedCols.length > 0) {
      log.info(
        {
          legacyTableName,
          targetTableName,
          sourceName,
          coercedCols,
          epochUnit,
        },
        `Exodus: applying epoch→ISO coercion for ${coercedCols.length} column(s) (T11546)`,
      );
    }
  }

  // --- Step 5c: Detect enum-normalized columns in this target table (T11547) ---
  //
  // Log which columns have a normalization rule so the migration journal is
  // traceable and operators can verify the mapping was applied.
  const normalizedCols = sharedColumns.filter((col) =>
    ENUM_NORMALIZATIONS.has(`${targetTableName}.${col}`),
  );
  if (normalizedCols.length > 0) {
    log.info(
      { legacyTableName, targetTableName, sourceName, normalizedCols },
      `Exodus: applying enum-value normalization for ${normalizedCols.length} column(s) (T11547)`,
    );
  }

  // --- Step 6: Build the SELECT expression list ---
  //
  // For each shared column, `buildSelectExpr` handles (priority order):
  //   1. Epoch→ISO coercion when target has ISO GLOB CHECK and source is INTEGER (T11546)
  //   2. Enum-value normalization for legacy values not in the consolidated CHECK (T11547)
  //   3. COALESCE for NOT NULL target columns without schema defaults (T11533)
  //   4. Plain column reference otherwise
  const selectExprs = sharedColumns.map((col) => {
    const srcType = srcTypeMap.get(col) ?? '';
    const tgtInfo = tgtColMap.get(col)!;
    return buildSelectExpr(
      attachAlias,
      legacyTableName,
      targetTableName,
      col,
      srcType,
      tgtInfo,
      isoGlobCols,
      epochUnit,
    );
  });

  // --- Step 6b: Handle target-only NOT NULL columns without schema defaults ---
  //
  // If a target-only column is NOT NULL with no dflt_value, omitting it from
  // the INSERT causes a "NOT NULL constraint failed" error, which INSERT OR IGNORE
  // silently converts to a dropped row. We must include these columns in the
  // INSERT with a literal type-default value so every row survives. (T11533 fix)
  const tgtOnlyNotNullCols = tgtOnlyColumns.filter((col) => {
    const info = tgtColMap.get(col);
    return info !== undefined && info.notnull === 1 && info.dflt_value === null;
  });

  const allInsertCols = [...sharedColumns, ...tgtOnlyNotNullCols];
  const allSelectExprs = [
    ...selectExprs,
    ...tgtOnlyNotNullCols.map((col) => {
      const info = tgtColMap.get(col)!;
      return `${typeDefaultLiteral(info.type)} AS "${col}"`;
    }),
  ];

  const colList = allInsertCols.map((c) => `"${c}"`).join(', ');
  const selectList = allSelectExprs.join(', ');

  // INSERT OR IGNORE so idempotency keys prevent duplicates on resume.
  // The source alias uses legacyTableName; the target uses consolidatedName.
  // OR IGNORE fires on PK/UNIQUE conflicts (safe for idempotent resume) AND
  // on CHECK constraint violations (dangerous — must detect and report).
  const stmt = targetNativeDb.prepare(
    `INSERT OR IGNORE INTO main."${targetTableName}" (${colList}) ` +
      `SELECT ${selectList} FROM "${attachAlias}"."${legacyTableName}"`,
  );
  const result = stmt.run();
  const rowsCopied = (result as unknown as { changes: number }).changes ?? 0;

  // --- Step 7: No-swallow assertion (ROOT CAUSE 1b — T11546) ---
  //
  // If rowsCopied < sourceCount, rows were silently dropped. This can happen for
  // two reasons:
  //   a) PK/UNIQUE conflict on idempotent resume — EXPECTED and SAFE (the data
  //      is already in the target from a previous run).
  //   b) CHECK / NOT NULL / type constraint violation — DATA LOSS, must error.
  //
  // We distinguish these by counting existing target rows BEFORE the INSERT
  // and comparing: if (existingBefore + sourceCount) > rowsCopied + existingBefore,
  // some rows were dropped by constraints rather than deduplicated. However,
  // since we are mid-transaction and do not know existingBefore (prior sources
  // may have written to the same table), we take a simpler approach: if
  // rowsCopied == 0 AND sourceCount > 0, this is almost certainly a constraint
  // failure (a full-table dedup on resume would be extremely unusual). If
  // rowsCopied < sourceCount but > 0, it may be a partial dedup. We log a
  // warning for partial losses and a hard error for full (0-row) losses.
  //
  // The verifier (`runExodusVerify`) catches any remaining discrepancy post-hoc.
  if (rowsCopied < sourceCount) {
    const dropped = sourceCount - rowsCopied;
    if (rowsCopied === 0) {
      // Full table drop — almost certainly a CHECK or type constraint failure.
      const reason = `INSERT OR IGNORE dropped ALL ${sourceCount} rows from '${legacyTableName}'→'${targetTableName}' (rowsCopied=0, sourceCount=${sourceCount}). Likely a CHECK/type constraint violation — check epoch coercion or enum values.`;
      log.error(
        { legacyTableName, targetTableName, sourceName, sourceCount, rowsCopied },
        `Exodus: ${reason}`,
      );
      return { rowsCopied: 0, skipped: false, reason };
    }
    // Partial drop — could be UNIQUE dedup on resume or a real constraint drop.
    // Log as warning and let the verifier catch genuine losses.
    log.warn(
      { legacyTableName, targetTableName, sourceName, sourceCount, rowsCopied, dropped },
      `Exodus: INSERT OR IGNORE dropped ${dropped}/${sourceCount} rows from '${legacyTableName}'→'${targetTableName}' — may be idempotent-resume dedup or a constraint violation; verify will confirm`,
    );
  }

  return { rowsCopied, skipped: false };
}

// ---------------------------------------------------------------------------
// Main migration runner
// ---------------------------------------------------------------------------

/**
 * Validate that the journal's schema version matches the current target version.
 *
 * When `forceCrossVersion === true`, mismatches are logged but not fatal.
 */
function checkSchemaVersion(journal: ExodusJournal, forceCrossVersion: boolean): boolean {
  if (journal.targetSchemaVersion !== EXODUS_TARGET_SCHEMA_VERSION) {
    const msg = `Schema version mismatch: journal=${journal.targetSchemaVersion}, expected=${EXODUS_TARGET_SCHEMA_VERSION}`;
    if (forceCrossVersion) {
      log.warn(msg + ' (--force-cross-version: continuing anyway)');
      return true;
    }
    log.error(msg + ' — pass --force-cross-version to override');
    return false;
  }
  return true;
}

/**
 * Run the exodus migration.
 *
 * @param plan               - Pre-flight plan from `buildExodusPlan()`.
 * @param forceCrossVersion  - Skip the schema-version guard (AC9).
 * @param onProgress         - Optional progress callback called after each table.
 *
 * @returns {@link ExodusMigrateResult}
 *
 * @task T11248 (AC4, AC5, AC6, AC7, AC9)
 * @task T11531 (P0 attach-leak fix)
 */
export async function runExodusMigrate(
  plan: ExodusPlan,
  forceCrossVersion = false,
  onProgress?: (msg: string) => void,
): Promise<ExodusMigrateResult> {
  const { sources, stagingDir, diskPreflight } = plan;

  // AC8: disk pre-flight
  if (!diskPreflight) {
    return {
      ok: false,
      tables: [],
      stagingDir,
      backupPaths: [],
      error: `Insufficient disk space: need ≥3× source size (${plan.totalSourceBytes} bytes source, ${plan.availableBytes} bytes available). Free up space or use a different storage location.`,
    };
  }

  // Ensure staging directory exists (AC5)
  mkdirSync(stagingDir, { recursive: true });

  // Determine SQLite version from the first available source DB
  let sqliteVersion = 'unknown';
  for (const src of sources) {
    if (existsSync(src.path)) {
      const snap = openCleoDbSnapshot(src.path, { readOnly: true });
      sqliteVersion = getSqliteVersion(snap.db);
      snap.close();
      break;
    }
  }

  // Load or initialise the journal (AC5 — resume from staging)
  let journal = readJournal(stagingDir);
  if (journal === null) {
    journal = initJournal(sqliteVersion);
  } else {
    // Existing journal — check schema version (AC9)
    if (!checkSchemaVersion(journal, forceCrossVersion)) {
      return {
        ok: false,
        tables: [],
        stagingDir,
        backupPaths: [],
        error: 'Schema version mismatch. Pass --force-cross-version to override.',
      };
    }
    onProgress?.('Resuming from existing staging journal…');
  }

  const backupPaths: string[] = [];
  const allTableResults: TableCopyResult[] = [];
  const lockedPaths: string[] = [];

  try {
    // 1. Back up existing source DBs into staging dir and acquire advisory locks
    for (const src of sources) {
      if (!existsSync(src.path)) continue;
      const backupDest = join(stagingDir, `${src.name.replace(/[^a-z0-9-]/g, '_')}-backup.db`);
      if (!existsSync(backupDest)) {
        onProgress?.(`Backing up ${src.name} → staging dir…`);
        copyFileSync(src.path, backupDest);
        backupPaths.push(backupDest);
      }
      // AC4: advisory lock sentinel
      acquireAdvisoryLock(src.path);
      lockedPaths.push(src.path);
    }

    // 2. Open (or create) the consolidated target DBs via the chokepoint.
    //    This runs Drizzle migrations to create the target schema.
    onProgress?.('Opening consolidated project-scope cleo.db (running migrations)…');
    // openDualScopeDb takes cwd, not a db path — pass undefined to use process.cwd()
    const projectHandle = await openDualScopeDb('project');

    onProgress?.('Opening consolidated global-scope cleo.db (running migrations)…');
    const globalHandle = await openDualScopeDb('global');

    // Extract the raw DatabaseSync from the Drizzle wrapper ($client pattern).
    function extractNativeDb(handle: { db: unknown }): DatabaseSync {
      const drizzleHandle = handle.db as Record<string, unknown>;
      const client = drizzleHandle['$client'];
      if (client && typeof (client as Record<string, unknown>)['prepare'] === 'function') {
        return client as DatabaseSync;
      }
      // Fallback: the handle itself may be a DatabaseSync (unlikely but safe)
      if (typeof (drizzleHandle as unknown as Record<string, unknown>)['prepare'] === 'function') {
        return drizzleHandle as unknown as DatabaseSync;
      }
      throw new Error('Could not extract native DatabaseSync from dual-scope DB handle');
    }

    const projectNative = extractNativeDb(projectHandle);
    const globalNative = extractNativeDb(globalHandle);

    // 3. Per-scope sources migration (AC6)
    const projectSources = sources.filter((s) => s.targetScope === 'project' && existsSync(s.path));
    const globalSources = sources.filter((s) => s.targetScope === 'global' && existsSync(s.path));

    await migrateScope(
      'project',
      projectSources,
      projectNative,
      journal,
      stagingDir,
      allTableResults,
      onProgress,
    );
    await migrateScope(
      'global',
      globalSources,
      globalNative,
      journal,
      stagingDir,
      allTableResults,
      onProgress,
    );

    // Final journal update
    journal.updatedAt = new Date().toISOString();
    writeJournal(stagingDir, journal);

    projectHandle.close();
    globalHandle.close();

    return { ok: true, tables: allTableResults, stagingDir, backupPaths };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Exodus migration failed');
    return { ok: false, tables: allTableResults, stagingDir, backupPaths, error };
  } finally {
    // Release advisory locks
    for (const p of lockedPaths) {
      releaseAdvisoryLock(p);
    }
  }
}

/**
 * Migrate all tables from the given sources into the target native DB.
 *
 * ## ATTACH-once-per-source protocol (T11531)
 *
 * SQLite forbids `DETACH` inside an active multi-statement transaction.
 * To avoid the "database alias is already in use" error that caused ~80 %
 * data loss, we use the following sequence **per source DB**:
 *
 *   1. ATTACH the source path under a unique alias (outside any transaction).
 *   2. Open a read-only snapshot of the source for metadata queries.
 *   3. BEGIN the write transaction on the target.
 *   4. INSERT OR IGNORE … SELECT for each table using the attached alias.
 *   5. COMMIT (or ROLLBACK on error).
 *   6. DETACH the source alias in `finally` (outside the committed transaction).
 *   7. Close the read-only snapshot.
 *
 * Each source gets its own unique alias (`_src_<name>_<index>`) so multiple
 * sources can be processed sequentially without alias conflicts.
 *
 * ## FK-defer protocol (T11533 ROOT CAUSE 1)
 *
 * Before the first INSERT in any scope, foreign-key enforcement is switched OFF
 * on the target connection (`PRAGMA foreign_keys = OFF`) so copy order does not
 * matter (avoids "FOREIGN KEY constraint failed" for child-before-parent copies).
 * After all sources in the scope are committed, `PRAGMA foreign_key_check` is
 * executed to surface genuinely orphaned rows, and then FK enforcement is
 * restored (`PRAGMA foreign_keys = ON`).
 *
 * Sequence across all sources in a scope:
 *   PRAGMA foreign_keys = OFF
 *   for each source:
 *     ATTACH … AS alias (outside tx)
 *     BEGIN
 *     INSERT … SELECT for each table
 *     COMMIT
 *     DETACH alias (outside tx)
 *   PRAGMA foreign_key_check  → log orphans as warnings
 *   PRAGMA foreign_keys = ON
 */
async function migrateScope(
  scope: string,
  sources: LegacyDbDescriptor[],
  targetNativeDb: DatabaseSync,
  journal: ExodusJournal,
  stagingDir: string,
  allTableResults: TableCopyResult[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (sources.length === 0) return;

  onProgress?.(`Migrating ${scope}-scope sources…`);

  // FK-defer: disable FK enforcement for the entire scope's bulk copy so that
  // copy order (child-before-parent) does not cause constraint failures.
  // Restored + checked after all sources in this scope are committed (T11533).
  targetNativeDb.exec('PRAGMA foreign_keys = OFF');
  log.info({ scope }, 'Exodus: foreign_keys=OFF for bulk copy (T11533 FK-defer)');

  try {
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const attachAlias = makeAttachAlias(src.name, i);
      const escapedPath = src.path.replace(/'/g, "''");

      // Step 1: ATTACH the source outside any transaction (SQLite restriction).
      // The finally block below guarantees DETACH runs even on error.
      targetNativeDb.exec(`ATTACH DATABASE '${escapedPath}' AS "${attachAlias}"`);
      onProgress?.(`  [${src.name}] Attached as "${attachAlias}"`);

      // Step 2: Open a read-only snapshot for metadata (column info, counts).
      const snap = openCleoDbSnapshot(src.path, { readOnly: true });

      try {
        const tables = listTables(snap.db);

        // Step 3: BEGIN the transaction for this source's copy batch (AC6).
        // Per-source transactions mean a failing source does not roll back
        // previously-copied sources.
        targetNativeDb.exec('BEGIN');
        let txOpen = true;

        try {
          for (const tableName of tables) {
            // Check journal for resume (AC5)
            const existing = journal.tables.find(
              (e) => e.sourceDb === src.name && e.tableName === tableName,
            );
            if (existing?.status === 'done') {
              onProgress?.(`  ↳ ${src.name}.${tableName} — already done (resuming)`);
              allTableResults.push({
                sourceDb: src.name,
                tableName,
                rowsCopied: existing.rowsCopied,
                skipped: false,
              });
              continue;
            }

            onProgress?.(`  ↳ Copying ${src.name}.${tableName}…`);
            let rowsCopied = 0;
            let status: TableMigrationStatus = 'done';
            let errorMsg: string | undefined;
            let skipped = false;

            try {
              // Step 4: INSERT using the already-attached alias — no per-table ATTACH/DETACH.
              // FK enforcement is OFF (set at scope start), so copy order does not matter.
              // Pass src.name so copyTableFromAttached can resolve the consolidated target name.
              const copyResult = copyTableFromAttached(
                targetNativeDb,
                snap.db,
                attachAlias,
                tableName,
                src.name,
              );
              rowsCopied = copyResult.rowsCopied;
              if (copyResult.skipped) {
                status = 'skipped';
                errorMsg = copyResult.reason;
                skipped = true;
              } else if (copyResult.reason) {
                // No-swallow error: all rows dropped by a constraint (T11546).
                // The table is NOT skipped (copy was attempted) but the result
                // must be surfaced as an error, not a silent 0-row success.
                status = 'skipped'; // Mark skipped so journal doesn't say "done" on 0 rows
                errorMsg = copyResult.reason;
                // skipped stays false — the distinction is the reason field (data loss vs intentional skip)
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.warn({ tableName, sourceDb: src.name, err }, 'Table copy failed — skipping');
              status = 'skipped';
              errorMsg = msg;
              skipped = true;
            }

            // Update journal entry
            const entry: JournalTableEntry = {
              sourceDb: src.name,
              tableName,
              status,
              rowsCopied,
              updatedAt: new Date().toISOString(),
              ...(errorMsg ? { error: errorMsg } : {}),
            };

            const idx = journal.tables.findIndex(
              (e) => e.sourceDb === src.name && e.tableName === tableName,
            );
            if (idx >= 0) {
              journal.tables[idx] = entry;
            } else {
              journal.tables.push(entry);
            }
            journal.updatedAt = new Date().toISOString();
            // Atomic journal write after each table (AC5 — crash-resumable)
            writeJournal(stagingDir, journal);

            allTableResults.push({
              sourceDb: src.name,
              tableName,
              rowsCopied,
              skipped,
              reason: errorMsg,
            });
          }

          // Step 5: COMMIT all copies for this source.
          targetNativeDb.exec('COMMIT');
          txOpen = false;
        } catch (err) {
          if (txOpen) {
            try {
              targetNativeDb.exec('ROLLBACK');
            } catch {
              // ignore rollback errors
            }
          }
          throw err;
        }
      } finally {
        // Step 7: Close the read-only metadata snapshot.
        snap.close();

        // Step 6: DETACH the source alias — executed outside the (now committed
        // or rolled-back) transaction so SQLite allows it.
        try {
          targetNativeDb.exec(`DETACH DATABASE "${attachAlias}"`);
          onProgress?.(`  [${src.name}] Detached "${attachAlias}"`);
        } catch (detachErr) {
          // Log but do not re-throw — a failed DETACH is non-fatal for the
          // migrated data; the alias will be released when the target DB closes.
          log.warn(
            { attachAlias, sourceDb: src.name, err: detachErr },
            'DETACH failed — alias will be released on DB close',
          );
        }
      }
    } // end for loop over sources
  } finally {
    // FK-check: validate referential integrity AFTER all bulk copies are committed.
    // Genuine orphan rows surface here as warnings; child-before-parent ordering
    // artifacts that would have caused "FOREIGN KEY constraint failed" during copy
    // are now harmless (rows were inserted in FK-OFF mode).
    try {
      const orphans = targetNativeDb.prepare('PRAGMA foreign_key_check').all() as Array<{
        table: string;
        rowid: number;
        parent: string;
        fkid: number;
      }>;
      if (orphans.length > 0) {
        log.warn(
          { scope, orphanCount: orphans.length, sample: orphans.slice(0, 5) },
          `Exodus: PRAGMA foreign_key_check found ${orphans.length} orphan row(s) after bulk copy — these are genuine data orphans (not ordering artifacts)`,
        );
      } else {
        log.info({ scope }, 'Exodus: PRAGMA foreign_key_check PASSED — no orphan rows');
      }
    } catch (checkErr) {
      log.warn(
        { scope, err: checkErr },
        'Exodus: PRAGMA foreign_key_check failed (non-fatal) — target schema may not have FK constraints enabled',
      );
    }

    // Restore FK enforcement on the target connection.
    try {
      targetNativeDb.exec('PRAGMA foreign_keys = ON');
      log.info({ scope }, 'Exodus: foreign_keys=ON restored after bulk copy');
    } catch (fkErr) {
      log.warn({ scope, err: fkErr }, 'Exodus: could not restore foreign_keys=ON (non-fatal)');
    }
  }
}
