#!/usr/bin/env node
/**
 * Gate 38 — sync write-invariant registry (T12881 · epic T12323).
 *
 * The raw sync applier never runs the TypeScript write paths, so every rule
 * TypeScript enforces on a write to a synced table must be classified (spec
 * `t12859-sync-write-validator-inventory` §3.6.7). Each rejection site on a
 * synced write path carries a tag in its own leading comment (the comment
 * lines directly above the site's line) or trailing on that line:
 *
 *   // @sync-invariant task.status.absorbing
 *   // @sync-invariant none:input-shape <reason>
 *   // @sync-invariant none:local-only <reason>
 *
 * naming an entry of `packages/contracts/src/invariants/sync-write-invariants.ts`
 * whose `tables` include a table the site's function (or module) writes, or an
 * escape with a non-empty reason.
 *
 * ## Detection (TypeScript compiler API, not regex over code)
 *
 * 1. WRITE-PATH MODULES, among the tracked (`git ls-files`) non-test `.ts`
 *    under `packages/{core,cleo,playbooks,studio}/src`:
 *    - modules that write a synced table: Drizzle `.insert/.update/.delete(<table
 *      symbol>)`, raw `INSERT|UPDATE|DELETE|REPLACE` SQL in a string or
 *      template literal, or a mutating `DataAccessor` method called on an
 *      accessor-like receiver (`accessor`, `acc`, `tx`, `transaction`,
 *      `this.inner`, `*Accessor`);
 *    - modules reachable from a dispatch domain's MUTATE path: only the
 *      imports referenced from the `mutate` method and from handler entries
 *      named by the domain's mutate operations (query-only handlers are
 *      excluded), then the import graph from there, with named imports
 *      resolved through barrel re-exports to their defining module. Lazily
 *      loaded bindings count as named imports: a const initialised from
 *      `(await import(spec)).name`, a destructured `const { a } = await
 *      import(spec)`, and `const m = await import(spec)` as a namespace. The
 *      binding is the nearest enclosing declaration, whatever its scope, which
 *      over-counts reachability (the safe direction).
 * 2. REJECTION SITES in those modules: `throw new X(…)`, `throw f(…)` (a
 *    factory-built error; the callee name is the code), `return new XError(…)`
 *    inside an Error-returning factory, `engineError(…)`, `emitFailure(…)`,
 *    `cliError(…)`, `{ success: false, error: … }`, a `return` from a
 *    `validate*`/`assert*` function declared to return `RuleViolation[]`, and
 *    an `E_*`/`W_*`/`*_INVARIANT_VIOLATION` string used as a `code:` value or
 *    call argument outside those forms.
 * 3. SILENT RULES: a function (or module top level) that writes synced table
 *    T and reads a different synced table, or reads T by a column other than
 *    its key (cascade), or increments a column in SQL (`x = x + …`, counter).
 *    It carries `@sync-invariant <id>` or `@sync-side-effect <id>`.
 *
 * ## Shrink-only baseline
 *
 * Untagged sites are counted per `file :: code` (no symbol, no line), so a
 * rename inside a file costs nothing. The baseline
 * (`scripts/.lint-sync-write-invariants-baseline.json`) may only shrink:
 *
 * - every run: a write-path `file :: code` with more untagged sites than the
 *   baseline fails (tag the site);
 * - without `--base` (push to main, local): a baseline count above the current
 *   count is stale and fails;
 * - with `--base <ref>` (PR and merge-queue mode; CI passes the base): only
 *   keys of files changed against the base are judged stale, so two shrinking
 *   PRs merge cleanly; and every key the baseline added or raised against the
 *   base's baseline (`git show`) must be justified: either listed in the
 *   baseline's `audited` map as `{ "reason": "T#### …", "count": n }` whose
 *   count covers the new count and rose against the base's audited count
 *   (an inherited or re-worded audit justifies nothing new),
 *   or net-zero for its code over the changed files (the sites already
 *   existed at the base: a move between files, or a module newly reachable
 *   through a new import). The base side counts only sites that were on a
 *   write path at the base (the base tree is scanned too) and that the
 *   base's baseline paid for, so deleting or trimming a never-baselined
 *   file earns no credit.
 *
 * `--update-baseline` rewrites the baseline under the same rule: it refuses an
 * unjustified add or raise unless `--seed` is passed (pass `--base <ref>` so
 * moves and newly reachable modules are justified).
 *
 * ## Registry closure (§3.6.7 rules 5-6)
 *
 * - every `tables[]` entry is classified by Gate A;
 * - `trigger-covered`: each trigger or index is created by a migration SQL
 *   file (a name created only in runtime code fails: the D28 class); the
 *   fresh-store check is `store/__tests__/sync-write-invariants-gate.test.ts`;
 * - `post-apply-check`: a non-empty footprint, and (unless `pending`) a
 *   `check.functionName` exported by `check.module`;
 * - `monotonic-merge-rule`: names a classified table and at least one column;
 * - `readsNonSynced` on a post-apply-check needs `pinnedPolicy: true`;
 * - a `runtimeGate` or `check.functionName` with no non-test caller is a dead
 *   gate;
 * - `pending` names a `T####` task; `--verify-tasks` checks each pending task,
 *   the baseline's burn-down task and each task an `audited` reason names
 *   exist and are open, through the released
 *   CLI (`${CLEO_BIN:-cleo} show`, in `$CLEO_TASKS_CWD` or the repo root). CI
 *   has no task store, so CI does not pass it.
 *
 * Usage: node scripts/lint-sync-write-invariants.mjs
 *          [--check|--strict] [--base <ref>] [--verify-tasks]
 *          [--update-baseline [--seed]] [--report]
 *   --strict also fails on any baselined site.
 *
 * @task T12881
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Repo-relative path of the shrink-only baseline. */
export const BASELINE_PATH = 'scripts/.lint-sync-write-invariants-baseline.json';

