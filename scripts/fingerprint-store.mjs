#!/usr/bin/env node
/**
 * Gate B oracle (replay fidelity), Gate C invariant counter (merge validity)
 * and volume report (T12332 · epic T12322).
 *
 * Reads a `cleo.db` without writing to it or beside it, and writes a
 * fingerprint:
 *
 *   - every table's class, read from the Gate A registry
 *     (`packages/core/src/store/table-classification.ts`, via `classifyTable`);
 *   - every table's row count, plus volume per class;
 *   - for every table whose class syncs (the portable classes), a sha256 per
 *     row and an aggregate digest over the table (see "Row hashes");
 *   - dangling-reference counts on the relationship edges that must survive a
 *     replay (Gate B holds a replica to "no more than the source");
 *   - counts of the rules the CLI enforces on write (Gate C holds a merge to
 *     "no increase": legacy rows already violate some rules, so zero would
 *     turn every legacy row into a conflict on the first sync).
 *
 * ## Row hashes: the replicated projection
 *
 * A row is hashed over the columns that REPLICATE, not over every column.
 * Column overrides in the registry (`strip`, `local-only`, `portable-secret`)
 * are left out: they legitimately differ on a faithful replica on another
 * device, and hashing a secret column would make the fingerprint a guessing
 * oracle for it. An override with a `jsonPath` removes only that path from the
 * JSON value. The hashed column names are recorded in `columns`.
 *
 * Integers are read as BigInt, so values above 2^53 hash exactly.
 *
 * Each row hash is HMAC-SHA256 over the canonical values in column-name
 * order. The table digest (`sha256`) is sha256 over the column names plus the
 * SORTED row hashes, so it is independent of the physical row order and equal
 * only for an equal multiset of rows. Replay compares digests (exact set
 * equality). Merge needs a subset check, so the row hashes are also written,
 * sorted, to a sidecar file (`--rows`, default `<out>.rows`), one
 * `<table>\t<hash>` line per row. The JSON records the sidecar's basename and
 * its sha256 (`rowsSha256`), so the comparator can bind the two files.
 *
 * ## The HMAC key: one per comparison
 *
 * An unkeyed row hash is a guessing oracle: a row with few, predictable
 * values (a dependency edge `T3 → T2`) is recovered by hashing candidates. The
 * row hash is therefore keyed. Both sides of one comparison MUST use the same
 * key, and the key must NOT travel with the fingerprints:
 *
 *   node scripts/fingerprint-store.mjs --db source.db --out shared/source.json \
 *     --role source --key-out ~/private/compare.key   # a new random 32-byte key, 0600
 *   node scripts/fingerprint-store.mjs --db replica.db --out shared/replica.json \
 *     --role replica --key-file ~/private/compare.key
 *   node scripts/compare-fingerprints.mjs --source shared/source.json \
 *     --replica shared/replica.json --key-file ~/private/compare.key
 *
 * There is no default key location. One of `--key-file` (an existing key) or
 * `--key-out` (where to create a new one) is required, and `--key-out` is
 * refused anywhere inside the directory tree of `--out` or of the `.rows`
 * sidecar (the directory itself or any subdirectory). The check compares file
 * identity (device + inode of every ancestor, after `realpathSync.native`,
 * `scripts/lib/path-containment.mjs`), so neither a symlink nor a different
 * letter case on a case-insensitive filesystem gets around it: a directory of
 * fingerprints is the thing that gets copied or shared, and a key inside it
 * would travel with the rows it protects. `--key-out` never overwrites an
 * existing file.
 *
 * The JSON records `keyId`, an HMAC of a fixed label under the key, and
 * `mac`, an HMAC under the key over the canonical encoding of every other
 * field (`scripts/lib/fingerprint-mac.mjs`). The comparator verifies both
 * with `--key-file`, so an edited field (`rowsFile`, `rowsSha256`, a digest,
 * a count) fails.
 *
 * ## Run identity (not yet store identity)
 *
 * Every fingerprint records `identity`, which the MAC covers:
 *   - `role`: `source` or `replica`, from the required `--role`;
 *   - `projectId`: the portable project id from the `project-id` file beside
 *     the store (`.cleo/project-id` for a project `cleo.db`), or `null`;
 *   - `nonce`: random per run (or `--nonce`, which must then be unique).
 * The comparator requires the source fingerprint to have role `source` and
 * the replica `replica`, different nonces, and the same non-null project id
 * on both sides. That refuses a copied source fingerprint, swapped
 * `--source`/`--replica`, a missing or one-sided project id, and another
 * project's store.
 *
 * LIMIT: this identifies a fingerprint RUN, not a STORE. `cleo.db` persists
 * neither a store-instance id nor its project id today, so fingerprinting the
 * source store a second time with `--role replica` is indistinguishable from
 * fingerprinting a genuine replica, and the project id comes from a file an
 * operator can edit. Reading both ids from the store itself needs a schema
 * change, tracked as T12675 (coordinated with T12341's per-store lineage
 * salt).
 *
 * SENSITIVE: the `.rows` sidecar and the key file are written with mode
 * 0600. Anyone holding both can test guesses against every row, so keep the
 * key on the machine that runs the comparison, and delete the sidecars and
 * the key afterwards.
 *
 * Memory: one table's row hashes are held at a time (about 130 bytes per row
 * as hex strings, so ~130 MB for a 1M-row table), then sorted, digested and
 * appended to the sidecar. Nothing else grows with the store.
 *
 * ## Read-only, with no sidecars
 *
 * The store is opened through a `file:` URI with `immutable=1`, so SQLite
 * creates no `-wal`/`-shm`/journal file and needs no write access to the
 * directory (a `chmod 555` directory works). `immutable` ignores a WAL, so an
 * input whose `-wal` file is non-empty (a live store, or one not checkpointed)
 * is snapshotted first: it is opened read-only in place and copied with
 * `VACUUM INTO` a private temp directory, and the copy is fingerprinted. A live
 * store's snapshot needs its `-shm` to be usable, as it is while a writer runs.
 *
 * The snapshot is a plaintext copy of the store, so it lives as briefly as
 * possible. The temp directory is created with mode 0700. As soon as the copy
 * is open, a `finally` removes the directory; the open handle keeps the pages
 * readable (POSIX), so no copy stays on disk while the store is hashed. A
 * SIGINT, SIGTERM or SIGHUP that arrives during the (synchronous) copy is
 * deferred, not fatal: the script yields to the event loop right after the
 * copy, and the handler removes the directory and exits with 128 + signal
 * number before any hashing. An `exit` handler repeats the removal as a last resort (for example
 * when the directory could not be removed while open). Only SIGKILL or a power
 * loss during the copy can leave a copy behind.
 *
 * The fingerprint never records a path: the store is named by `--label`
 * only, and the output is checked for the store's absolute path before it is
 * written. Fingerprints are artifacts that may be shared, and the nexus rule
 * (identity is `project_id`, never a path; ADR-094) applies to them too.
 *
 * sqlite-vec is loaded when available so the vec0 `brain_embeddings` table
 * (portable-personal) can be hashed. When it cannot be read, the table is
 * recorded as `unreadable`, and the comparator fails on it rather than
 * skipping it silently.
 *
 * Usage:
 *   node scripts/fingerprint-store.mjs --db <cleo.db> [--scope project|global]
 *     (--key-file <file> | --key-out <file>) [--label <name>] [--out <file.json>]
 *     --role source|replica [--rows <file.rows>] [--nonce <value>]
 *
 * Companion: scripts/compare-fingerprints.mjs.
 *
 * @task T12332
 * @task T12613
 * @task T12636
 * @task T12641
 * @task T12675
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  classifyTable,
  isPortableTableClass,
} from '../packages/core/src/store/table-classification.ts';
import { parsePortableProjectId } from '../packages/paths/src/portable-project-id.ts';
import { fingerprintMac, parseKey } from './lib/fingerprint-mac.mjs';
import { isInsideDirectoryTree } from './lib/path-containment.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    scope: { type: 'string', default: 'project' },
    label: { type: 'string', default: 'store' },
    out: { type: 'string' },
    rows: { type: 'string' },
    'key-file': { type: 'string' },
    'key-out': { type: 'string' },
    role: { type: 'string' },
    nonce: { type: 'string' },
  },
});
if (!values.db) throw new Error('pass --db <cleo.db>');
if (!['project', 'global'].includes(values.scope))
  throw new Error('--scope must be project or global');
const scope = /** @type {'project' | 'global'} */ (values.scope);
if (!['source', 'replica'].includes(values.role))
  throw new Error('fingerprint-store: pass --role source or --role replica');
