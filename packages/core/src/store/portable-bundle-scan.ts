/**
 * portable-bundle-scan.ts — tree walking, SQLite snapshotting and row
 * counting shared by the portable-bundle export and import sides.
 *
 * Kept free of CLI and registry concerns: it answers "what is in this root,
 * what may leave the machine, and how many rows does each table hold".
 *
 * @task T12318
 * @epic T12317
 * @module store/portable-bundle-scan
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import {
  DB_INVENTORY,
  type PortableExclusion,
  type PortableSymlinkEntry,
} from '@cleocode/contracts';
import { resolveDualScopeDbPath } from './dual-scope-db.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

// node:sqlite interop (createRequire — Vitest strips `node:` prefix)
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Store identity — derived from the canonical resolvers, never hand-typed
// ---------------------------------------------------------------------------

/**
 * Basename of the consolidated (post-E6) store, derived from the dual-scope
 * resolver so a future rename cannot silently strand the export again.
 */
export const PRIMARY_STORE_BASENAME = path.basename(
  resolveDualScopeDbPath('global', undefined, path.sep),
);

/**
 * Pre-E6 per-domain database basenames that sit directly in a root, by tier.
 * Derived from `DB_INVENTORY` (whose templates still describe the pre-E6
 * layout): any inventory file at the top of `.cleo/` or `<cleoHome>/`.
 */
export const LEGACY_STORE_BASENAMES: Readonly<Record<'project' | 'global', ReadonlySet<string>>> = {
  project: legacyBasenames('<projectRoot>/.cleo/'),
  global: legacyBasenames('$XDG_DATA_HOME/cleo/'),
};

function legacyBasenames(prefix: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of DB_INVENTORY) {
    if (!entry.filePathTemplate.startsWith(prefix)) continue;
    const rest = entry.filePathTemplate.slice(prefix.length);
    if (!rest.includes('/')) names.add(rest);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Walk rules
// ---------------------------------------------------------------------------

/** Rules controlling what a section walk captures. */
export interface SectionRules {
  /**
   * Relative directory paths excluded with a reason. A key matches the
   * directory itself; a key ending in `*` matches any directory whose
   * relative path starts with the prefix.
   */
  excludedDirs: Readonly<Record<string, string>>;
  /** Directory basenames excluded at ANY depth, with a reason. */
  excludedDirNamesAnywhere: Readonly<Record<string, string>>;
  /** Returns the remedy when `relPath` is a secret, else null. */
  secretRemedy: (relPath: string) => string | null;
}

/** File suffixes that are never captured byte-for-byte (live DBs go through VACUUM). */
const EXCLUDED_FILE_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['-wal', 'SQLite WAL sidecar (the database is captured via VACUUM INTO)'],
  ['-shm', 'SQLite shared-memory sidecar (regenerated on open)'],
  ['-journal', 'SQLite rollback journal (the database is captured via VACUUM INTO)'],
  ['.pid', 'process id file (machine-local runtime state)'],
  ['.lock', 'lock file (machine-local runtime state)'],
  ['.sock', 'socket (machine-local runtime state)'],
  ['.tmp', 'temporary file'],
];

const IDENTITY_REMEDY =
  'Project signing identity (Ed25519). Without it, run any severity-signing command to mint a new key; previously signed audit lines keep verifying against their embedded public key.';

/** Walk rules for a project `.cleo/` directory. */
export const PROJECT_SECTION_RULES: SectionRules = {
  excludedDirs: {
    backups: 'local snapshots (regenerable; the live stores are captured via VACUUM INTO)',
    cache: 'cache (regenerable)',
    logs: 'logs (machine-local)',
    locks: 'lock directory (machine-local runtime state)',
  },
  excludedDirNamesAnywhere: {
    worktrees: 'git worktrees (recreated per machine)',
    node_modules: 'dependency install (regenerable)',
    __pycache__: 'Python bytecode cache (regenerable)',
  },
  secretRemedy: (relPath) => (relPath.startsWith('keys/') ? IDENTITY_REMEDY : null),
};

/** Secret files in the global CLEO home and what losing each one costs. */
const GLOBAL_SECRETS: Readonly<Record<string, string>> = {
  'global-salt':
    'Global salt for agent API-key derivation. A new salt is generated on first use; every registered agent must re-authenticate (re-issue agent API keys).',
  'machine-key':
    'Machine key (encrypts stored agent credentials). A new key is generated on first use; stored agent credentials cannot be decrypted and must be re-entered.',
  'llm-credentials.json':
    'Stored LLM provider credentials. Re-run provider login / re-enter API keys.',
  'anthropic-oauth.json': 'Anthropic OAuth session. Re-run the Anthropic login.',
  'google_oauth.json': 'Google OAuth session. Re-run the Google login.',
  'anthropic-key': 'Anthropic API key. Re-enter it.',
};

/**
 * Generic credential-looking basenames, applied to TOP-LEVEL files of a home
 * (and to everything under `auth/` in the config home). Deeper files are
 * content (skills, templates, docs) where words like "token" are prose.
 */
