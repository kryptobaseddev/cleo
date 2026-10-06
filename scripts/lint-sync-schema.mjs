#!/usr/bin/env node

/**
 * Gate 36: change-journal schema rules (T12819 · T12827 · T12786 · T12797).
 *
 * Journal spec `t12342-t12343-journal-design` §2.3a rules 2–4 and 8, §3.5
 * Rule 4. Zero tolerance; there is no baseline.
 *
 * Source rules (every non-test `*.ts`, `*.mjs`, `*.js`, `*.rs` under
 * `packages/` and `crates/`, plus every migration `.sql`):
 *
 *   1. Nothing drops `cleo_trigger_suspend`. The table is schema-owned and the
 *      owned guard and side-effect triggers read it (C2).
 *   2. Only `packages/core/src/store/sync/machinery.ts` (`dropSyncMachinery`)
 *      may drop a `_sync_*` table (rule 4).
 *   3. No migration SQL mentions `_sync_cap_`: capture triggers are owned by
 *      the open pass, never by a migration (rule 8).
 *
 * Forward-only migration rules (D4): they apply to migration files whose
 * folder timestamp is at or after the WHEN-clause migration
 * (`20260930170000_t12819-trigger-suspend-clause`). Released files are never
 * edited, so older files are never linted for rules they predate.
 *
 *   4. Every `CREATE TRIGGER` of an owned guard or side-effect trigger
 *      (`OWNED_TRIGGERS` in `store/sync/trigger-classes.ts`) carries the
 *      suspension clause for its class.
 *   5. Determinism (NEW-8): a migration DML statement (INSERT / UPDATE /
 *      DELETE / REPLACE) may not call `datetime('now')`, `CURRENT_TIMESTAMP`,
 *      `random()`, `randomblob()` or another non-deterministic function.
 *      Every replica runs the backfill itself and must get the same values.
 *      DDL defaults and trigger bodies are exempt.
 *   6. A file that rebuilds a table (runs with foreign keys OFF) may not
 *      DELETE from a foreign-key parent or UPDATE a referenced parent key:
 *      nothing cascades there (R5-4).
 *
 * Release rule:
 *
 *   7. A migration file present on the base ref is byte-identical in the
 *      working tree (#1719: an edited released file changes its hash, and
 *      `E_MIGRATION_HASH_DRIFT` refuses every store that applied it). The base
 *      is `--base <ref>`, else `origin/$GITHUB_BASE_REF`, else `origin/main`;
 *      when no base ref resolves the rule is skipped and says so. "Released"
 *      means present at the merge-base of HEAD and the base (T13294): a
 *      migration that landed on the base after the branch was cut is not on
 *      the branch yet, which is no deletion. Without the history to find a
 *      merge-base (a shallow clone) the base tip is used, and the gate says so.
 *
 * Usage: node scripts/lint-sync-schema.mjs [--check|--strict] [--base <ref>]
 *
 * @task T12819
 * @task T12827
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MIGRATIONS = join(REPO_ROOT, 'packages/core/migrations');
const TRIGGER_CLASSES = join(REPO_ROOT, 'packages/core/src/store/sync/trigger-classes.ts');
const MACHINERY = 'packages/core/src/store/sync/machinery.ts';

/** The first migration the forward-only rules apply to. */
export const FORWARD_FROM = '20260930170000_t12819-trigger-suspend-clause';

const SCAN_GLOBS = ['*.ts', '*.tsx', '*.mjs', '*.js', '*.rs', '*.sql'];

/** `OWNED_TRIGGERS` parsed from the classes module SOURCE (no build needed). */
export function ownedTriggers(source) {
  const block = /export const OWNED_TRIGGERS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!block) throw new Error('lint-sync-schema: OWNED_TRIGGERS not found');
  const out = new Map();
  for (const m of block[1].matchAll(/^\s*(\w+):\s*'(guard|side-effect)'/gm)) out.set(m[1], m[2]);
  if (out.size === 0) throw new Error('lint-sync-schema: OWNED_TRIGGERS is empty');
  return out;
}

