#!/usr/bin/env node
/**
 * Gate 38 — sync write-invariant registry (T12881 · epic T12323).
 *
 * The raw sync applier never runs the TypeScript write paths, so every rule
 * TypeScript enforces on a write to a synced table must be classified (spec
 * `t12859-sync-write-validator-inventory` §3.6.7). Each rejection site on a
 * synced write path carries a tag on the line above it (or trailing it):
 *
 *   // @sync-invariant task.status.absorbing
 *   // @sync-invariant none:input-shape <reason>
 *   // @sync-invariant none:local-only <reason>
 *
 * naming an entry of `packages/contracts/src/invariants/sync-write-invariants.ts`
 * or an escape with a non-empty reason.
 *
 * ## Detection (TypeScript compiler API, not regex over code)
 *
 * 1. WRITE-PATH MODULES: non-test `.ts` under `packages/{core,cleo,playbooks}/src`
 *    that write a synced table (Drizzle `.insert/.update/.delete(<table symbol>)`,
 *    raw `INSERT|UPDATE|DELETE|REPLACE` SQL in a string or template literal, or
 *    a mutating `DataAccessor` method), or that are reachable in the import
 *    graph from a dispatch domain handler with a `mutate` method. Named
 *    imports are resolved through barrel re-exports to their defining module,
 *    so a barrel does not pull in every module it re-exports.
 * 2. REJECTION SITES in those modules: `throw new X(…)`, `engineError(…)`,
 *    `emitFailure(…)`, `cliError(…)`, `{ success: false, error: … }`, a
 *    `return` from a `validate*`/`assert*` function declared to return
 *    `RuleViolation[]`, and an `E_*`/`W_*`/`*_INVARIANT_VIOLATION` string used
 *    as a `code:` value or call argument outside those forms.
 * 3. SILENT RULES: a function that writes synced table T and reads a
 *    different synced table, or reads T by a column other than its key
 *    (cascade), or increments a column in SQL (`x = x + …`, counter). The
 *    function carries `@sync-invariant <id>` or `@sync-side-effect <id>`.
 *
 * A site is keyed (file, enclosing symbol, code) without line numbers. An
 * untagged site must be in the committed baseline
 * (`packages/core/src/store/__tests__/fixtures/sync-write-sites.baseline.json`,
 * a count per key), which may only shrink: a key whose count fell, or that is
 * gone, fails until `--update-baseline` rewrites it.
 *
 * ## Registry closure (§3.6.7 rules 5-6)
 *
 * - every `tables[]` entry is classified by Gate A;
 * - `trigger-covered`: each trigger or index is created by a migration SQL
 *   file (a name created only in runtime code fails: the D28 class);
 *   `fresh-store` existence is checked by
 *   `store/__tests__/sync-write-invariants-gate.test.ts`;
 * - `post-apply-check`: a non-empty footprint, and (unless `pending`) a
 *   `check.functionName` exported by `check.module`;
 * - `monotonic-merge-rule`: names a classified table and at least one column;
 * - `readsNonSynced` on a post-apply-check needs `pinnedPolicy: true`;
 * - a `runtimeGate` or `check.functionName` with no non-test caller is a dead
 *   gate;
 * - `not-sync-relevant` and `identity-layer` need a reason; ids are unique.
 *
 * Usage: node scripts/lint-sync-write-invariants.mjs [--check|--strict|--update-baseline [--seed]|--report]
 *   default/--check: fail on a new untagged site, a stale baseline or a
 *   registry problem. --strict also fails on any baselined site.
 *   --update-baseline rewrites the baseline but refuses to add or raise an
 *   entry unless --seed is passed (the initial seeding, or a reviewed raise).
 *
 * @task T12881
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Repo-relative path of the shrink-only baseline. */
export const BASELINE_PATH =
  'packages/core/src/store/__tests__/fixtures/sync-write-sites.baseline.json';

/** Packages whose `src/` is scanned. */
export const SOURCE_DIRS = ['packages/core/src', 'packages/cleo/src', 'packages/playbooks/src'];

