#!/usr/bin/env node

/**
 * Dual-Scope Unqualified Read Gate (T12156 · gh#1283)
 *
 * Some tables exist in BOTH the project `cleo.db` and the global `cleo.db`, and
 * both files can be visible on one connection at once. An unqualified
 *
 *   SELECT count(*) FROM __drizzle_migrations
 *
 * then resolves by SQLite's search order — `temp`, `main`, then attached
 * schemas in attach order — and returns a confident number that never says
 * which file it came from. Measured 2026-09-12 on this repo: project 108,
 * global 14, and the bare query answers 108 with nothing to suggest a second
 * table was in scope.
 *
 * ## Where the second schema comes from (NOT dual-scope)
 *
 * `openDualScopeDb` performs no ATTACH. The attach that creates the ambiguity
 * is `ensureGlobalRegistryAttached()` in `store/nexus-sqlite.ts`, which binds
 * the global `cleo.db` onto the PROJECT handle as `nexus_global` so that nexus
 * registry tables resolve by bare name through SQLite's fall-through. That
 * fall-through is deliberate and load-bearing — which is why "qualify every
 * read" is the WRONG rule. It would break nexus.
 *
 * The correct rule is narrower, and this gate encodes it:
 *
 *   Qualify the tables that exist in BOTH schemas.
 *   Leave bare names alone for tables that exist in only one.
 *
 * ## Why it matters more than a tidiness rule
 *
 * `bindProjectDomain` resolves through ONE path-keyed native handle shared by
 * every project-scope domain. So the nexus attach is process-global and
 * retroactive — a domain bound BEFORE anything touched nexus has its own
 * handle gain a second schema underneath it. Measured:
 *
 *   sibling domain BEFORE nexus: ["main"]
 *   sibling domain AFTER  nexus: ["main","nexus_global"]   (same native object)
 *
 * The ambiguity window is therefore not "nexus code". It is "any project-scope
 * domain, at any point after anything in the process has touched nexus".
 *
 * ## The ambiguous set is a property of DISK, not of source
 *
 * Two sources feed it, and neither alone is complete:
 *
 *   1. `schema/cleo-shared/` — tables deliberately resident in both scopes.
 *   2. {@link INFRA_BOTH_SCOPES} — journals and lease tables that every
 *      consolidated DB carries regardless of scope, plus raw-SQL tables that
 *      are not declared as a drizzle `sqliteTable` and so cannot be derived
 *      from the schema modules at all (`brain_schema_meta` is one).
 *
 * A source-derived set undercounts a live install for a third reason: a table
 * REMOVED from a schema module is not dropped from databases that already have
 * it. The four nexus graph tables moved project-ward under ADR-090/T11539 and
 * no migration drops the now-empty global copies, so a real global `cleo.db`
 * still carries them. This gate deliberately does not try to model that — see
 * gh#1283 for the disk-truth audit that does.
 *
 * Modes:
 *   (default)           fail on any net-new unqualified reference
 *   --update-baseline   regenerate after a deliberate fix
 *   --strict            zero tolerance: fail on ANY unqualified reference
 *
 * @task T12156 (gh#1283)
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BASELINE = resolve(REPO_ROOT, 'scripts/.lint-dual-scope-unqualified-reads-baseline.json');
const SHARED_SCHEMA_DIR = 'packages/core/src/store/schema/cleo-shared';

/**
 * Tables present in both scopes that no `sqliteTable(...)` declaration can
 * reveal — drizzle's own journal, the writer-lease pair, and brain's raw-SQL
 * meta table. Kept explicit rather than inferred so that adding one is a
 * visible decision.
 */
const INFRA_BOTH_SCOPES = [
  '__drizzle_migrations',
  '_writer_leases',
  '_writer_queue',
  'brain_schema_meta',
];

/**
 * Blank out block and line comments so a doc example is never read as code.
 *
 * Comments are replaced with an equal number of NEWLINES rather than deleted.
 * Deleting them collapses the file and every reported line number after the
 * first block comment points at the wrong line — which sends the reader to a
 * docblock instead of the query, and makes a correct finding look like a false
 * positive.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);
}

/**
 * Table names declared in `schema/cleo-shared/` — resident in both scopes by
 * design. Parsed from source rather than hardcoded so a new shared table is
 * covered the moment it is declared.
 */
function sharedSchemaTables() {
  const dir = resolve(REPO_ROOT, SHARED_SCHEMA_DIR);
  const names = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue;
    const code = stripComments(readFileSync(resolve(dir, file), 'utf-8'));
    for (const m of code.matchAll(/\bsqliteTable\(\s*'([^']+)'/g)) names.add(m[1]);
  }
  return names;
}

