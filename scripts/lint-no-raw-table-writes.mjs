#!/usr/bin/env node

/**
 * Raw table-writer ratchet (Gate A · T12332)
 *
 * Every table in the project and global `cleo.db` now carries a replication
 * class (`packages/core/src/store/table-classification.ts`). A change can only
 * be captured for replication if it goes through the sanctioned write path: a
 * handle from `openDualScopeDb` and the domain accessors built on it. A raw
 * SQL `INSERT` / `UPDATE` / `DELETE` / `REPLACE` scattered through the code
 * base is a write nobody can enumerate. Some of today's raw writers land in
 * frozen bare twins that no reader looks at (draft §2.2), and Studio writes
 * brain rows through its own `DatabaseSync` without a lease (draft §B.2).
 *
 * This gate is a RATCHET, not a zero-tolerance rule: the existing offenders
 * are recorded in a baseline, keyed by (file, table), and that baseline may
 * only shrink.
 *
 *   - A write site that is not in the baseline (a new file, a new table in a
 *     file, or a higher count) FAILS.
 *   - A baseline entry whose count fell FAILS too, until the baseline is
 *     regenerated. A removed offender must be dropped from the baseline in
 *     the same change, so the allowance cannot be spent again later.
 *
 * ## What counts as a write site
 *
 * Non-test source (`*.ts`, `*.tsx`, `*.mjs`, `*.js`, `*.rs` under `packages/`
 * and `crates/`) carrying an SQL write keyword followed by a classified table
 * name, optionally schema-qualified:
 *
 *   INSERT [OR …] INTO t · REPLACE INTO t · UPDATE [OR …] t · DELETE FROM t
 *
 * The match is case-insensitive and whitespace-tolerant, so a lower-case or
 * multi-line statement counts. Comments are blanked first by a small lexer
 * that knows strings, template literals, regex literals and (for Rust) raw
 * strings, nested block comments and char literals, so a string holding `/*`
 * or `//` never blanks real code. Line numbers survive the blanking.
 *
 * Drizzle query-builder writes (`db.insert(table)`) are not raw SQL and are
 * not counted. Neither is a dynamic name (`INSERT INTO ${table}`): it cannot
 * be resolved statically. That is the known blind spot of a text scan and an
 * explicit follow-up (T12332 round 2).
 *
 * ## Non-sync writers are exempt per (file, table), with a reason
 *
 * Only a write to a table that SYNCS has to reach the change journal
 * (T12343). A raw write to a `local-only`, `derived` or `frozen-legacy`
 * table (a schema stamp, a lease, a queue, an FTS5 index, a dropped twin) is
 * exempt in {@link EXEMPT}, keyed by (file, table) with the exact site count
 * and the reason. Never by class or by whole file: a file that later adds a
 * write to a syncing table still fails. An entry EXPIRES, and the gate fails,
 * when its table's class becomes portable: the write then needs an accessor.
 * A count that moves either way fails too, until the entry is edited.
 *
 * ## Staged-snapshot sites are marked per site
 *
 * A few writers reach STAGED backup snapshots through file paths, never the
 * live store (`credential-transfer.ts` redaction). Such a site stays raw. It
 * carries the inline marker `// gate-28: staged-snapshot <function>` on the
 * write's line or within the {@link MARKER_REACH} lines above it, naming the
 * enclosing function, and an entry in {@link STAGED_SNAPSHOT} keyed by
 * (file, table, function). A marker with no entry, an entry with no marker,
 * or a marker naming the wrong function fails.
 *
 * Everything else (the sync-class sites) is the baselined ratchet above.
 *
 * ## The chokepoint is not an offender
 *
 * The chokepoint is `openDualScopeDb` and the canonical accessors built on
 * it: the modules implementing the `@cleocode/contracts` accessor interfaces
 * ({@link SANCTIONED}). Their raw SQL IS the sanctioned write path, so they
 * are exempt rather than baselined. A sanctioned path that no longer exists
 * fails the gate, so the exemption cannot go stale. Files that only carry SQL
 * words in prose are listed in {@link PROSE_ONLY} with the reason. Migration
 * `.sql` files are DDL history, not runtime writers, and are not scanned.
 *
 * ## Drizzle builder writes (report only)
 *
 * `--drizzle-report` lists Drizzle builder writes (`db.insert(t)`,
 * `.update(t)`, `.delete(t)`) whose table binding is declared on a syncing
 * table, outside the sanctioned files. The binding is resolved by name from
 * the schema modules, so it is a heuristic: it is reported, never gated
 * (journal spec §4.6; it becomes a ratchet after wave W1).
 *
 * ## REPLACE conflict resolution is banned (T12787 · zero tolerance)
 *
 * Separately from the ratchet, every `INSERT OR REPLACE INTO t`,
 * `REPLACE INTO t`, `UPDATE OR REPLACE t` and DDL `ON CONFLICT REPLACE`
 * constraint in scanned source (the SANCTIONED chokepoint included)
 * FAILS, in every mode. REPLACE resolves a conflict by DELETING the existing
 * row and inserting a new one; with `foreign_keys=ON` SQLite runs the ON
 * DELETE action of every FK referencing the deleted row — `CASCADE` deletes
 * the children, `SET NULL` / `SET DEFAULT` detaches them — even though the
 * "same" row is re-inserted a moment later. Write an UPSERT instead:
 * `INSERT … ON CONFLICT(<key>) DO UPDATE SET c = excluded.c` (for an
 * `INSERT … SELECT` source add `WHERE true` before `ON CONFLICT`).
 *
 * A site whose target provably is not such a parent (a `vec0` virtual table,
 * which rejects UPSERT) opts out with `// replace-allowed: <reason>` on the
 * same line or the line above. The opt-out is REFUSED when the statically
 * named target is the parent of an `ON DELETE CASCADE | SET NULL | SET
 * DEFAULT` foreign key declared in any migration `.sql` or scanned source
 * ({@link fkActionParents}). A dynamic target (`${table}`) can never be
 * proven safe, so it must be an UPSERT.
 *
 * Modes:
 *   (default) / --check   fail on a new offender, an un-dropped removal, or
 *                         an exemption / marker that no longer holds
 *   --update-baseline     regenerate after a deliberate change
 *   --strict              zero tolerance: fail on ANY raw write site that is
 *                         not exempt or marked
 *   --drizzle-report      also list the Drizzle builder writes (report only)
 *
 * @task T12332
 * @task T12343
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BASELINE = resolve(REPO_ROOT, 'scripts/.lint-no-raw-table-writes-baseline.json');
const REGISTRY = resolve(REPO_ROOT, 'packages/core/src/store/table-classification.ts');

/**
 * The chokepoint: `openDualScopeDb`, the writer lease, and the canonical
 * accessors built on them (the modules implementing the `@cleocode/contracts`
 * accessor interfaces: `DataAccessor`, the role sub-accessors, the agent
 * registry, brain, docs, memory, safety and service-connection accessors).
 * These ARE the sanctioned write path.
 */