/** `DataAccessor` methods that write (packages/contracts/src/data-accessor.ts). */
export const ACCESSOR_MUTATORS = new Set([
  'saveArchive',
  'saveSessions',
  'appendLog',
  'upsertSingleTask',
  'insertNewTask',
  'archiveSingleTask',
  'removeSingleTask',
  'addRelation',
  'removeRelation',
  'updateTaskFields',
  'shiftPositions',
  'upsertSingleSession',
  'removeSingleSession',
  'claimTask',
  'unclaimTask',
  'renewSessionClaims',
]);

/** `DataAccessor` reads by a non-key column (cascade sources), all on tasks_tasks. */
export const ACCESSOR_NON_KEY_READS = new Set([
  'getChildren',
  'countChildren',
  'countActiveChildren',
  'getAncestorChain',
  'getSubtree',
  'getDependents',
  'getDependencyChain',
  'queryTasks',
]);

const FAILURE_CALLEES = new Set(['engineError', 'emitFailure', 'cliError']);
const CODE_LITERAL = /^[EW]_[A-Z0-9_]+$|_INVARIANT_VIOLATION$/;
const TAG = /@sync-(invariant|side-effect)[ \t]+(\S+)(?:[ \t]+([^\n*]*))?/g;
const ESCAPES = new Set(['none:input-shape', 'none:local-only']);
const KEY_COLUMNS = new Set(['id', 'uid']);

const SQL_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+[`"[]?(?:\w+\.)?([A-Za-z_]\w*)/gi;
const SQL_READ =
  /\bFROM\s+[`"[]?(?:\w+\.)?([A-Za-z_]\w*)[`"\]]?(?:\s+(?:AS\s+)?\w+)?\s+WHERE\s+(?:\w+\.)?(\w+)/gi;
