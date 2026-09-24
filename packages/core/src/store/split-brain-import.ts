/**
 * Split-brain import: bring the rows only one copy of a project store has
 * into another copy, under new ids, without touching a single pre-existing
 * row (T12329).
 *
 * ## The failure this repairs
 *
 * A project directory copied to a second path keeps its `project-info.json`
 * and its `.cleo/cleo.db`. From then on, both copies write under one
 * projectId. Both task allocators continue from the same counter, so the
 * same `T####` names different work in each copy. Brain observations
 * written in one copy never reach the other. Measured on cleocode, whose
 * checkout was rsynced to `/home/keatonhoskins/cleocode` on 2026-09-14:
 * T12188–T12202 exist in both stores with different titles, and 11
 * observations exist only in `/home`.
 *
 * ## What counts as a source-only row
 *
 * The copies were one store until they diverged. The divergence point `T0` is
 * the newest `created_at` among tasks present in BOTH stores with the SAME
 * `created_at`. A source row absent from the target is imported only if it was
 * written after `T0`. A source row written before `T0` was present in the
 * target at divergence, so its absence there means the target deleted it (for
 * example by session GC). Resurrecting it would undo the target's own history,
 * so such rows are counted and reported, never imported.
 *
 * A task whose id exists in both stores with a different `created_at` is a
 * COLLISION: the same id holds different work. Every imported task gets a newly
 * minted id: `max(sequence counter, max stored id) + k`, the same lower bound
 * `allocateNextTaskId` uses. The live allocator therefore continues past the
 * imported ids with no counter write. Child rows follow their task (acceptance
 * criteria, AC history, dependencies, relations, labels, work history, commit
 * links, audit rows). Brain rows and sessions keep their ids, which are
 * time+random and absent in the target by construction. A brain or session id
 * that collides is reported as unresolved, not imported.
 *
 * ## What is deliberately not imported (reported with counts)
 *
 * - telemetry: usage, retrieval and token logs;
 * - derived data the runtime rebuilds: the brain page graph and embeddings;
 * - parent-owned child-projection AC rows on a parent that is NOT imported. A
 *   rebuild rewrites the parent's whole AC set, and this import never modifies
 *   a pre-existing row. The runtime rebuild owns it;
 * - rows in any other table that reference an imported task. They are counted
 *   per table so coverage is never silently partial.
 *
 * ## Provenance
 *
 * Every imported entity gets a `tasks_audit_log` row: action
 * `split_brain_import`, the original id, the new id, the source store path and
 * label. Every imported task also carries a note naming its original id. The
 * returned receipt lists the full id map.
 *
 * The target is written in ONE `BEGIN IMMEDIATE` transaction, or not at all
 * (`dryRun`, the default in the CLI). The source is opened read-only.
 *
 * @task T12329
 */

import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildAcRowId } from '../tasks/ac-table.js';

/** A SQLite value as node:sqlite returns it. */
type SqlValue = string | number | bigint | Uint8Array | null;
/** One row keyed by column name. */
type Row = Record<string, SqlValue>;

/** Options for {@link importSplitBrain}. */
export interface SplitBrainImportOptions {
  /** Store that holds the extra rows. Opened read-only. */
  readonly sourcePath: string;
  /** Store that receives them. Opened read-only when `dryRun`. */
  readonly targetPath: string;
  /** Plan only; write nothing. */
  readonly dryRun?: boolean;
  /** Human label for the source, recorded in provenance (e.g. its checkout path). */
  readonly sourceLabel?: string;
  /**
   * Override the detected divergence point (ISO 8601). Only rows written
   * after it are candidates.
   */
  readonly divergedAfter?: string;
  /**
   * Task under which provenance rows for non-task entities are recorded
   * (`tasks_audit_log.task_id` is NOT NULL). It must exist in the target.
   * Required to apply an import that includes non-task rows.
   */
  readonly provenanceTaskId?: string;
}

/** One imported (or planned) entity. */
export interface SplitBrainMapping {
  /** Table the row lives in. */
  readonly table: string;
  /** Id in the source store. */
  readonly originalId: string;
  /** Id in the target store (equal to `originalId` when kept). */
  readonly newId: string;
  /** Why it is imported. */
  readonly reason: 'collision' | 'source-only';
}

/** Rows found in the source but not imported, with the reason. */
export interface SplitBrainSkip {
  /** Table. */
  readonly table: string;
  /** Row count. */
  readonly count: number;
  /** Why these rows are not imported. */
  readonly reason: string;
}