export const SANCTIONED = new Set([
  'packages/core/src/store/dual-scope-db.ts',
  'packages/core/src/store/writer-lease.ts',
  'packages/core/src/store/agent-registry-accessor.ts',
  'packages/core/src/store/brain-accessor-impl.ts',
  'packages/core/src/store/data-accessor.ts',
  'packages/core/src/store/docs-accessor-impl.ts',
  'packages/core/src/store/memory-accessor.ts',
  'packages/core/src/store/role-accessors-impl.ts',
  'packages/core/src/store/safety-data-accessor.ts',
  'packages/core/src/store/service-connections-accessor.ts',
  'packages/core/src/store/sqlite-data-accessor.ts',
  'packages/core/src/store/umbrella-data-accessor.ts',
  // T12535: the atomic twin collapses. They run on the chokepoint handle
  // inside the tasks/brain domain bind (before any accessor exists for that
  // bind), and the accessors import the modules that call them, so the merge
  // SQL cannot live in an accessor without an import cycle.
  'packages/core/src/store/twin-collapse.ts',
]);

/** Files whose SQL words are prose only, never executed. File → reason. */
export const PROSE_ONLY = new Map([
  [
    'packages/contracts/src/dispatch/operations-registry.ts',
    'operation descriptions ("INSERT/UPDATE releases row …"); the contracts package opens no database',
  ],
]);

const SCHEMA_STAMP = 'schema-version stamp for this store file (local-only); never synced';
const MIGRATION_JOURNAL =
  'migration journal (local-only): which migrations THIS store applied; never synced';
const NEXUS_META =
  'nexus graph state (local-only): index stamps for this checkout, rebuilt by `cleo nexus analyze`';
const DERIVER_QUEUE = 'deriver work queue (local-only): per-device background queue';
const FTS5 = 'FTS5 index maintenance (derived): rebuilt from its base table, never synced';
const FROZEN = 'frozen bare twin (frozen-legacy): dropped by T12535; no reader';
const SYNC_BOOKKEEPING =
  'change journal bookkeeping (local-only): flags, clock and replica binding of THIS store file (T12342)';

/**
 * Raw writers of NON-SYNC tables, exempt per (file, table): file → table →
 * `{ count, reason }`. The count is exact. An entry whose table is portable
 * (and not `frozen-legacy`) in either scope has EXPIRED and fails the gate.
 * Keep entries sorted by file.
 */