/** Packages whose `src/` is scanned. */
export const SOURCE_DIRS = [
  'packages/core/src',
  'packages/cleo/src',
  'packages/playbooks/src',
  'packages/studio/src',
];

/** Dispatch domains: the mutate entry points. */
export const ENTRY_PREFIX = 'packages/cleo/src/dispatch/domains/';

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

/** A receiver that is a DataAccessor (or a transaction over one). */
const ACCESSOR_RECEIVER = /(^|\.)(accessor|acc|tx|transaction|inner|dataAccessor|\w*Accessor)$/;

const FAILURE_CALLEES = new Set(['engineError', 'emitFailure', 'cliError']);
const CODE_LITERAL = /^[EW]_[A-Z0-9_]+$|_INVARIANT_VIOLATION$/;
const TAG = /@sync-(invariant|side-effect)[ \t]+(\S+)(?:[ \t]+([^\n*]*))?/g;
const ESCAPES = new Set(['none:input-shape', 'none:local-only']);
const KEY_COLUMNS = new Set(['id', 'uid']);
const CLOSED_STATUSES = new Set(['done', 'cancelled', 'archived', 'completed', 'deleted']);

const SQL_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+[`"[]?(?:\w+\.)?([A-Za-z_]\w*)/gi;
const SQL_READ =
  /\bFROM\s+[`"[]?(?:\w+\.)?([A-Za-z_]\w*)[`"\]]?(?:\s+(?:AS\s+)?\w+)?\s+WHERE\s+(?:\w+\.)?(\w+)/gi;
