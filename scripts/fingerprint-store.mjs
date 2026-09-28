#!/usr/bin/env node
/**
 * Gate B oracle (replay fidelity), Gate C invariant counter (merge validity)
 * and volume report (T12332 · epic T12322).
 *
 * Opens a `cleo.db` READ-ONLY and writes a fingerprint:
 *
 *   - every table's class, read from the Gate A registry
 *     (`packages/core/src/store/table-classification.ts`, via `classifyTable`);
 *   - every table's row count, plus volume per class;
 *   - for every table whose class syncs (the portable classes), a sha256 over
 *     all rows in a canonical order (every column ascending; the hash also
 *     covers the column names, so an added or dropped column changes it);
 *   - dangling-reference counts on the relationship edges that must survive a
 *     replay (Gate B holds a replica to "no more than the source");
 *   - counts of the rules the CLI enforces on write (Gate C holds a merge to
 *     "no increase": legacy rows already violate some rules, so zero would
 *     turn every legacy row into a conflict on the first sync).
 *
 * The fingerprint never records a path: the store is named by `--label`
 * only, and the output is checked for the store's absolute path before it is
 * written. Fingerprints are artifacts that may be shared, and the nexus rule
 * (identity is `project_id`, never a path; ADR-094) applies to them too.
 *
 * sqlite-vec is loaded when available so the vec0 `brain_embeddings` table
 * (portable-personal) can be hashed. When it cannot be read, the table is
 * recorded as `unreadable`, and the comparator fails replay on it rather than
 * skipping it silently.
 *
 * Usage:
 *   node scripts/fingerprint-store.mjs --db <cleo.db> [--scope project|global]
 *     [--label <name>] [--out <file.json>]
 *
 * Companion: scripts/compare-fingerprints.mjs.
 *
 * @task T12332
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import {
  classifyTable,
  isPortableTableClass,
} from '../packages/core/src/store/table-classification.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    scope: { type: 'string', default: 'project' },
    label: { type: 'string', default: 'store' },
    out: { type: 'string' },
  },
});
if (!values.db) throw new Error('pass --db <cleo.db>');
if (!['project', 'global'].includes(values.scope))
  throw new Error('--scope must be project or global');
const scope = /** @type {'project' | 'global'} */ (values.scope);

const db = new DatabaseSync(values.db, { readOnly: true, allowExtension: true });
let vecLoaded = false;
try {
  createRequire(resolve(REPO_ROOT, 'packages/core/package.json'))('sqlite-vec').load(db);
  vecLoaded = true;
} catch {
  // Without sqlite-vec the vec0 table is recorded as unreadable, never skipped.
}

const q = (sql) => db.prepare(sql).all();
const ident = (s) => `"${s.replaceAll('"', '""')}"`;

/** Stable text form of one SQLite value, so the hash does not depend on driver types. */
function canon(v) {
  if (v === null || v === undefined) return 'N';
  if (v instanceof Uint8Array) return `B${Buffer.from(v).toString('hex')}`;
  if (typeof v === 'bigint' || typeof v === 'number') return `I${String(v)}`;
  return `S${String(v).length}:${v}`;
}

/** Registry view of one table: its class (or PENDING / UNCLASSIFIED) and whether it syncs. */
function classOf(table) {
  const c = classifyTable(scope, table);
  if (c.kind === 'entry')
    return { class: c.class, status: c.entry.status, shareable: isPortableTableClass(c.class) };
  if (c.kind === 'pattern')
    return { class: c.class, status: 'pattern', shareable: isPortableTableClass(c.class) };
  if (c.kind === 'pending') return { class: 'PENDING', status: 'pending', shareable: false };
  return { class: 'UNCLASSIFIED', status: 'unclassified', shareable: false };
}

const tables = q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
  (r) => r.name,
);
const result = {
  store: values.label,
  scope,
  at: new Date().toISOString(),
  vecLoaded,
  tables: {},
  volumeByClass: {},
  relationships: {},
  invariants: {},
};