const rowsPath = values.rows ?? (values.out ? `${values.out}.rows` : undefined);

/** Open a file for writing with mode 0600, including when it already exists with wider bits. */
function openPrivate(file) {
  const fd = openSync(file, 'w', 0o600);
  fchmodSync(fd, 0o600);
  return fd;
}

// The HMAC key for the row hashes and the JSON MAC: shared by both sides of one comparison.
if (Boolean(values['key-file']) === Boolean(values['key-out']))
  throw new Error(
    'fingerprint-store: pass exactly one of --key-file <existing> or --key-out <new>',
  );
let key;
if (values['key-file']) {
  key = parseKey(readFileSync(values['key-file'], 'utf8'));
} else {
  const keyOut = resolve(values['key-out']);
  // File identity, not path strings: symlinks and case folding must not hide containment.
  for (const shared of [values.out, rowsPath]) {
    if (!shared) continue;
    if (isInsideDirectoryTree(keyOut, dirname(resolve(shared))))
      throw new Error(
        'fingerprint-store: refusing --key-out inside the directory tree of --out or --rows: sharing that directory would share the key',
      );
  }
  key = randomBytes(32).toString('hex');
  // wx: never overwrite a key another comparison may still use.
  const fd = openSync(keyOut, 'wx', 0o600);
  fchmodSync(fd, 0o600);
  writeSync(fd, `${key}\n`);
  closeSync(fd);
}
// The run identity: role, portable project id (or null) and a per-run nonce, all under the MAC.
let projectId = null;
const projectIdFile = join(dirname(resolve(values.db)), 'project-id');
if (existsSync(projectIdFile)) {
  const read = parsePortableProjectId(readFileSync(projectIdFile, 'utf8'));
  if (read.status !== 'valid')
    throw new Error(`fingerprint-store: unusable project-id file: ${read.reason}`);
  projectId = read.projectId;
}
if (values.nonce !== undefined && !/^[0-9A-Za-z_-]{16,128}$/.test(values.nonce))
  throw new Error('fingerprint-store: --nonce must be 16-128 characters of [0-9A-Za-z_-]');