export const EXEMPT = {
  'crates/cleo-supervisor/src/lease_handler.rs': {
    _writer_leases: {
      count: 2,
      reason: 'writer lease (local-only): a pid and a wall-clock expiry on this device',
    },
  },
  'packages/cleo/src/cli/commands/doctor.ts': { tasks: { count: 1, reason: FROZEN } },
  'packages/core/src/deriver/enqueue.ts': { deriver_queue: { count: 1, reason: DERIVER_QUEUE } },
  'packages/core/src/deriver/queue-manager.ts': {
    deriver_queue: { count: 5, reason: DERIVER_QUEUE },
  },
  'packages/core/src/doctor/knowledge.ts': { _nexus_meta: { count: 2, reason: NEXUS_META } },
  'packages/core/src/llm/catalog-seeder.ts': {
    __catalog_meta: {
      count: 1,
      reason: 'model catalog seed stamp (local-only): when THIS device last seeded models.dev',
    },
  },
  'packages/core/src/memory/brain-search.ts': {
    brain_decisions_fts: { count: 5, reason: FTS5 },
    brain_learnings_fts: { count: 5, reason: FTS5 },
    brain_observations_fts: { count: 5, reason: FTS5 },
    brain_patterns_fts: { count: 5, reason: FTS5 },
  },
  'packages/core/src/memory/decision-cross-link.ts': {
    _nexus_meta: { count: 1, reason: NEXUS_META },
  },
  'packages/core/src/nexus/analyze-orchestrator.ts': {
    _nexus_meta: { count: 4, reason: NEXUS_META },
    _nexus_parse_cache: {
      count: 3,
      reason: 'nexus parse cache (local-only): keyed by file stat on this checkout',
    },
    nexus_symbols_fts: { count: 1, reason: FTS5 },
  },
  'packages/core/src/nexus/assessment-store.ts': { _nexus_meta: { count: 3, reason: NEXUS_META } },
  'packages/core/src/nexus/graph-manifest.ts': { _nexus_meta: { count: 3, reason: NEXUS_META } },
  'packages/core/src/nexus/tasks-bridge.ts': { _nexus_meta: { count: 1, reason: NEXUS_META } },
  'packages/core/src/sentient/ingesters/nexus-ingester.ts': {
    nexus_schema_meta: { count: 2, reason: SCHEMA_STAMP },
  },
  'packages/core/src/store/agent-registry-store.ts': {
    _agent_registry_meta: { count: 1, reason: SCHEMA_STAMP },
  },
  'packages/core/src/store/background-jobs.ts': {
    background_jobs: {
      count: 2,
      reason: 'background job queue (local-only): pids and progress of jobs on this device',
    },
  },
  'packages/core/src/store/conduit-sqlite.ts': {
    _conduit_meta: { count: 1, reason: SCHEMA_STAMP },
  },
  'packages/core/src/store/exodus/migrate.ts': {
    tasks_schema_meta: { count: 1, reason: SCHEMA_STAMP },
  },
  'packages/core/src/store/exodus/recovery.ts': {
    _exodus_database_identity: {
      count: 1,
      reason: 'exodus recovery identity (local-only): names this store file during a migration',
    },
  },
  'packages/core/src/store/legacy-tasks-lineage.ts': {
    __drizzle_migrations: { count: 2, reason: MIGRATION_JOURNAL },
  },
  'packages/core/src/store/memory-sqlite.ts': {
    brain_schema_meta: { count: 1, reason: SCHEMA_STAMP },
  },
  'packages/core/src/store/migrate-signaldock-to-conduit.ts': {
    conduit_messages_fts: { count: 1, reason: FTS5 },
  },
  'packages/core/src/store/migration-manager.ts': {
    __drizzle_migrations: { count: 5, reason: MIGRATION_JOURNAL },
  },
  'packages/core/src/store/nexus-sqlite.ts': {
    nexus_schema_meta: { count: 1, reason: SCHEMA_STAMP },
    nexus_symbols_fts: { count: 5, reason: FTS5 },
  },
  'packages/core/src/store/snapshot-gate.ts': {
    tasks_schema_meta: { count: 1, reason: SCHEMA_STAMP },
  },
  'packages/core/src/store/sqlite.ts': { tasks_schema_meta: { count: 2, reason: SCHEMA_STAMP } },
  'packages/core/src/store/sync/clock-store.ts': {
    _sync_clock: { count: 1, reason: SYNC_BOOKKEEPING },
  },
  'packages/core/src/store/sync/flags.ts': { _sync_meta: { count: 1, reason: SYNC_BOOKKEEPING } },
  'packages/core/src/store/sync/replica.ts': {
    _sync_meta: { count: 2, reason: SYNC_BOOKKEEPING },
    _sync_replica: { count: 2, reason: SYNC_BOOKKEEPING },
  },
  'packages/core/src/store/sync/schema.ts': { _sync_meta: { count: 1, reason: SYNC_BOOKKEEPING } },
  'packages/core/src/store/sync/trigger-classes.ts': {
    cleo_trigger_suspend: {
      count: 3,
      reason:
        'trigger-suspension flag rows (local-only): inserted and deleted inside one frame transaction; step 0 clears a committed row (T12819)',
    },
  },
  'packages/core/src/tasks/backfill-child-projections.ts': {
    task_acceptance_criteria: { count: 2, reason: FROZEN },
    tasks: { count: 1, reason: FROZEN },
  },
  'packages/core/src/telemetry/sqlite.ts': {
    telemetry_schema_meta: { count: 1, reason: SCHEMA_STAMP },
  },
};

/** How many lines above a write its staged-snapshot marker may sit. */
export const MARKER_REACH = 3;

const MARKER_RE = /\/\/\s*gate-28:\s*staged-snapshot\s+([A-Za-z_$][\w$]*)/;

/**
 * Raw writes to STAGED backup snapshots (reached by file path, never the live
 * store), per site: file → table → function → `{ count, reason }`. Each site
 * also carries the inline marker `// gate-28: staged-snapshot <function>`.
 * A syncing table's LIVE-store write never goes here: it moves behind an
 * accessor (journal spec §4.6, wave W3).
 */
export const STAGED_SNAPSHOT = {
  'packages/core/src/store/credential-transfer.ts': {
    agent_registry_agents: {
      redactCredentialCiphertexts: {
        count: 1,
        reason:
          'blanks device-bound ciphertext in a staged backup snapshot; assertStagedCopy refuses a live store',
      },
    },
    service_connections: {
      redactCredentialCiphertexts: {
        count: 1,
        reason:
          'blanks device-bound ciphertext in a staged backup snapshot; assertStagedCopy refuses a live store',
      },
    },
    tasks_agent_credentials: {
      redactCredentialCiphertexts: {
        count: 1,
        reason:
          'blanks device-bound ciphertext in a staged backup snapshot; assertStagedCopy refuses a live store',
      },
    },
  },
};

const SCAN_GLOBS = ['*.ts', '*.tsx', '*.mjs', '*.js', '*.rs'];
const SCAN_SCOPE_DESCRIPTION =
  'packages/**, crates/** — *.ts, *.tsx, *.mjs, *.js, *.rs (excluding tests, dist/, .d.ts)';

/**
 * Every explicit registry entry, both scopes: physical name → one
 * `{ scope, class, status }` per scope that lists it.
 *
 * Parsed from the registry SOURCE (the `*_TABLES` object literals), so the
 * gate needs no build and covers a new classification the moment it lands.
 * An entry's own `class` and `status` come before its column overrides, so
 * the first match in the entry body is the table's.
 *
 * @param {string} source - `table-classification.ts` contents.
 * @returns {Map<string, Array<{ scope: string, class: string, status: string }>>}
 */
