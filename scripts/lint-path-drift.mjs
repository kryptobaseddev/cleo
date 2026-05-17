#!/usr/bin/env node
/**
 * Lint rule: reject hard-coded CLEO data-directory paths inside
 * `packages/core/src/`.
 *
 * Why this matters
 * ----------------
 * The `E-CONFIG-AUTH-UNIFY` epic (E1, T9403–T9407) routed every CLEO data
 * directory reference through `@cleocode/paths` (`getCleoHome`, the platform
 * paths resolver, and the new `CLEO_HOME` / `CLEO_CONFIG_HOME` env overrides).
 * That migration is only useful if it stays migrated — a single
 * `join(homedir(), '.local', 'share', 'cleo')` slipped back into the source
 * undoes the work and silently breaks Windows / macOS / `CLEO_HOME`-override
 * users.
 *
 * This linter is the regression gate. It scans `packages/core/src/`
 * (excluding tests / mocks / dist) for three patterns and fails CI if any
 * un-allowlisted match is found:
 *
 *   1. The removed `cleoHomeDir(` symbol (replaced by `getCleoHome` from
 *      `@cleocode/paths` per T9403). Comments mentioning the old name as
 *      part of a migration breadcrumb are tolerated; only function calls
 *      are flagged.
 *   2. The literal `join(homedir(), '.local', 'share', 'cleo')` — the
 *      pre-T9403 hard-coded XDG path. The replacement is `getCleoHome()`
 *      from `@cleocode/paths`.
 *   3. Bare `process.env['XDG_DATA_HOME']` reads. A handful of files
 *      legitimately build platform-aware paths manually (machine-key
 *      crypto root, doctor checks for orphan worktrees, branch-lock
 *      worktree root, llm/catalog-cache). They are allowlisted by
 *      filename. Anything else MUST route through `getCleoPlatformPaths()`
 *      or `getCleoHome()` so the `CLEO_HOME` override is honoured uniformly.
 *
 * Opt-out
 * -------
 * Genuinely-justified exceptions can append `// path-drift-allowed` as a
 * trailing comment on the offending line. Use sparingly. Long-lived
 * exceptions should be added to `KNOWN_XDG_DATA_HOME_FILES` below with a
 * one-line rationale.
 *
 * @task T9407
 * @epic E-CONFIG-AUTH-UNIFY
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/** Directory roots to scan. */
const SCAN_DIRS = ['packages/core/src'];

/** Path segments that mark a directory we should not descend into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  '__tests__',
  'coverage',
]);

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts']);

/** Suffixes that mark a test fixture file even outside __tests__. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

/** Comment marker that suppresses the check for one line. */
const OPT_OUT_MARKER = 'path-drift-allowed';

/**
 * Files that legitimately read `process.env['XDG_DATA_HOME']` directly.
 *
 * These predate the `@cleocode/paths` package and intentionally build
 * platform-aware paths manually (e.g. the machine-key encryption root must
 * exist before the paths package is importable in some bootstrap windows).
 *
 * Paths are POSIX-style and relative to the repository root.
 *
 * NEW additions to this list require a peer review note explaining why the
 * file cannot use `getCleoPlatformPaths()` from `@cleocode/paths`.
 */
const KNOWN_XDG_DATA_HOME_FILES = new Set([
  // Machine-key crypto root — runs in bootstrap windows that must not import
  // the paths package.
  'packages/core/src/crypto/credentials.ts',
  // LLM catalog cache — honours its own `CLEO_DATA_DIR` env override, kept
  // separate from `CLEO_HOME` for catalog-only test isolation.
  'packages/core/src/llm/catalog-cache.ts',
  // Worktree root resolution — needs to mirror the layout produced by spawn
  // shell scripts that compute the path independently.
  'packages/core/src/spawn/branch-lock.ts',
  // Doctor check — audits orphan worktrees by recomputing the same root.
  'packages/core/src/validation/doctor/checks.ts',
]);

/**
 * Patterns we hard-fail on (no allowlist, only the per-line opt-out marker
 * suppresses these). Comments are stripped before matching so historical
 * migration breadcrumbs in TSDoc / `//` lines do not trip the linter.
 */