const SQL_READ_ANY = /\b(?:FROM|JOIN)\s+[`"[]?(?:\w+\.)?([A-Za-z_]\w*)/gi;
const SQL_COUNTER = /\b(\w+)\s*=\s*(?:\w+\.)?\1\s*[+-]/i;

// ---------------------------------------------------------------------------
// Files and modules
// ---------------------------------------------------------------------------

const isSource = (f) =>
  f.endsWith('.ts') &&
  !f.endsWith('.d.ts') &&
  !/\.(test|spec)\.ts$/.test(f) &&
  !f.split('/').some((seg) => seg === '__tests__' || seg === 'node_modules' || seg === 'dist');

/**
 * Tracked non-test `.ts` files under the given directories, repo-relative
 * with `/`. Uses `git ls-files`; falls back to walking the tree outside git.
 *
 * @param {string} root
 * @param {readonly string[]} dirs
 * @returns {string[]}
 */
export function listSources(root, dirs) {
  const run = spawnSync('git', ['ls-files', '-z', '--', ...dirs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status === 0) {
    return run.stdout
      .split('\0')
      .filter((f) => f && isSource(f) && existsSync(join(root, f)))
      .sort();
  }
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join('/');
        if (isSource(rel)) out.push(rel);
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
 * @param {(file: string) => boolean} [exists] - Whether a repo-relative file
 *   exists in the tree being scanned (default: on disk under `root`).
 * @returns {string | null}
 */
export function resolveSpecifier(root, fromFile, spec, exists = (f) => existsSync(join(root, f))) {
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
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The scanned sources of a git tree at a ref, read in one `git cat-file
 * --batch` pass, in the shape `scanTree` takes as `tree`. PR mode scans the
 * base this way to know which modules were on a write path at the base.
 *
 * @param {string} root
 * @param {string} ref
 * @param {readonly string[]} [dirs]
 * @returns {{ files: string[], texts: Map<string, string>, exists: (file: string) => boolean }}
 */
export function treeAt(root, ref, dirs = SOURCE_DIRS) {
  const all = git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...dirs])
    .split('\0')
    .filter(Boolean);
  const files = all.filter(isSource).sort();
  const texts = new Map();
  if (files.length > 0) {
    const buf = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: `${files.map((f) => `${ref}:${f}`).join('\n')}\n`,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pos = 0;
    for (const f of files) {
      const eol = buf.indexOf(0x0a, pos);
      const header = buf.subarray(pos, eol).toString('utf8');
      const size = Number(/^\S+ blob (\d+)$/.exec(header)?.[1]);
      if (!Number.isFinite(size)) throw new Error(`git cat-file ${ref}:${f}: ${header}`);
      texts.set(f, buf.subarray(eol + 1, eol + 1 + size).toString('utf8'));
      pos = eol + 1 + size + 1;
    }
  }
  const present = new Set(all);
  return { files, texts, exists: (f) => present.has(f) };
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

function functionName(fn) {
  if (!fn) return '';
  if (fn.name) return fn.name.getText();
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p))) return p.name.getText();
  return '';
}

/**
 * Tags in the site's OWN comments: its leading comment, the comment lines
 * directly above its first line, or a comment trailing that line. Never the
 * enclosing statement's comment.
 */
function tagsFor(sf, text, node) {
  const tags = [];
  const scan = (s) => {
    for (const m of s.matchAll(TAG))
      tags.push({ kind: m[1], id: m[2], reason: (m[3] ?? '').trim() });
  };
  for (const c of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
    scan(text.slice(c.pos, c.end));
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const starts = sf.getLineStarts();
  const lineText = text.slice(
    starts[line],
    line + 1 < starts.length ? starts[line + 1] : text.length,
  );
  const trailing = lineText.indexOf('//');
  if (trailing !== -1) scan(lineText.slice(trailing));
  for (let i = line - 1; i >= 0; i--) {
    const l = text.slice(starts[i], starts[i + 1]);
    if (!/^\s*(\/\/|\*|\/\*)/.test(l)) break;
    scan(l);
  }
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

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return expr.getText();
}

/** String values of an array literal or `new Set([...])`, resolving one identifier hop. */
function stringsOf(expr, consts) {
  if (!expr) return [];
  if (ts.isIdentifier(expr) && consts.has(expr.text))
    return stringsOf(consts.get(expr.text), consts);
  if (ts.isNewExpression(expr)) return stringsOf(expr.arguments?.[0], consts);
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.flatMap((e) =>
      ts.isSpreadElement(e) ? stringsOf(e.expression, consts) : (literalText(e) ?? []),
    );
  }
  return [];
}

/**
 * The identifiers a dispatch domain's mutate path references: the `mutate`
 * method body, plus object-literal entries named by mutate operations, plus
 * (transitively) same-file declarations they reference. Entries named only
 * by query operations are skipped. `null` when the file declares no mutate
 * operations.
 */
function mutateReferences(sf) {
  const consts = new Map();
  const decls = new Map();
  let mutateMethod;
  let mutateOps;
  let queryOps = [];
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      consts.set(n.name.text, n.initializer);
      decls.set(n.name.text, n.initializer);
    }
    if (ts.isFunctionDeclaration(n) && n.name) decls.set(n.name.text, n);
    if (
      !mutateMethod &&
      n.name?.getText() === 'mutate' &&
      (ts.isMethodDeclaration(n) ||
        (ts.isPropertyAssignment(n) &&
          (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))))
    )
      mutateMethod = n;
    if (ts.isMethodDeclaration(n) && n.name?.getText() === 'getSupportedOperations' && n.body) {
      const walk = (m) => {
        if (ts.isPropertyAssignment(m) && m.name.getText() === 'mutate')
          mutateOps = stringsOf(m.initializer, consts);
        if (ts.isPropertyAssignment(m) && m.name.getText() === 'query')
          queryOps = stringsOf(m.initializer, consts);
        ts.forEachChild(m, walk);
      };
      walk(n.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!mutateMethod || !mutateOps) return null;
  const mutate = new Set(mutateOps);
  const queryOnly = new Set(queryOps.filter((q) => !mutate.has(q)));
  const refs = new Set();
  const seen = new Set();
  const collect = (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    const walk = (m) => {
      if (
        (ts.isPropertyAssignment(m) || ts.isMethodDeclaration(m)) &&
        m.name &&
        queryOnly.has(m.name.getText().replace(/^['"]|['"]$/g, ''))
      )
        return;
      if (ts.isIdentifier(m)) {
        refs.add(m.text);
        const d = decls.get(m.text);
        if (d && d !== node) collect(d);
      }
      ts.forEachChild(m, walk);
    };
    walk(node);
  };
  collect(mutateMethod);
  // Handler entries named by a mutate op anywhere in the file.
  const entries = (m) => {
    if (
      (ts.isPropertyAssignment(m) || ts.isMethodDeclaration(m)) &&
      m.name &&
      mutate.has(m.name.getText().replace(/^['"]|['"]$/g, ''))
    )
      collect(m);
    ts.forEachChild(m, entries);
  };
  entries(sf);
  return refs;
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
  /** @type {Map<ts.Node, { writes: Set<string>, reads: Set<string>, nonKeyReads: Set<string>, counter: boolean, first?: ts.Node }>} */
  const fnFacts = new Map();
  const factsOf = (node) => {
    const fn = enclosingFunction(node) ?? sf;
    let f = fnFacts.get(fn);
    if (!f) {
      f = { writes: new Set(), reads: new Set(), nonKeyReads: new Set(), counter: false };
      fnFacts.set(fn, f);
    }
    f.first ??= node;
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
  const isErrorFactory = (fn) =>
    !!fn && (/Error$/.test(functionName(fn)) || /\b\w*Error\b/.test(fn.type?.getText() ?? ''));

  const visit = (node) => {
    // Imports.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        const names = [];
        const locals = [];
        let whole = !clause || !!clause.name;
        let namespace;
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          whole = true;
          namespace = bindings.name.text;
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue;
            names.push((el.propertyName ?? el.name).text);
            locals.push(el.name.text);
          }
        }
        if (whole || names.length > 0)
          imports.push({
            spec: node.moduleSpecifier.text,
            names,
            locals,
            whole,
            namespace,
            defaultName: clause?.name?.text,
          });
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      // Lazily loaded bindings (T13126) count as named imports bound to the
      // declared names, so a mutate handler that uses them reaches the module:
      // - `const x = lazy(async () => (await import(s)).name)`: `x` is `name`;
      // - `const { a, b: c } = await import(s)`: `a` is `a`, `c` is `b`;
      // - `const m = await import(s)`: `m` is the namespace.
      // The binding is the NEAREST enclosing variable declaration, whatever its
      // scope, so an import inside a function body may bind to an outer const
      // too. That over-counts reachability, the safe direction for a
      // write-path registry.
      let decl = node.parent;
      while (decl && !ts.isVariableDeclaration(decl) && !ts.isSourceFile(decl)) decl = decl.parent;
      const declared = decl && ts.isVariableDeclaration(decl) ? decl : null;
      const awaited = node.parent && ts.isAwaitExpression(node.parent) ? node.parent : null;
      const accessed =
        awaited?.parent &&
        ts.isParenthesizedExpression(awaited.parent) &&
        awaited.parent.parent &&
        ts.isPropertyAccessExpression(awaited.parent.parent)
          ? awaited.parent.parent.name.text
          : null;
      const names = [];
      const locals = [];
      let namespace;
      if (declared && ts.isIdentifier(declared.name)) {
        if (accessed) {
          names.push(accessed);
          locals.push(declared.name.text);
        } else {
          namespace = declared.name.text;
        }
      } else if (declared && ts.isObjectBindingPattern(declared.name) && !accessed) {
        for (const el of declared.name.elements) {
          if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
          const prop =
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          names.push(prop);
          locals.push(el.name.text);
        }
      }
      imports.push({
        spec: node.arguments[0].text,
        names,
        locals,
        whole: true,
        namespace,
        dynamic: true,
      });
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

    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.name?.getText() === 'mutate'
    ) {
      hasMutateHandler = true;
    }

    // SQL in literals.
    const lit = literalText(node);
    if (lit !== null && /\b(INSERT|UPDATE|DELETE|REPLACE|SELECT)\b/i.test(lit)) {
      let wroteHere = false;
      const writes = [...lit.matchAll(SQL_WRITE)].map((m) => m[1]).filter(isSync);
      const reads = [...lit.matchAll(SQL_READ_ANY)].map((m) => m[1]).filter(isSync);
      const nonKey = [...lit.matchAll(SQL_READ)]
        .filter((m) => isSync(m[1]) && !KEY_COLUMNS.has(m[2]))
        .map((m) => m[1]);
      if (writes.length + reads.length > 0) {
        const f = factsOf(node);
        for (const t of writes) {
          f.writes.add(t);
          writesSync = true;
          wroteHere = true;
        }
        if (wroteHere && SQL_COUNTER.test(lit)) f.counter = true;
        for (const t of reads) f.reads.add(t);
        for (const t of nonKey) f.nonKeyReads.add(t);
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const arg = node.arguments[0];
      if ((method === 'insert' || method === 'update' || method === 'delete') && arg) {
        const t = tableOfSymbol(arg);
        if (t && isSync(t)) {
          factsOf(node).writes.add(t);
          writesSync = true;
        }
      }
      // A Drizzle read: `.from(<table>)` on a `.select…()` chain only (not Array.from).
      if (
        method === 'from' &&
        arg &&
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        /^select/.test(receiver.expression.name.text)
      ) {
        const t = tableOfSymbol(arg);
        if (t && isSync(t)) {
          const f = factsOf(node);
          f.reads.add(t);
          const whereText = node.parent?.parent?.getText() ?? '';
          const sym = ts.isPropertyAccessExpression(arg) ? arg.name.text : arg.getText();
          for (const m of whereText.matchAll(new RegExp(`\\b${sym}\\.(\\w+)`, 'g'))) {
            if (!KEY_COLUMNS.has(m[1])) f.nonKeyReads.add(t);
          }
        }
      }
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
      const receiverText = receiver.getText();
      if (ACCESSOR_RECEIVER.test(receiverText)) {
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
    }

    // Rejection sites.
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const ne = node.expression;
      site(node, errorCodeOf(ne.arguments) ?? ne.expression.getText());
      markConsumed(node);
    } else if (
      ts.isThrowStatement(node) &&
      node.expression &&
      ts.isCallExpression(node.expression)
    ) {
      // A factory-built error: throw dependencyCycleError(…).
      site(node, calleeName(node.expression.expression));
      markConsumed(node);
    } else if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isNewExpression(node.expression) &&
      /Error$/.test(node.expression.expression.getText()) &&
      isErrorFactory(enclosingFunction(node))
    ) {
      const ne = node.expression;
      site(node, errorCodeOf(ne.arguments) ?? ne.expression.getText());
      markConsumed(node);
    } else if (
      ts.isArrowFunction(node) &&
      !ts.isBlock(node.body) &&
      ts.isNewExpression(node.body) &&
      /Error$/.test(node.body.expression.getText()) &&
      isErrorFactory(node)
    ) {
      site(node.body, errorCodeOf(node.body.arguments) ?? node.body.expression.getText());
      markConsumed(node.body);
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

  // Silent rules, per function (or the module top level).
  for (const [fn, f] of fnFacts) {
    if (f.writes.size === 0) continue;
    const cascade = [...f.writes].some(
      (t) => [...f.reads].some((r) => r !== t) || f.nonKeyReads.has(t),
    );
    const anchor = fn === sf ? f.first : fn;
    const symbol = fn === sf ? '<module>' : symbolName(fn.body ?? fn);
    const tags = tagsFor(sf, text, anchor);
    if (cascade) sites.push({ node: anchor, code: 'silent:cascade', symbol, silent: true, tags });
    if (f.counter) sites.push({ node: anchor, code: 'silent:counter', symbol, silent: true, tags });
  }

  // The synced tables each site's function (else the module) writes.
  const moduleWrites = new Set([...fnFacts.values()].flatMap((f) => [...f.writes]));
  const tablesFor = (node) => {
    const own = ts.isFunctionLike(node) ? node : enclosingFunction(node);
    const f = fnFacts.get(own ?? sf);
    return f?.writes.size ? [...f.writes] : [...moduleWrites];
  };

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
      tables: tablesFor(node),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    })),
    imports,
    declaredTables,
    writesSync,
    hasMutateHandler,
    mutateRefs: hasMutateHandler ? mutateReferences(sf) : null,
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
 *   tree?: ReturnType<typeof treeAt>,
 * }} opts - `tree`: scan these files instead of the working tree (`treeAt`).
 */
export function scanTree({ root, dirs = SOURCE_DIRS, syncTables, entryFilter, tree }) {
  const files = tree?.files ?? listSources(root, dirs);
  const texts = tree?.texts ?? new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  const exists = tree?.exists ?? ((f) => existsSync(join(root, f)));
  const schemaSymbols = new Map();
  for (const [f, text] of texts) {
    if (!text.includes('sqliteTable(')) continue;
    for (const [sym, table] of analyseFile(f, text, { syncTables, schemaSymbols: new Map() })
      .declaredTables) {
      if (!schemaSymbols.has(sym) || syncTables.has(table)) schemaSymbols.set(sym, table);
    }
  }
  const ctx = { syncTables, schemaSymbols };
  const analysed = new Map();
  for (const [f, text] of texts) analysed.set(f, analyseFile(f, text, ctx));

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
        const target = resolveSpecifier(root, mod, r.from, exists);
        if (!target) continue;
        if (r.star) out.push(...resolveExport(target, name, seen));
        else if (r.name === name) out.push(...resolveExport(target, r.as, seen));
      }
      if (out.length === 0) out = [mod];
    }
    resolveCache.set(key, out);
    return out;
  };
  /** Modules an import edge set reaches; `only` limits it to referenced local names. */
  const targetsOf = (f, only) => {
    const a = analysed.get(f);
    const targets = new Set();
    for (const imp of a.imports) {
      const target = resolveSpecifier(root, f, imp.spec, exists);
      if (!target || !analysed.has(target)) continue;
      if (only) {
        const usedWhole =
          (imp.namespace && only.has(imp.namespace)) ||
          (imp.defaultName && only.has(imp.defaultName));
        if (usedWhole) targets.add(target);
        imp.names.forEach((name, i) => {
          if (only.has(imp.locals[i])) for (const t of resolveExport(target, name)) targets.add(t);
        });
        continue;
      }
      if (imp.whole) targets.add(target);
      for (const name of imp.names) for (const t of resolveExport(target, name)) targets.add(t);
    }
    return targets;
  };
  const edges = new Map();
  for (const f of analysed.keys()) edges.set(f, targetsOf(f));

  const entries = [...analysed.values()]
    .filter((a) => a.hasMutateHandler && (entryFilter ? entryFilter(a.file) : true))
    .map((a) => a.file);
  const reachable = new Set(entries);
  const queue = [];
  for (const e of entries) {
    const refs = analysed.get(e).mutateRefs;
    for (const t of refs ? targetsOf(e, refs) : edges.get(e)) {
      if (!reachable.has(t)) {
        reachable.add(t);
        queue.push(t);
      }
    }
  }
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
  return { files, analysed, writePath, reachable, entries, sites, texts, ctx };
}

/** Baseline key of a site: `file :: code` (no symbol, no line). */
export function siteKey(s) {
  return `${s.file} :: ${s.code}`;
}

/** File of a baseline key. */
export const keyFile = (key) => key.slice(0, key.indexOf(' :: '));
/** Code of a baseline key. */
export const keyCode = (key) => key.slice(key.indexOf(' :: ') + 4);

/**
 * Classify sites against the registry: untagged sites and tag problems.
 *
 * @param {ReturnType<typeof scanTree>['sites']} sites
 * @param {readonly { id: string, tables: readonly string[] }[] | Set<string>} registry
 */
export function checkSites(sites, registry) {
  const byId = new Map(
    registry instanceof Set
      ? [...registry].map((id) => [id, null])
      : registry.map((e) => [e.id, e]),
  );
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
      } else if (!byId.has(t.id)) {
        problems.push(
          `${s.file}:${s.line} dangling tag @sync-${t.kind} ${t.id} (no registry entry)`,
        );
      } else {
        const entry = byId.get(t.id);
        if (entry && s.tables?.length && !entry.tables.some((x) => s.tables.includes(x))) {
          problems.push(
            `${s.file}:${s.line} tag ${t.id} covers ${entry.tables.join(', ')} but the site writes ${s.tables.join(', ')}`,
          );
        }
      }
    }
  }
  return { untagged, problems };
}

/** Untagged site counts per key. */
export function countKeys(untagged) {
  const counts = {};
  for (const s of untagged) counts[siteKey(s)] = (counts[siteKey(s)] ?? 0) + 1;
  return counts;
}

/**
 * Compare untagged sites with the baseline.
 *
 * @param {Record<string, number>} counts - Current untagged counts per key.
 * @param {Record<string, number>} baseline
 * @param {{ staleFiles?: Set<string> | null }} [opts] - When set, only keys of
 *   these files are judged stale (PR mode); otherwise every key is.
 */
export function compareBaseline(counts, baseline, opts = {}) {
  const added = [];
  const stale = [];
  for (const [k, n] of Object.entries(counts)) {
    const allowed = baseline[k] ?? 0;
    if (n > allowed) added.push(`${k} (${n} untagged, baseline ${allowed})`);
  }
  for (const [k, n] of Object.entries(baseline)) {
    if (opts.staleFiles && !opts.staleFiles.has(keyFile(k))) continue;
    const now = counts[k] ?? 0;
    if (now < n) stale.push(`${k} (baseline ${n}, now ${now})`);
  }
  return { added: added.sort(), stale: stale.sort() };
}

/**
 * The count an `audited` entry approves, or `null` when it approves nothing:
 * an entry is `{ reason, count }` with a `T####` in the reason and a
 * non-negative integer count. The legacy string form approves nothing new.
 *
 * @param {string | { reason?: string, count?: number } | undefined} entry
 * @returns {number | null}
 */
export function auditedCount(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!/\bT\d+\b/.test(String(entry.reason ?? ''))) return null;
  return Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : null;
}