const SQL_READ_ANY = /\b(?:FROM|JOIN)\s+[`"[]?(?:\w+\.)?([A-Za-z_]\w*)/gi;
const SQL_COUNTER = /\b(\w+)\s*=\s*(?:\w+\.)?\1\s*[+-]/i;

// ---------------------------------------------------------------------------
// Files and modules
// ---------------------------------------------------------------------------

/**
 * Non-test `.ts` files under the given directories, repo-relative with `/`.
 *
 * @param {string} root
 * @param {readonly string[]} dirs
 * @returns {string[]}
 */
export function listSources(root, dirs) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
      const full = join(abs, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (
        name.endsWith('.ts') &&
        !name.endsWith('.d.ts') &&
        !/\.(test|spec)\.ts$/.test(name)
      ) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  for (const dir of dirs) if (existsSync(join(root, dir))) walk(join(root, dir));
  return out.sort();
}

/**
 * Resolve an import specifier from `fromFile` to a repo-relative `.ts` file.
 *
 * @param {string} root
 * @param {string} fromFile
 * @param {string} spec
 * @returns {string | null}
 */
export function resolveSpecifier(root, fromFile, spec) {
  let base;
  if (spec.startsWith('.')) base = join(dirname(fromFile), spec);
  else {
    const m = /^@cleocode\/([a-z0-9-]+)(?:\/(.+))?$/.exec(spec);
    if (!m) return null;
    base = m[2] ? `packages/${m[1]}/src/${m[2]}` : `packages/${m[1]}/src/index`;
  }
  base = base
    .split(sep)
    .join('/')
    .replace(/\.(m?js|ts)$/, '');
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `?${s.literal.text}`).join('');
  }
  return null;
}

function symbolName(node) {
  const names = [];
  for (let n = node; n; n = n.parent) {
    let name;
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n)) &&
      n.name
    ) {
      name = n.name.getText();
    } else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))
        name = p.name.getText();
    }
    if (name) names.unshift(name);
  }
  return names.length > 0 ? names.join('.') : '<module>';
}

function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n)) return n;
  }
  return undefined;
}

function enclosingStatement(node) {
  let n = node;
  while (
    n.parent &&
    !ts.isSourceFile(n.parent) &&
    !ts.isBlock(n.parent) &&
    !ts.isCaseClause(n.parent)
  ) {
    if (ts.isStatement(n) && !ts.isBlock(n)) break;
    n = n.parent;
  }
  return n;
}

/** Tags in the comment block directly above `node`'s statement, or trailing its first line. */
function tagsFor(sf, text, node) {
  const stmt = enclosingStatement(node);
  const comments = [
    ...(ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
  ];
  // A site nested inside a statement (e.g. a `throw` inside an arrow body on
  // one line) also accepts the comment on its own line.
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = line + 1 < sf.getLineStarts().length ? sf.getLineStarts()[line + 1] : text.length;
  const lineText = text.slice(lineStart, lineEnd);
  const tags = [];
  const scan = (s) => {
    for (const m of s.matchAll(TAG))
      tags.push({ kind: m[1], id: m[2], reason: (m[3] ?? '').trim() });
  };
  for (const c of comments) scan(text.slice(c.pos, c.end));
  if (lineText.includes('@sync-')) scan(lineText.slice(lineText.indexOf('//')));
  // The comment line(s) directly above the site's own line.
  const lines = text.slice(0, lineStart).split('\n');
  lines.pop();
  for (let i = lines.length - 1; i >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[i]); i--) scan(lines[i]);
  const seen = new Set();
  return tags.filter((t) => {
    const k = `${t.kind} ${t.id} ${t.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function errorCodeOf(args) {
  for (const a of args ?? []) {
    if (ts.isPropertyAccessExpression(a) && a.expression.getText() === 'ExitCode')
      return `ExitCode.${a.name.text}`;
    const lit = literalText(a);
    if (lit !== null && CODE_LITERAL.test(lit)) return lit;
    if (ts.isObjectLiteralExpression(a)) {
      for (const p of a.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText() === 'code') {
          const v = literalText(p.initializer);
          if (v !== null) return v;
          return p.initializer.getText();
        }
      }
    }
  }
  return null;
}

/**
 * Analyse one source file.
 *
 * @param {string} file - Repo-relative path.
 * @param {string} text - Source text.
 * @param {{ syncTables: Set<string>, schemaSymbols: Map<string, string> }} ctx
 */
export function analyseFile(file, text, ctx) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isSync = (t) => ctx.syncTables.has(t);
  const tableOfSymbol = (expr) => {
    const name = ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.getText();
    return ctx.schemaSymbols.get(name);
  };

  const sites = [];
  const imports = [];
  const declaredTables = [];
  let writesSync = false;
  let hasMutateHandler = false;
  /** @type {Map<ts.Node, { writes: Set<string>, reads: Set<string>, nonKeyReads: Set<string>, counter: boolean }>} */
  const fnFacts = new Map();
  const factsOf = (node) => {
    const fn = enclosingFunction(node) ?? sf;
    let f = fnFacts.get(fn);
    if (!f) {
      f = { writes: new Set(), reads: new Set(), nonKeyReads: new Set(), counter: false };
      fnFacts.set(fn, f);
    }
    return f;
  };
  const consumed = new Set();
  const site = (node, code) => {
    sites.push({ node, code, symbol: symbolName(node), tags: tagsFor(sf, text, node) });
  };
  const markConsumed = (node) => {
    const walk = (n) => {
      consumed.add(n);
      ts.forEachChild(n, walk);
    };
    walk(node);
  };

  const visit = (node) => {
    // Imports and re-exports.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        const names = [];
        let whole = !clause || !!clause.name;
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) whole = true;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
          }
        }
        if (whole || names.length > 0)
          imports.push({ spec: node.moduleSpecifier.text, names, whole });
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ spec: node.arguments[0].text, names: [], whole: true });
    }

    // Schema symbols: const x = sqliteTable('name', …).
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      /^sqliteTable$/.test(node.initializer.expression.getText()) &&
      node.initializer.arguments[0] &&
      ts.isStringLiteral(node.initializer.arguments[0])
    ) {
      declaredTables.push([node.name.getText(), node.initializer.arguments[0].text]);
    }

    // Dispatch domain handler with a mutate method.
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.name?.getText() === 'mutate'
    ) {
      hasMutateHandler = true;
    }

    // SQL in literals.
    const lit = literalText(node);
    if (lit !== null && /\b(INSERT|UPDATE|DELETE|REPLACE|SELECT)\b/i.test(lit)) {
      const f = factsOf(node);
      let wroteHere = false;
      for (const m of lit.matchAll(SQL_WRITE)) {
        if (isSync(m[1])) {
          f.writes.add(m[1]);
          writesSync = true;
          wroteHere = true;
        }
      }
      if (wroteHere && SQL_COUNTER.test(lit)) f.counter = true;
      for (const m of lit.matchAll(SQL_READ_ANY)) if (isSync(m[1])) f.reads.add(m[1]);
      for (const m of lit.matchAll(SQL_READ)) {
        if (isSync(m[1]) && !KEY_COLUMNS.has(m[2])) f.nonKeyReads.add(m[1]);
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const arg = node.arguments[0];
      // Drizzle writes and reads on a table symbol.
      if ((method === 'insert' || method === 'update' || method === 'delete') && arg) {
        const t = tableOfSymbol(arg);
        if (t && isSync(t)) {
          factsOf(node).writes.add(t);
          writesSync = true;
        }
      }
      if (method === 'from' && arg) {
        const t = tableOfSymbol(arg);
        if (t && isSync(t)) {
          const f = factsOf(node);
          f.reads.add(t);
          // A .where(…) on the same chain naming a non-key column of the table.
          const chain = node.parent;
          const whereText = chain?.parent?.getText() ?? '';
          const sym = ts.isPropertyAccessExpression(arg) ? arg.name.text : arg.getText();
          for (const m of whereText.matchAll(new RegExp(`\\b${sym}\\.(\\w+)`, 'g'))) {
            if (!KEY_COLUMNS.has(m[1])) f.nonKeyReads.add(t);
          }
        }
      }
      // Drizzle counter: .set({ x: sql`${t.x} + 1` }).
      if (method === 'set' && arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            ts.isTaggedTemplateExpression(p.initializer) &&
            /\+\s*(\d|\$\{)/.test(p.initializer.template.getText())
          )
            factsOf(node).counter = true;
        }
      }
      // DataAccessor.
      if (ACCESSOR_MUTATORS.has(method)) {
        factsOf(node).writes.add('tasks_tasks');
        writesSync = true;
      }
      if (ACCESSOR_NON_KEY_READS.has(method)) {
        const f = factsOf(node);
        f.reads.add('tasks_tasks');
        f.nonKeyReads.add('tasks_tasks');
      }
    }

    // Rejection sites.
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const ne = node.expression;
      site(node, errorCodeOf(ne.arguments) ?? ne.expression.getText());
      markConsumed(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      FAILURE_CALLEES.has(node.expression.text) &&
      !consumed.has(node)
    ) {
      site(node, errorCodeOf(node.arguments) ?? node.expression.text);
      markConsumed(node);
    } else if (ts.isObjectLiteralExpression(node) && !consumed.has(node)) {
      const props = new Map(
        node.properties
          .filter((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
          .map((p) => [p.name.getText(), p]),
      );
      const success = props.get('success');
      if (
        success &&
        ts.isPropertyAssignment(success) &&
        success.initializer.kind === ts.SyntaxKind.FalseKeyword &&
        props.has('error')
      ) {
        const err = props.get('error');
        let code = 'success:false';
        if (err && ts.isPropertyAssignment(err) && ts.isObjectLiteralExpression(err.initializer)) {
          code = errorCodeOf([err.initializer]) ?? code;
        }
        site(node, code);
        markConsumed(node);
      }
    } else if (ts.isReturnStatement(node) && node.expression && !consumed.has(node)) {
      const fn = enclosingFunction(node);
      const name = fn?.name?.getText() ?? '';
      if (/^(validate|assert)/.test(name) && /RuleViolation\[\]/.test(fn?.type?.getText() ?? '')) {
        const e = node.expression;
        const empty = ts.isArrayLiteralExpression(e) && e.elements.length === 0;
        if (!empty) site(node, 'RuleViolation[]');
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !consumed.has(node) &&
      CODE_LITERAL.test(node.text)
    ) {
      const p = node.parent;
      const asCode =
        (ts.isPropertyAssignment(p) && p.initializer === node && p.name.getText() === 'code') ||
        ((ts.isCallExpression(p) || ts.isNewExpression(p)) &&
          (p.arguments ?? []).includes(node) &&
          !ts.isImportDeclaration(p));
      if (asCode) site(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Silent rules, per function.
  for (const [fn, f] of fnFacts) {
    if (f.writes.size === 0) continue;
    const cascade = [...f.writes].some(
      (t) => [...f.reads].some((r) => r !== t) || f.nonKeyReads.has(t),
    );
    const node = fn === sf ? sf : fn;
    const anchor = fn === sf ? (sf.statements[0] ?? sf) : fn;
    if (cascade)
      sites.push({
        node: anchor,
        code: 'silent:cascade',
        symbol: fn === sf ? '<module>' : symbolName(fn.body ?? fn),
        silent: true,
        tags: fn === sf ? [] : tagsFor(sf, text, node),
      });
    if (f.counter)
      sites.push({
        node: anchor,
        code: 'silent:counter',
        symbol: fn === sf ? '<module>' : symbolName(fn.body ?? fn),
        silent: true,
        tags: fn === sf ? [] : tagsFor(sf, text, node),
      });
  }

  // Re-exports (for barrel resolution) and local exports.
  const localExports = new Set();
  const reexports = [];
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const from =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      if (!st.exportClause) {
        if (from) reexports.push({ from, star: true });
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly) continue;
          if (from)
            reexports.push({ from, name: el.name.text, as: (el.propertyName ?? el.name).text });
          else localExports.add(el.name.text);
        }
      } else if (from) reexports.push({ from, star: true });
    } else if (
      ts.canHaveModifiers(st) &&
      ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) localExports.add(d.name.getText());
      } else if (st.name) localExports.add(st.name.getText());
    }
  }

  return {
    file,
    sites: sites.map(({ code, symbol, tags, silent, node }) => ({
      code,
      symbol,
      tags,
      silent: !!silent,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    })),
    imports,
    declaredTables,
    writesSync,
    hasMutateHandler,
    localExports,
    reexports,
  };
}

