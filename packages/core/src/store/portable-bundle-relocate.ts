/**
 * portable-bundle-relocate.ts — rewrite a restored project's absolute paths
 * from its old root to its new root, and report every absolute path it
 * deliberately left alone.
 *
 * Rewrites are limited to STRUCTURAL locators: path-named columns and
 * path-named keys inside `*_json` columns. Historical records (audit logs,
 * observations, narratives, captured tool output, task text) are reported
 * but never edited: rewriting them would falsify history and invalidate
 * content hashes and signatures computed over the original text.
 *
 * Operates on a staged copy BEFORE it is placed, so a failed relocation
 * never leaves a half-rewritten live store.
 *
 * @task T12318
 * @epic T12317
 * @module store/portable-bundle-relocate
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { PortablePathFinding, PortableRelocationReport } from '@cleocode/contracts';
import { isAbsolutePath } from '@cleocode/paths';
import { installSchemaWriteGuard } from './worktree-build-guard.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** Column names that hold a single filesystem locator. */
const PATH_COLUMN = /(^|_)(path|cwd|root|dir)$/i;
/** Keys inside JSON columns that hold a filesystem locator. */
const PATH_JSON_KEY =
  /^(path|filePath|projectRoot|projectPath|root|cwd|worktreePath|worktreeRoot|gitRoot|cleoDir|dir|brainDbPath|tasksDbPath)$/;
/** Tables whose rows are historical record — reported, never rewritten. */
const HISTORICAL_TABLE =
  /(audit|_log$|history|_events?$|narrative|transcript|observation|journal|backfill|background_jobs|handoff|retrieval|usage)/i;
/** Columns holding captured text or evidence — reported, never rewritten. */
const HISTORICAL_COLUMN =
  /(verification|narrative|details|stdout|output|text|description|notes|title|summary|content|body|message|proposal|snapshot)/i;

const EXAMPLE_LIMIT = 160;

/** Either path separator: bundle rows carry the SOURCE machine's paths. */
const ANY_SEP = /[\\/]+/;

/**
 * Drop trailing separators so `/a/b/` and `/a/b` compare equal. A bare root
 * (`/`, `C:\`) becomes `''` / `C:`, the prefix every path on it starts with.
 */
function trimTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/**
 * Separator to write under `root`: `\` for a drive-rooted or UNC root,
 * `/` otherwise. Decided by the destination, never by the host OS, so a
 * relocation reads the same wherever it runs.
 */
function separatorFor(root: string): '/' | '\\' {
  return /^[A-Za-z]:/.test(root) || root.startsWith('\\\\') ? '\\' : '/';
}

/**
 * The segments of `value` below `root`, with `.` and `..` resolved, or
 * `null` when `value` is not at or under `root`.
 *
 * Accepts `/` and `\` as the boundary and in the remainder: a Windows bundle
 * relocated on Linux must see `C:\p\a` under `C:\p`, and vice versa, so the
 * host's `path.relative` / `path.sep` cannot be used. A `..` that climbs
 * above `root` (`/p/../../etc`) means the value is not under it.
 */
