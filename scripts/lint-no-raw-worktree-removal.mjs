#!/usr/bin/env node
/**
 * Gate 41: no raw worktree removal outside the disposal engine (T14276 AC2 · T13924).
 *
 * ## What this prevents
 *
 * Seven paths used to delete worktrees under three policies, and one of them
 * (`pruneWorktree`, run by `cleo complete`) force-removed dirty worktrees. All
 * of them now go through `disposeWorktree` in
 * `packages/worktree/src/worktree-dispose.ts`, which removes a worktree only
 * with proof that nothing in it is lost, and otherwise keeps it (or, for
 * `destroy --force`, archives it first). A new caller of the raw removal would
 * reopen the hole silently, so this gate refuses one.
 *
 * ## Checks
 *
 * Every `*.ts`/`*.mts`/`*.tsx`/`*.js`/`*.mjs` under `packages/<pkg>/src/`
 * (tests, `__tests__/` and `.d.ts` excluded), with comments and string text
 * blanked first. Outside the engine file it fails on:
 *
 * - the identifiers `napiDestroyWorktree`, `forceRemoveWorktreeDir` and
 *   `removeWorktreeFromDisk` (the former raw removals and their aliases);
 * - an import of the native `destroyWorktree` from the napi binding module.
 *
 * Zero tolerance: there is no baseline. `--check` and `--strict` are the same.
 *
 * Usage: node scripts/lint-no-raw-worktree-removal.mjs [--check|--strict]
 *
 * @task T14276
 * @task T13924
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from './lint-no-esm-bare-require.mjs';

/** The one file allowed to remove a worktree. */
export const ENGINE_FILE = 'packages/worktree/src/worktree-dispose.ts';

/** Raw removal identifiers no other file may name. */
const RAW_REMOVAL =
  /(?<![\w$])(napiDestroyWorktree|forceRemoveWorktreeDir|removeWorktreeFromDisk)(?![\w$])/g;

/** `import { …destroyWorktree… } from '…napi-binding…'`, multi-line import blocks included. */
const NAPI_DESTROY_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bdestroyWorktree\b[^}]*\}\s*from\s*(['"])[^'"]*napi-binding[^'"]*\1/g;

const SOURCE_EXT = /\.(ts|mts|tsx|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|mts|tsx|js|mjs)$/;

/**
 * Find every raw worktree removal in one source text.
 *
 * @param {string} src - Module source.
 * @returns {{ line: number, text: string }[]}
 */
export function findRawRemovals(src) {
  const code = blankNonCode(src);
  const lines = src.split('\n');
  const hits = [];
  const at = (index) => {
    const line = code.slice(0, index).split('\n').length;
    hits.push({ line, text: lines[line - 1].trim() });
  };
  RAW_REMOVAL.lastIndex = 0;
  for (let m = RAW_REMOVAL.exec(code); m !== null; m = RAW_REMOVAL.exec(code)) at(m.index);
  // The module specifier is string text, blanked in `code`: match on the source,
  // keeping only imports that start where `code` still has the `import` keyword.
  NAPI_DESTROY_IMPORT.lastIndex = 0;
  for (let m = NAPI_DESTROY_IMPORT.exec(src); m !== null; m = NAPI_DESTROY_IMPORT.exec(src)) {
    if (code.startsWith('import', m.index)) at(m.index);
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Recursively list scannable source files under a directory.
 *
 * @param {string} dir - Absolute directory.
 * @returns {string[]} Absolute paths.
 */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(abs));
    } else if (
      entry.isFile() &&
      SOURCE_EXT.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !TEST_FILE.test(entry.name)
    ) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Run the gate against a repo root.
 *
 * @param {string} repoRoot - Repository root.
 * @returns {{ ok: boolean, scanned: number, violations: string[] }}
 */
export function runGate(repoRoot) {
  const pkgsDir = join(repoRoot, 'packages');
  const roots = existsSync(pkgsDir)
    ? readdirSync(pkgsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(pkgsDir, e.name, 'src')))
        .map((e) => join(pkgsDir, e.name, 'src'))
    : [];
  const files = roots.flatMap(listSourceFiles);
  const violations = [];
  for (const abs of files) {
    const rel = relative(repoRoot, abs).split(sep).join('/');
    if (rel === ENGINE_FILE) continue;
    for (const h of findRawRemovals(readFileSync(abs, 'utf8'))) {
      violations.push(`${rel}:${h.line}: ${h.text}`);
    }
  }
  return { ok: files.length > 0 && violations.length === 0, scanned: files.length, violations };
}

/** Entry point. */
function main() {
  const result = runGate(process.cwd());
  if (result.scanned === 0) {
    console.error(
      'lint-no-raw-worktree-removal: FAIL — found no source files to scan. ' +
        'The scan lost its input; this is not a clean repo.',
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `lint-no-raw-worktree-removal: FAIL — ${result.violations.length} raw worktree removal(s) outside ${ENGINE_FILE}:\n`,
    );
    for (const v of result.violations) console.error(`  • ${v}`);
    console.error(
      '\nDispose of a worktree with `disposeWorktree` from @cleocode/worktree (T13924): it removes only with proof that nothing is lost.',
    );
    process.exit(1);
  }
  console.log(
    `lint-no-raw-worktree-removal: OK — ${result.scanned} source file(s); every worktree removal goes through ${ENGINE_FILE}.`,
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