// ---------------------------------------------------------------------------
// Repository scan
// ---------------------------------------------------------------------------

/**
 * Scan a tree: write-path modules and their rejection sites.
 *
 * @param {{
 *   root: string,
 *   dirs?: readonly string[],
 *   syncTables: Set<string>,
 *   entryFilter?: (file: string) => boolean,
 * }} opts
 */
export function scanTree({ root, dirs = SOURCE_DIRS, syncTables, entryFilter }) {
  const files = listSources(root, dirs);
  const texts = new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  // Pass 1: schema symbols.
  const schemaSymbols = new Map();
  for (const [f, text] of texts) {
    if (!text.includes('sqliteTable(')) continue;
    for (const [sym, table] of analyseFile(f, text, { syncTables, schemaSymbols: new Map() })
      .declaredTables) {
      // A symbol bound to a synced table anywhere is treated as synced.
      if (!schemaSymbols.has(sym) || syncTables.has(table)) schemaSymbols.set(sym, table);
    }
  }
  // Pass 2: everything else.
  const analysed = new Map();
  for (const [f, text] of texts)
    analysed.set(f, analyseFile(f, text, { syncTables, schemaSymbols }));

  // Barrel-aware import graph.
  const resolveCache = new Map();
  const resolveExport = (mod, name, seen = new Set()) => {
    const key = `${mod}#${name}`;
    if (resolveCache.has(key)) return resolveCache.get(key);
    if (seen.has(key)) return [];
    seen.add(key);
    const a = analysed.get(mod);
    if (!a) return [];
    let out = [];
    if (a.localExports.has(name)) out = [mod];
    else {
      for (const r of a.reexports) {
        const target = resolveSpecifier(root, mod, r.from);
        if (!target) continue;
        if (r.star) out.push(...resolveExport(target, name, seen));
        else if (r.name === name) out.push(...resolveExport(target, r.as, seen));
      }
      if (out.length === 0) out = [mod];
    }
    resolveCache.set(key, out);
    return out;
  };
  const edges = new Map();
  for (const [f, a] of analysed) {
    const targets = new Set();
    for (const imp of a.imports) {
      const target = resolveSpecifier(root, f, imp.spec);
      if (!target || !analysed.has(target)) continue;
      if (imp.whole) targets.add(target);
      for (const name of imp.names) for (const t of resolveExport(target, name)) targets.add(t);
    }
    edges.set(f, targets);
  }
  const entries = [...analysed.values()]
    .filter((a) => a.hasMutateHandler && (entryFilter ? entryFilter(a.file) : true))
    .map((a) => a.file);
  const reachable = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const f = queue.pop();
    for (const t of edges.get(f) ?? []) {
      if (!reachable.has(t)) {
        reachable.add(t);
        queue.push(t);
      }
    }
  }

  const writePath = new Set(
    [...analysed.values()].filter((a) => a.writesSync || reachable.has(a.file)).map((a) => a.file),
  );
  const sites = [];
  for (const f of writePath) {
    for (const s of analysed.get(f).sites) sites.push({ file: f, ...s });
  }
  return { files, analysed, writePath, reachable, entries, sites, texts };
}