function segmentsUnder(value: string, root: string): string[] | null {
  const base = trimTrailingSep(root);
  if (root.length === 0 || !value.startsWith(base)) return null;
  const rest = value.slice(base.length);
  if (rest.length > 0 && !/^[\\/]/.test(rest)) return null;
  const out: string[] = [];
  for (const segment of rest.split(ANY_SEP)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out;
}

/**
 * True when `value` is `root` or lies under it (path-boundary aware, so
 * `/a/b` does not match `/a/bc`; `..` escapes do not count as under).
 *
 * @param value - Candidate path.
 * @param root - Root path; a trailing separator is ignored.
 * @returns Whether `value` is at or under `root`.
 */
export function isUnderRoot(value: string, root: string): boolean {
  return segmentsUnder(value, root) !== null;
}

/**
 * Re-root `value` from `from` onto `to` (boundary aware).
 *
 * The remainder keeps its segments, with `.`/`..` resolved, and is joined
 * with `to`'s separator: `C:\p\a\b` moved from `C:\p` to `/home/me/p`
 * becomes `/home/me/p/a/b`, not the single POSIX filename `a\b`.
 *
 * @param value - Path under `from`.
 * @param from - Old root; a trailing separator is ignored.
 * @param to - New root; a trailing separator is ignored.
 * @returns The relocated path, or `value` unchanged when it is not under `from`.
 */
export function relocatePath(value: string, from: string, to: string): string {
  const segments = segmentsUnder(value, from);
  if (segments === null) return value;
  const base = trimTrailingSep(to);
  const sep = separatorFor(to);
  if (segments.length === 0) return base.length > 0 ? base : to;
  return `${base}${sep}${segments.join(sep)}`;
}

/** How a relocation treats one column: a path locator, path keys inside JSON, or neither. */
export type RelocatableColumn = 'path' | 'json' | null;

/**
 * Whether {@link relocateDatabase} rewrites `column` of `table`, and how.
 * Historical tables and columns and `WITHOUT ROWID` tables are never
 * rewritten.
 *
 * @param table - Table name.
 * @param column - Column name.
 * @param withoutRowid - The table is `WITHOUT ROWID`.
 * @returns `path`, `json`, or `null` when the column is left alone.
 * @task T12336
 */
export function relocatableColumn(
  table: string,
  column: string,
  withoutRowid: boolean,
): RelocatableColumn {
  if (withoutRowid || HISTORICAL_TABLE.test(table) || HISTORICAL_COLUMN.test(column)) return null;
  if (PATH_COLUMN.test(column)) return 'path';
  if (/_json$/i.test(column)) return 'json';
  return null;
}

/**
 * The value {@link relocateDatabase} would write for one text cell of a
 * relocatable column, or the value unchanged when it would not rewrite it.
 * The cloud vault hashes cells through this, so a relocated store hashes
 * exactly like its source.
 *
 * @param kind - The column's kind ({@link relocatableColumn}).
 * @param value - Cell text.
 * @param from - Old root.
 * @param to - New root.
 * @returns The relocated text.
 * @task T12336
 */
export function relocateCell(
  kind: 'path' | 'json',
  value: string,
  from: string,
  to: string,
): string {
  if (kind === 'path') {
    return isAbsolutePath(value) && isUnderRoot(value, from)
      ? relocatePath(value, from, to)
      : value;
  }
  if (!/^[[{]/.test(value)) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const r = rewriteJson(
    parsed,
    from,
    to,
    () => {},
    () => {},
  );
  return r.changed > 0 ? JSON.stringify(r.value) : value;
}

/** Recursively rewrite path-named string keys of a parsed JSON value. */
function rewriteJson(
  node: unknown,
  from: string,
  to: string,
  onOutside: (value: string) => void,
  onRewrite: (newValue: string) => void,
): { value: unknown; changed: number } {
  if (Array.isArray(node)) {
    let changed = 0;
    const out = node.map((item) => {
      const r = rewriteJson(item, from, to, onOutside, onRewrite);
      changed += r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (node !== null && typeof node === 'object') {
    let changed = 0;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && PATH_JSON_KEY.test(key) && isAbsolutePath(value)) {
        if (isUnderRoot(value, from)) {
          out[key] = relocatePath(value, from, to);
          onRewrite(out[key] as string);
          changed += 1;
        } else {
          onOutside(value);
          out[key] = value;
        }
        continue;
      }
      const r = rewriteJson(value, from, to, onOutside, onRewrite);
      changed += r.changed;
      out[key] = r.value;
    }
    return { value: out, changed };
  }
  return { value: node, changed: 0 };
}

/** Accumulates findings keyed by location. */
class FindingSet {
  private readonly map = new Map<string, PortablePathFinding>();

  add(location: string, example: string): void {
    const existing = this.map.get(location);
    if (existing) existing.count += 1;
    else this.map.set(location, { location, count: 1, example: example.slice(0, EXAMPLE_LIMIT) });
  }

  list(): PortablePathFinding[] {
    return [...this.map.values()].sort((a, b) => b.count - a.count);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Relocate one SQLite database from `from` to `to`.
 *
 * @param dbPath - Staged database (modified in place).
 * @param dbLabel - Label used in finding locations (e.g. `cleo.db`).
 * @param from - Old project root.
 * @param to - New project root.
 * @param report - Report to append to.
 */
export function relocateDatabase(
  dbPath: string,
  dbLabel: string,
  from: string,
  to: string,
  report: PortableRelocationReport,
): void {
  const rewritten = new FindingSet();
  const leftUnder = new FindingSet();
  const leftOutside = new FindingSet();
  const missing = new FindingSet();
  const destCleo = `${trimTrailingSep(to)}${separatorFor(to)}.cleo`;
  const checkTarget = (location: string, next: string): void => {
    // Files under the new .cleo/ are placed after relocation; anything else
    // must already exist (or be restored by the user, e.g. a git clone).
    if (!isUnderRoot(next, destCleo) && !fs.existsSync(next)) missing.add(location, next);
  };
  const db = new DatabaseSync(dbPath);
  installSchemaWriteGuard(db); // T12687
  try {
    const tables = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string; sql: string | null }>;
    const virtualNames = tables
      .filter((t) => (t.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE'))
      .map((t) => t.name);
    for (const table of tables) {
      if (virtualNames.includes(table.name)) continue;
      if (virtualNames.some((v) => table.name.startsWith(`${v}_`))) continue;
      const withoutRowid = (table.sql ?? '').toUpperCase().includes('WITHOUT ROWID');
      const columns = (
        db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const column of columns) {
        const location = `${dbLabel}:${table.name}.${column}`;
        const kind = relocatableColumn(table.name, column, withoutRowid);
        const pathColumn = kind === 'path';
        const jsonColumn = kind === 'json';
        const col = quoteIdent(column);
        const rows = db
          .prepare(
            `SELECT ${withoutRowid ? 'NULL' : 'rowid'} AS rid, ${col} AS v FROM ${quoteIdent(table.name)} WHERE typeof(${col}) = 'text' AND (instr(${col}, ?) > 0${pathColumn ? ` OR ${col} LIKE '/%'` : ''}${jsonColumn ? ` OR instr(${col}, '"/') > 0` : ''})`,
          )
          .all(from) as Array<{ rid: number | bigint | null; v: string }>;
        for (const row of rows) {
          const mentionsRoot = row.v.includes(from);
          if (pathColumn && isAbsolutePath(row.v)) {
            if (isUnderRoot(row.v, from)) {
              const next = relocatePath(row.v, from, to);
              db.prepare(`UPDATE ${quoteIdent(table.name)} SET ${col} = ? WHERE rowid = ?`).run(
                next,
                row.rid,
              );
              rewritten.add(location, row.v);
              checkTarget(location, next);
            } else {
              leftOutside.add(location, row.v);
            }
            continue;
          }
          if (jsonColumn && /^[[{]/.test(row.v)) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(row.v);
            } catch {
              parsed = undefined;
            }
            if (parsed !== undefined) {
              const r = rewriteJson(
                parsed,
                from,
                to,
                (v) => leftOutside.add(location, v),
                (v) => checkTarget(location, v),
              );
              if (r.changed > 0) {
                const next = JSON.stringify(r.value);
                db.prepare(`UPDATE ${quoteIdent(table.name)} SET ${col} = ? WHERE rowid = ?`).run(
                  next,
                  row.rid,
                );
                rewritten.add(location, row.v);
                if (next.includes(from)) leftUnder.add(location, next);
                continue;
              }
            }
          }
          if (mentionsRoot) leftUnder.add(location, row.v);
        }
      }
    }
  } finally {
    db.close();
  }
  report.rewritten.push(...rewritten.list());
  report.leftUnderOldRoot.push(...leftUnder.list());
  report.leftOutsideRoot.push(...leftOutside.list());
  report.rewrittenTargetMissing.push(...missing.list());
}

/** Project JSON files whose string values are relocated wholesale. */
export const RELOCATED_JSON_FILES: readonly string[] = [
  'config.json',
  'project-context.json',
  'worktrees.json',
];

/** Rewrite every string value under `from` in a parsed JSON value. */
function rewriteAllStrings(
  node: unknown,
  from: string,
  to: string,
): { value: unknown; changed: number } {
  if (typeof node === 'string') {
    return isAbsolutePath(node) && isUnderRoot(node, from)
      ? { value: relocatePath(node, from, to), changed: 1 }
      : { value: node, changed: 0 };
  }
  if (Array.isArray(node)) {
    let changed = 0;
    const value = node.map((n) => {
      const r = rewriteAllStrings(n, from, to);
      changed += r.changed;
      return r.value;
    });
    return { value, changed };
  }
  if (node !== null && typeof node === 'object') {
    let changed = 0;
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = rewriteAllStrings(v, from, to);
      changed += r.changed;
      value[k] = r.value;
    }
    return { value, changed };
  }
  return { value: node, changed: 0 };
}

/**
 * A {@link RELOCATED_JSON_FILES} file's JSON with every string value that is
 * an absolute path under `from` re-rooted onto `to`, serialised compactly, so
 * two copies of one file relocated to different roots compare equal (the
 * cloud vault hashes them this way, T13005).
 *
 * @param text - File content.
 * @param from - Old root.
 * @param to - New root.
 * @returns Compact JSON, or `null` when `text` is not JSON.
 * @task T13005
 */
export function relocatedJsonText(text: string, from: string, to: string): string | null {
  try {
    return JSON.stringify(rewriteAllStrings(JSON.parse(text), from, to).value);
  } catch {
    return null;
  }
}

/**
 * Relocate the staged `.cleo/` files of one project and report text files that
 * still mention the old root.
 *
 * - `project-info.json`: left as is. `projectId` and the write-once
 *   `projectHash` are identity keys (release ids, audit rows), never path
 *   facts, so a relocation keeps both (T12557).
 * - `config.json`, `project-context.json`, `worktrees.json`: string values that
 *   are absolute paths under the old root are rewritten. Paths embedded inside
 *   prose strings are left and reported.
 * - Every other text file mentioning the old root is reported, not edited.
 *
 * @param stagedCleoDir - Staged copy of the project's `.cleo/` directory.
 * @param relPaths - Relative paths of the staged regular files.
 * @param from - Old project root.
 * @param to - New project root.
 * @param report - Report to append to.
 */
export function relocateProjectFiles(
  stagedCleoDir: string,
  relPaths: readonly string[],
  from: string,
  to: string,
  report: PortableRelocationReport,
): void {
  for (const rel of relPaths) {
    const abs = path.join(stagedCleoDir, rel);
    let text: string;
    try {
      if (fs.statSync(abs).size > 8 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    if (!text.includes(from)) continue;
    if (RELOCATED_JSON_FILES.includes(rel)) {
      try {
        const r = rewriteAllStrings(JSON.parse(text), from, to);
        if (r.changed > 0) {
          const next = `${JSON.stringify(r.value, null, 2)}\n`;
          fs.writeFileSync(abs, next);
          report.rewritten.push({ location: rel, count: r.changed });
          text = next;
        }
      } catch {
        // not JSON — fall through to reporting
      }
    }
    const occurrences = text.split(from).length - 1;
    if (occurrences > 0) {
      const at = text.indexOf(from);
      report.leftUnderOldRoot.push({
        location: rel,
        count: occurrences,
        example: text.slice(Math.max(0, at - 40), at + EXAMPLE_LIMIT - 40),
      });
    }
  }
}
