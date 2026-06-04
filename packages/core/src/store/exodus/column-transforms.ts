/**
 * Shared column-value transform layer for the exodus migration.
 *
 * The exodus copy (`migrate.ts`) does not move source values byte-for-byte into
 * the consolidated `cleo.db`: a handful of columns are TRANSFORMED on the way in
 * so they satisfy the consolidated schema's CHECK constraints (which the legacy
 * runtime DBs did not carry). Three transform classes exist:
 *
 *   1. **Epoch INTEGER → ISO-8601 TEXT** ({@link buildEpochToIsoExpr}) — for any
 *      target column carrying an ISO-GLOB CHECK ({@link detectIsoGlobColumns}).
 *      A per-row magnitude heuristic ({@link EPOCH_SECONDS_THRESHOLD}) classifies
 *      seconds vs milliseconds.
 *   2. **Legacy enum → canonical member** ({@link ENUM_NORMALIZATIONS} +
 *      {@link enumNormExpr}) — maps pre-tightening enum aliases (e.g.
 *      `tasks_commits.conventional_type` `'style'`/`'merge'` → `'chore'`).
 *   3. **Non-finite REAL → finite** ({@link NUMERIC_CLAMPS} +
 *      {@link numericClampExpr}) — `Inf`/`-Inf`/`NaN` → a finite in-range value
 *      (`brain_weight_history.delta_weight`).
 *
 * ## Why this module exists (T11809 · AC2)
 *
 * Before T11809 these transforms lived ONLY in `migrate.ts`. The parity verifier
 * (`verify-migration.ts`) digested RAW source values against the TRANSFORMED
 * target values, so every coerced column (epoch INTEGER vs ISO TEXT, legacy enum
 * vs canonical, Inf vs clamped) produced a `hashMatch === false` even on a
 * perfectly lossless migration — a false-negative that aborted the cutover and
 * lost the batch writes accumulated during the migrating open.
 *
 * Extracting the transform logic into ONE shared module lets the verifier digest
 * the SOURCE side **through the same transforms migrate applied**
 * ({@link buildDigestExpr}), so equal logical data digests equal. `migrate.ts`
 * re-imports these primitives so its copy behaviour stays byte-identical; the
 * verifier imports {@link buildDigestExpr} for the digest-oriented variant.
 *
 * @task T11809 (exodus verify applies source-side coercion — hashMatch on equal data)
 * @task T11546 (epoch→ISO coercion — original)
 * @task T11547 (enum normalization — original)
 * @task T11782 (non-finite numeric clamp — original)
 * @epic T11249 (E6)
 * @saga T11242
 */

import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// NOT NULL default-literal helper
// ---------------------------------------------------------------------------

/**
 * Determine a safe SQL literal default for a NOT NULL column with no schema
 * default, given its SQLite type affinity.
 *
 * Used by `migrate.ts` to coalesce NULL source values for target-only NOT NULL
 * columns so that rows are not silently dropped by `INSERT OR IGNORE` when a
 * source value is NULL (T11533 ROOT CAUSE 2 fix).
 *
 * @param colType - Raw `type` string from `PRAGMA table_info` (e.g. `"INTEGER"`,
 *   `"TEXT"`, `"REAL"`, `"BLOB"`, or compound forms like `"text NOT NULL"`).
 * @returns A SQL literal string suitable for embedding in a `COALESCE()` call.
 */