const SECRET_BASENAME_PATTERN =
  /(credential|secret|oauth|password|\.pem$|\.key$|^id_(rsa|ed25519))/i;

/** Walk rules for the global CLEO home. */
export const GLOBAL_HOME_RULES: SectionRules = {
  excludedDirs: {
    worktrees: 'agent git worktrees (recreated per machine)',
    'verification-archives': 'archived verification runs (regenerable history, large)',
    _archive: 'archive of superseded state',
    logs: 'logs (machine-local)',
    backups: 'local snapshots (regenerable)',
    '.backups': 'local snapshots (regenerable)',
    locks: 'lock directory (machine-local runtime state)',
    cache: 'cache (regenerable)',
    '.cleanup-*': 'upgrade cleanup markers (machine-local)',
    '.cleo-import-*': 'in-progress import staging',
  },
  excludedDirNamesAnywhere: {
    node_modules: 'dependency install (regenerable)',
    __pycache__: 'Python bytecode cache (regenerable)',
  },
  secretRemedy: (relPath) => {
    const explicit = GLOBAL_SECRETS[relPath];
    if (explicit !== undefined) return explicit;
    return !relPath.includes('/') && SECRET_BASENAME_PATTERN.test(relPath)
      ? `Credential-like file "${relPath}". Recreate it on the target machine.`
      : null;
  },
};

/** Walk rules for the config home (`$XDG_CONFIG_HOME/cleo`). */
export const CONFIG_HOME_RULES: SectionRules = {
  excludedDirs: {},
  excludedDirNamesAnywhere: {
    node_modules: 'dependency install (regenerable)',
    __pycache__: 'Python bytecode cache (regenerable)',
  },
  secretRemedy: (relPath) =>
    relPath.startsWith('auth/') || (!relPath.includes('/') && SECRET_BASENAME_PATTERN.test(relPath))
      ? `Provider authentication material "${relPath}". Re-run the provider login.`
      : null,
};

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/** Classified contents of one root. */
export interface SectionScan {
  /** SQLite files (relative paths). */
  sqlite: string[];
  /** Regular non-secret files (relative paths). */
  files: string[];
  /** Secret files with their remedies. */
  secrets: Array<{ relPath: string; remedy: string }>;
  /** Symlinks whose targets stay inside the root. */
  symlinks: PortableSymlinkEntry[];
  /** Exclusions with sizes. */
  excluded: PortableExclusion[];
}

/** Maximum entries measured under one excluded directory before reporting a lower bound. */
const EXCLUSION_MEASURE_BUDGET = 200_000;

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * True when a file starts with the SQLite header.
 *
 * @param absPath - File to test.
 * @returns Whether the file is a SQLite database.
 */
export function isSqliteFile(absPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    return read === 16 && header.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Measure bytes and files under a directory, stopping at a budget.
 *
 * @param absDir - Directory to measure (symlinks are not followed).
 * @returns Totals and whether the walk completed.
 */
function measureDir(absDir: string): { bytes: number; fileCount: number; complete: boolean } {
  let bytes = 0;
  let fileCount = 0;
  let visited = 0;
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > EXCLUSION_MEASURE_BUDGET) return { bytes, fileCount, complete: false };
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        try {
          bytes += fs.lstatSync(abs).size;
          fileCount += 1;
        } catch {
          // vanished mid-walk
        }
      }
    }
  }
  return { bytes, fileCount, complete: true };
}

function matchExcludedDir(relPath: string, name: string, rules: SectionRules): string | null {
  const anywhere = rules.excludedDirNamesAnywhere[name];
  if (anywhere !== undefined) return anywhere;
  for (const [key, reason] of Object.entries(rules.excludedDirs)) {
    if (key.endsWith('*') ? relPath.startsWith(key.slice(0, -1)) : relPath === key) return reason;
  }
  return null;
}

/** Record a symlink: kept when its target stays inside the root, else excluded. */
function classifySymlink(scan: SectionScan, root: string, relPath: string, abs: string): void {
  let target = '<unreadable>';
  try {
    target = fs.readlinkSync(abs);
  } catch {
    // keep placeholder
  }
  const resolved = path.resolve(path.dirname(abs), target);
  const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  if (!path.isAbsolute(target) && inside) {
    scan.symlinks.push({ relPath, target });
    return;
  }
  scan.excluded.push({
    relPath,
    reason: `symlink -> ${target} (points outside the root; not followed — recreate it on the target if needed)`,
    bytes: 0,
    fileCount: 0,
    sizeComplete: true,
  });
}