/** Baseline key of a site. */
export function siteKey(s) {
  return `${s.file} :: ${s.symbol} :: ${s.code}`;
}

/**
 * Classify sites against the registry: tagged-ok, untagged, and tag problems.
 *
 * @param {ReturnType<typeof scanTree>['sites']} sites
 * @param {Set<string>} registryIds
 */
export function checkSites(sites, registryIds) {
  const untagged = [];
  const problems = [];
  for (const s of sites) {
    const wanted = s.tags.filter((t) => (s.silent ? true : t.kind === 'invariant'));
    if (wanted.length === 0) {
      untagged.push(s);
      continue;
    }
    for (const t of wanted) {
      if (t.id.startsWith('none:')) {
        if (!ESCAPES.has(t.id)) problems.push(`${s.file}:${s.line} unknown escape tag ${t.id}`);
        else if (!t.reason) problems.push(`${s.file}:${s.line} ${t.id} needs a reason`);
      } else if (!registryIds.has(t.id)) {
        problems.push(
          `${s.file}:${s.line} dangling tag @sync-${t.kind} ${t.id} (no registry entry)`,
        );
      }
    }
  }
  return { untagged, problems };
}

/**
 * Compare untagged sites with the baseline (a count per key).
 *
 * @param {{ file: string, symbol: string, code: string }[]} untagged
 * @param {Record<string, number>} baseline
 * @returns {{ added: string[], stale: string[], counts: Record<string, number> }}
 */