/**
 * Keys a new baseline adds or raises against the base baseline that are not
 * justified. A raise above the untagged sites that exist (`why.counts`) is
 * never justified; otherwise a raise to `n` is justified when the key's
 * audit approves at least `n` (`auditedCount`) or when its code is net-zero
 * over the changed files (`netDelta[code] <= 0`). Given `why.baseAudited`
 * (PR mode), the audited count must also have risen against the base's
 * (absent or legacy at the base: the base's own count), so an audit
 * inherited from the base, or re-worded, justifies nothing new (T12954).
 *
 * @param {Record<string, number>} next
 * @param {Record<string, number> | null} base - `null`: no base baseline (seeding).
 * @param {{ audited?: Record<string, unknown>, baseAudited?: Record<string, unknown>, netDelta?: Record<string, number>, counts?: Record<string, number> }} why
 * @returns {string[]}
 */
export function unjustifiedRaises(next, base, why = {}) {
  if (!base) return [];
  const out = [];
  for (const [k, n] of Object.entries(next)) {
    const before = base[k] ?? 0;
    if (n <= before) continue;
    // A raise above the sites that actually exist is never justified: a
    // hand-inflated count or a fake key (#1768 re-review H1).
    if (why.counts && n > (why.counts[k] ?? 0)) {
      out.push(`${k} (${before} -> ${n}, but only ${why.counts[k] ?? 0} untagged site(s) exist)`);
      continue;
    }
    const approved = auditedCount(why.audited?.[k]);
    const floor = why.baseAudited ? (auditedCount(why.baseAudited[k]) ?? before) : -1;
    if (approved !== null && approved >= n && approved > floor) continue;
    if (why.netDelta && (why.netDelta[keyCode(k)] ?? 0) <= 0) continue;
    out.push(`${k} (${before} -> ${n})`);
  }
  return out.sort();
}