/** Record one regular file: excluded sidecar, secret, SQLite, or plain file. */
function classifyFile(
  scan: SectionScan,
  rules: SectionRules,
  relPath: string,
  name: string,
  abs: string,
): void {
  const suffix = EXCLUDED_FILE_SUFFIXES.find(([s]) => name.endsWith(s));
  if (suffix !== undefined) {
    let size = 0;
    try {
      size = fs.lstatSync(abs).size;
    } catch {
      // vanished
    }
    scan.excluded.push({
      relPath,
      reason: suffix[1],
      bytes: size,
      fileCount: 1,
      sizeComplete: true,
    });
    return;
  }
  const remedy = rules.secretRemedy(relPath);
  if (remedy !== null) scan.secrets.push({ relPath, remedy });
  else if (isSqliteFile(abs)) scan.sqlite.push(relPath);
  else scan.files.push(relPath);
}

/**
 * Walk one root and classify every entry. Symlinks are never followed; an
 * in-root relative symlink is recorded for recreation, any other symlink is
 * reported as an exclusion so nothing leaves the root silently.
 *
 * @param root - Absolute root directory.
 * @param rules - Section rules.
 * @param skipAbsolute - Absolute paths to ignore entirely (e.g. the export's own staging dir).
 * @returns The classified scan.
 */
export function scanSection(
  root: string,
  rules: SectionRules,
  skipAbsolute: ReadonlySet<string> = new Set(),
): SectionScan {
  const scan: SectionScan = { sqlite: [], files: [], secrets: [], symlinks: [], excluded: [] };
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir === '' ? root : path.join(root, relDir);
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = path.join(root, relPath);
      if (skipAbsolute.has(abs)) continue;
      if (entry.isSymbolicLink()) {
        classifySymlink(scan, root, relPath, abs);
      } else if (entry.isDirectory()) {
        const reason = matchExcludedDir(relPath, entry.name, rules);
        if (reason === null) {
          stack.push(relPath);
          continue;
        }
        const m = measureDir(abs);
        scan.excluded.push({
          relPath,
          reason,
          bytes: m.bytes,
          fileCount: m.fileCount,
          sizeComplete: m.complete,
        });
      } else if (entry.isFile()) {
        classifyFile(scan, rules, relPath, entry.name, abs);
      } else {
        scan.excluded.push({
          relPath,
          reason: 'not a regular file (socket/fifo/device)',
          bytes: 0,
          fileCount: 0,
          sizeComplete: true,
        });
      }
    }
  }
  scan.sqlite.sort();
  scan.files.sort();
  return scan;
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot a SQLite database with `VACUUM INTO` over a READ-ONLY connection.
 *
 * VACUUM INTO runs inside one read transaction, so the snapshot is
 * consistent even while other processes write through WAL. The source is
 * never checkpointed or otherwise modified.
 *
 * @param srcPath - Source database.
 * @param destPath - Snapshot path (must not exist).
 * @throws {Error} When the source cannot be opened or read.
 */
export function vacuumSnapshot(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const db = new DatabaseSync(srcPath, { readOnly: true });
  try {
    applyPerfPragmas(db, { enableWal: false });
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * Count rows in every ordinary table of a database.
 *
 * Virtual tables are reported as uncounted (their rows live in shadow tables,
 * which are counted); any other failure is reported with its message rather
 * than swallowed.
 *
 * @param dbPath - Database to count.
 * @returns Counts and uncountable tables.
 */
export function countRows(dbPath: string): {
  rowCounts: Record<string, number>;
  uncountedTables: Record<string, string>;
} {
  const rowCounts: Record<string, number> = {};
  const uncountedTables: Record<string, string> = {};
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    applyPerfPragmas(db, { enableWal: false });
    const tables = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string | null }>;
    for (const t of tables) {
      if ((t.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE')) {
        uncountedTables[t.name] = 'virtual table (rows counted in its shadow tables)';
        continue;
      }
      try {
        const row = db
          .prepare(`SELECT COUNT(*) AS cnt FROM "${t.name.replace(/"/g, '""')}"`)
          .get() as { cnt: number } | undefined;
        rowCounts[t.name] = Number(row?.cnt ?? 0);
      } catch (err) {
        uncountedTables[t.name] = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    db.close();
  }
  return { rowCounts, uncountedTables };
}

/**
 * Run `PRAGMA integrity_check` on a database.
 *
 * @param dbPath - Database to check.
 * @returns `ok` or the first reported problem.
 */
export function integrityCheck(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    return row?.integrity_check ?? 'no result';
  } finally {
    db.close();
  }
}

/** Tables surfaced as "key counts" in results when present. */
export const KEY_COUNT_TABLES: readonly string[] = [
  'tasks_tasks',
  'tasks_sessions',
  'brain_observations',
  'brain_decisions',
  'brain_learnings',
  'brain_patterns',
  'conduit_messages',
  'nexus_project_registry',
  'nexus_nodes',
];

/**
 * Select the key-table subset of a row-count map.
 *
 * @param rowCounts - Full counts.
 * @returns Counts for the key tables that exist.
 */
export function pickKeyCounts(rowCounts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of KEY_COUNT_TABLES) {
    const v = rowCounts[t];
    if (v !== undefined) out[t] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Stream a file through SHA-256.
 *
 * @param filePath - File to hash.
 * @returns Lowercase hex digest.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