/** The suspension clause for a class, whitespace-normalized. */
export function clauseFor(cls) {
  return `NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('${cls}', 'all'))`;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Strip `--` line comments and block comments (SQL). */
export function stripSqlComments(sql) {
  return sql
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Blank `//` and block comments in JS/TS/Rust, keeping strings (approximate). */
function stripCodeComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Rules 1–3 on one file's text. */
export function sourceViolations(file, text) {
  const isSql = file.endsWith('.sql');
  const code = isSql ? stripSqlComments(text) : stripCodeComments(text);
  const out = [];
  for (const m of code.matchAll(
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"'[]?(?:main\.)?[`"'[]?cleo_trigger_suspend\b/gi,
  )) {
    out.push({
      file,
      line: lineOf(code, m.index),
      rule: 1,
      message: 'drops cleo_trigger_suspend (schema-owned, never dropped)',
    });
  }
  if (file !== MACHINERY) {
    for (const m of code.matchAll(
      /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"'[]?(?:main\.)?[`"'[]?_sync_\w*/gi,
    )) {
      out.push({
        file,
        line: lineOf(code, m.index),
        rule: 2,
        message: 'drops a _sync_* table outside dropSyncMachinery',
      });
    }
  }
  if (isSql && file.includes('/migrations/')) {
    for (const m of code.matchAll(/_sync_cap_/g)) {
      out.push({
        file,
        line: lineOf(code, m.index),
        rule: 3,
        message: 'migration SQL mentions _sync_cap_ (capture triggers belong to the open pass)',
      });
    }
  }
  return out;
}

/** Split migration text into statements (drizzle breakpoint), comments stripped. */
function statements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => stripSqlComments(s).trim())
    .filter(Boolean);
}