const identity = {
  role: values.role,
  projectId,
  nonce: values.nonce ?? randomBytes(16).toString('hex'),
};

const keyId = createHmac('sha256', key)
  .update('cleo-fingerprint-key-id')
  .digest('hex')
  .slice(0, 16);

/** Load sqlite-vec into a connection; false when it is not installed. */
function loadVec(conn) {
  try {
    createRequire(resolve(REPO_ROOT, 'packages/core/package.json'))('sqlite-vec').load(conn);
    return true;
  } catch {
    return false;
  }
}

/** Open a file with `immutable=1`: no journal, no WAL, no sidecars, no directory writes. */
function openImmutable(file) {
  const url = pathToFileURL(resolve(file));
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true, allowExtension: true });
}

const input = resolve(values.db);
if (!existsSync(input)) throw new Error('fingerprint-store: --db does not exist');
const walFile = `${input}-wal`;
let snapshotDir;
let snapshotted = false;

/** Remove the plaintext snapshot, if any. Safe to call more than once. */
function removeSnapshot() {
  if (!snapshotDir) return;
  try {
    rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = undefined;
  } catch {
    // Still open where an open file cannot be removed; the exit handler retries.
  }
}
process.on('exit', removeSnapshot);
for (const [signal, number] of [
  ['SIGINT', 2],
  ['SIGHUP', 1],
  ['SIGTERM', 15],
]) {
  process.on(signal, () => {
    removeSnapshot();
    process.exit(128 + number);
  });
}