export function compareBaseline(untagged, baseline) {
  const counts = {};
  for (const s of untagged) counts[siteKey(s)] = (counts[siteKey(s)] ?? 0) + 1;
  const added = [];
  const stale = [];
  for (const [k, n] of Object.entries(counts)) {
    const allowed = baseline[k] ?? 0;
    if (n > allowed) added.push(`${k} (${n} untagged, baseline ${allowed})`);
  }
  for (const [k, n] of Object.entries(baseline)) {
    const now = counts[k] ?? 0;
    if (now < n) stale.push(`${k} (baseline ${n}, now ${now})`);
  }
  return { added: added.sort(), stale: stale.sort(), counts };
}

/**
 * Registry closure problems (§3.6.7 rules 5-6).
 *
 * @param {{
 *   registry: readonly any[],
 *   classified: Set<string>,
 *   migrationSql: string,
 *   runtimeSql: string,
 *   exportsOf: (module: string) => Set<string> | null,
 *   callersOf: (name: string, module: string) => number,
 * }} input
 * @returns {string[]}
 */
export function checkRegistry({
  registry,
  classified,
  migrationSql,
  runtimeSql,
  exportsOf,
  callersOf,
}) {
  const problems = [];
  const ids = new Set();
  const created = (name) =>
    new RegExp(
      `CREATE\\s+(?:UNIQUE\\s+)?(?:TRIGGER|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"]?${name}[\`"]?\\b`,
      'i',
    );
  for (const e of registry) {
    const at = `registry ${e.id}`;
    if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e.id))
      problems.push(`${at}: id is not dotted kebab-case`);
    if (!e.reason?.trim()) problems.push(`${at}: needs a reason`);
    if (e.pending && (!/^T\d+$/.test(e.pending.task) || !e.pending.reason?.trim()))
      problems.push(`${at}: pending needs a T<digits> task and a reason`);
    for (const t of e.tables ?? []) {
      if (!classified.has(t)) problems.push(`${at}: table ${t} is not classified by Gate A`);
    }
    if ((e.tables ?? []).length === 0) problems.push(`${at}: names no table`);
    if (e.class === 'trigger-covered') {
      if (!e.triggers?.length) problems.push(`${at}: trigger-covered names no trigger or index`);
      for (const name of e.triggers ?? []) {
        if (!created(name).test(migrationSql)) {
          problems.push(
            created(name).test(runtimeSql)
              ? `${at}: ${name} is created only in runtime code, not by a migration`
              : `${at}: ${name} is created by no migration`,
          );
        }
      }
    }
    if (e.class === 'post-apply-check') {
      if (!e.check?.footprint?.length)
        problems.push(`${at}: post-apply-check needs a non-empty footprint`);
      if (!e.pending) {
        if (!e.check?.module || !e.check?.functionName)
          problems.push(`${at}: post-apply-check needs check.module and check.functionName`);
        else if (!exportsOf(e.check.module)?.has(e.check.functionName))
          problems.push(`${at}: ${e.check.functionName} is not exported by ${e.check.module}`);
      }
      if (e.readsNonSynced?.length && e.pinnedPolicy !== true)
        problems.push(
          `${at}: reads non-synced ${e.readsNonSynced.join(', ')} without pinnedPolicy (§3.5 Rule 1)`,
        );
    }
    if (e.class === 'monotonic-merge-rule') {
      if (!e.mergeRule) problems.push(`${at}: monotonic-merge-rule needs mergeRule`);
      else {
        if (!classified.has(e.mergeRule.table))
          problems.push(`${at}: mergeRule table ${e.mergeRule.table} is not classified by Gate A`);
        if (!e.mergeRule.columns?.length) problems.push(`${at}: mergeRule names no column`);
      }
    }
    const gates = [e.runtimeGate, e.check?.functionName && e.check?.module ? e.check : null].filter(
      Boolean,
    );
    for (const g of gates) {
      if (!exportsOf(g.module)?.has(g.functionName)) {
        if (g === e.runtimeGate)
          problems.push(`${at}: runtimeGate ${g.functionName} is not exported by ${g.module}`);
      } else if (callersOf(g.functionName, g.module) === 0) {
        problems.push(`${at}: ${g.functionName} has no non-test caller (dead gate)`);
      }
    }
    for (const s of e.sites ?? []) {
      if (!s.file || !s.symbol) problems.push(`${at}: a site needs file and symbol`);
    }
  }
  return problems;
}

