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
 * ## REPLACE conflict resolution is banned (T12787 · zero tolerance)
 *
 * Separately from the ratchet, every `INSERT OR REPLACE INTO t` and
 * `REPLACE INTO t` in scanned source (the SANCTIONED chokepoint included)
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
 *   (default) / --check   fail on a new offender or an un-dropped removal
 *   --update-baseline     regenerate after a deliberate change
 *   --strict              zero tolerance: fail on ANY raw write site
 *
 * @task T12332
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
 * `INSERT OR REPLACE INTO t` / `REPLACE INTO t`. The target is captured as a
 * name, or left undefined when it is dynamic (`${…}`) and cannot be resolved.
 */
const REPLACE_RE =
  /\b(?:insert\s+or\s+replace\s+into|replace\s+into)\s+(?:[`"'[]?[a-z_]\w*[`"'\]]?\.)?(?:[`"'[]?([a-z_]\w*)|\$\{)/gi;

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
  for (const m of code.matchAll(REPLACE_RE)) {
    let line = 1;
    for (let k = 0; k < m.index; k++) if (code.charCodeAt(k) === 10) line++;
    hits.push({ line, table: m[1] ? m[1].toLowerCase() : null });
  }
  return hits;
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
  const tables = registryTables(readFileSync(REGISTRY, 'utf-8'));
  const findings = [];
  for (const file of sourceFiles()) {
    const lang = file.endsWith('.rs') ? 'rs' : 'js';
    const code = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf-8'), lang);
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

  const replaceFailed = reportReplace(scanReplace());

  if (args.has('--strict')) {
    if (replaceFailed) return 1;
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
    if (replaceFailed) return 1;
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