/**
 * Net change in untagged sites per code over the files changed against a
 * base. A site counts on the head side only when its file is on a write path
 * at head (`writePath`), and on the base side only when its file was on a
 * write path at the base (`baseWritePath`): a site that was never baselined
 * earns no credit (T12953). Per changed file:
 *
 * - on the base write path (a move, rename or deletion nets to zero): head
 *   minus base, where a loss earns credit only for base sites the base
 *   baseline paid for (`baseBaseline[file :: code]`): the base baseline is
 *   the record of what was paid, whatever the base scan (run with the head's
 *   table classification) finds;
 * - on the head write path only (new, or newly reachable): the head sites
 *   above the base file's own count, so its pre-existing sites cost nothing
 *   and the sites it loses earn nothing;
 * - on neither: nothing.
 *
 * @param {{ changed: readonly string[], headText: (f: string) => string | null,
 *   baseText: (f: string) => string | null, writePath: Set<string>,
 *   baseWritePath: Set<string>, baseBaseline?: Record<string, number> | null,
 *   ctx: { syncTables: Set<string>, schemaSymbols: Map<string, string> },
 *   baseCtx?: { syncTables: Set<string>, schemaSymbols: Map<string, string> },
 *   registry: readonly { id: string, tables: readonly string[] }[] }} input
 * @returns {Record<string, number>}
 */
