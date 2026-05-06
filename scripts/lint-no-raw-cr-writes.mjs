#!/usr/bin/env node
/**
 * Lint rule: reject raw `process.stdout.write('\r…')` writes outside
 * `@cleocode/animations`.
 *
 * Why this matters
 * ----------------
 * Animations (spinners, progress bars) work by overwriting the current line
 * with `\r` + escape sequences. Doing this from anywhere other than the
 * `AnimateContext`-gated handles in `@cleocode/animations` breaks the LAFS
 * protocol invariant — a stray spinner write inside `--json`, `--quiet`,
 * non-TTY, or `NO_COLOR` mode corrupts machine-readable output.
 *
 * The single source of truth for `\r` writes is `createSpinnerHandle()`
 * in `@cleocode/animations`. Every other callsite must route through that
 * handle (or a thin adapter like `cleo/src/cli/animation-bridge.ts`).
 *
 * Opt-out
 * -------
 * Genuinely necessary exceptions can append `// raw-cr-allowed` as a trailing
 * comment on the offending line. Use sparingly — usually the right answer is
 * to add the surface to `@cleocode/animations` and consume it from there.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/** Directory roots to scan. */
const SCAN_DIRS = ['packages'];

/** Path segments that mark a directory we should not descend into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  'coverage',
]);

/** Path segments that mark a package whose source is allowed to write `\r`. */
const ALLOW_PACKAGE_SEGMENTS = new Set(['animations']);

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mjs', '.mts', '.js', '.cjs']);

/** Comment marker that suppresses the check for one line. */
const OPT_OUT_MARKER = 'raw-cr-allowed';

/**
 * Pattern matches `process.stdout.write('\r...')` or `process.stderr.write('\r...')`.
 * Both single and double-quoted string literals plus template literals are covered.
 * Backslash-r matched literally because TypeScript source carries the escape.
 */
const RAW_CR_REGEX = /process\.std(?:out|err)\.write\s*\(\s*[`'"]\\r/;

// ============================================================================
// Walker
// ============================================================================

const violations = [];

function isAllowedPackage(filePath) {
  // packages/<name>/...  → check <name>
  const segments = filePath.split(sep);
  const idx = segments.indexOf('packages');
  if (idx === -1) return false;
  const pkgName = segments[idx + 1];
  return ALLOW_PACKAGE_SEGMENTS.has(pkgName);
}

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name);
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (shouldSkipDir(name)) continue;
      walk(full);
    } else if (stat.isFile()) {
      if (!SCAN_EXTS.has(extname(name))) continue;
      if (isAllowedPackage(full)) continue;
      scanFile(full);
    }
  }
}

function scanFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RAW_CR_REGEX.test(line)) continue;
    if (line.includes(OPT_OUT_MARKER)) continue;
    violations.push({ file: filePath, line: i + 1, snippet: line.trim() });
  }
}

// ============================================================================
// Run
// ============================================================================

for (const dir of SCAN_DIRS) {
  walk(dir);
}

if (violations.length === 0) {
  console.info('lint-no-raw-cr-writes: OK (no raw \\r writes outside @cleocode/animations)');
  process.exit(0);
}

console.error(
  `lint-no-raw-cr-writes: FAIL — found ${violations.length} raw \\r write(s) outside @cleocode/animations:\n`,
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
}
console.error(
  `\nFix: route the write through @cleocode/animations createSpinnerHandle.\n` +
    `If genuinely necessary, append a trailing "// ${OPT_OUT_MARKER}" comment on the line.`,
);
process.exit(1);