/**
 * Concatenated text of every migration `.sql` under the given directories.
 *
 * @param {string} root
 * @param {readonly string[]} dirs
 */
export function readMigrationSql(root, dirs) {
  const parts = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.sql')) parts.push(readFileSync(full, 'utf8'));
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d));
  return parts.join('\n');
}

/**
 * Build the closure helpers over a scanned tree.
 *
 * @param {string} root
 * @param {ReturnType<typeof scanTree>} scan
 */
export function closureHelpers(root, scan) {
  const exportsOf = (module) => {
    const a = scan.analysed.get(module);
    if (a) return a.localExports;
    if (!existsSync(join(root, module))) return null;
    return analyseFile(module, readFileSync(join(root, module), 'utf8'), {
      syncTables: new Set(),
      schemaSymbols: new Map(),
    }).localExports;
  };
  const callersOf = (name, module) => {
    const call = new RegExp(`\\b${name}\\s*\\(`);
    let n = 0;
    for (const [f, text] of scan.texts) {
      if (f === module) continue;
      // Imports, re-exports and comments are not calls; neither is a
      // same-named declaration.
      const lines = text.split('\n').filter((l) => !/^\s*(import\b|export\s*[{*]|\/\/|\*)/.test(l));
      if (lines.some((l) => call.test(l.replace(new RegExp(`function\\s+${name}\\b`), '')))) n++;
    }
    return n;
  };
  const runtimeSql = [...scan.texts.values()].join('\n');
  return { exportsOf, callersOf, runtimeSql };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadRepoInputs() {
  const { SYNC_WRITE_INVARIANTS } = await import(
    '../packages/contracts/src/invariants/sync-write-invariants.ts'
  );
  const { getTableRegistry, isPortableTableClass } = await import(
    '../packages/core/src/store/table-classification.ts'
  );
  const syncTables = new Set();
  const classified = new Set();
  for (const scope of ['project', 'global']) {
    for (const [t, e] of Object.entries(getTableRegistry(scope).tables)) {
      classified.add(t);
      if (isPortableTableClass(e.class) && e.status !== 'frozen-legacy') syncTables.add(t);
    }
  }
  return { registry: SYNC_WRITE_INVARIANTS, syncTables, classified };
}

/**
 * Run the gate on the repository.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  const mode = argv.includes('--update-baseline')
    ? 'update'
    : argv.includes('--strict')
      ? 'strict'
      : argv.includes('--report')
        ? 'report'
        : 'check';
  const { registry, syncTables, classified } = await loadRepoInputs();
  const scan = scanTree({
    root: REPO_ROOT,
    syncTables,
    entryFilter: (f) => f.startsWith('packages/cleo/src/dispatch/domains/'),
  });
  const ids = new Set(registry.map((e) => e.id));
  const { untagged, problems: tagProblems } = checkSites(scan.sites, ids);
  const { exportsOf, callersOf, runtimeSql } = closureHelpers(REPO_ROOT, scan);
  const registryProblems = checkRegistry({
    registry,
    classified,
    migrationSql: readMigrationSql(REPO_ROOT, [
      'packages/core/migrations',
      'packages/cleo/src/migrations',
    ]),
    runtimeSql,
    exportsOf,
    callersOf,
  });
  const baselineFile = join(REPO_ROOT, BASELINE_PATH);
  const baseline = existsSync(baselineFile)
    ? JSON.parse(readFileSync(baselineFile, 'utf8')).sites
    : {};
  const { added, stale, counts } = compareBaseline(untagged, baseline);
  const pending = registry.filter((e) => e.pending).length;
  const summary =
    `${scan.writePath.size} write-path modules (${scan.entries.length} mutate entry points), ` +
    `${scan.sites.length} sites, ${untagged.length} untagged in ${Object.keys(counts).length} keys; ` +
    `registry ${registry.length} entries (${pending} pending)`;

  if (mode === 'update') {
    if (tagProblems.length + registryProblems.length > 0) {
      for (const p of [...tagProblems, ...registryProblems]) process.stderr.write(`FAIL ${p}\n`);
      process.stderr.write(
        'lint-sync-write-invariants: fix the problems above before rewriting the baseline.\n',
      );
      return 1;
    }
    // Shrink-only: rewriting may drop or lower entries, never add or raise
    // one. --seed is for the initial seeding and for a deliberate, reviewed
    // raise; the diff of the baseline file shows it.
    if (added.length > 0 && !argv.includes('--seed')) {
      for (const k of added) process.stderr.write(`FAIL would add to the baseline: ${k}\n`);
      process.stderr.write(
        'lint-sync-write-invariants: the baseline only shrinks. Tag the new site(s) instead (or pass --seed for a reviewed raise).\n',
      );
      return 1;
    }
    const grows = added.length > 0;
    const sorted = Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(
      baselineFile,
      `${JSON.stringify(
        {
          $comment:
            'Untagged rejection sites on synced write paths, per (file :: symbol :: code). Shrink-only (T12881, gate 38): tag a site with // @sync-invariant <id> and regenerate with node scripts/lint-sync-write-invariants.mjs --update-baseline.',
          total: untagged.length,
          sites: sorted,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `lint-sync-write-invariants: baseline written (${untagged.length} sites, ${Object.keys(sorted).length} keys)${grows ? ' — seeded/raised with --seed' : ''}.\n`,
    );
    return 0;
  }
  if (mode === 'report') {
    process.stdout.write(`${summary}\n`);
    for (const e of registry.filter((x) => x.pending))
      process.stdout.write(`  pending ${e.id}: ${e.pending.task} ${e.pending.reason}\n`);
    return 0;
  }

  const failures = [
    ...tagProblems,
    ...registryProblems,
    ...added.map((k) => `untagged rejection site on a synced write path: ${k}`),
    ...stale.map((k) => `stale baseline entry (shrink it with --update-baseline): ${k}`),
    ...(mode === 'strict' ? Object.keys(counts).map((k) => `baselined untagged site: ${k}`) : []),
  ];
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
    process.stderr.write(
      `lint-sync-write-invariants: FAIL — ${failures.length} problem(s); ${summary}.\n` +
        '  Tag each site with // @sync-invariant <id> (packages/contracts/src/invariants/sync-write-invariants.ts)\n' +
        '  or // @sync-invariant none:input-shape|none:local-only <reason>.\n',
    );
    return 1;
  }
  process.stdout.write(`lint-sync-write-invariants: OK — ${summary}.\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await main());