export function netDeltaByCode({
  changed,
  headText,
  baseText,
  writePath,
  baseWritePath,
  baseBaseline = null,
  ctx,
  baseCtx = ctx,
  registry,
}) {
  const delta = {};
  const countsOf = (text, file, c) => {
    const out = {};
    if (text === null) return out;
    const { sites } = analyseFile(file, text, c);
    const { untagged } = checkSites(
      sites.map((s) => ({ ...s, file })),
      registry,
    );
    for (const s of untagged) out[s.code] = (out[s.code] ?? 0) + 1;
    return out;
  };
  for (const f of changed) {
    const headOn = writePath.has(f) && headText(f) !== null;
    const baseOn = baseWritePath.has(f);
    if (!headOn && !baseOn) continue;
    const head = headOn ? countsOf(headText(f), f, ctx) : {};
    const base = countsOf(baseText(f), f, baseCtx);
    for (const code of new Set([...Object.keys(head), ...Object.keys(base)])) {
      const h = head[code] ?? 0;
      const b = base[code] ?? 0;
      let d;
      if (!baseOn || h >= b) d = Math.max(0, h - b);
      else {
        const paid = baseBaseline ? (baseBaseline[`${f} :: ${code}`] ?? 0) : b;
        d = -Math.max(0, Math.min(b, paid) - h);
      }
      if (d !== 0) delta[code] = (delta[code] ?? 0) + d;
    }
  }
  return delta;
}

