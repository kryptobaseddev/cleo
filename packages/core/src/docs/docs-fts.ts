/**
 * Full-text index over the docs store (T14197).
 *
 * `memory find --docs` ranked every doc body per query with n-gram
 * similarity (`searchAllProjectDocs`): about 3.5 s on a 3,312-doc store, so
 * docs stayed an opt-in source. This index lives in the project `cleo.db`:
 * one row per slugged text doc (the slug's current body, superseded docs
 * included, so a match on one can surface its current doc), ranked by BM25.
 *
 * Two tables, rowid for rowid: `docs_fts`, a contentless FTS5 table (title
 * and body are tokenized, not stored a second time), and `docs_fts_rows`,
 * which names the slug and sha256 each rowid holds. FTS5's
 * `contentless_unindexed` would keep those in one table, but dropping such a
 * table leaves its `_content` shadow behind (SQLite 3.51 to 3.54), which can
 * neither be dropped nor let the table be created again: a lost index could
 * never be rebuilt.
 *
 * The index is derived: it holds nothing the store cannot rebuild, and both
 * tables are classified `derived` (Gate A, never synced). {@link syncDocsFts} keeps it in
 * step by diffing the slug → sha256 map of `attachments` against the index
 * and re-reading only the bodies that changed. The docs mutations (add,
 * update, supersede, remove, merge, import) call it after they succeed, and
 * every search calls it first, so rows another writer or device added are
 * picked up too. A missing table is created and filled from the store by the
 * same diff.
 *
 * @task T14197
 * @epic T14106
 */

import type { DatabaseSync } from 'node:sqlite';
import { isNotNull } from 'drizzle-orm';
import { bindTasksDomain } from '../store/sqlite.js';
import { attachments } from '../store/tasks-schema.js';

/** The FTS5 table (project `cleo.db`, class `derived`). */
export const DOCS_FTS_TABLE = 'docs_fts';

/** The slug and sha256 each `docs_fts` rowid holds (class `derived`). */
export const DOCS_FTS_ROWS_TABLE = 'docs_fts_rows';

/** Bytes of a doc body indexed (the n-gram search read the same window). */
export const DOCS_FTS_MAX_BYTES = 64 * 1024;

/** BM25 column weights: the title outweighs the body. */
const BM25_WEIGHTS = '4.0, 1.0';

/**
 * How long a search waits for the write lock before it gives up syncing and
 * reads the index as it is: a read never blocks behind another writer.
 */
export const DOCS_FTS_READ_BUSY_TIMEOUT_MS = 250;

/** What one {@link syncDocsFts} did. */
export interface DocsFtsSync {
  /** False when this SQLite build has no FTS5 (the caller falls back). */
  readonly available: boolean;
  /** Docs (re)indexed. */
  readonly indexed: number;
  /** Index rows removed (doc gone, renamed or re-versioned). */
  readonly removed: number;
  /** Docs in the index afterwards. */
  readonly total: number;
}

/** A slugged doc as the store holds it now. */
interface StoreDoc {
  slug: string;
  sha256: string;
  title: string;
}

/** Whether an attachment's JSON describes text the index should read. */
function isTextAttachment(attachmentJson: string): boolean {
  let parsed: { kind?: unknown; mime?: unknown };
  try {
    parsed = JSON.parse(attachmentJson) as { kind?: unknown; mime?: unknown };
  } catch {
    return false;
  }
  const mime =
    parsed.kind === 'blob'
      ? parsed.mime
      : parsed.kind === 'local-file'
        ? (parsed.mime ?? 'text/plain')
        : null;
  if (typeof mime !== 'string') return false;
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/yaml' ||
    mime === 'application/x-yaml'
  );
}

