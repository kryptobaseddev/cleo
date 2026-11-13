#!/usr/bin/env node
/**
 * Gate 44: every `@cleocode/contracts/<subpath>` import maps to exactly one
 * source file (T14412).
 *
 * ## What this prevents
 *
 * Vitest and the built packages resolve a contracts subpath differently.
 * Vitest (`vitest-workspace-resolver.ts`) historically mapped `@cleocode/contracts/x.js` to
 * `src/x.ts`, else `src/x/index.ts`. Node resolves the same specifier through
 * the `exports` map of `packages/contracts/package.json` onto `dist/`. In
 * #2772 `@cleocode/contracts/config.js` read `src/config.ts` under vitest while
 * `exports['./config.js']` pointed at `dist/config/index.js`: the tests passed
 * and the build broke.
 *
 * ## Checks (pure static; no build needed)
 *
 * 1. No file/folder collision under `packages/contracts/src`: a module `x.ts`
 *    beside a directory `x/` makes `x.js` name two sources.
 * 2. For every `@cleocode/contracts/<subpath>` specifier (import, re-export,
 *    `import type`, dynamic `import()`) in the runtime source of the packages
 *    gate 40 scans, the `import` and `types` targets that Node's `exports`
 *    resolution picks are the compiled form of the source vitest reads. A
 *    subpath that is not exported, or whose source does not exist, fails too.
 *
 * Zero tolerance: there is no baseline. `--check` and `--strict` are the same.
 *
 * Usage: node scripts/lint-contracts-subpath-resolution.mjs [--check|--strict]
 *
 * @task T14412
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import ts from 'typescript';
import { isMain } from './lib/is-main.mjs';
import { resolveExportsTarget } from './lib/package-exports.mjs';
import { SCANNED_PACKAGES } from './lint-no-contracts-barrel-value-imports.mjs';

export { resolveExportsTarget } from './lib/package-exports.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** The contracts package root, relative to the repo root. */
export const CONTRACTS_DIR = 'packages/contracts';

const PREFIX = '@cleocode/contracts/';

/**
 * Every `@cleocode/contracts/<subpath>` specifier in one source file.
 *
 * @param {string} file - Path used in reports.
 * @param {string} source - TypeScript source.
 * @returns {{ file: string, line: number, specifier: string }[]} One entry per specifier.
 */
export function findSubpathSpecifiers(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = [];
  const record = (literal) => {
    if (!literal.text.startsWith(PREFIX)) return;
    const line = sf.getLineAndCharacterOfPosition(literal.getStart(sf)).line + 1;
    hits.push({ file, line, specifier: literal.text });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      record(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * The `src/` file a `dist/` target is compiled from (`rootDir: src`).
 *
 * @param {string} target - An exports target (`./dist/config/index.js`).
 * @returns {string | null} The source path (`src/config/index.ts`), or null.
 */
export function distTargetToSource(target) {
  const m = /^\.\/dist\/(.+?)(\.d\.ts|\.js)$/.exec(target);
  return m ? `src/${m[1]}.ts` : null;
}

/**
 * The conventional source layout for a contracts subpath: `src/<base>.ts`,
 * else `src/<base>/index.ts` (the Vitest resolver's legacy fallback).
 *
 * @param {string} subpath - The subpath after the package name.
 * @param {(rel: string) => boolean} exists - Whether a package-relative file exists.
 * @returns {string | null} The source path, or null.
 */
export function vitestSource(subpath, exists) {
  const base = subpath.replace(/\.js$/, '');
  for (const rel of [`src/${base}.ts`, posix.join('src', base, 'index.ts')]) {
    if (exists(rel)) return rel;
  }
  return null;
}

/**
 * Module files `x.ts` that sit beside a directory `x/` in the source tree.
 *
 * @param {string[]} files - Package-relative tracked files (`src/a/b.ts`).
 * @returns {{ module: string, dir: string }[]} One entry per collision.
 */
export function findCollisions(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return files
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ module: f, dir: f.slice(0, -'.ts'.length) }))
    .filter(({ dir }) => dirs.has(dir))
    .map(({ module, dir }) => ({ module, dir: `${dir}/` }));
}