export function typeDefaultLiteral(colType: string): string {
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
 * Function shape for an enum-normalization rule: given the `srcRef` SQL
 * expression for a column, return a SQL expression that produces the canonical
 * value.
 */
export type NormalizeFn = (srcRef: string) => string;

/**
 * Per-(targetTable, column) normalization rules that map legacy enum values to
 * the canonical enum accepted by the consolidated schema CHECK constraints.
 *
 * Each entry is a function that, given the `srcRef` SQL expression for the
 * column, returns a SQL CASE expression that produces the canonical value.
 * Rows with already-canonical values pass through unchanged (the ELSE branch).
 *
 * ## Brain enum normalizations REMOVED (T11647)
 *
 * The brain memory family no longer participates in enum normalization. Its
 * consolidated exodus target now matches the LEGACY RUNTIME shape, which carries
 * NO SQL CHECK constraints (the `text({ enum })` unions are enforced at the
 * application layer only). With no CHECK to satisfy, coercing brain enum values
 * would be data corruption, not a fix — so every brain enum value is copied
 * VERBATIM. The historical brain rules (`brain_observations.{source_type,type}`,
 * `brain_decisions.{confirmation_state,decision_category,confidence,outcome,
 * decided_by}`) were deleted. The TASKS-domain rules below remain because those
 * consolidated tables keep their CHECK constraints.
 *
 * ## nexus/signaldock enum-drift audit (T11809 · AC1)
 *
 * A real-data audit of `nexus.db` (106 MB) and `signaldock.db` (280 KB) against
 * the consolidated CHECK enums found ZERO out-of-enum values for every
 * CHECK-constrained column that has source data: `nexus_nodes.kind` (24,482
 * rows), `nexus_relations.type` (39,163 rows), `nexus_contracts.type` (0 rows),
 * `nexus_sigils.role` (8 rows), `agent_registry_agents.status` (19 rows),
 * `agent_registry_users.role` (0 rows). No new normalization entry was required.
 * The reported "nexus/signaldock drop rows" symptom was in fact the AC2 verify
 * false-negative (epoch→ISO coercion makes the source digest differ from the
 * target digest), which fixing {@link buildDigestExpr} resolves — NOT a CHECK
 * drop. See the T11809 return notes for the full per-column row counts.
 *
 * Lookup key: `${targetTable}.${column}` (lowercase, dotted).
 *
 * @since T11547 (P0 data-loss fix)
 * @since T11548 (P0 final enum coverage)
 * @since T11647 (brain target = runtime shape — brain enum coercions removed)
 */
export const ENUM_NORMALIZATIONS: ReadonlyMap<string, NormalizeFn> = new Map([
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

  // --- brain_* enum normalizations REMOVED (T11647) -----------------------
  // The brain memory family now lands in the consolidated cleo.db in its LEGACY
  // RUNTIME shape — INTEGER epoch timestamps and, critically, NO SQL CHECK
  // constraints (the `text({ enum })` unions are enforced only at the
  // application layer, exactly as the runtime `drizzle-brain` tables are). With
  // no brain CHECK constraint to satisfy, exodus MUST copy every brain enum
  // value VERBATIM — coercing them (e.g. source_type 'observer-compressed'/
  // 'sleep-consolidation' → 'agent', type 'observation'/'proposal'/'pattern' →
  // nearest) would now be unnecessary data CORRUPTION, not a constraint fix.
  // The previous brain entries (brain_observations.{source_type,type},
  // brain_decisions.{confirmation_state,decision_category,confidence,outcome,
  // decided_by}) are therefore deleted. The non-brain entries below still apply
  // because those consolidated tables retain their CHECK constraints.

  // --- tasks_token_usage.transport (T11548 → REMOVED T11649) ---------------
  // NO normalization. 'mcp' is a first-class transport origin (MCP-gateway
  // requests) and is preserved verbatim. The consolidated CHECK enum was WIDENED
  // to include 'mcp' (canonical TOKEN_USAGE_TRANSPORTS SSoT + forward migration
  // 20260602000002_t11649-token-usage-transport-mcp), so the value lands without
  // coercion. The earlier 'mcp' → 'agent' mapping was a silent semantic alteration
  // of ~194 rows (count-preserving, NOT integrity-preserving) — see T11649.

  // (brain_decisions.{decision_category,confidence} normalizations removed —
  //  T11647: brain target = runtime shape with no CHECK; copy values verbatim.)

  // --- tasks_commits.conventional_type (T11548 + T11578) -------------------
  // The consolidated CHECK enum is feat/fix/chore/docs/refactor/test/build/ci/
  // perf/revert/breaking. Real git history carries non-conventional subjects:
  //   - 'style'           → 'chore' (pre-T11548 mapping; no 'style' in enum).
  //   - 'merge'/'release' → 'chore' (T11578): merge + release commits are
  //     maintenance-class; the precise semantic is preserved by the dedicated
  //     `is_merge_commit` / `is_release_commit` boolean columns, so collapsing
  //     `conventional_type` to the maintenance catch-all 'chore' is lossless at
  //     the row grain. Without this the 'merge'/'release' rows violate the CHECK,
  //     `INSERT OR IGNORE` drops the WHOLE commits table, and the exodus-on-open
  //     data-continuity gate aborts the cutover (T11578 CI regression).
  //   - any OTHER out-of-enum value → 'chore' (defensive: future non-conventional
  //     subjects must never re-break the zero-deficit gate; the boolean flags and
  //     raw subject text remain the precise provenance).
  [
    'tasks_commits.conventional_type',
    (src: string) =>
      `CASE` +
      ` WHEN ${src} IS NULL THEN NULL` +
      ` WHEN ${src} IN ('feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'build', 'ci', 'perf', 'revert', 'breaking') THEN ${src}` +
      ` ELSE 'chore'` +
      ` END`,
  ],

  // --- tasks_task_relations.relation_type (T11548) -------------------------
  // 'grouped-by' → 'groups' (enum: related/blocks/duplicates/absorbs/fixes/extends/
  // supersedes/groups). 4 rows.
  [
    'tasks_task_relations.relation_type',
    (src: string) => `CASE ${src} WHEN 'grouped-by' THEN 'groups' ELSE ${src} END`,
  ],

  // --- tasks_lifecycle_stages.stage_name (T11548) --------------------------
  // Legacy camelCase / past-tense values → canonical snake_case stage names.
  // 'implemented' → 'implementation', 'qaPassed' → 'validation',
  // 'testsPassed' → 'testing'. 3 rows.
  [
    'tasks_lifecycle_stages.stage_name',
    (src: string) =>
      `CASE ${src}` +
      ` WHEN 'implemented' THEN 'implementation'` +
      ` WHEN 'qaPassed' THEN 'validation'` +
      ` WHEN 'testsPassed' THEN 'testing'` +
      ` ELSE ${src}` +
      ` END`,
  ],

  // --- tasks_architecture_decisions.gate_status (T11548) ------------------
  // 'passed (T5313 consensus)' → 'passed', 'approved' → 'passed'
  // (enum: pending/passed/failed/waived). 2 rows.
  [
    'tasks_architecture_decisions.gate_status',
    (src: string) =>
      `CASE` +
      ` WHEN ${src} LIKE 'passed%' THEN 'passed'` +
      ` WHEN ${src} = 'approved' THEN 'passed'` +
      ` ELSE ${src}` +
      ` END`,
  ],

  // --- tasks_evidence_ac_bindings.binding_type (T11548) -------------------
  // Values with a 'validator:...' prefix → 'direct'
  // (enum: direct/satisfies/coverage). 3 rows.
  // Strip the namespace prefix introduced before the enum was tightened.
  [
    'tasks_evidence_ac_bindings.binding_type',
    (src: string) =>
      `CASE` + ` WHEN ${src} LIKE 'validator:%' THEN 'direct'` + ` ELSE ${src}` + ` END`,
  ],

  // (brain_decisions.{outcome,decided_by} normalizations removed — T11647:
  //  brain target = runtime shape with no CHECK; legacy values like 'accepted',
  //  'rejected', 'prime' now survive VERBATIM instead of being coerced.)
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
export function enumNormExpr(targetTableName: string, col: string, srcRef: string): string | null {
  const key = `${targetTableName}.${col}`;
  const fn = ENUM_NORMALIZATIONS.get(key);
  return fn ? fn(srcRef) : null;
}

// ---------------------------------------------------------------------------
// Non-finite numeric clamp layer (ROOT CAUSE fix — T11782 · FIX B)
// ---------------------------------------------------------------------------

/**
 * Function shape for a numeric-clamp rule: given the `srcRef` SQL expression for
 * a column, return a SQL expression that maps non-finite values to finite ones.
 */
export type NumericClampFn = (srcRef: string) => string;

/**
 * Per-(targetTable, column) numeric-clamp rules that coerce non-finite legacy
 * REAL values (`Inf` / `-Inf` / `NaN`) to a finite in-range value so the row is
 * NOT silently dropped by `INSERT OR IGNORE`.
 *
 * ## Why this exists (T11782)
 *
 * 188,926 of 697,780 legacy `brain_weight_history` rows carry
 * `delta_weight = Inf`/`-Inf` (the R-STDP plasticity writer saturated the delta
 * before the value was clamped at write time). SQLite stores ±Inf as the IEEE-754
 * float, but the consolidated `brain_weight_history.delta_weight` column is a
 * plain `real NOT NULL` with NO CHECK — so a verbatim copy would land the Inf
 * value. The historical deficit, however, was that those rows tripped a constraint
 * elsewhere in the copy chain and `INSERT OR IGNORE` dropped them, yielding a
 * deficit that fired the parity-gate abort. Clamping the non-finite value to a
 * finite member of the column's domain guarantees every row lands.
 *
 * The clamp mirrors the {@link ENUM_NORMALIZATIONS} shape: each entry is a
 * function `(srcRef) => CASE …`. Finite values pass through unchanged via the
 * ELSE branch. The `col != col` self-comparison is the canonical SQL NaN guard
 * (NaN is the only value not equal to itself); `9e999` is the SQLite literal that
 * evaluates to `+Infinity` (and `-9e999` to `-Infinity`).
 *
 * Lookup key: `${targetTable}.${column}` (lowercase, dotted).
 *
 * @since T11782 (P0 — brain_weight_history Inf recovery)
 */
export const NUMERIC_CLAMPS: ReadonlyMap<string, NumericClampFn> = new Map([
  // --- brain_weight_history.delta_weight (T11782) -------------------------
  // +Inf → 1.0 (max canonical reinforcement), -Inf → -1.0 (max canonical
  // depression), NaN → 0.0 (no-op delta). Finite values pass through.
  [
    'brain_weight_history.delta_weight',
    (src: string) =>
      `CASE` +
      ` WHEN ${src} = 9e999 THEN 1.0` +
      ` WHEN ${src} = -9e999 THEN -1.0` +
      ` WHEN ${src} != ${src} THEN 0.0` +
      ` ELSE ${src}` +
      ` END`,
  ],
]);

/**
 * Return a SQL CASE expression that clamps non-finite legacy REAL values for
 * `col` in `targetTableName` to a finite in-range value, or `null` when no
 * clamp rule exists for this (table, column).
 *
 * @param targetTableName - Physical consolidated target table name.
 * @param col             - Column name.
 * @param srcRef          - SQL expression referencing the source column.
 * @returns A SQL CASE expression string, or `null` if no rule applies.
 */
export function numericClampExpr(
  targetTableName: string,
  col: string,
  srcRef: string,
): string | null {
  const key = `${targetTableName}.${col}`;
  const fn = NUMERIC_CLAMPS.get(key);
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
 * Magnitude threshold distinguishing epoch SECONDS from epoch MILLISECONDS.
 *
 * A Unix epoch value for years 2020–2100 is roughly 1.6e9 – 4.1e9 seconds,
 * or 1.6e12 – 4.1e12 milliseconds. The safe boundary is 1e11 (100 billion):
 * any value BELOW 1e11 is in seconds (even year 2100 seconds ≈ 4.1e9 < 1e11);
 * any value AT OR ABOVE 1e11 is in milliseconds (year 2020 ms ≈ 1.6e12 > 1e11).
 *
 * This constant is embedded directly in the generated SQL CASE expression so
 * it is evaluated per-row — each row's epoch is classified independently.
 */
export const EPOCH_SECONDS_THRESHOLD = 100_000_000_000 as const; // 1e11

/**
 * Build a SQL expression that converts an INTEGER epoch column to ISO-8601 TEXT,
 * automatically detecting whether the stored value is in seconds or milliseconds
 * using a magnitude heuristic (T11549 correctness fix).
 *
 * ## Heuristic
 *
 * A per-row CASE checks whether the column value is below {@link EPOCH_SECONDS_THRESHOLD}
 * (100 billion). If so, the value is treated as seconds and passed directly to
 * `strftime(..., 'unixepoch')`. If at or above the threshold, it is divided by
 * 1000.0 first (milliseconds → seconds).
 *
 * This replaces the previous per-source heuristic which failed when individual
 * columns within a source DB used a different epoch unit than the majority of that
 * source's columns. The specific bug: `nexus.user_profile.{first_observed_at,
 * last_reinforced_at}` stores SECONDS (value ≈ 1.78e9) but the nexus source was
 * labeled `milliseconds`, causing these values to be divided by 1000 and converted
 * to a 1970 date.
 *
 * ## NULL handling
 *
 * A NULL source value is preserved as NULL so it passes the `IS NULL` branch of
 * the ISO GLOB CHECK constraint on the target column.
 *
 * @param srcRef - SQL expression referencing the source column value.
 * @returns A SQL CASE expression producing an ISO-8601 TEXT timestamp.
 */
export function buildEpochToIsoExpr(srcRef: string): string {
  return (
    `CASE` +
    ` WHEN ${srcRef} IS NULL THEN NULL` +
    ` WHEN ${srcRef} < ${EPOCH_SECONDS_THRESHOLD}` +
    ` THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${srcRef}, 'unixepoch')` +
    ` ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${srcRef}/1000.0, 'unixepoch')` +
    ` END`
  );
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
 * @param db           - Target DB with the consolidated schema.
 * @param tableName    - Physical table name (consolidated, e.g. `conduit_messages`).
 * @param targetSchema - Schema name the target table lives in (`'main'`, or an
 *   ATTACH alias for cross-scope routing — ADR-090 nexus graph residency, T11539).
 * @returns Set of column names that require ISO GLOB validation.
 */
export function detectIsoGlobColumns(
  db: DatabaseSync,
  tableName: string,
  targetSchema = 'main',
): Set<string> {
  const escapedTable = tableName.replace(/'/g, "''");
  const row = db
    .prepare(
      `SELECT sql FROM "${targetSchema}".sqlite_master WHERE type='table' AND name='${escapedTable}'`,
    )
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

// ---------------------------------------------------------------------------
// Digest-oriented transform expression (T11809 · AC2)
// ---------------------------------------------------------------------------

/**
 * Return `true` when the source column's type affinity is INTEGER-like, so an
 * epoch→ISO coercion applies when the matching target column carries an ISO GLOB
 * CHECK. Empty affinity and `NUMERIC` are treated as integer-like (matching the
 * historical `buildSelectExpr` behaviour — legacy epoch columns sometimes carry
 * no declared type or a `NUMERIC` affinity).
 *
 * @param srcType - Raw `type` string from the source `PRAGMA table_info`.
 * @returns `true` if the source column should be considered an INTEGER epoch.
 */
function isIntegerSourceType(srcType: string): boolean {
  const upper = srcType.toUpperCase();
  return upper.includes('INT') || upper === '' || upper === 'NUMERIC';
}

/**
 * Build the SQL expression a column's SOURCE value must pass through so it
 * matches the canonical value the migration STORES in the target — for use by
 * the parity verifier's content digest (T11809 · AC2).
 *
 * This is the digest-oriented sibling of migrate's `buildSelectExpr`. It applies
 * the SAME value transforms the migration actually performs — and ONLY those:
 *
 *   1. **Epoch→ISO-8601** ({@link buildEpochToIsoExpr}) — when the target has an
 *      ISO GLOB CHECK and the source column is INTEGER-typed.
 *   2. **Non-finite numeric clamp** ({@link numericClampExpr}).
 *   3. **Enum-value normalization** ({@link enumNormExpr}).
 *   4. **Plain column reference** otherwise.
 *
 * Crucially it does NOT add the NOT-NULL `COALESCE(..., type_default)` wrapping
 * that `buildSelectExpr` uses: that wrapping only ever fires on a NULL source
 * value that the target stores as a type-default, which is a NULL→default value
 * CHANGE the digest should not paper over (a genuine NULL→'' divergence remains a
 * real, visible content difference, not a coercion artifact). The verifier
 * intentionally omits it so the digest reflects the canonical value transforms
 * (epoch/enum/clamp) WITHOUT masking a true NULL→default substitution.
 *
 * The returned expression is a bare SQL value expression (no `AS "col"` alias)
 * suitable for embedding directly in a `SELECT <expr> ... ORDER BY ...` digest
 * query. When no transform applies, a plain quoted column reference is returned.
 *
 * @param targetTableName - Physical consolidated target table name (transform
 *   lookup key).
 * @param col             - Column name (present in BOTH source and target).
 * @param srcType         - Raw `type` string from the source `PRAGMA table_info`.
 * @param isoGlobCols     - Set of target columns carrying an ISO GLOB CHECK.
 * @returns A SQL value expression that maps the raw source value to the canonical
 *   value the target stores.
 */
export function buildDigestExpr(
  targetTableName: string,
  col: string,
  srcType: string,
  isoGlobCols: ReadonlySet<string>,
): string {
  const srcRef = `"${col}"`;

  // Priority 1: Epoch→ISO coercion — applies when the target has an ISO GLOB
  // CHECK and the source column is INTEGER (epoch) typed. Mirrors migrate's
  // per-row magnitude heuristic exactly.
  if (isoGlobCols.has(col) && isIntegerSourceType(srcType)) {
    return buildEpochToIsoExpr(srcRef);
  }

  // Priority 2: Non-finite numeric clamp (Inf/-Inf/NaN → finite in-range).
  const clampExpr = numericClampExpr(targetTableName, col, srcRef);
  if (clampExpr !== null) return clampExpr;

  // Priority 3: Enum-value normalization (legacy value → canonical member).
  const normExpr = enumNormExpr(targetTableName, col, srcRef);
  if (normExpr !== null) return normExpr;

  // Priority 4: plain column reference (no transform migrate would have applied).
  return srcRef;
}