/** Whether a table exists. */
function tableExists(native: DatabaseSync, name: string): boolean {
  return (
    native
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/** Whether both index tables exist. */
function indexExists(native: DatabaseSync): boolean {
  return tableExists(native, DOCS_FTS_TABLE) && tableExists(native, DOCS_FTS_ROWS_TABLE);
}

/**
 * Create the index when either table is missing, dropping the other so the
 * pair always starts empty together; false when FTS5 is not compiled in or
 * the store cannot be written now.
 */
function ensureIndex(native: DatabaseSync): boolean {
  if (indexExists(native)) return true;
  native.exec('SAVEPOINT docs_fts_create');
  try {
    native.exec(`DROP TABLE IF EXISTS ${DOCS_FTS_TABLE}`);
    native.exec(`DROP TABLE IF EXISTS ${DOCS_FTS_ROWS_TABLE}`);
    // Literal names: Gate A pins this runtime DDL (table-classification-gate.test.ts).
    native.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, body, content='', " +
        "contentless_delete=1, tokenize='porter unicode61')",
    );
    native.exec(
      'CREATE TABLE IF NOT EXISTS docs_fts_rows (' +
        'rowid INTEGER PRIMARY KEY, slug TEXT NOT NULL, sha256 TEXT NOT NULL)',
    );
    native.exec('RELEASE docs_fts_create');
    return true;
  } catch {
    native.exec('ROLLBACK TO docs_fts_create');
    native.exec('RELEASE docs_fts_create');
    return false;
  }
}

/**
 * Bring the docs index in step with the store: index every slugged text doc
 * whose body the index lacks or holds at another sha256, and drop rows whose
 * slug is gone. Creates (and so rebuilds) the table when it is missing. A
 * doc whose bytes cannot be read stays out until a later sync can read them.
 * Throws when the store cannot be written (another writer past
 * `busyTimeoutMs`, a read-only store); the index is then left as it was.
 *
 * @param projectRoot - Project root.
 * @param opts - `busyTimeoutMs`: how long to wait for the write lock (default:
 *   the connection's own busy timeout).
 * @returns What changed.
 * @example
 * ```ts
 * const { indexed, total } = await syncDocsFts(projectRoot);
 * ```
 */
export async function syncDocsFts(
  projectRoot: string,
  opts: { busyTimeoutMs?: number } = {},
): Promise<DocsFtsSync> {
  const { native } = await bindTasksDomain(projectRoot);
  if (opts.busyTimeoutMs === undefined) return syncWith(projectRoot, native);
  const prior = (native.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)
    ?.timeout;
  native.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs))}`);
  try {
    return await syncWith(projectRoot, native);
  } finally {
    if (typeof prior === 'number') native.exec(`PRAGMA busy_timeout = ${prior}`);
  }
}

/** {@link syncDocsFts} on a bound connection. */
async function syncWith(projectRoot: string, native: DatabaseSync): Promise<DocsFtsSync> {
  const { db } = await bindTasksDomain(projectRoot);
  if (!ensureIndex(native)) return { available: false, indexed: 0, removed: 0, total: 0 };

  const rows = await db
    .select({
      slug: attachments.slug,
      sha256: attachments.sha256,
      summary: attachments.summary,
      attachmentJson: attachments.attachmentJson,
    })
    .from(attachments)
    .where(isNotNull(attachments.slug))
    .all();
  const store = new Map<string, StoreDoc>();
  for (const row of rows) {
    if (!row.slug || !isTextAttachment(row.attachmentJson)) continue;
    store.set(row.slug, {
      slug: row.slug,
      sha256: row.sha256,
      title: [row.summary ?? '', row.slug.replace(/[-_]+/g, ' ')].join(' ').trim(),
    });
  }

  const indexedRows = native
    .prepare(`SELECT rowid, slug, sha256 FROM ${DOCS_FTS_ROWS_TABLE}`)
    .all() as Array<{ rowid: number; slug: string; sha256: string }>;
  const current = new Set<string>();
  const stale: number[] = [];
  for (const row of indexedRows) {
    if (store.get(row.slug)?.sha256 === row.sha256 && !current.has(row.slug)) current.add(row.slug);
    else stale.push(row.rowid);
  }
  const missing = [...store.values()].filter((doc) => !current.has(doc.slug));
  if (stale.length === 0 && missing.length === 0)
    return { available: true, indexed: 0, removed: 0, total: current.size };

  const bodies: Array<{ doc: StoreDoc; body: string }> = [];
  if (missing.length > 0) {
    const { createAttachmentStore } = await import('../store/attachment-store.js');
    const attachmentStore = createAttachmentStore();
    for (const doc of missing) {
      const fetched = await attachmentStore.get(doc.sha256, projectRoot).catch(() => null);
      if (!fetched) continue;
      bodies.push({ doc, body: fetched.bytes.toString('utf8').slice(0, DOCS_FTS_MAX_BYTES) });
    }
  }

  native.exec('SAVEPOINT docs_fts_sync');
  try {
    const removeText = native.prepare(`DELETE FROM ${DOCS_FTS_TABLE} WHERE rowid = ?`);
    const removeRow = native.prepare(`DELETE FROM ${DOCS_FTS_ROWS_TABLE} WHERE rowid = ?`);
    for (const rowid of stale) {
      removeText.run(rowid);
      removeRow.run(rowid);
    }
    const insertRow = native.prepare(
      `INSERT INTO ${DOCS_FTS_ROWS_TABLE}(slug, sha256) VALUES (?, ?)`,
    );
    const insertText = native.prepare(
      `INSERT INTO ${DOCS_FTS_TABLE}(rowid, title, body) VALUES (?, ?, ?)`,
    );
    for (const { doc, body } of bodies) {
      const { lastInsertRowid } = insertRow.run(doc.slug, doc.sha256);
      insertText.run(lastInsertRowid, doc.title, body);
    }
    native.exec('RELEASE docs_fts_sync');
  } catch (err) {
    native.exec('ROLLBACK TO docs_fts_sync');
    native.exec('RELEASE docs_fts_sync');
    throw err;
  }
  return {
    available: true,
    indexed: bodies.length,
    removed: stale.length,
    total: current.size + bodies.length,
  };
}

/**
 * An FTS5 MATCH expression for free text: each word quoted (so FTS5 syntax in
 * the query is inert), OR-joined so BM25 ranks docs matching more words higher.
 *
 * @param query - The search text.
 * @returns The expression, or null when the text has no searchable word.
 */
export function docsFtsMatch(query: string): string | null {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2),
    ),
  ];
  return words.length === 0 ? null : words.map((w) => `"${w}"`).join(' OR ');
}

/**
 * Slugs of the docs matching `query`, best BM25 rank first. Superseded docs
 * are included: the caller resolves each to its current doc.
 *
 * A read never fails or blocks on the index write: the search first tries a
 * {@link syncDocsFts} that waits at most {@link DOCS_FTS_READ_BUSY_TIMEOUT_MS}
 * for the write lock. When that sync cannot write (another writer, a
 * read-only store), the index is searched as it stands; when there is no
 * index to search, or anything else fails, the result is null and the caller
 * falls back. Never throws.
 *
 * @param projectRoot - Project root.
 * @param query - The search text.
 * @param limit - Maximum slugs.
 * @returns The slugs, or null when there is no usable index (no FTS5, not
 *   yet built and not buildable now, or unreadable).
 * @example
 * ```ts
 * const slugs = await searchDocsFts(projectRoot, 'backup retention', 10);
 * ```
 */
export async function searchDocsFts(
  projectRoot: string,
  query: string,
  limit: number,
): Promise<string[] | null> {
  try {
    const sync = await syncDocsFts(projectRoot, {
      busyTimeoutMs: DOCS_FTS_READ_BUSY_TIMEOUT_MS,
    }).catch(() => null);
    if (sync !== null && !sync.available) return null;
    const { native } = await bindTasksDomain(projectRoot);
    // The sync could not write: search the index as it stands, if there is one.
    if (!indexExists(native)) return null;
    const match = docsFtsMatch(query);
    if (match === null || limit <= 0) return [];
    const rows = native
      .prepare(
        `SELECT r.slug FROM ${DOCS_FTS_TABLE} JOIN ${DOCS_FTS_ROWS_TABLE} r ` +
          `ON r.rowid = ${DOCS_FTS_TABLE}.rowid WHERE ${DOCS_FTS_TABLE} MATCH ? ` +
          `ORDER BY bm25(${DOCS_FTS_TABLE}, ${BM25_WEIGHTS}) LIMIT ?`,
      )
      .all(match, limit) as Array<{ slug: string }>;
    return rows.map((row) => row.slug);
  } catch {
    return null;
  }
}