let db;
if (existsSync(walFile) && statSync(walFile).size > 0) {
  // immutable=1 would ignore the WAL's committed pages: snapshot the store first.
  try {
    snapshotDir = mkdtempSync(join(tmpdir(), 'cleo-fingerprint-'));
    chmodSync(snapshotDir, 0o700);
    const dbFile = join(snapshotDir, 'snapshot.db');
    const live = new DatabaseSync(input, { readOnly: true, allowExtension: true });
    loadVec(live);
    live.prepare('VACUUM INTO ?').run(dbFile);
    live.close();
    db = openImmutable(dbFile);
    snapshotted = true;
  } finally {
    // The open handle keeps the copy readable; the plaintext file goes now.
    removeSnapshot();
  }
  // The copy is synchronous, so a signal that arrived during it is still pending:
  // yield once so its handler runs now, before any hashing.
  await new Promise((done) => setImmediate(done));
} else {
  db = openImmutable(input);
}
const vecLoaded = loadVec(db);

const q = (sql) => db.prepare(sql).all();
const ident = (s) => `"${s.replaceAll('"', '""')}"`;

/** Stable text form of one SQLite value, so the hash does not depend on driver types. */
function canon(v) {
  if (v === null || v === undefined) return 'N';
  if (v instanceof Uint8Array) return `B${Buffer.from(v).toString('hex')}`;
  if (typeof v === 'bigint') return `I${v}`;
  if (typeof v === 'number') return `R${v}`;
  return `S${String(v).length}:${v}`;
}

/**
 * Remove one registry JSONPath (`$`, `.key`, `.*`, `[*]`) from a parsed value.
 * The last segment names what is removed.
 */
function removeJsonPath(node, segments) {
  if (node === null || typeof node !== 'object' || segments.length === 0) return;
  const [seg, ...rest] = segments;
  const keys = seg === '*' ? Object.keys(node) : Object.hasOwn(node, seg) ? [seg] : [];
  for (const k of keys) {
    if (rest.length === 0) {
      if (Array.isArray(node)) node[k] = null;
      else delete node[k];
    } else removeJsonPath(node[k], rest);
  }
}

/** `$.a.*.b[*].c` → ['a', '*', 'b', '*', 'c']. */
function parseJsonPath(path) {
  if (!path.startsWith('$')) throw new Error(`unsupported jsonPath ${path}`);
  return path
    .slice(1)
    .replaceAll('[*]', '.*')
    .split('.')
    .filter((s) => s.length > 0);
}

/** Registry view of one table: its class (or PENDING / UNCLASSIFIED), whether it syncs, and its column overrides. */
function classOf(table) {
  const c = classifyTable(scope, table);
  if (c.kind === 'entry')
    return {
      class: c.class,
      status: c.entry.status,
      shareable: isPortableTableClass(c.class),
      overrides: c.entry.columns ?? [],
    };
  if (c.kind === 'pattern')
    return {
      class: c.class,
      status: 'pattern',
      shareable: isPortableTableClass(c.class),
      overrides: [],
    };
  if (c.kind === 'pending')
    return { class: 'PENDING', status: 'pending', shareable: false, overrides: [] };
  return { class: 'UNCLASSIFIED', status: 'unclassified', shareable: false, overrides: [] };
}

const tables = q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
  (r) => r.name,
);
const result = {
  store: values.label,
  scope,
  at: new Date().toISOString(),
  vecLoaded,
  keyId,
  identity,
  rowsFile: rowsPath ? basename(rowsPath) : null,
  rowsSha256: null,
  tables: {},
  volumeByClass: {},
  relationships: {},
  invariants: {},
};

