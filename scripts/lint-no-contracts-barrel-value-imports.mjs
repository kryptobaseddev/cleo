#!/usr/bin/env node
/**
 * Contracts barrel value-import guard (T13126).
 *
 * `@cleocode/contracts`'s index re-exports every contracts module, and loading
 * it evaluates every contracts zod schema: ~40 MB of heap in each process. A
 * runtime import of ONE value from the barrel (`ExitCode`, `OPERATIONS`, a
 * schema) paid all of it, and core's store layer did exactly that, so every
 * `cleo` command that opened a store loaded the whole barrel. Type-only imports
 * are erased at compile time and cost nothing.
 *
 * Rule: in the runtime source of the packages below, a VALUE imported from
 * `@cleocode/contracts` comes from the module that declares it
 * (`@cleocode/contracts/<path>.js`), never from the bare barrel. Allowed:
 *
 * - `import type { … } from '@cleocode/contracts'` and inline `type` specifiers;
 * - `export type { … } from '@cleocode/contracts'`;
 * - the public barrels listed in {@link BARREL_ENTRIES}, which re-export
 *   contracts as part of their own API (`export * from '@cleocode/contracts'`).
 *
 * Tests are exempt. {@link BASELINE} pins the few files that still import
 * from the barrel; it may only shrink, and a stale entry fails.
 *
 * Usage: node scripts/lint-no-contracts-barrel-value-imports.mjs [--check|--strict]
 *
 * @task T13126
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Packages whose runtime source the CLI loads; each is scanned. */
export const SCANNED_PACKAGES = Object.freeze([
  'packages/core/src/',
  'packages/cleo/src/',
  'packages/runtime/src/',
  'packages/caamp/src/',
  'packages/nexus/src/',
  'packages/git-shim/src/',
  'packages/worktree/src/',
]);

/** Public barrels that re-export contracts as part of their API. */
export const BARREL_ENTRIES = Object.freeze([
  'packages/core/src/index.ts',
  'packages/core/src/internal.ts',
  'packages/core/src/contracts.ts',
]);

/**
 * Files that still import a value from the barrel, and why (may only shrink).
 *
 * Each is documented by a core skill (gate 32), so touching it requires a
 * skill version bump, and ct-cleo's version is pinned to CLEO-INJECTION.md.
 * None is on a barrel-free path: the CLI loads the CORE barrel (which
 * re-exports contracts) before these commands run. Convert each when its
 * skill next changes, and delete its entry.
 */
export const BASELINE = Object.freeze([
  'packages/cleo/src/cli/commands/docs.ts',
  'packages/cleo/src/cli/commands/nexus.ts',
  'packages/cleo/src/cli/commands/session.ts',
  'packages/cleo/src/cli/commands/sticky.ts',
  'packages/cleo/src/cli/commands/verify.ts',
  'packages/core/src/orchestration/lead-rollup.ts',
]);

const BARREL = '@cleocode/contracts';

/**
 * Value imports and re-exports of the contracts barrel in one source file.
 *
 * @param {string} file - Path used in reports.
 * @param {string} source - TypeScript source.
 * @returns {{ file: string, line: number, text: string }[]} One entry per offending statement.
 */
export function findBarrelValueImports(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = [];
  const report = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ file, line, text: node.getText(sf).split('\n')[0] ?? '' });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === BARREL
    ) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          const named = clause.namedBindings;
          const valueSpecifier =
            clause.name !== undefined ||
            (named !== undefined &&
              (ts.isNamespaceImport(named) || named.elements.some((el) => !el.isTypeOnly)));
          if (valueSpecifier) report(node);
        } else if (!clause) {
          report(node); // side-effect import evaluates the barrel
        }
      } else if (!node.isTypeOnly) {
        const clause = node.exportClause;
        const valueSpecifier =
          clause === undefined || // export * from
          ts.isNamespaceExport(clause) ||
          clause.elements.some((el) => !el.isTypeOnly);
        if (valueSpecifier) report(node);
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === BARREL
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Tracked, non-test TypeScript files in the scanned packages. */
function scannedFiles() {
  const out = execFileSync('git', ['ls-files', '--', ...SCANNED_PACKAGES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter((f) => !/(^|\/)__tests__\//.test(f) && !/\.(test|spec)\.ts$/.test(f))
    .filter((f) => !BARREL_ENTRIES.includes(f));
}

function main() {
  const hits = [];
  const stale = [];
  const files = scannedFiles();
  for (const file of files) {
    const found = findBarrelValueImports(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
    if (BASELINE.includes(file)) {
      if (found.length === 0) stale.push(file);
      continue;
    }
    hits.push(...found);
  }
  for (const file of BASELINE) if (!files.includes(file)) stale.push(file);
  if (stale.length > 0) {
    console.error(
      'lint-no-contracts-barrel-value-imports: FAIL — baselined file(s) no longer import from the barrel; delete them from BASELINE:',
    );
    for (const file of stale) console.error(`  ${file}`);
    process.exit(1);
  }
  if (hits.length === 0) {
    console.log(
      `lint-no-contracts-barrel-value-imports: OK — ${files.length} files scanned; none outside the ${BASELINE.length}-file baseline imports a value from the @cleocode/contracts barrel.`,
    );
    return;
  }
  console.error(
    `lint-no-contracts-barrel-value-imports: FAIL — ${hits.length} value import(s) from the @cleocode/contracts barrel:`,
  );
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`);
  console.error(
    '\nImport each value from the module that declares it, e.g.\n' +
      "  import { ExitCode } from '@cleocode/contracts/exit-codes.js';\n" +
      'Type-only imports may stay on the barrel (they are erased). The barrel evaluates every contracts zod schema (~40 MB of heap).',
  );
  process.exit(1);
}

if (isMain(import.meta.url)) main();