for (const t of tables) {
  const { class: cls, status, shareable } = classOf(t);
  const entry = { class: cls, status, shareable };
  try {
    entry.rows = Number(q(`SELECT count(*) AS n FROM ${ident(t)}`)[0].n);
  } catch (e) {
    // A virtual table whose module is not loaded here (vec0 without sqlite-vec).
    entry.unreadable = String(e.message).slice(0, 160);
    result.tables[t] = entry;
    continue;
  }
  result.volumeByClass[cls] = (result.volumeByClass[cls] ?? 0) + entry.rows;
  if (shareable) {
    const cols = q(`PRAGMA table_info(${ident(t)})`)
      .map((c) => c.name)
      .sort();
    const h = createHash('sha256').update(cols.join('\u0000'));
    const list = cols.map(ident).join(',');
    for (const row of db.prepare(`SELECT ${list} FROM ${ident(t)} ORDER BY ${list}`).iterate()) {
      h.update(`${cols.map((c) => canon(row[c])).join('\u0001')}\n`);
    }
    entry.sha256 = h.digest('hex');
  }
  result.tables[t] = entry;
}

// Relationship edges that must survive replay. Each counts rows whose reference
// does not resolve in this store; a replica must reproduce the same count, never more.
const edges = {
  'tasks.parent_id': [
    'tasks_tasks',
    "SELECT count(*) n FROM tasks_tasks c WHERE c.parent_id IS NOT NULL AND c.parent_id <> '' AND NOT EXISTS (SELECT 1 FROM tasks_tasks p WHERE p.id = c.parent_id)",
  ],
  'dependencies.task_id': [
    'tasks_task_dependencies',
    'SELECT count(*) n FROM tasks_task_dependencies d WHERE NOT EXISTS (SELECT 1 FROM tasks_tasks t WHERE t.id = d.task_id)',
  ],
  'dependencies.depends_on': [
    'tasks_task_dependencies',
    'SELECT count(*) n FROM tasks_task_dependencies d WHERE NOT EXISTS (SELECT 1 FROM tasks_tasks t WHERE t.id = d.depends_on)',
  ],
  'relations.related_to': [
    'tasks_task_relations',
    'SELECT count(*) n FROM tasks_task_relations r WHERE NOT EXISTS (SELECT 1 FROM tasks_tasks t WHERE t.id = r.related_to)',
  ],
  'acceptance_criteria.task_id': [
    'tasks_task_acceptance_criteria',
    'SELECT count(*) n FROM tasks_task_acceptance_criteria a WHERE NOT EXISTS (SELECT 1 FROM tasks_tasks t WHERE t.id = a.task_id)',
  ],
  'evidence_bindings.ac_id': [
    'tasks_evidence_ac_bindings',
    'SELECT count(*) n FROM tasks_evidence_ac_bindings b WHERE NOT EXISTS (SELECT 1 FROM tasks_task_acceptance_criteria a WHERE a.id = b.ac_id)',
  ],
  // Sessions are personal (§F.7): on a collaborator's replica this edge is expected to dangle.
  'tasks.session_id(personal)': [
    'tasks_tasks',
    "SELECT count(*) n FROM tasks_tasks t WHERE t.session_id IS NOT NULL AND t.session_id <> '' AND NOT EXISTS (SELECT 1 FROM tasks_sessions s WHERE s.id = t.session_id)",
  ],
  // The bare ADR table is the live twin (§F.1).
  'adr.superseded_by_id': [
    'architecture_decisions',
    "SELECT count(*) n FROM architecture_decisions a WHERE a.superseded_by_id IS NOT NULL AND a.superseded_by_id <> '' AND NOT EXISTS (SELECT 1 FROM architecture_decisions b WHERE b.id = a.superseded_by_id)",
  ],
  'adr.supersedes_id': [
    'architecture_decisions',
    "SELECT count(*) n FROM architecture_decisions a WHERE a.supersedes_id IS NOT NULL AND a.supersedes_id <> '' AND NOT EXISTS (SELECT 1 FROM architecture_decisions b WHERE b.id = a.supersedes_id)",
  ],
};
for (const [name, [table, sql]] of Object.entries(edges)) {
  if (!tables.includes(table)) {
    result.relationships[name] = { skipped: `no table ${table}` };
    continue;
  }
  try {
    const total = Number(q(`SELECT count(*) n FROM ${ident(table)}`)[0].n);
    result.relationships[name] = { rows: total, dangling: Number(q(sql)[0].n) };
  } catch (e) {
    result.relationships[name] = { error: String(e.message).slice(0, 160) };
  }
}