/** The `T####` task ids an `audited` map's reasons name. */
export function auditedTasks(audited) {
  return Object.values(audited ?? {}).flatMap(
    (entry) =>
      String(entry && typeof entry === 'object' ? entry.reason : entry).match(/\bT\d+\b/g) ?? [],
  );
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

/**
 * Check that tasks exist and are open.
 *
 * @param {Iterable<string>} tasks
 * @param {(task: string) => { status?: string, error?: string }} statusOf
 * @returns {string[]}
 */
export function taskProblems(tasks, statusOf) {
  const problems = [];
  for (const task of [...new Set(tasks)].sort()) {
    const { status, error } = statusOf(task);
    if (error) problems.push(`task ${task}: ${error}`);
    else if (status && CLOSED_STATUSES.has(status))
      problems.push(`task ${task} is ${status}: it must be open`);
  }
  return problems;
}

function cliStatusOf(task) {
  const bin = process.env.CLEO_BIN || 'cleo';
  const run = spawnSync(bin, ['show', task, '--field', '/data/task/status'], {
    cwd: process.env.CLEO_TASKS_CWD || REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.error) return { error: `cannot run ${bin}: ${run.error.message}` };
  if (run.status !== 0) return { error: `not found (cleo show exited ${run.status})` };
  return { status: run.stdout.trim() };
}

// ---------------------------------------------------------------------------
// Git helpers (PR mode)
// ---------------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A file's text at a ref, or `null` when it does not exist there. */
export function textAt(root, ref, file) {
  try {
    return git(root, ['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

/**
 * Scanned files changed between a ref and the working tree. `--no-renames`
 * lists both sides of a rename, so the old path's sites are subtracted.
 */
export function changedFiles(root, ref, dirs = SOURCE_DIRS) {
  return git(root, ['diff', '--name-only', '--no-renames', ref, '--', ...dirs])
    .split('\n')
    .filter((f) => f && isSource(f));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Parse the command line.
 *
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  const out = { mode: 'check', base: undefined, seed: false, verifyTasks: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.mode = out.mode === 'strict' ? 'strict' : 'check';
    else if (a === '--strict') out.mode = 'strict';
    else if (a === '--update-baseline') out.mode = 'update';
    else if (a === '--report') out.mode = 'report';
    else if (a === '--seed') out.seed = true;
    else if (a === '--verify-tasks') out.verifyTasks = true;
    else if (a === '--base' || a.startsWith('--base=')) {
      const v = a === '--base' ? argv[++i] : a.slice('--base='.length);
      if (!v || v.startsWith('--')) return { error: '--base needs a git ref' };
      out.base = v;
    } else return { error: `unknown argument ${a}` };
  }
  return out;
}

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

/** Read a baseline document (or the empty one). */
export function parseBaseline(text) {
  if (!text) return { sites: {}, audited: {}, burnDown: undefined };
  const doc = JSON.parse(text);
  return { sites: doc.sites ?? {}, audited: doc.audited ?? {}, burnDown: doc.burnDown };
}

/**
 * Run the gate.
 *
 * @param {readonly string[]} [argv]
 * @param {{ root?: string, inputs?: { registry: readonly any[], syncTables: Set<string>, classified: Set<string> }, statusOf?: (t: string) => { status?: string, error?: string } }} [opts]
 * @returns {Promise<number>} 0 OK, 1 problems, 2 bad arguments.
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`lint-sync-write-invariants: ${args.error}\n`);
    return 2;
  }
  const root = opts.root ?? REPO_ROOT;
  const { registry, syncTables, classified } = opts.inputs ?? (await loadRepoInputs());
  const scan = scanTree({
    root,
    syncTables,
    entryFilter: (f) => f.startsWith(ENTRY_PREFIX),
  });
  const { untagged, problems: tagProblems } = checkSites(scan.sites, registry);
  const { exportsOf, callersOf, runtimeSql } = closureHelpers(root, scan);
  const registryProblems = checkRegistry({
    registry,
    classified,
    migrationSql: readMigrationSql(root, [
      'packages/core/migrations',
      'packages/cleo/src/migrations',
    ]),
    runtimeSql,
    exportsOf,
    callersOf,
  });
  const baselineFile = join(root, BASELINE_PATH);
  const baseline = parseBaseline(
    existsSync(baselineFile) ? readFileSync(baselineFile, 'utf8') : '',
  );
  const counts = countKeys(untagged);

  // PR mode inputs.
  let changed = null;
  let netDelta;
  let baseBaseline = null;
  let baseAudited;
  if (args.base) {
    changed = changedFiles(root, args.base);
    const baseText = textAt(root, args.base, BASELINE_PATH);
    const parsed = baseText ? parseBaseline(baseText) : null;
    baseBaseline = parsed?.sites ?? null;
    baseAudited = parsed?.audited ?? {};
    const baseScan = scanTree({
      root,
      syncTables,
      entryFilter: (f) => f.startsWith(ENTRY_PREFIX),
      tree: treeAt(root, args.base),
    });
    netDelta = netDeltaByCode({
      changed,
      headText: (f) =>
        scan.texts.get(f) ??
        (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null),
      baseText: (f) => textAt(root, args.base, f),
      writePath: scan.writePath,
      baseWritePath: baseScan.writePath,
      baseBaseline,
      ctx: scan.ctx,
      baseCtx: baseScan.ctx,
      registry,
    });
  }

  const taskIssues = args.verifyTasks
    ? taskProblems(
        [
          ...registry.filter((e) => e.pending).map((e) => e.pending.task),
          ...(baseline.burnDown ? [baseline.burnDown] : []),
          ...auditedTasks(baseline.audited),
        ],
        opts.statusOf ?? cliStatusOf,
      )
    : [];

  const pending = registry.filter((e) => e.pending).length;
  const summary =
    `${scan.writePath.size} write-path modules (${scan.entries.length} mutate entry points), ` +
    `${scan.sites.length} sites, ${untagged.length} untagged in ${Object.keys(counts).length} keys; ` +
    `registry ${registry.length} entries (${pending} pending)`;

  if (args.mode === 'update') {
    const fatal = [...tagProblems, ...registryProblems, ...taskIssues];
    if (fatal.length > 0) {
      for (const p of fatal) process.stderr.write(`FAIL ${p}\n`);
      process.stderr.write(
        'lint-sync-write-invariants: fix the problems above before rewriting the baseline.\n',
      );
      return 1;
    }
    // Against the base when given; otherwise against the committed baseline.
    const raises = args.seed
      ? []
      : unjustifiedRaises(counts, args.base ? (baseBaseline ?? {}) : baseline.sites, {
          audited: baseline.audited,
          baseAudited,
          netDelta,
        });
    if (raises.length > 0) {
      for (const k of raises) process.stderr.write(`FAIL would add to the baseline: ${k}\n`);
      process.stderr.write(
        'lint-sync-write-invariants: the baseline only shrinks. Tag the new site(s), pass --base <ref> so moves and newly reachable modules net to zero, or list a reviewed raise in "audited" with a T#### reason.\n',
      );
      return 1;
    }
    const sorted = Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    );
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(
      baselineFile,
      `${JSON.stringify(
        {
          $comment: `Untagged rejection sites on synced write paths, per (file :: code). Shrink-only (T12881, gate 38): tag each site with // @sync-invariant <id> and regenerate with node scripts/lint-sync-write-invariants.mjs --update-baseline --base origin/main. Burn-down: ${baseline.burnDown ?? 'T12946'}.`,
          burnDown: baseline.burnDown ?? 'T12946',
          audited: baseline.audited,
          sites: sorted,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `lint-sync-write-invariants: baseline written (${untagged.length} sites, ${Object.keys(sorted).length} keys).\n`,
    );
    return 0;
  }
  if (args.mode === 'report') {
    process.stdout.write(`${summary}\n`);
    for (const e of registry.filter((x) => x.pending))
      process.stdout.write(`  pending ${e.id}: ${e.pending.task} ${e.pending.reason}\n`);
    return 0;
  }

  const { added, stale } = compareBaseline(counts, baseline.sites, {
    staleFiles: changed ? new Set(changed) : null,
  });
  const raises = args.base
    ? unjustifiedRaises(baseline.sites, baseBaseline, {
        audited: baseline.audited,
        baseAudited,
        netDelta,
        counts,
      })
    : [];
  const failures = [
    ...tagProblems,
    ...registryProblems,
    ...taskIssues,
    ...added.map((k) => `untagged rejection site on a synced write path: ${k}`),
    ...stale.map((k) => `stale baseline entry (shrink it with --update-baseline): ${k}`),
    ...raises.map((k) => `baseline raised against ${args.base} without justification: ${k}`),
    ...(args.mode === 'strict'
      ? Object.keys(counts).map((k) => `baselined untagged site: ${k}`)
      : []),
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
  process.stdout.write(
    `lint-sync-write-invariants: OK — ${summary}${args.base ? ` (against ${args.base})` : ''}.\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exit(await main());