/** Receipt of {@link importSplitBrain}. */
export interface SplitBrainReport {
  /** `true` when nothing was written. */
  readonly dryRun: boolean;
  /** Source store path. */
  readonly sourcePath: string;
  /** Target store path. */
  readonly targetPath: string;
  /** Divergence point used (ISO 8601). */
  readonly divergedAfter: string;
  /** Tasks identical in both stores (same id and created_at). */
  readonly sharedTasks: number;
  /** Imported (or, in a dry run, planned) entities with their id mapping. */
  readonly mappings: readonly SplitBrainMapping[];
  /** Rows written (or planned) per table, including child rows. */
  readonly rowsByTable: Readonly<Record<string, number>>;
  /** Rows found in the source that are not imported, with reasons. */
  readonly skipped: readonly SplitBrainSkip[];
  /** Rows that could not be imported safely, with reasons. */
  readonly unresolved: readonly SplitBrainSkip[];
}

/** Child tables that follow an imported task. `refs` are the task-id columns. */
const TASK_CHILD_TABLES: readonly { table: string; refs: readonly string[] }[] = [
  { table: 'tasks_task_dependencies', refs: ['task_id', 'depends_on'] },
  { table: 'tasks_task_relations', refs: ['task_id', 'related_to'] },
  { table: 'tasks_task_labels', refs: ['task_id'] },
  { table: 'tasks_task_work_history', refs: ['task_id'] },
  { table: 'tasks_task_commits', refs: ['task_id'] },
  { table: 'tasks_audit_log', refs: ['task_id'] },
];

/** Id-keyed entities imported under their own id when written after divergence. */
const KEPT_ID_ENTITIES: readonly {
  table: string;
  time: string;
  taskRefs: readonly string[];
  jsonTaskRefs?: readonly string[];
}[] = [
  {
    table: 'tasks_sessions',
    time: 'started_at',
    taskRefs: ['current_task'],
    jsonTaskRefs: ['tasks_completed_json', 'tasks_created_json'],
  },
  { table: 'brain_observations', time: 'created_at', taskRefs: [] },
  { table: 'brain_decisions', time: 'created_at', taskRefs: ['context_task_id'] },
  { table: 'brain_learnings', time: 'created_at', taskRefs: [] },
  { table: 'brain_patterns', time: 'extracted_at', taskRefs: [] },
  // The bare operation audit log is still written by the dispatch layer (it is
  // not a dead relic), so its post-divergence history is imported too.
  { table: 'audit_log', time: 'timestamp', taskRefs: ['task_id'] },
  { table: 'tasks_releases', time: 'created_at', taskRefs: [], jsonTaskRefs: ['tasks_json'] },
  {
    table: 'tasks_release_changesets',
    time: 'created_at',
    taskRefs: [],
    jsonTaskRefs: ['task_ids'],
  },
];

/** Source-only rows in these tables are skipped as telemetry or derived data. */
const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  brain_usage_log: 'telemetry (not replicated)',
  brain_retrieval_log: 'telemetry (not replicated)',
  tasks_token_usage: 'telemetry (not replicated)',
  token_usage: 'telemetry (not replicated)',
  brain_page_nodes: 'derived brain graph (rebuilt by the runtime)',
  brain_page_edges: 'derived brain graph (rebuilt by the runtime)',
};

/** Timestamp columns used to date a row in the coverage scan, in preference order. */
const COVERAGE_TIME_COLUMNS = [
  'created_at',
  'timestamp',
  'recorded_at',
  'started_at',
  'extracted_at',
];

/** Tables whose rows reference tasks and are handled explicitly above. */
const HANDLED_TASK_REF_TABLES = new Set([
  'tasks_tasks',
  'tasks_task_acceptance_criteria',
  'tasks_task_acceptance_criteria_history',
  'brain_memory_links',
  'tasks_evidence_ac_bindings',
  ...TASK_CHILD_TABLES.map((spec) => spec.table),
  ...KEPT_ID_ENTITIES.map((spec) => spec.table),
  ...Object.keys(EXCLUDED_TABLES),
]);

/**
 * Parse CLEO's mixed timestamp formats to epoch ms.
 *
 * `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no zone, meaning UTC.
 * Comparing that text against ISO text is wrong within a day (`' '` sorts
 * before `'T'`), so every comparison goes through this function.
 *
 * @param value - Stored timestamp.
 * @returns Epoch milliseconds, or `null` when absent or unparseable.
 */
