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
 * A line of non-test source (`*.ts`, `*.tsx`, `*.mjs`, `*.js`, `*.rs` under
 * `packages/` and `crates/`) carrying an upper-case SQL write keyword directly
 * followed by a classified table name, optionally schema-qualified:
 *
 *   INSERT [OR …] INTO t · REPLACE INTO t · UPDATE [OR …] t · DELETE FROM t
 *
 * Comments are blanked first, keeping line numbers. Drizzle query-builder
 * writes (`db.insert(table)`) are not raw SQL and are not counted. Neither is
 * a dynamic name (`INSERT INTO ${table}`), because it cannot be resolved
 * statically. That is the known blind spot of a text scan.
 *
 * The sanctioned chokepoint modules themselves are exempt (see
 * {@link SANCTIONED}). Migration `.sql` files are DDL history, not runtime
 * writers, and are not scanned.
 *
 * Modes:
 *   (default) / --check   fail on a new offender or an un-dropped removal
 *   --update-baseline     regenerate after a deliberate change
 *   --strict              zero tolerance: fail on ANY raw write site
 *
 * @task T12332
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BASELINE = resolve(REPO_ROOT, 'scripts/.lint-no-raw-table-writes-baseline.json');
const REGISTRY = resolve(REPO_ROOT, 'packages/core/src/store/table-classification.ts');

/** The chokepoint modules that ARE the sanctioned write path. */
const SANCTIONED = new Set([
  'packages/core/src/store/dual-scope-db.ts',
  'packages/core/src/store/writer-lease.ts',
]);

const SCAN_GLOBS = ['*.ts', '*.tsx', '*.mjs', '*.js', '*.rs'];
const SCAN_SCOPE_DESCRIPTION =
  'packages/**, crates/** — *.ts, *.tsx, *.mjs, *.js, *.rs (excluding tests, dist/, .d.ts)';

/**
 * Physical table names classified in the registry, both scopes.
 *
 * Parsed from the registry SOURCE (the `*_TABLES` object literals), so the
 * gate needs no build and covers a new classification the moment it lands.
 */
function registryTables(source) {
  const names = new Set();
  const blocks = source.matchAll(
    /const (?:PROJECT|GLOBAL)_TABLES: Readonly<Record<string, TableRegistryEntry>> = \{([\s\S]*?)\n\};/g,
  );
  for (const [, body] of blocks) {
    for (const m of body.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z_$][\w$]*)): \{/gm)) {
      names.add(m[1] ?? m[2]);
    }
  }
  if (names.size === 0) {
    throw new Error(
      `lint-no-raw-table-writes: parsed no tables from ${relative(REPO_ROOT, REGISTRY)}`,
    );
  }
  return names;
}

/** Blank comments with equal-length whitespace so line numbers survive. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);
}

function sourceFiles() {
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
    .filter((f) => !SANCTIONED.has(f));
}

/**
 * Write sites on one line: every (table) named right after a write keyword.
 * The table name must be followed by a non-identifier character, so `tasks`
 * never matches inside `tasks_tasks`.
 */
const WRITE_RE =
  /\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+[A-Z]+)?|DELETE\s+FROM)\s+[`"'[]?(?:[A-Za-z_]\w*[`"'\]]?\.[`"'[]?)?([A-Za-z_]\w*)/g;

function writeSites(code, tables) {
  const hits = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(WRITE_RE)) {
      if (tables.has(m[1])) hits.push({ line: i + 1, table: m[1] });
    }
  }
  return hits;
}

function scan() {
  const tables = registryTables(readFileSync(REGISTRY, 'utf-8'));
  const findings = [];
  for (const file of sourceFiles()) {
    const code = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf-8'));
    for (const hit of writeSites(code, tables)) findings.push({ file, ...hit });
  }
  return findings;
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
  const findings = scan();
  const counts = countByFile(findings);
  const fileCount = Object.keys(counts).length;

  if (args.has('--update-baseline')) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          note:
            'Raw SQL writes on classified cleo.db tables outside the sanctioned accessor (T12332). ' +
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
      `lint-no-raw-table-writes: baseline written — ${findings.length} raw write site(s) across ${fileCount} file(s).`,
    );
    return 0;
  }

  if (args.has('--strict')) {
    if (findings.length === 0) {
      console.log('lint-no-raw-table-writes: STRICT OK — no raw write on a classified table.');
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
    console.log(
      `lint-no-raw-table-writes: OK — ${findings.length} baselined raw write site(s) in ${fileCount} file(s), no new offender.\n` +
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
      '\nWrite through the sanctioned path instead: a handle from openDualScopeDb and the\n' +
        "table's domain accessor. A raw write bypasses the chokepoint that replication\n" +
        'captures, so the change would never reach another device (Gate A, T12332).\n',
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

process.exit(main());