const HARD_FAIL_PATTERNS = [
  {
    id: 'cleoHomeDir-call',
    description: '`cleoHomeDir(` was removed by T9403 — use `getCleoHome` from `@cleocode/paths`',
    regex: /\bcleoHomeDir\s*\(/,
  },
  {
    id: 'hardcoded-xdg-cleo-path',
    description:
      "Literal `join(homedir(), '.local', 'share', 'cleo')` bypasses `@cleocode/paths` — call `getCleoHome()` instead",
    regex: /join\s*\(\s*homedir\(\)\s*,\s*['"]\.local['"]\s*,\s*['"]share['"]\s*,\s*['"]cleo['"]/,
  },
];

/**
 * Allowlisted pattern: bare `XDG_DATA_HOME` reads. Allowed in the files
 * listed in {@link KNOWN_XDG_DATA_HOME_FILES} and forbidden anywhere else.
 */
const XDG_DATA_HOME_PATTERN = {
  id: 'bare-xdg-data-home',
  description:
    "Bare `process.env['XDG_DATA_HOME']` bypasses `@cleocode/paths` — use `getCleoPlatformPaths()` or `getCleoHome()` instead",
  regex: /process\.env\[\s*['"]XDG_DATA_HOME['"]\s*\]/,
};

// ============================================================================
// Helpers
// ============================================================================

const violations = [];

function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  // Normalise Windows separators so `KNOWN_XDG_DATA_HOME_FILES` membership
  // checks work identically on every platform.
  return rel.split(sep).join(posix.sep);
}

/**
 * Strip line-level comment trailers and most block-comment fragments so a
 * mention of `cleoHomeDir` inside a TSDoc `@deprecated` note never trips the
 * linter. We intentionally accept rare false negatives over false positives.
 */
function stripComments(line) {
  // Single-line `// ...`
  const slashIdx = line.indexOf('//');
  let stripped = slashIdx === -1 ? line : line.slice(0, slashIdx);
  // Inline `/* ... */`
  stripped = stripped.replace(/\/\*[^*]*\*\//g, '');
  return stripped;
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
      if (isTestFile(full)) continue;
      scanFile(full);
    }
  }
}

function scanFile(filePath) {
  const relPath = toPosixRel(filePath);
  const xdgAllowlisted = KNOWN_XDG_DATA_HOME_FILES.has(relPath);

  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const code = stripComments(original);
    if (!code.trim()) continue;
    if (original.includes(OPT_OUT_MARKER)) continue;

    for (const pattern of HARD_FAIL_PATTERNS) {
      if (pattern.regex.test(code)) {
        violations.push({
          file: relPath,
          line: i + 1,
          ruleId: pattern.id,
          message: pattern.description,
          snippet: original.trim(),
        });
      }
    }

    if (!xdgAllowlisted && XDG_DATA_HOME_PATTERN.regex.test(code)) {
      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: XDG_DATA_HOME_PATTERN.id,
        message: XDG_DATA_HOME_PATTERN.description,
        snippet: original.trim(),
      });
    }
  }
}

// ============================================================================
// Run
// ============================================================================

for (const dir of SCAN_DIRS) {
  walk(dir);
}

if (violations.length === 0) {
  console.info(
    'lint-path-drift: OK (no cleoHomeDir / hardcoded ~/.local/share/cleo / bare XDG_DATA_HOME drift)',
  );
  process.exit(0);
}

console.error(`lint-path-drift: FAIL — found ${violations.length} path-drift violation(s):\n`);
for (const v of violations) {
  console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
  console.error(`    -> ${v.message}`);
}
console.error(
  `\nFix:\n` +
    `  • Replace \`cleoHomeDir()\` and hardcoded \`join(homedir(), '.local', 'share', 'cleo')\`\n` +
    `    with \`getCleoHome()\` from \`@cleocode/paths\`.\n` +
    `  • Replace bare \`process.env['XDG_DATA_HOME']\` reads with the resolver\n` +
    `    returned by \`getCleoPlatformPaths()\` from \`@cleocode/paths\`.\n` +
    `  • If a callsite genuinely cannot use the paths package, add its\n` +
    `    repo-relative path to \`KNOWN_XDG_DATA_HOME_FILES\` in this script\n` +
    `    with a one-line rationale, or append \`// ${OPT_OUT_MARKER}\` to\n` +
    `    the offending line.\n`,
);
process.exit(1);