const rowsFd = rowsPath ? openPrivate(rowsPath) : undefined;
const rowsDigest = createHash('sha256');
for (const t of tables) {
  const { class: cls, status, shareable, overrides } = classOf(t);
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
    const excluded = new Set(overrides.filter((o) => !o.jsonPath).map((o) => o.column));
    const jsonStrips = overrides
      .filter((o) => o.jsonPath)
      .map((o) => [o.column, parseJsonPath(o.jsonPath)]);
    const cols = q(`PRAGMA table_info(${ident(t)})`)
      .map((c) => c.name)
      .filter((c) => !excluded.has(c))
      .sort();
    entry.columns = cols;
    entry.excludedColumns = [...excluded].sort();
    const stmt = db.prepare(`SELECT ${cols.map(ident).join(',')} FROM ${ident(t)}`);
    stmt.setReadBigInts(true);
    const hashes = [];
    for (const row of stmt.iterate()) {
      for (const [col, segments] of jsonStrips) {
        if (typeof row[col] !== 'string') continue;
        try {
          const parsed = JSON.parse(row[col]);
          removeJsonPath(parsed, segments);
          row[col] = JSON.stringify(parsed);
        } catch {
          // Not JSON: nothing to strip.
        }
      }
      hashes.push(
        createHmac('sha256', key)
          .update(cols.map((c) => canon(row[c])).join('\u0001'))
          .digest('hex'),
      );
    }
    // Sorting makes the digest a function of the row multiset, not of physical order.
    hashes.sort();
    const h = createHash('sha256').update(cols.join('\u0000'));
    for (const rh of hashes) h.update(`${rh}\n`);
    entry.sha256 = h.digest('hex');
    if (rowsFd !== undefined && hashes.length > 0) {
      const chunk = `${hashes.map((rh) => `${t}\t${rh}`).join('\n')}\n`;
      writeSync(rowsFd, chunk);
      rowsDigest.update(chunk);
    }
  }
  result.tables[t] = entry;
}
if (rowsFd !== undefined) {
  closeSync(rowsFd);
  result.rowsSha256 = rowsDigest.digest('hex');
}

// Relationship edges that must survive replay. Each counts rows whose reference
// does not resolve in this store; a replica must reproduce the same count, never more.
// All of these tables live in the project store.
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
// Informational edges are measured and reported but never held to "no increase".
// tasks.session_id points at tasks_sessions, which is portable-personal (§F.7):
// sessions travel between the OWNER's devices but never into a collaborator's
// replica of the shared project, so there a task started by someone else keeps
// a session_id that cannot resolve. That dangling reference is by design.
const informationalEdges = {
  'tasks.session_id': [
    'tasks_tasks',
    "SELECT count(*) n FROM tasks_tasks t WHERE t.session_id IS NOT NULL AND t.session_id <> '' AND NOT EXISTS (SELECT 1 FROM tasks_sessions s WHERE s.id = t.session_id)",
  ],
};

/** Run one count; a failure is recorded, never dropped. */
function measure(sql) {
  try {
    return Number(q(sql)[0].n);
  } catch (e) {
    return { error: String(e.message).slice(0, 160) };
  }
}

if (scope === 'project') {
  for (const [group, informational] of [
    [edges, false],
    [informationalEdges, true],
  ]) {
    for (const [name, [table, sql]] of Object.entries(group)) {
      const rec = informational ? { informational: true } : {};
      if (!tables.includes(table)) rec.skipped = `no table ${table}`;
      else {
        const total = measure(`SELECT count(*) n FROM ${ident(table)}`);
        const dangling = measure(sql);
        if (typeof dangling === 'number' && typeof total === 'number')
          Object.assign(rec, { rows: total, dangling });
        else rec.error = (typeof dangling === 'number' ? total : dangling).error;
      }
      result.relationships[name] = rec;
    }
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
  for (const [name, sql] of Object.entries(invariants)) result.invariants[name] = measure(sql);
}
db.close();
removeSnapshot();

result.mac = fingerprintMac(result, key);
const json = JSON.stringify(result, null, 1);
// Never record a path: refuse to write a fingerprint that names the store's location.
for (const leak of [input, dirname(input), dirname(dirname(input))]) {
  if (leak.length > 1 && json.includes(leak)) {
    if (rowsPath) rmSync(rowsPath, { force: true });
    throw new Error(
      'fingerprint-store: refusing to write a fingerprint that contains the store path',
    );
  }
}
if (values.out) writeFileSync(values.out, `${json}\n`);

const shareable = Object.values(result.tables).filter((e) => e.sha256);
console.log(
  `${result.store} (${scope}): ${tables.length} tables, ${shareable.length} fingerprinted, sqlite-vec ${vecLoaded ? 'loaded' : 'NOT loaded'}${snapshotted ? ', read from a VACUUM INTO snapshot (non-empty WAL)' : ''}`,
);
console.log(`volume by class: ${JSON.stringify(result.volumeByClass)}`);
if (scope === 'project') console.log(`invariants: ${JSON.stringify(result.invariants)}`);
for (const [k, v] of Object.entries(result.relationships))
  console.log(`  ${k}: ${JSON.stringify(v)}`);