/**
 * Problems with one contracts subpath specifier, or an empty list.
 *
 * @param {string} specifier - `@cleocode/contracts/<subpath>`.
 * @param {Record<string, unknown>} exportsMap - `package.json` `exports`.
 * @param {(rel: string) => boolean} exists - Whether a package-relative file exists.
 * @returns {string[]} Human-readable problems.
 */
export function checkSpecifier(specifier, exportsMap, exists) {
  const subpath = specifier.slice(PREFIX.length);
  const source = vitestSource(subpath, exists);
  const problems = [];
  if (source === null)
    problems.push(`no source: neither src/<subpath>.ts nor src/<subpath>/index.ts exists`);
  for (const condition of /** @type {const} */ (['import', 'types'])) {
    const target = resolveExportsTarget(exportsMap, subpath, condition);
    if (target === null) {
      problems.push(`not exported for "${condition}" (Node throws ERR_PACKAGE_PATH_NOT_EXPORTED)`);
      continue;
    }
    const compiledFrom = distTargetToSource(target);
    if (compiledFrom === null || !exists(compiledFrom)) {
      problems.push(`"${condition}" resolves to ${target}, which no src/ file compiles to`);
    } else if (source !== null && compiledFrom !== source) {
      problems.push(
        `"${condition}" resolves to ${target} (from ${compiledFrom}) but vitest reads ${source}`,
      );
    }
  }
  return problems;
}

/** Tracked files under a directory, relative to the repo root. */
function tracked(...paths) {
  return execFileSync('git', ['ls-files', '--', ...paths], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function main() {
  const failures = [];
  const contractsFiles = tracked(`${CONTRACTS_DIR}/src/`).map((f) =>
    f.slice(CONTRACTS_DIR.length + 1),
  );
  for (const { module, dir } of findCollisions(contractsFiles)) {
    failures.push(`${CONTRACTS_DIR}/${module} collides with ${CONTRACTS_DIR}/${dir}`);
  }

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, CONTRACTS_DIR, 'package.json'), 'utf8'));
  const exists = (rel) => existsSync(join(REPO_ROOT, CONTRACTS_DIR, rel));
  const files = tracked(...SCANNED_PACKAGES)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter((f) => !/(^|\/)__tests__\//.test(f) && !/\.(test|spec)\.ts$/.test(f));
  const verdicts = new Map();
  let specifiers = 0;
  for (const file of files) {
    for (const hit of findSubpathSpecifiers(file, readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      specifiers++;
      if (!verdicts.has(hit.specifier)) {
        verdicts.set(hit.specifier, checkSpecifier(hit.specifier, pkg.exports, exists));
      }
      for (const problem of verdicts.get(hit.specifier)) {
        failures.push(`${hit.file}:${hit.line}  ${hit.specifier}: ${problem}`);
      }
    }
  }

  if (failures.length === 0) {
    console.log(
      `lint-contracts-subpath-resolution: OK — no file/folder collision in ${CONTRACTS_DIR}/src; ` +
        `${specifiers} subpath import(s) (${verdicts.size} distinct) in ${files.length} files resolve to the same source in dist as under vitest.`,
    );
    return;
  }
  console.error(`lint-contracts-subpath-resolution: FAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nVitest reads src/<subpath>.ts (else src/<subpath>/index.ts); Node reads the dist/ file the\n' +
      `${CONTRACTS_DIR}/package.json "exports" map picks. They must be the same module: move x.ts to\n` +
      'x/index.ts (or rename it) instead of keeping x.ts beside x/, and point the export at its dist/ form.',
  );
  process.exit(1);
}

if (isMain(import.meta.url)) main();