export function parseStoreTimestamp(value: SqlValue | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Quote an identifier for SQL. */
function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Column metadata for a table, or `null` when the table does not exist. */
function columns(db: DatabaseSync, table: string): { name: string; pk: number; type: string }[] {
  return db.prepare(`SELECT name, pk, type FROM pragma_table_info(?)`).all(table) as {
    name: string;
    pk: number;
    type: string;
  }[];
}

/** All rows of a table. */
function allRows(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${q(table)}`).all() as Row[];
}

/** Whether a table exists. */
function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

/** Stable key for a row's primary key (or all columns when there is none). */
function pkKey(row: Row, pk: readonly string[]): string {
  return JSON.stringify(pk.map((column) => String(row[column] ?? '')));
}

/** A new audit-log id in the runtime's `log-<epoch>-<hex>` format. */
function newLogId(): string {
  return `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`;
}

/** Collects the INSERTs of one import so they can be counted before any write. */
class InsertPlan {
  readonly rows: { table: string; row: Row }[] = [];
  readonly byTable: Record<string, number> = {};

  constructor(private readonly target: DatabaseSync) {}

  /**
   * Queue a row, keeping only columns the target has. An INTEGER PRIMARY KEY is
   * dropped so the target assigns a fresh one.
   */
  add(table: string, row: Row): void {
    const targetCols = columns(this.target, table);
    const out: Row = {};
    for (const col of targetCols) {
      if (col.pk === 1 && col.type.toUpperCase() === 'INTEGER') continue;
      if (col.name in row) out[col.name] = row[col.name] ?? null;
    }
    this.rows.push({ table, row: out });
    this.byTable[table] = (this.byTable[table] ?? 0) + 1;
  }

  /** Execute every queued INSERT; any constraint violation aborts the caller's transaction. */
  apply(): void {
    for (const { table, row } of this.rows) {
      const names = Object.keys(row);
      this.target
        .prepare(
          `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        )
        .run(...names.map((name) => row[name] ?? null));
    }
  }
}

/**
 * Import the source-only rows of a split-brain store pair into the target.
 *
 * @param options - Source, target, dry-run flag and provenance label.
 * @returns The receipt: divergence point, id map, per-table counts, and
 *   every skipped or unresolved row group with its reason.
 * @throws {Error} When the stores share no task (they are not two copies of
 *   one store), or when the target write fails. A failed write is rolled
 *   back entirely.
 *
 * @example
 * ```ts
 * const plan = importSplitBrain({ sourcePath: home, targetPath: live, dryRun: true });
 * ```
 */
export function importSplitBrain(options: SplitBrainImportOptions): SplitBrainReport {
  const dryRun = options.dryRun !== false;
  // db-open-allowed: a split-brain import reads a foreign store file by path; it is not this project's handle
  const source = new DatabaseSync(options.sourcePath, { readOnly: true });
  // db-open-allowed: the target is an explicit store file, opened read-only for a dry run
  const target = new DatabaseSync(options.targetPath, { readOnly: dryRun });
  try {
    return runImport(source, target, options, dryRun);
  } finally {
    source.close();
    target.close();
  }
}