export function registryClasses(source) {
  const out = new Map();
  const blocks = source.matchAll(
    /const (PROJECT|GLOBAL)_TABLES: Readonly<Record<string, TableRegistryEntry>> = \{([\s\S]*?)\n\};/g,
  );
  for (const [, scope, body] of blocks) {
    for (const part of body.split(/^ {2}(?=(?:'[^']+'|[A-Za-z_$][\w$]*): \{)/m)) {
      const head = /^(?:'([^']+)'|([A-Za-z_$][\w$]*)): \{/.exec(part);
      if (!head) continue;
      const name = head[1] ?? head[2];
      const cls = /\bclass: '([^']+)'/.exec(part)?.[1];
      const status = /\bstatus: '([^']+)'/.exec(part)?.[1];
      if (!cls || !status) {
        throw new Error(`lint-no-raw-table-writes: registry entry ${name} has no class/status`);
      }
      if (!out.has(name)) out.set(name, []);
      out.get(name).push({ scope: scope.toLowerCase(), class: cls, status });
    }
  }
  if (out.size === 0) {
    throw new Error(
      `lint-no-raw-table-writes: parsed no tables from ${relative(REPO_ROOT, REGISTRY)}`,
    );
  }
  return out;
}

/**
 * Whether raw writes to a table must reach the change journal: its class is
 * portable in some scope, and it is not a frozen legacy twin.
 *
 * @param {Array<{ class: string, status: string }> | undefined} entries
 * @returns {boolean}
 */
export function isSyncTable(entries) {
  return (entries ?? []).some(
    (e) => e.class.startsWith('portable-') && e.status !== 'frozen-legacy',
  );
}

/** Keywords after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Blank comments with spaces, keeping newlines, so line numbers survive.
 *
 * A small lexer, not a regex: it skips string, template and regex literals
 * (and, for Rust, raw strings, char literals and NESTED block comments), so
 * `'/*'` inside a string or `/\/\*` inside a regex never swallows code.
 * String contents are kept verbatim: the SQL lives in them.
 *
 * @param {string} src - File contents.
 * @param {'js' | 'rs'} lang - Lexical rules to apply.
 * @returns {string} `src` with every comment character except `\n` blanked.
 */
export function stripComments(src, lang = 'js') {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Template-literal nesting: each entry is the brace depth of a `${` scope.
  const templates = [];
  let depth = 0;
  let prev = ''; // last significant (non-space) code char, for regex detection
  let prevWord = '';
  let i = 0;

  const skipQuoted = (q) => {
    // i is at the opening quote; returns the index after the closing one.
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') j += 2;
      else if (c === q) return j + 1;
      else if (c === '\n' && lang === 'js')
        return j; // unterminated: stop at EOL
      else j++;
    }
    return n;
  };

  /** Scan template text from i (inside backticks); stop after ` or at `${`. */
  const scanTemplate = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        return 'end';
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        templates.push(depth);
        return 'expr';
      } else i++;
    }
    return 'end';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      let nest = 1;
      while (j < n && nest > 0) {
        if (src[j] === '*' && src[j + 1] === '/') {
          nest--;
          j += 2;
        } else if (lang === 'rs' && src[j] === '/' && src[j + 1] === '*') {
          nest++;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (lang === 'rs') {
      const raw = /^b?r(#*)"/.exec(src.slice(i, i + 40));
      if (raw && !/[\w]/.test(src[i - 1] ?? '')) {
        const close = `"${raw[1]}`;
        const end = src.indexOf(close, i + raw[0].length);
        i = end < 0 ? n : end + close.length;
        prev = '"';
        continue;
      }
      if (c === '"') {
        i = skipQuoted('"');
        prev = '"';
        continue;
      }
      if (c === "'") {
        const ch = /^'(?:\\.[^']*|[^'\\])'/.exec(src.slice(i, i + 12));
        i += ch ? ch[0].length : 1; // otherwise a lifetime: plain code
        prev = "'";
        continue;
      }
    } else {
      if (c === '"' || c === "'") {
        i = skipQuoted(c);
        prev = c;
        prevWord = '';
        continue;
      }
      if (c === '`') {
        i++;
        if (scanTemplate() === 'end') prev = '`';
        else prev = '{';
        prevWord = '';
        continue;
      }
      if (c === '/') {
        const regexContext =
          prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord);
        if (regexContext) {
          let j = i + 1;
          let inClass = false;
          while (j < n && src[j] !== '\n') {
            const r = src[j];
            if (r === '\\') j += 2;
            else if (r === '/' && !inClass) break;
            else {
              if (r === '[') inClass = true;
              else if (r === ']') inClass = false;
              j++;
            }
          }
          i = j + 1;
          while (i < n && /[a-z]/i.test(src[i])) i++;
          prev = '/';
          prevWord = '';
          continue;
        }
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop();
          i++;
          if (scanTemplate() === 'end') prev = '`';
          else prev = '{';
          continue;
        }
        depth--;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = '';
    }
    i++;
  }
  return out.join('');
}