const NON_DETERMINISTIC =
  /\b(?:random|randomblob)\s*\(|'now'|"now"|\bCURRENT_(?:TIMESTAMP|DATE|TIME)\b|\bunixepoch\s*\(\s*\)/i;

/** Tables that are the parent of some foreign key, with the referenced columns. */
export function fkParents(allSql) {
  const out = new Map();
  for (const m of allSql.matchAll(/\bREFERENCES\s+[`"[]?(\w+)[`"\]]?\s*(?:\(([^)]*)\))?/gi)) {
    const t = m[1].toLowerCase();
    if (!out.has(t)) out.set(t, new Set());
    for (const c of (m[2] ?? 'id').split(','))
      out.get(t).add(c.replace(/[`"[\]\s]/g, '').toLowerCase());
  }
  return out;
}

/** Rules 4–6 on one forward migration file. */
export function migrationViolations(file, sql, owned, parents) {
  const out = [];
  const stmts = statements(sql);
  const rebuild = stmts.some((s) =>
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?__new_|\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b|\bDROP\s+TABLE\b/i.test(
      s,
    ),
  );
  for (const s of stmts) {
    const trig = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)/i.exec(s);
    if (trig) {
      const cls = owned.get(trig[1]);
      if (cls && !norm(s).includes(norm(clauseFor(cls)))) {
        out.push({
          file,
          rule: 4,
          message: `owned ${cls} trigger ${trig[1]} lacks its suspension clause`,
        });
      }
      continue; // trigger bodies run at write time, not as a backfill
    }
    if (/^(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(s) && NON_DETERMINISTIC.test(s)) {
      out.push({
        file,
        rule: 5,
        message: `non-deterministic function in migration DML: ${s.slice(0, 80)}`,
      });
    }
    if (rebuild) {
      const del = /^DELETE\s+FROM\s+[`"[]?(\w+)/i.exec(s);
      if (del && parents.has(del[1].toLowerCase())) {
        out.push({
          file,
          rule: 6,
          message: `rebuild file deletes from FK parent ${del[1]} (foreign keys are OFF: nothing cascades; delete the children explicitly)`,
        });
      }
      const upd =
        /^UPDATE\s+(?:OR\s+\w+\s+)?[`"[]?(\w+)[`"\]]?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(s);
      if (upd && parents.has(upd[1].toLowerCase())) {
        const keys = parents.get(upd[1].toLowerCase());
        const assigned = [...upd[2].matchAll(/[`"[]?(\w+)[`"\]]?\s*=/g)].map((m) =>
          m[1].toLowerCase(),
        );
        const hit = assigned.filter((c) => keys.has(c));
        if (hit.length > 0) {
          out.push({
            file,
            rule: 6,
            message: `rebuild file updates referenced key ${upd[1]}.${hit.join(',')} (ON UPDATE CASCADE is off; update the children explicitly)`,
          });
        }
      }
    }
  }
  return out;
}

function gitLsFiles() {
  return execFileSync('git', ['ls-files', ...SCAN_GLOBS], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => /^(packages|crates)\//.test(f))
    .filter((f) => !/(^|\/)(__tests__|__fixtures__|tests|test|dist|target|node_modules)\//.test(f))
    .filter((f) => !/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f))
    .filter((f) => !f.endsWith('.d.ts'));
}

/** Every migration.sql: { rel, folder, name }. */
function migrationFiles() {
  const out = [];
  for (const set of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (!set.isDirectory()) continue;
    for (const m of readdirSync(join(MIGRATIONS, set.name), { withFileTypes: true })) {
      if (!m.isDirectory()) continue;
      const abs = join(MIGRATIONS, set.name, m.name, 'migration.sql');
      try {
        readFileSync(abs);
      } catch {
        continue;
      }
      out.push({ abs, rel: relative(REPO_ROOT, abs), name: m.name });
    }
  }
  return out;
}

function resolveBase(args) {
  const i = args.indexOf('--base');
  const candidates = [];
  if (i >= 0 && args[i + 1]) candidates.push(args[i + 1]);
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main');
  for (const ref of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      return ref;
    } catch {
      // try the next
    }
  }
  return null;
}

/**
 * The commit rule 7 compares with (T13294): the merge-base of HEAD and `base`,
 * so a migration the base gained after the branch was cut is not counted as
 * deleted. `null` when git cannot find one (a shallow clone without the shared
 * history); the caller then falls back to the base tip.
 */
export function releaseCommit(base, root = REPO_ROOT) {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', base], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Rule 7: released migration files unchanged against `base` (a commit-ish). */
export function releasedFileEdits(base, files, root = REPO_ROOT) {
  const tracked = new Set(
    execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', 'packages/core/migrations'], {
      cwd: root,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((f) => f.endsWith('/migration.sql')),
  );
  const out = [];
  for (const f of files) {
    if (!tracked.has(f.rel)) continue;
    const was = execFileSync('git', ['show', `${base}:${f.rel}`], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 64 << 20,
    });
    if (!was.equals(readFileSync(f.abs))) {
      out.push({
        file: f.rel,
        rule: 7,
        message: `released migration edited (vs ${base}); add a new migration instead`,
      });
    }
  }
  // A released file deleted from the tree is an edit too.
  const present = new Set(files.map((f) => f.rel));
  for (const f of tracked) {
    if (!present.has(f))
      out.push({ file: f, rule: 7, message: `released migration deleted (vs ${base})` });
  }
  return out;
}

/**
 * Rule 7 as the gate runs it: against the merge-base of HEAD and `base`, else
 * (no shared history) the base tip. Returns the violations and the OK note.
 */
export function releaseCheck(base, files, root = REPO_ROOT) {
  const at = releaseCommit(base, root);
  return {
    violations: releasedFileEdits(at ?? base, files, root),
    note: at
      ? `released files unchanged vs the merge-base ${at.slice(0, 12)} of HEAD and ${base}`
      : `released files unchanged vs ${base} (no merge-base: shallow clone? compared with the base tip)`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const owned = ownedTriggers(readFileSync(TRIGGER_CLASSES, 'utf8'));
  const violations = [];

  for (const f of gitLsFiles()) {
    violations.push(...sourceViolations(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
  }

  const files = migrationFiles();
  const allSql = files.map((f) => stripSqlComments(readFileSync(f.abs, 'utf8'))).join('\n');
  const parents = fkParents(allSql);
  let forward = 0;
  for (const f of files) {
    if (f.name < FORWARD_FROM) continue;
    forward++;
    violations.push(...migrationViolations(f.rel, readFileSync(f.abs, 'utf8'), owned, parents));
  }

  const base = resolveBase(args);
  let releaseNote;
  if (base) {
    const release = releaseCheck(base, files);
    violations.push(...release.violations);
    releaseNote = release.note;
  } else {
    releaseNote = 'rule 7 SKIPPED: no base ref (pass --base <ref> or fetch origin/main)';
  }

  if (violations.length > 0) {
    console.error(`lint-sync-schema: FAIL — ${violations.length} violation(s):\n`);
    for (const v of violations)
      console.error(`  [rule ${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}  ${v.message}`);
    console.error(
      '\nSee the header of scripts/lint-sync-schema.mjs and journal spec §2.3a / §3.5 Rule 4.\n',
    );
    return 1;
  }
  console.log(
    `lint-sync-schema: OK — ${owned.size} owned triggers; ${forward} forward migration file(s) checked; ${releaseNote}.`,
  );
  if (!base && args.includes('--strict')) return 1;
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