// Rules the CLI enforces on write. A merge re-counts these after applying
// remote ops; any increase over the pre-merge count is a conflict record.
const invariants = {
  // A cycle through depends_on edges (add/update rejects one).
  dependencyCycles: `WITH RECURSIVE walk(start, cur, path) AS (
      SELECT task_id, depends_on, ',' || task_id || ',' FROM tasks_task_dependencies
      UNION ALL
      SELECT w.start, d.depends_on, w.path || w.cur || ','
      FROM walk w JOIN tasks_task_dependencies d ON d.task_id = w.cur
      WHERE instr(w.path, ',' || w.cur || ',') = 0)
    SELECT count(DISTINCT start) n FROM walk WHERE cur = start`,
  // PM-Core V2 containment: saga at root; epic under saga or root; task under epic; subtask under task.
  containmentViolations: `SELECT count(*) n FROM tasks_tasks c LEFT JOIN tasks_tasks p ON p.id = c.parent_id
    WHERE c.parent_id IS NOT NULL AND c.parent_id <> '' AND c.type IS NOT NULL AND NOT (
      (c.type = 'epic' AND p.type = 'saga') OR (c.type = 'task' AND p.type = 'epic') OR
      (c.type = 'subtask' AND p.type = 'task') OR p.type IS NULL)`,
  sagaWithParent:
    "SELECT count(*) n FROM tasks_tasks WHERE type = 'saga' AND parent_id IS NOT NULL AND parent_id <> ''",
  // Leaf-or-container: a task with live children must not carry its own acceptance rows.
  containerWithOwnAcceptance: `SELECT count(DISTINCT p.id) n FROM tasks_tasks p
    JOIN tasks_tasks c ON c.parent_id = p.id AND c.status NOT IN ('archived','cancelled')
    JOIN tasks_task_acceptance_criteria a ON a.task_id = p.id
    WHERE p.type IN ('task','subtask') AND p.status NOT IN ('archived','cancelled')`,
  // Completed tasks whose blocking dependencies are not done.
  doneWithOpenDependency: `SELECT count(DISTINCT t.id) n FROM tasks_tasks t
    JOIN tasks_task_dependencies d ON d.task_id = t.id JOIN tasks_tasks u ON u.id = d.depends_on
    WHERE t.status = 'done' AND u.status NOT IN ('done','archived','cancelled')`,
};
if (scope === 'project') {
  for (const [name, sql] of Object.entries(invariants)) {
    try {
      result.invariants[name] = Number(q(sql)[0].n);
    } catch (e) {
      result.invariants[name] = { error: String(e.message).slice(0, 160) };
    }
  }
}
db.close();

const json = JSON.stringify(result, null, 1);
// Never record a path: refuse to write a fingerprint that names the store's location.
const abs = resolve(values.db);
for (const leak of [abs, dirname(abs), dirname(dirname(abs))]) {
  if (leak.length > 1 && json.includes(leak)) {
    throw new Error(
      'fingerprint-store: refusing to write a fingerprint that contains the store path',
    );
  }
}
if (values.out) writeFileSync(values.out, `${json}\n`);

const shareable = Object.values(result.tables).filter((e) => e.sha256);
console.log(
  `${result.store} (${scope}): ${tables.length} tables, ${shareable.length} fingerprinted, sqlite-vec ${vecLoaded ? 'loaded' : 'NOT loaded'}`,
);
console.log(`volume by class: ${JSON.stringify(result.volumeByClass)}`);
if (scope === 'project') console.log(`invariants: ${JSON.stringify(result.invariants)}`);
for (const [k, v] of Object.entries(result.relationships))
  console.log(`  ${k}: ${JSON.stringify(v)}`);