function sourceFiles({ includeSanctioned = false } = {}) {
  const out = execFileSync('git', ['ls-files', ...SCAN_GLOBS], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => /^(packages|crates)\//.test(f))
    .filter((f) => !/(^|\/)(__tests__|__fixtures__|tests|test|dist|target|node_modules)\//.test(f))
    .filter((f) => !/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f))
    .filter((f) => !f.endsWith('.d.ts'))
    .filter((f) => (includeSanctioned || !SANCTIONED.has(f)) && !PROSE_ONLY.has(f));
}

/**
 * A write keyword and the table it names. Case-insensitive; `\s+` spans
 * newlines, so a multi-line statement matches. The name is captured whole
 * (`\w*` is greedy), so `tasks` never matches inside `tasks_tasks`.
 */
const WRITE_RE =
  /\b(?:insert(?:\s+or\s+[a-z]+)?\s+into|replace\s+into|update(?:\s+or\s+[a-z]+)?|delete\s+from)\s+[`"'[]?(?:[a-z_]\w*[`"'\]]?\.[`"'[]?)?([a-z_]\w*)/gi;

/**
 * Every write site in comment-stripped code, with its 1-based line (the line
 * of the write keyword).
 *
 * @param {string} code - Output of {@link stripComments}.
 * @param {Set<string>} tables - Classified physical table names.
 * @returns {Array<{ line: number, table: string }>}
 */
export function writeSites(code, tables) {
  const hits = [];
  for (const m of code.matchAll(WRITE_RE)) {
    const table = m[1].toLowerCase();
    if (!tables.has(table)) continue;
    let line = 1;
    for (let k = 0; k < m.index; k++) if (code.charCodeAt(k) === 10) line++;
    hits.push({ line, table });
  }
  return hits;
}

/**
 * Staged-snapshot markers that are real comments: the marker text is in the
 * source and blanked in the comment-stripped code (a marker inside a string
 * is not a marker).
 *
 * @param {string} src - File contents.
 * @param {string} code - `src` after {@link stripComments}.
 * @returns {Array<{ line: number, fn: string }>}
 */
export function stagedMarkers(src, code) {
  const srcLines = src.split('\n');
  const codeLines = code.split('\n');
  const out = [];
  for (let i = 0; i < srcLines.length; i++) {
    const m = MARKER_RE.exec(srcLines[i]);
    if (!m) continue;
    if (codeLines[i].slice(m.index, m.index + m[0].length).trim() !== '') continue;
    out.push({ line: i + 1, fn: m[1] });
  }
  return out;
}

const FUNCTION_DECL =
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)|\bfn\s+([A-Za-z_][\w]*)\s*[<(]/g;

/**
 * The name of the nearest named function declared at or above `line` in
 * comment-stripped code (`function f`, `const f = (…) =>`, Rust `fn f`).
 * Anonymous callbacks are skipped, so a write inside `withDb(p, (db) => …)`
 * belongs to the named function around the callback.
 *
 * @param {string} code - Output of {@link stripComments}.
 * @param {number} line - 1-based line of the write.
 * @returns {string | undefined}
 */
export function enclosingFunction(code, line) {
  const head = code.split('\n').slice(0, line).join('\n');
  let name;
  for (const m of head.matchAll(FUNCTION_DECL)) name = m[1] ?? m[2] ?? m[3];
  return name;
}

/**
 * Bind each staged-snapshot marker to the first write site on its line or
 * within {@link MARKER_REACH} lines below it. A site takes at most one marker.
 *
 * @returns {{ sites: Array<object>, stray: Array<{ line: number, fn: string }> }}
 *   `sites` with `marker: { fn, enclosing }` set on the marked ones.
 */
export function bindMarkers(sites, markers, code) {
  const out = sites.map((s) => ({ ...s }));
  const stray = [];
  for (const mk of markers) {
    const site = out.find(
      (s) => !s.marker && s.line >= mk.line && s.line <= mk.line + MARKER_REACH,
    );
    if (!site) {
      stray.push(mk);
      continue;
    }
    site.marker = { fn: mk.fn, enclosing: enclosingFunction(code, site.line) };
  }
  return { sites: out, stray };
}

/**
 * Split findings into the baselined residue and the exempt / marked sites,
 * and check every exemption and marker still holds.
 *
 * @param {Array<{ file: string, line: number, table: string, marker?: { fn: string, enclosing?: string } }>} findings
 * @param {Map<string, Array<{ class: string, status: string }>>} classes - {@link registryClasses}.
 * @param {typeof EXEMPT} exempt
 * @param {typeof STAGED_SNAPSHOT} staged
 * @returns {{ residual: typeof findings, exemptSites: number, stagedSites: number, errors: string[] }}
 */
export function applyExemptions(findings, classes, exempt, staged) {
  const errors = [];
  const residual = [];
  const exemptSeen = {};
  const stagedSeen = {};
  let exemptSites = 0;
  let stagedSites = 0;

  for (const f of findings) {
    if (f.marker) {
      const entry = staged[f.file]?.[f.table]?.[f.marker.fn];
      if (!entry) {
        errors.push(
          `${f.file}:${f.line} [${f.table}]: staged-snapshot marker for ${f.marker.fn} has no STAGED_SNAPSHOT entry`,
        );
      } else if (f.marker.enclosing !== f.marker.fn) {
        errors.push(
          `${f.file}:${f.line} [${f.table}]: marker names ${f.marker.fn}, but the write is in ${f.marker.enclosing ?? '(no named function)'}`,
        );
      }
      const key = `${f.file}\0${f.table}\0${f.marker.fn}`;
      stagedSeen[key] = (stagedSeen[key] ?? 0) + 1;
      stagedSites++;
      continue;
    }
    if (exempt[f.file]?.[f.table]) {
      const key = `${f.file}\0${f.table}`;
      exemptSeen[key] = (exemptSeen[key] ?? 0) + 1;
      exemptSites++;
      continue;
    }
    residual.push(f);
  }

  for (const [file, tables] of Object.entries(exempt)) {
    for (const [table, { count, reason }] of Object.entries(tables)) {
      const entries = classes.get(table);
      if (!entries) {
        errors.push(`EXEMPT ${file} [${table}]: not a classified table; drop the entry`);
        continue;
      }
      if (isSyncTable(entries)) {
        const now = entries.map((e) => `${e.scope} ${e.class}`).join(', ');
        errors.push(
          `EXEMPT ${file} [${table}]: EXPIRED, the table now syncs (${now}). ` +
            'Move the write behind its accessor and drop the entry.',
        );
      }
      if (!reason || reason.trim() === '') errors.push(`EXEMPT ${file} [${table}]: no reason`);
      const seen = exemptSeen[`${file}\0${table}`] ?? 0;
      if (seen !== count) {
        errors.push(
          `EXEMPT ${file} [${table}]: ${count} site(s) exempt, ${seen} found. ` +
            (seen > count
              ? 'A new raw write: move it behind an accessor, or raise the count with a reviewed reason.'
              : 'Lower the count (drop the entry at 0) so the allowance cannot be reused.'),
        );
      }
    }
  }

  for (const [file, tables] of Object.entries(staged)) {
    for (const [table, fns] of Object.entries(tables)) {
      for (const [fn, { count, reason }] of Object.entries(fns)) {
        if (!reason || reason.trim() === '') {
          errors.push(`STAGED_SNAPSHOT ${file} [${table}] ${fn}: no reason`);
        }
        const seen = stagedSeen[`${file}\0${table}\0${fn}`] ?? 0;
        if (seen !== count) {
          errors.push(
            `STAGED_SNAPSHOT ${file} [${table}] ${fn}: ${count} marked site(s) expected, ${seen} found`,
          );
        }
      }
    }
  }

  return { residual, exemptSites, stagedSites, errors };
}

/**
 * `INSERT OR REPLACE INTO t` / `REPLACE INTO t` / `UPDATE OR REPLACE t` (an
 * UPDATE that hits a UNIQUE conflict deletes the OTHER row). The target is
 * captured as a name, or left undefined when it is dynamic (`${…}`) and
 * cannot be resolved.
 *
 * Known limit: the keywords must sit in one string literal. SQL assembled from
 * split strings (`'INSERT OR ' + mode + ' INTO t'`) is not seen — review that.
 */
const REPLACE_RE =
  /\b(?:insert\s+or\s+replace\s+into|update\s+or\s+replace|replace\s+into)\s+(?:[`"'[]?[a-z_]\w*[`"'\]]?\.)?(?:[`"'[]?([a-z_]\w*)|\$\{)/gi;

/**
 * DDL `ON CONFLICT REPLACE` on a column / table constraint: every plain
 * INSERT or UPDATE into that table then resolves conflicts by REPLACE. The
 * table is not resolved (reported `null`), so the opt-out is refused.
 * `INSERT … ON CONFLICT(x) DO …` (an UPSERT) does not match.
 */
const DDL_REPLACE_RE = /\bon\s+conflict\s+replace\b/gi;

/** Opt-out marker for a REPLACE whose target is not an FK-action parent. */
const REPLACE_ALLOWED_RE = /\/\/\s*replace-allowed:\s*\S/;

/**
 * Every REPLACE site in comment-stripped code.
 *
 * @param {string} code - Output of {@link stripComments}.
 * @returns {Array<{ line: number, table: string | null }>} `table` is lower-cased,
 *   or `null` for a dynamic target.
 */
export function replaceSites(code) {
  const hits = [];
  const lineOf = (index) => {
    let line = 1;
    for (let k = 0; k < index; k++) if (code.charCodeAt(k) === 10) line++;
    return line;
  };
  for (const m of code.matchAll(REPLACE_RE)) {
    hits.push({ line: lineOf(m.index), table: m[1] ? m[1].toLowerCase() : null });
  }
  for (const m of code.matchAll(DDL_REPLACE_RE)) {
    hits.push({ line: lineOf(m.index), table: null });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Whether a REPLACE site carries a `// replace-allowed: <reason>` opt-out on
 * its own line or the line above. Read from the RAW source: the marker is a
 * comment, which {@link stripComments} blanks.
 *
 * @param {string[]} rawLines - The unstripped file, split on newlines.
 * @param {number} line - 1-based line of the REPLACE keyword.
 * @returns {boolean}
 */
export function replaceAllowed(rawLines, line) {
  return [rawLines[line - 1], rawLines[line - 2]].some(
    (l) => l !== undefined && REPLACE_ALLOWED_RE.test(l),
  );
}

/**
 * Tables that are the PARENT of a foreign key whose ON DELETE action deletes
 * or rewrites child rows (`CASCADE`, `SET NULL`, `SET DEFAULT`): the tables a
 * REPLACE must never target.
 *
 * @param {string} sql - SQL text (a migration, or source holding DDL strings).
 * @returns {Set<string>} Lower-cased parent table names.
 */
export function fkActionParents(sql) {
  const parents = new Set();
  const re =
    /\breferences\s+[`"'[]?([a-z_]\w*)[`"'\]]?\s*(?:\([^)]*\))?((?:\s+(?:on\s+(?:update|delete)\s+(?:cascade|restrict|set\s+null|set\s+default|no\s+action)|match\s+\w+|(?:not\s+)?deferrable(?:\s+initially\s+\w+)?))*)/gi;
  for (const m of sql.matchAll(re)) {
    if (/on\s+delete\s+(?:cascade|set\s+null|set\s+default)/i.test(m[2] ?? '')) {
      parents.add(m[1].toLowerCase());
    }
  }
  return parents;
}

/** FK-action parents across every tracked migration `.sql` and the given sources. */
function repoFkActionParents(sources) {
  const sqlFiles = execFileSync('git', ['ls-files', '*.sql'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((f) => /^(packages|crates)\//.test(f));
  const parents = new Set();
  for (const text of [
    ...sqlFiles.map((f) => readFileSync(resolve(REPO_ROOT, f), 'utf-8')),
    ...sources,
  ]) {
    for (const p of fkActionParents(text)) parents.add(p);
  }
  return parents;
}

/**
 * Zero-tolerance REPLACE scan (T12787): every REPLACE site without an opt-out,
 * plus every opted-out site whose target is dynamic or an FK-action parent.
 *
 * @returns {Array<{ file: string, line: number, table: string | null, reason: string }>}
 */
export function scanReplace() {
  const files = sourceFiles({ includeSanctioned: true });
  const raw = new Map(files.map((f) => [f, readFileSync(resolve(REPO_ROOT, f), 'utf-8')]));
  const parents = repoFkActionParents([...raw.values()]);
  const violations = [];
  for (const [file, src] of raw) {
    const code = stripComments(src, file.endsWith('.rs') ? 'rs' : 'js');
    const rawLines = src.split('\n');
    for (const site of replaceSites(code)) {
      if (!replaceAllowed(rawLines, site.line)) {
        violations.push({ file, ...site, reason: 'REPLACE conflict resolution' });
      } else if (site.table === null) {
        violations.push({ file, ...site, reason: 'opt-out on a dynamic target' });
      } else if (parents.has(site.table)) {
        violations.push({ file, ...site, reason: 'opt-out on an ON DELETE action FK parent' });
      }
    }
  }
  return violations;
}

/** Print REPLACE violations; returns 1 when there are any. */
function reportReplace(violations) {
  if (violations.length === 0) return 0;
  console.error(
    `lint-no-raw-table-writes: FAIL — ${violations.length} REPLACE write(s) (T12787, zero tolerance):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.table ?? '<dynamic>'}]  ${v.reason}`);
  }
  console.error(
    '\nREPLACE deletes the conflicting row before re-inserting it, and with foreign keys\n' +
      'on SQLite runs every ON DELETE CASCADE / SET NULL that references it: the\n' +
      'children are deleted or detached. Use an UPSERT: INSERT … ON CONFLICT(<key>) DO\n' +
      'UPDATE SET c = excluded.c (add WHERE true after an INSERT … SELECT source). A\n' +
      'target proven not to be an FK parent may opt out: // replace-allowed: <reason>.\n',
  );
  return 1;
}

function scan() {
  const missing = [...SANCTIONED, ...PROSE_ONLY.keys()].filter(
    (f) => !existsSync(resolve(REPO_ROOT, f)),
  );
  if (missing.length > 0) {
    throw new Error(
      `lint-no-raw-table-writes: exempt path(s) no longer exist: ${missing.join(', ')}. ` +
        'Remove them from SANCTIONED / PROSE_ONLY.',
    );
  }
  const classes = registryClasses(readFileSync(REGISTRY, 'utf-8'));
  const tables = new Set(classes.keys());
  const findings = [];
  const stray = [];
  const sources = [];
  for (const file of sourceFiles()) {
    const lang = file.endsWith('.rs') ? 'rs' : 'js';
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
    const code = stripComments(src, lang);
    sources.push({ file, code });
    const bound = bindMarkers(writeSites(code, tables), stagedMarkers(src, code), code);
    for (const hit of bound.sites) findings.push({ file, ...hit });
    for (const mk of bound.stray) stray.push({ file, ...mk });
  }
  return { findings, stray, classes, sources };
}

/**
 * Drizzle builder writes on a binding declared for a syncing table, outside
 * the sanctioned files: `db.insert(x)`, `.update(x)`, `.delete(x)`. The
 * binding → table map comes from `sqliteTable('name', …)` declarations, by
 * name, so this is a heuristic REPORT, never a gate.
 *
 * @param {Array<{ file: string, code: string }>} sources - Scanned files.
 * @param {Map<string, Array<{ class: string, status: string }>>} classes
 * @returns {Array<{ file: string, line: number, binding: string, tables: string[] }>}
 */
export function drizzleWrites(sources, classes) {
  const decl = execFileSync('git', ['ls-files', 'packages/*/src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((f) => f && !/(^|\/)__tests__\//.test(f));
  const bindings = new Map();
  for (const f of decl) {
    const src = readFileSync(resolve(REPO_ROOT, f), 'utf-8');
    if (!src.includes('sqliteTable(')) continue;
    for (const m of src.matchAll(
      /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*sqliteTable\(\s*['"]([a-z_]\w*)['"]/g,
    )) {
      if (!bindings.has(m[1])) bindings.set(m[1], new Set());
      bindings.get(m[1]).add(m[2]);
    }
  }
  const out = [];
  for (const { file, code } of sources) {
    for (const m of code.matchAll(
      /\.(?:insert|update|delete)\(\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\)/g,
    )) {
      const names = [...(bindings.get(m[1]) ?? [])].filter((t) => isSyncTable(classes.get(t)));
      if (names.length === 0) continue;
      let line = 1;
      for (let k = 0; k < m.index; k++) if (code.charCodeAt(k) === 10) line++;
      out.push({ file, line, binding: m[1], tables: names.sort() });
    }
  }
  return out;
}

/** (file → table → count), sorted for a stable baseline diff. */
function countByFile(findings) {
  const byFile = {};
  for (const f of findings) {
    byFile[f.file] ??= {};
    byFile[f.file][f.table] = (byFile[f.file][f.table] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(byFile)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, t]) => [
        file,
        Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const scanned = scan();
  const { residual, exemptSites, stagedSites, errors } = applyExemptions(
    scanned.findings,
    scanned.classes,
    EXEMPT,
    STAGED_SNAPSHOT,
  );
  for (const mk of scanned.stray) {
    errors.push(
      `${mk.file}:${mk.line}: staged-snapshot marker (${mk.fn}) sits over no raw write within ${MARKER_REACH} lines`,
    );
  }
  const findings = residual;
  const counts = countByFile(findings);
  const fileCount = Object.keys(counts).length;
  const exemptLine = `  exempt: ${exemptSites} non-sync site(s) (EXEMPT), ${stagedSites} staged-snapshot site(s) (STAGED_SNAPSHOT)`;

  if (args.has('--drizzle-report')) {
    const writes = drizzleWrites(scanned.sources, scanned.classes);
    console.log(
      `lint-no-raw-table-writes: REPORT — ${writes.length} Drizzle builder write(s) on syncing tables outside the sanctioned files (heuristic; not gated):`,
    );
    for (const w of writes)
      console.log(`    ${w.file}:${w.line}  ${w.binding} → ${w.tables.join(', ')}`);
  }

  if (errors.length > 0) {
    console.error(
      `lint-no-raw-table-writes: FAIL — ${errors.length} exemption / marker problem(s):\n`,
    );
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      '\nNon-sync raw writers are exempt per (file, table) in EXEMPT; staged-snapshot sites are\n' +
        'marked `// gate-28: staged-snapshot <function>` and listed in STAGED_SNAPSHOT. A write to a\n' +
        'syncing table needs an accessor, never an exemption (journal spec §4.6).\n',
    );
    return 1;
  }

  if (args.has('--update-baseline')) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          note:
            'Raw SQL writes on SYNCING cleo.db tables outside the sanctioned accessor (T12332, T12343). ' +
            'Non-sync writers are exempt per (file, table) in the script, not here. ' +
            'Counts may only DECREASE, and a decrease must be recorded here. Regenerate with: ' +
            'node scripts/lint-no-raw-table-writes.mjs --update-baseline',
          totalFindings: findings.length,
          files: fileCount,
          counts,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    console.log(
      `lint-no-raw-table-writes: baseline written — ${findings.length} raw write site(s) across ${fileCount} file(s).\n${exemptLine}`,
    );
    return 0;
  }

  const replaceFailed = reportReplace(scanReplace());

  if (args.has('--strict')) {
    if (replaceFailed) return 1;
    if (findings.length === 0) {
      console.log(
        `lint-no-raw-table-writes: STRICT OK — no raw write on a syncing table.\n${exemptLine}`,
      );
      return 0;
    }
    console.error(`lint-no-raw-table-writes: STRICT FAIL — ${findings.length} raw write site(s).`);
    for (const f of findings) console.error(`    ${f.file}:${f.line}  ${f.table}`);
    return 1;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
  } catch {
    console.error(
      `lint-no-raw-table-writes: no baseline at ${relative(REPO_ROOT, BASELINE)}.\n` +
        '  Create it with: node scripts/lint-no-raw-table-writes.mjs --update-baseline',
    );
    return 1;
  }
  const base = baseline.counts ?? {};

  const added = [];
  const removed = [];
  for (const [file, tables] of Object.entries(counts)) {
    for (const [table, now] of Object.entries(tables)) {
      const was = base[file]?.[table] ?? 0;
      if (now > was) added.push({ file, table, was, now });
    }
  }
  for (const [file, tables] of Object.entries(base)) {
    for (const [table, was] of Object.entries(tables)) {
      const now = counts[file]?.[table] ?? 0;
      if (now < was) removed.push({ file, table, was, now });
    }
  }

  if (added.length === 0 && removed.length === 0) {
    if (replaceFailed) return 1;
    console.log(
      `lint-no-raw-table-writes: OK — ${findings.length} baselined raw write site(s) in ${fileCount} file(s), no new offender.\n` +
        `${exemptLine}\n` +
        `  scanned: ${SCAN_SCOPE_DESCRIPTION}`,
    );
    return 0;
  }

  if (added.length > 0) {
    console.error(
      `lint-no-raw-table-writes: FAIL — ${added.length} new raw write(s) on a classified cleo.db table:\n`,
    );
    for (const r of added) {
      console.error(`  ${r.file}  [${r.table}]: ${r.was} -> ${r.now}`);
      for (const f of findings.filter((x) => x.file === r.file && x.table === r.table)) {
        console.error(`    ${f.file}:${f.line}`);
      }
    }
    console.error(
      '\nMove the write into the canonical accessor for that table (the modules in\n' +
        'SANCTIONED: sqlite-data-accessor for tasks, agent-registry-accessor, brain /\n' +
        'docs / memory / role accessors, …), which write through openDualScopeDb. A raw\n' +
        'write anywhere else bypasses the chokepoint that replication captures, so the\n' +
        'change would never reach another device (Gate A, T12332).\n',
    );
  }
  if (removed.length > 0) {
    console.error(
      `lint-no-raw-table-writes: FAIL — ${removed.length} baselined raw write(s) are gone but still allowed by the baseline:\n`,
    );
    for (const r of removed) console.error(`  ${r.file}  [${r.table}]: ${r.was} -> ${r.now}`);
    console.error(
      '\nGood — now drop them so the allowance cannot be reused:\n' +
        '  node scripts/lint-no-raw-table-writes.mjs --update-baseline\n',
    );
  }
  return 1;
}

if (isMain(import.meta.url)) process.exit(main());
