#!/usr/bin/env node
/**
 * Gate: no bare `require()` in ESM sources (T12704).
 *
 * ## What this prevents
 *
 * An ES module has no `require`. A bare `require('node:fs')` in a package with
 * `"type": "module"` throws `ReferenceError: require is not defined` when it
 * runs under Node — but vitest supplies a `require`, so the unit tests stay
 * green while the shipped build fails. Most sites sit inside a `try` or a
 * best-effort path, so the failure is silent. Measured 2026-09-29:
 *
 *   - `docs/docs-audit.ts` never created the audit secret, so the docs audit
 *     trail wrote nothing (the error was swallowed by `writeAuditEntry`).
 *   - `validation/doctor/checks.ts` skipped both canonical-path sub-checks
 *     (deprecated flat dirs, misplaced rcasd root files) and reported `passed`.
 *   - `worktree/worktree-include.ts` sent every spawn to the literal-only
 *     symlink fallback, so no `.worktreeinclude` glob ever copied (T12685).
 *
 * Use a static `import`, a dynamic `await import()`, or bind a local
 * `const require = createRequire(import.meta.url)` in the file.
 *
 * ## Checks
 *
 * Every `*.ts`/`*.mts`/`*.tsx`/`*.js`/`*.mjs` under `packages/<pkg>/src/`,
 * for each package whose `package.json` declares `"type": "module"` (tests,
 * `__tests__/` and `.d.ts` excluded). Comments and string/template-literal
 * text are blanked first, so a `require(` in documentation or in generated
 * child-process source is not a violation. A file that binds `require` itself
 * (`const require = createRequire(...)`) is exempt.
 *
 * ## Baseline
 *
 * `worktree-include.ts` is owned by PR #1679 (T12685), which replaces its
 * `require` with a static import. It is baselined at its current count so the
 * two PRs do not conflict; delete the entry when #1679 lands. A count ABOVE
 * the baseline fails; `--strict` ignores the baseline entirely.
 *
 * Usage: node scripts/lint-no-esm-bare-require.mjs [--check|--strict]
 *
 * @task T12704
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the workspace packages, relative to the repo root. */
export const PACKAGES_ROOT = 'packages';

/**
 * Per-file allowed counts. Each entry names the task that removes it.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const BASELINE = Object.freeze({
  // PR #1679 (T12685) replaces this require with a static import; delete
  // this entry once it lands.
  'packages/worktree/src/worktree-include.ts': 1,
});

const SOURCE_EXT = /\.(ts|mts|tsx|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|mts|tsx|js|mjs)$/;

/** A bare call: `require(` not preceded by `.`, an identifier char or `$`. */
const BARE_REQUIRE = /(?<![.\w$])require\s*\(/g;

/** A local binding that makes `require` legitimate in this file. */
const LOCAL_BINDING = /\b(?:const|let|var)\s+require\s*=/;

/**
 * Blank comments and the text of string and template literals, keeping
 * newlines (so line numbers survive) and the code inside `${…}`.
 *
 * @param {string} src
 * @returns {string}
 */
export function blankNonCode(src) {
  let out = '';
  let i = 0;
  /** Brace depth per open template `${`, innermost last. */
  const templateStack = [];
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : '');
      i = src[j] === c ? j + 1 : j;
    } else if (c === '`' || (c === '}' && templateStack.at(-1) === 0)) {
      // Template text: from an opening backtick, or resuming after `${…}`.
      if (c === '}') templateStack.pop();
      let j = i + 1;
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) {
        j += src[j] === '\\' ? 2 : 1;
      }
      out += c + blank(src.slice(i + 1, j));
      if (src[j] === '$') {
        out += '${';
        templateStack.push(0);
        i = j + 2;
      } else {
        out += src[j] === '`' ? '`' : '';
        i = j + 1;
      }
    } else {
      if (templateStack.length > 0) {
        if (c === '{') templateStack[templateStack.length - 1] += 1;
        else if (c === '}') templateStack[templateStack.length - 1] -= 1;
      }
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Find every bare `require(` in one ESM source text.
 *
 * @param {string} src - Module source.
 * @returns {{ line: number, text: string }[]} Empty when the file binds `require` itself.
 */
export function findBareRequires(src) {
  const code = blankNonCode(src);
  if (LOCAL_BINDING.test(code)) return [];
  const lines = src.split('\n');
  const hits = [];
  BARE_REQUIRE.lastIndex = 0;
  for (let m = BARE_REQUIRE.exec(code); m !== null; m = BARE_REQUIRE.exec(code)) {
    const line = code.slice(0, m.index).split('\n').length;
    hits.push({ line, text: lines[line - 1].trim() });
  }
  return hits;
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
 * The `src/` directory of every workspace package that declares `"type": "module"`.
 *
 * @param {string} repoRoot - Repository root.
 * @returns {string[]} Absolute `src/` paths.
 */
export function esmSourceRoots(repoRoot) {
  const pkgsDir = join(repoRoot, PACKAGES_ROOT);
  if (!existsSync(pkgsDir)) return [];
  const roots = [];
  for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJson = join(pkgsDir, entry.name, 'package.json');
    const src = join(pkgsDir, entry.name, 'src');
    if (!existsSync(pkgJson) || !existsSync(src)) continue;
    const { type } = JSON.parse(readFileSync(pkgJson, 'utf8'));
    if (type === 'module') roots.push(src);
  }
  return roots.sort();
}

/**
 * Run the gate against a repo root.
 *
 * @param {string} repoRoot - Repository root.
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ ok: boolean, scanned: number, violations: string[], notes: string[] }}
 */
export function runGate(repoRoot, opts = {}) {
  const files = esmSourceRoots(repoRoot).flatMap(listSourceFiles);
  const violations = [];
  const notes = [];
  const seen = new Set();
  for (const abs of files) {
    const rel = relative(repoRoot, abs).split(sep).join('/');
    seen.add(rel);
    const hits = findBareRequires(readFileSync(abs, 'utf8'));
    const allowed = opts.strict ? 0 : (BASELINE[rel] ?? 0);
    if (hits.length > allowed) {
      for (const h of hits) violations.push(`${rel}:${h.line}: ${h.text}`);
    } else if (hits.length < allowed) {
      notes.push(`${rel}: baseline allows ${allowed}, found ${hits.length} — tighten BASELINE.`);
    }
  }
  for (const rel of Object.keys(BASELINE)) {
    if (!seen.has(rel)) notes.push(`${rel}: baselined but not scanned — delete the entry.`);
  }
  return {
    ok: files.length > 0 && violations.length === 0,
    scanned: files.length,
    violations,
    notes,
  };
}

/** Entry point. */
function main() {
  const strict = process.argv.includes('--strict');
  const result = runGate(process.cwd(), { strict });
  for (const n of result.notes) console.log(`lint-no-esm-bare-require: note — ${n}`);
  if (result.scanned === 0) {
    console.error(
      'lint-no-esm-bare-require: FAIL — found no ESM source files to scan. ' +
        'The scan lost its input; this is not a clean repo.',
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `lint-no-esm-bare-require: FAIL — ${result.violations.length} bare require() call(s) in ESM:\n`,
    );
    for (const v of result.violations) console.error(`  • ${v}`);
    console.error(
      '\nAn ES module has no `require`: this throws "require is not defined" under Node ' +
        '(vitest supplies one, so tests stay green). Use a static `import`, `await import()`, ' +
        'or bind `const require = createRequire(import.meta.url)` in the file.',
    );
    process.exit(1);
  }
  console.log(
    `lint-no-esm-bare-require: OK — ${result.scanned} ESM source file(s), no bare require().`,
  );
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  main();
}