/** Every TypeScript source file tracked by git, excluding tests and schema modules. */
function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '*.ts'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => f.startsWith('packages/'))
    .filter((f) => !/(^|\/)(__tests__|dist)\//.test(f))
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
    .filter((f) => !f.includes('/store/schema/'));
}

/**
 * Find SQL references to `table` that carry no schema qualifier.
 *
 * Anchored on the SQL keyword that introduces a table reference, so a bare
 * mention of the name in prose, an identifier, or a column alias is not a hit.
 * A reference already written `main.x`, `nexus_global.x` or `"scope".x` is
 * qualified and therefore correct — those are what the gate wants to see.
 */
function unqualifiedHits(code, table) {
  const t = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kw = 'FROM|JOIN|INTO|UPDATE|DELETE\\s+FROM|TABLE';
  // (?<![.\w]) rejects `main.__drizzle_migrations` and `x___drizzle_migrations`.
  const re = new RegExp(`\\b(?:${kw})\\s+["'\`]?(?<![.\\w])${t}\\b`, 'gi');
  const hits = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push(i + 1);
    re.lastIndex = 0;
  }
  return hits;
}

const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update-baseline');
const STRICT = args.has('--strict');

const ambiguous = [...new Set([...sharedSchemaTables(), ...INFRA_BOTH_SCOPES])].sort();
const findings = [];

for (const file of sourceFiles()) {
  const code = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf-8'));
  for (const table of ambiguous) {
    if (!code.includes(table)) continue;
    for (const line of unqualifiedHits(code, table)) findings.push({ file, table, line });
  }
}

/** Per-file counts — the unit the baseline ratchets on. */
const byFile = {};
for (const f of findings) byFile[f.file] = (byFile[f.file] ?? 0) + 1;

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Unqualified reads of tables resident in BOTH cleo.db scopes (gh#1283). ' +
          'Counts may only DECREASE. Regenerate with: node scripts/lint-dual-scope-unqualified-reads.mjs --update-baseline',
        ambiguousTables: ambiguous.length,
        totalFindings: findings.length,
        counts: Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  console.log(
    `lint-dual-scope-unqualified-reads: baseline written — ${findings.length} unqualified reference(s) across ${Object.keys(byFile).length} file(s), ${ambiguous.length} ambiguous table(s).`,
  );
  process.exit(0);
}

/** Render a finding list to stderr. */
function report(list) {
  for (const f of list) console.error(`    ${f.file}:${f.line}  ${f.table}`);
}

if (STRICT) {
  if (findings.length === 0) {
    console.log(
      'lint-dual-scope-unqualified-reads: STRICT OK — every both-scope table reference is schema-qualified.',
    );
    process.exit(0);
  }
  console.error(
    `lint-dual-scope-unqualified-reads: STRICT FAIL — ${findings.length} unqualified reference(s).`,
  );
  report(findings);
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
} catch {
  console.error(
    `lint-dual-scope-unqualified-reads: no baseline at ${relative(REPO_ROOT, BASELINE)}.\n` +
      '  Create it with: node scripts/lint-dual-scope-unqualified-reads.mjs --update-baseline',
  );
  process.exit(1);
}

const baseCounts = baseline.counts ?? {};
const regressions = Object.entries(byFile)
  .filter(([file, n]) => n > (baseCounts[file] ?? 0))
  .map(([file, n]) => ({ file, was: baseCounts[file] ?? 0, now: n }));

if (regressions.length === 0) {
  const improved = Object.entries(baseCounts).filter(([file, was]) => (byFile[file] ?? 0) < was);
  const suffix =
    improved.length > 0
      ? ` (${improved.length} file(s) improved — consider --update-baseline)`
      : '';
  console.log(
    `lint-dual-scope-unqualified-reads: OK — ${findings.length} unqualified reference(s), no regression against baseline${suffix}.`,
  );
  process.exit(0);
}

console.error(
  `lint-dual-scope-unqualified-reads: FAIL — ${regressions.length} file(s) gained unqualified reads of a both-scope table:\n`,
);
for (const r of regressions) {
  console.error(`  ${r.file}: ${r.was} -> ${r.now}`);
  report(findings.filter((f) => f.file === r.file));
  console.error('');
}
console.error(
  'These tables exist in BOTH the project and global `cleo.db`, and both can be\n' +
    'visible on one connection (nexus ATTACHes the global file as `nexus_global`,\n' +
    'onto a native handle every project-scope domain shares). A bare name resolves\n' +
    'by SQLite search order and returns a confident answer without saying which\n' +
    'file it read (gh#1283).\n\n' +
    '  FIX: qualify the schema — `main.<table>` for the handle you opened, or the\n' +
    '       attach alias for the other scope.\n\n' +
    '  Do NOT "fix" this by qualifying everything: nexus registry tables resolve by\n' +
    '  bare name through the fall-through on purpose. Only both-scope tables are\n' +
    '  ambiguous.',
);
process.exit(1);