function runImport(
  source: DatabaseSync,
  target: DatabaseSync,
  options: SplitBrainImportOptions,
  dryRun: boolean,
): SplitBrainReport {
  const label = options.sourceLabel ?? options.sourcePath;
  const mappings: SplitBrainMapping[] = [];
  const skipped: SplitBrainSkip[] = [];
  const unresolved: SplitBrainSkip[] = [];
  const plan = new InsertPlan(target);
  const now = new Date().toISOString();

  // --- Divergence point -----------------------------------------------------
  const targetTasks = new Map(
    allRows(target, 'tasks_tasks').map((row) => [String(row['id']), row] as const),
  );
  const sourceTasks = allRows(source, 'tasks_tasks');
  let shared = 0;
  let detectedT0 = Number.NEGATIVE_INFINITY;
  for (const row of sourceTasks) {
    const twin = targetTasks.get(String(row['id']));
    if (twin && twin['created_at'] === row['created_at']) {
      shared++;
      detectedT0 = Math.max(detectedT0, parseStoreTimestamp(row['created_at']) ?? detectedT0);
    }
  }
  if (shared === 0)
    throw new Error(
      'The stores share no task (same id and created_at): they are not two copies of one store. Refusing to import.',
    );
  const t0 = options.divergedAfter
    ? (parseStoreTimestamp(options.divergedAfter) ?? detectedT0)
    : detectedT0;
  const afterT0 = (value: SqlValue | undefined): boolean => {
    const ms = parseStoreTimestamp(value);
    return ms !== null && ms > t0;
  };

  // --- Tasks: mint new ids ----------------------------------------------------
  const taskMap = new Map<string, string>();
  const importTasks: Row[] = [];
  let predating = 0;
  for (const row of sourceTasks) {
    const id = String(row['id']);
    const twin = targetTasks.get(id);
    if (twin && twin['created_at'] === row['created_at']) continue;
    if (!afterT0(row['created_at'])) {
      predating++;
      continue;
    }
    importTasks.push(row);
    mappings.push({
      table: 'tasks_tasks',
      originalId: id,
      newId: '',
      reason: twin ? 'collision' : 'source-only',
    });
  }
  if (predating > 0)
    skipped.push({
      table: 'tasks_tasks',
      count: predating,
      reason: 'absent in target but written before divergence (deleted in the target)',
    });

  // Same lower bound as allocateNextTaskId: max(counter, max stored numeric id).
  const maxStored = Number(
    (
      target
        .prepare(
          `SELECT COALESCE(MAX(CAST(substr(id, 2) AS INTEGER)), 0) AS m FROM tasks_tasks
           WHERE id GLOB 'T[0-9]*' AND substr(id, 2) NOT GLOB '*[^0-9]*'`,
        )
        .get() as { m: number }
    ).m,
  );
  const counterRow = hasTable(target, 'schema_meta')
    ? (target
        .prepare(
          `SELECT json_extract(value, '$.counter') AS c FROM schema_meta WHERE key = 'task_id_sequence'`,
        )
        .get() as { c: number | null } | undefined)
    : undefined;
  let next = Math.max(maxStored, Number(counterRow?.c ?? 0));
  // Parents first so a parent's new id exists before its children reference it.
  const depth = (row: Row): number => {
    let d = 0;
    let parent = row['parent_id'];
    const byId = new Map(importTasks.map((task) => [String(task['id']), task] as const));
    while (typeof parent === 'string' && byId.has(parent) && d < 64) {
      d++;
      parent = byId.get(parent)?.['parent_id'] ?? null;
    }
    return d;
  };
  importTasks.sort((a, b) => depth(a) - depth(b));
  for (const row of importTasks) {
    next++;
    taskMap.set(String(row['id']), `T${String(next).padStart(3, '0')}`);
  }
  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i];
    if (mapping?.table === 'tasks_tasks')
      mappings[i] = { ...mapping, newId: taskMap.get(mapping.originalId) ?? '' };
  }
  const remapTask = (value: SqlValue | undefined): SqlValue =>
    typeof value === 'string' ? (taskMap.get(value) ?? value) : (value ?? null);

  for (const row of importTasks) {
    const oldId = String(row['id']);
    const newId = taskMap.get(oldId) ?? oldId;
    const notes = (() => {
      try {
        const parsed = JSON.parse(String(row['notes_json'] ?? '[]')) as unknown;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    notes.push(
      `${now}: imported by split-brain reconcile (T12329) from ${label}, where this task was ${oldId}.`,
    );
    plan.add('tasks_tasks', {
      ...row,
      id: newId,
      parent_id: remapTask(row['parent_id']),
      notes_json: JSON.stringify(notes),
      idempotency_key: null,
    });
  }

  // --- Acceptance criteria of imported tasks ---------------------------------
  const acMap = new Map<string, string>();
  let parentProjections = 0;
  for (const row of hasTable(source, 'tasks_task_acceptance_criteria')
    ? allRows(source, 'tasks_task_acceptance_criteria')
    : []) {
    const owner = String(row['task_id']);
    const ownerNew = taskMap.get(owner);
    if (!ownerNew) {
      if (typeof row['target_task_id'] === 'string' && taskMap.has(row['target_task_id']))
        parentProjections++;
      continue;
    }
    const kind = String(row['kind'] ?? 'text');
    let sourceKey = String(row['source_key'] ?? '');
    let text = String(row['text'] ?? '');
    const oldTarget = row['target_task_id'];
    const targetTask = remapTask(oldTarget);
    if (typeof oldTarget === 'string' && taskMap.has(oldTarget)) {
      // A projection of an imported child under an imported parent: rename in place.
      sourceKey = sourceKey.replace(oldTarget, String(targetTask));
      text = text.replace(oldTarget, String(targetTask));
    }
    const newAcId = buildAcRowId(ownerNew, kind === 'text' ? text : sourceKey);
    acMap.set(String(row['id']), newAcId);
    plan.add('tasks_task_acceptance_criteria', {
      ...row,
      id: newAcId,
      task_id: ownerNew,
      target_task_id: targetTask,
      source_key: sourceKey,
      text,
    });
  }
  if (parentProjections > 0)
    skipped.push({
      table: 'tasks_task_acceptance_criteria',
      count: parentProjections,
      reason:
        'child-projection rows owned by a parent that is not imported; the runtime projection rebuild owns them (it rewrites the parent, which this import never does)',
    });
  if (hasTable(source, 'tasks_task_acceptance_criteria_history'))
    for (const row of allRows(source, 'tasks_task_acceptance_criteria_history')) {
      const acId = acMap.get(String(row['ac_id']));
      if (acId) plan.add('tasks_task_acceptance_criteria_history', { ...row, ac_id: acId });
    }

  // --- Other task-owned child rows ------------------------------------------
  for (const spec of TASK_CHILD_TABLES) {
    if (!hasTable(source, spec.table) || !hasTable(target, spec.table)) continue;
    const pkCols = columns(target, spec.table);
    const textPk = pkCols.filter((col) => col.pk > 0 && col.type.toUpperCase() !== 'INTEGER');
    for (const row of allRows(source, spec.table)) {
      if (!spec.refs.some((ref) => typeof row[ref] === 'string' && taskMap.has(row[ref]))) continue;
      const out: Row = { ...row };
      for (const ref of spec.refs) out[ref] = remapTask(row[ref]);
      // A single text id (audit log) is re-minted so no live id can be hit.
      if (textPk.length === 1 && textPk[0]?.name === 'id') out['id'] = newLogId();
      plan.add(spec.table, out);
    }
  }

  // --- Id-keyed entities written after divergence ---------------------------
  const keptIds = new Map<string, Set<string>>();
  for (const spec of KEPT_ID_ENTITIES) {
    if (!hasTable(source, spec.table) || !hasTable(target, spec.table)) continue;
    const targetRows = new Map(
      allRows(target, spec.table).map((row) => [String(row['id']), row] as const),
    );
    const kept = new Set<string>();
    let before = 0;
    let collisions = 0;
    for (const row of allRows(source, spec.table)) {
      const id = String(row['id']);
      const twin = targetRows.get(id);
      if (twin) {
        if (twin[spec.time] !== row[spec.time] && afterT0(row[spec.time])) collisions++;
        continue;
      }
      if (!afterT0(row[spec.time])) {
        before++;
        continue;
      }
      const out: Row = { ...row };
      for (const ref of spec.taskRefs) out[ref] = remapTask(row[ref]);
      for (const col of spec.jsonTaskRefs ?? []) {
        try {
          const ids = JSON.parse(String(row[col] ?? 'null')) as unknown;
          if (Array.isArray(ids))
            out[col] = JSON.stringify(ids.map((v) => (typeof v === 'string' ? remapTask(v) : v)));
        } catch {
          /* not a JSON array: keep the stored text */
        }
      }
      plan.add(spec.table, out);
      kept.add(id);
      mappings.push({ table: spec.table, originalId: id, newId: id, reason: 'source-only' });
    }
    keptIds.set(spec.table, kept);
    if (before > 0)
      skipped.push({
        table: spec.table,
        count: before,
        reason: 'absent in target but written before divergence (deleted in the target)',
      });
    if (collisions > 0)
      unresolved.push({
        table: spec.table,
        count: collisions,
        reason: 'same id holds different content in both stores; not imported',
      });
  }
  const sessions = keptIds.get('tasks_sessions') ?? new Set<string>();
  if (sessions.size > 0 && hasTable(source, 'tasks_session_handoff_entries'))
    for (const row of allRows(source, 'tasks_session_handoff_entries'))
      if (sessions.has(String(row['session_id']))) plan.add('tasks_session_handoff_entries', row);

  // Evidence bindings written after divergence. A binding to an imported AC
  // follows it to the new AC id; its id embeds the AC id prefix, re-derived here.
  if (
    hasTable(source, 'tasks_evidence_ac_bindings') &&
    hasTable(target, 'tasks_evidence_ac_bindings')
  ) {
    const existing = new Set(
      allRows(target, 'tasks_evidence_ac_bindings').map((row) => String(row['id'])),
    );
    let collided = 0;
    for (const row of allRows(source, 'tasks_evidence_ac_bindings')) {
      if (!afterT0(row['created_at']) || existing.has(String(row['id']))) continue;
      const oldAc = String(row['ac_id'] ?? '');
      const newAc = acMap.get(oldAc);
      const id = newAc
        ? String(row['id']).replace(oldAc.slice(0, 8), newAc.slice(0, 8))
        : String(row['id']);
      if (existing.has(id)) {
        collided++;
        continue;
      }
      plan.add('tasks_evidence_ac_bindings', { ...row, id, ac_id: newAc ?? oldAc });
    }
    if (collided > 0)
      unresolved.push({
        table: 'tasks_evidence_ac_bindings',
        count: collided,
        reason: 'the re-derived binding id already exists in the target; not imported',
      });
  }

  // Memory links: follow an imported memory or an imported task.
  if (hasTable(source, 'brain_memory_links') && hasTable(target, 'brain_memory_links')) {
    const importedMemory = new Set<string>();
    for (const table of [
      'brain_observations',
      'brain_decisions',
      'brain_learnings',
      'brain_patterns',
    ])
      for (const id of keptIds.get(table) ?? []) importedMemory.add(id);
    const pk = columns(target, 'brain_memory_links')
      .filter((col) => col.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((col) => col.name);
    const existing = new Set(allRows(target, 'brain_memory_links').map((row) => pkKey(row, pk)));
    for (const row of allRows(source, 'brain_memory_links')) {
      const touches =
        importedMemory.has(String(row['memory_id'])) ||
        (typeof row['task_id'] === 'string' && taskMap.has(row['task_id']));
      if (!touches) continue;
      const out = { ...row, task_id: remapTask(row['task_id']) };
      if (!existing.has(pkKey(out, pk))) plan.add('brain_memory_links', out);
    }
  }

  // --- Coverage: every other tasks_/brain_ table referencing an imported task
  for (const [table, reason] of Object.entries(EXCLUDED_TABLES)) {
    if (!hasTable(source, table)) continue;
    const cols = columns(source, table).map((col) => col.name);
    const timeCol = ['created_at', 'timestamp', 'recorded_at'].find((c) => cols.includes(c));
    const count = allRows(source, table).filter(
      (row) =>
        (timeCol !== undefined && afterT0(row[timeCol])) ||
        cols.some((c) => typeof row[c] === 'string' && taskMap.has(row[c])),
    ).length;
    if (count > 0) skipped.push({ table, count, reason: `${reason}; written after divergence` });
  }
  if (taskMap.size > 0) {
    const tables = (
      source
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND (name LIKE 'tasks\\_%' ESCAPE '\\' OR name LIKE 'brain\\_%' ESCAPE '\\')`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of tables) {
      if (HANDLED_TASK_REF_TABLES.has(table)) continue;
      const refCols = columns(source, table)
        .map((col) => col.name)
        .filter((name) => /(^|_)task_id$|^target_task_id$|^related_to$|^depends_on$/.test(name));
      if (refCols.length === 0) continue;
      const count = allRows(source, table).filter((row) =>
        refCols.some((c) => typeof row[c] === 'string' && taskMap.has(row[c])),
      ).length;
      if (count > 0)
        unresolved.push({
          table,
          count,
          reason: 'references an imported task; this table is not supported by the import',
        });
    }
  }

  // --- Coverage: post-divergence rows in any other table --------------------
  // Every ordinary table the import does not handle is scanned for rows written
  // after T0 that have no identical row in the target. They are reported, so a
  // table this import does not know about can never be lost silently.
  const virtualTables = (
    source
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const ordinaryTables = (
    source
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !virtualTables.some((v) => name.startsWith(`${v}_`)));
  const reported = new Set(unresolved.map((entry) => entry.table));
  for (const table of ordinaryTables) {
    if (HANDLED_TASK_REF_TABLES.has(table) || reported.has(table) || !hasTable(target, table))
      continue;
    const cols = columns(source, table).map((col) => col.name);
    const timeCol = COVERAGE_TIME_COLUMNS.find((c) => cols.includes(c));
    if (!timeCol) continue;
    const targetCols = new Set(columns(target, table).map((col) => col.name));
    const shared = cols.filter((c) => targetCols.has(c));
    const probe = target.prepare(
      `SELECT 1 FROM ${q(table)} WHERE ${shared.map((c) => `${q(c)} IS ?`).join(' AND ')} LIMIT 1`,
    );
    let count = 0;
    for (const row of allRows(source, table)) {
      if (!afterT0(row[timeCol])) continue;
      if (probe.get(...shared.map((c) => row[c] ?? null)) === undefined) count++;
    }
    if (count > 0)
      unresolved.push({
        table,
        count,
        reason: 'written after divergence, absent in the target, and not handled by this import',
      });
  }

  // --- Provenance -------------------------------------------------------------
  const needsAnchor = mappings.some(
    (mapping) => mapping.table !== 'tasks_tasks' && mapping.table !== 'audit_log',
  );
  const anchor = options.provenanceTaskId;
  if (!dryRun && needsAnchor) {
    if (!anchor)
      throw new Error(
        'provenanceTaskId is required to apply an import with non-task rows: tasks_audit_log.task_id is NOT NULL.',
      );
    if (!targetTasks.has(anchor))
      throw new Error(`provenanceTaskId ${anchor} does not exist in the target store.`);
  }
  for (const mapping of mappings) {
    // An imported audit row is its own provenance; auditing it again adds nothing.
    if (mapping.table === 'audit_log') continue;
    const isTask = mapping.table === 'tasks_tasks';
    plan.add('tasks_audit_log', {
      id: newLogId(),
      timestamp: now,
      action: 'split_brain_import',
      task_id: isTask ? mapping.newId : (anchor ?? null),
      actor: 'split-brain-import',
      details_json: JSON.stringify({
        task: 'T12329',
        table: mapping.table,
        originalId: mapping.originalId,
        newId: mapping.newId,
        reason: mapping.reason,
        sourceStore: options.sourcePath,
        sourceLabel: label,
        divergedAfter: new Date(t0).toISOString(),
      }),
      source: 'split-brain-import',
      success: 1,
    });
  }

  if (!dryRun) {
    target.exec('BEGIN IMMEDIATE');
    try {
      plan.apply();
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    dryRun,
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
    divergedAfter: new Date(t0).toISOString(),
    sharedTasks: shared,
    mappings,
    rowsByTable: plan.byTable,
    skipped,
    unresolved,
  };
}

/** Per-table result of {@link verifyPreexistingRows}. */
export interface PreservedRowsCheck {
  /** Table name. */
  readonly table: string;
  /** Rows in the snapshot taken before the import. */
  readonly before: number;
  /** Rows after the import. */
  readonly after: number;
  /** Snapshot rows with no byte-identical row after the import (must be 0). */
  readonly missingOrChanged: number;
}

/**
 * Prove that an import only ADDED rows: every row of every ordinary table in
 * the pre-import snapshot still exists, byte-identical, in the post-import
 * store.
 *
 * FTS virtual tables and their shadow tables are excluded. They are derived,
 * and an FTS5 index legitimately rewrites its segments on insert.
 *
 * @param beforePath - Snapshot of the target taken before the import.
 * @param afterPath - The target after the import.
 * @returns One entry per table; every `missingOrChanged` must be 0.
 */
export function verifyPreexistingRows(beforePath: string, afterPath: string): PreservedRowsCheck[] {
  // db-open-allowed: read-only comparison of two explicit store snapshots
  const db = new DatabaseSync(afterPath, { readOnly: true });
  try {
    db.prepare(`ATTACH DATABASE ? AS before_import`).run(beforePath);
    const virtual = (
      db
        .prepare(
          `SELECT name FROM before_import.sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const tables = (
      db
        .prepare(
          `SELECT name FROM before_import.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name`,
        )
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !virtual.some((v) => name.startsWith(`${v}_`)));
    return tables.map((table) => {
      const count = (schema: string): number =>
        Number(
          (db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${q(table)}`).get() as { n: number }).n,
        );
      const missing = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM (SELECT * FROM before_import.${q(table)} EXCEPT SELECT * FROM main.${q(table)})`,
            )
            .get() as { n: number }
        ).n,
      );
      return {
        table,
        before: count('before_import'),
        after: count('main'),
        missingOrChanged: missing,
      };
    });
  } finally {
    db.close();
  }
}
