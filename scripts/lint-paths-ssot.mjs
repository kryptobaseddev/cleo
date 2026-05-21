#!/usr/bin/env node
/**
 * Lint rule: enforce `packages/paths/` as the ONLY source of worktree + `.cleo`
 * XDG path resolution — AC1 of T9802 / E-WT-PATHS-SSOT.
 *
 * Why this matters
 * ----------------
 * Saga T9800 SG-WORKTREE-CANON + Council verdict D009 designated
 * `packages/paths/` as the canonical SSoT for all worktree and XDG path
 * computations. T9803 (PR #389) fixed the orphan-`.cleo/` synthesis at the
 * chokepoint level; T9806 (PR #406) added DB open guards. This linter is the
 * CI regression gate that keeps the SSoT clean going forward.
 *
 * Three anti-patterns are flagged (outside `packages/paths/` itself):
 *
 *   1. Direct `import … from 'env-paths'` (or `require('env-paths')`) — the
 *      npm package that wraps XDG logic. All consumers MUST route through
 *      `@cleocode/paths` (which internally uses env-paths in one place).
 *      Suppress with `// env-paths-ok: <reason>`.
 *
 *   2. Hand-rolled XDG reads of the form
 *      `process.env['XDG_DATA_HOME'] ?? join(...)` or
 *      `process.env['XDG_CONFIG_HOME'] ?? join(...)` OUTSIDE `packages/paths/`.
 *      The replacement is `getCleoHome()` / `getCleoPlatformPaths()` from
 *      `@cleocode/paths`. Suppress with `// xdg-raw-ok: <reason>`.
 *
 *   3. Hand-rolled worktree root calculations — `xdgData + '/cleo/worktrees'`
 *      or equivalent string concatenation outside `packages/paths/`.
 *      The replacement is `resolveWorktreeRootForHash()` / `getCleoWorktreesRoot()`
 *      from `@cleocode/paths`. Suppress with `// worktree-path-ok: <reason>`.
 *
 * Baseline mode (default)
 * -----------------------
 * On first run the script writes `scripts/.lint-paths-ssot-baseline.json`
 * with the current violation counts per rule. Subsequent runs FAIL if the
 * count for any rule INCREASES (net-add). Count decreases are always
 * accepted — they mean progress.
 *
 * Pass `--strict` to require zero violations (no baseline tolerance).
 * Pass `--update-baseline` to overwrite the baseline with the current counts.
 *
 * Opt-out
 * -------
 * Per-line: append `// env-paths-ok: <reason>`, `// xdg-raw-ok: <reason>`,
 * or `// worktree-path-ok: <reason>` as a trailing comment.
 * Per-file: add an entry to the FILE_ALLOWLIST in this script with a
 * one-line rationale (reserved for files that MUST use the low-level APIs).
 *
 * Phase note
 * ----------
 * This is PHASE 1 of AC3/AC4: the baseline records the current violation
 * count and CI fails on net-add. Phase 2 (full migration sweep to drive the
 * count to zero across all packages) is tracked as the T9802 follow-up noted
 * in AGENTS.md.
 *
 * @task T9802
 * @epic E-WT-PATHS-SSOT
 * @saga T9800 SG-WORKTREE-CANON
 * @see packages/paths/src/worktree-paths.ts — canonical SSoT
 * @see packages/paths/src/cleo-paths.ts     — canonical SSoT
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

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
  '__tests__',
  'coverage',
  '.next',
  '.svelte-kit',
  'fixtures',
]);

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts']);

/** Suffixes that mark a test fixture file even outside __tests__. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

/** Per-line opt-out markers. */
const OPT_OUT_ENV_PATHS = 'env-paths-ok';
const OPT_OUT_XDG_RAW = 'xdg-raw-ok';
const OPT_OUT_WORKTREE_PATH = 'worktree-path-ok';

/**
 * Files that are explicitly exempt from ALL rules in this linter.
 * Entries use POSIX-style relative paths from the repo root.
 * Keep this list minimal — prefer per-line opt-outs for true one-liners.
 */
const FILE_ALLOWLIST = new Set([
  // packages/paths is the SSoT itself — all XDG reads are legitimate here.
  'packages/paths/src/platform-paths.ts',
  // cleo-os postinstall runs before @cleocode/paths is installed (bootstrap).
  'packages/cleo-os/src/postinstall.ts',
]);

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-paths-ssot-baseline.json';

// ============================================================================
// Patterns
// ============================================================================

/**
 * Rule 1 — direct `env-paths` npm imports outside packages/paths/.
 * Matches `from 'env-paths'`, `from "env-paths"`, `require('env-paths')`.
 */
const RULE_ENV_PATHS = {
  id: 'direct-env-paths-import',
  description:
    "Direct `import … from 'env-paths'` (or require) bypasses the @cleocode/paths SSoT — " +
    'use `getCleoHome()` or `getCleoPlatformPaths()` from `@cleocode/paths` instead.',
  optOut: OPT_OUT_ENV_PATHS,
  regex: /\bfrom\s+['"]env-paths['"]\s*;|\brequire\s*\(\s*['"]env-paths['"]\s*\)/,
  /** Only flag outside packages/paths/ */
  scopeFilter: (/** @type {string} */ relPath) => !relPath.startsWith('packages/paths/'),
};

/**
 * Rule 2 — hand-rolled XDG reads outside packages/paths/.
 * Matches `process.env['XDG_DATA_HOME'] ??` or `process.env["XDG_CONFIG_HOME"] ??`
 * (the actual value-read pattern, not TSDoc/comment mentions).
 */
const RULE_XDG_RAW = {
  id: 'hand-rolled-xdg-read',
  description:
    "Hand-rolled `process.env['XDG_DATA_HOME'] ?? join(...)` bypasses the @cleocode/paths SSoT — " +
    'use `getCleoHome()` or `getCleoPlatformPaths()` from `@cleocode/paths` instead.',
  optOut: OPT_OUT_XDG_RAW,
  regex: /process\.env\s*\[\s*['"]XDG_(?:DATA|CONFIG|STATE)_HOME['"]\s*\]\s*\?\?/,
  scopeFilter: (/** @type {string} */ relPath) => !relPath.startsWith('packages/paths/'),
};

/**
 * Rule 3 — hand-rolled worktree root calculations outside packages/paths/.
 * Matches string literals containing `/cleo/worktrees` which indicates a
 * hand-assembled worktree root path.
 */
const RULE_WORKTREE_PATH = {
  id: 'hand-rolled-worktree-path',
  description:
    "Hand-rolled worktree root calculation (e.g. `xdgData + '/cleo/worktrees'`) bypasses the " +
    '@cleocode/paths SSoT — use `resolveWorktreeRootForHash()` or `getCleoWorktreesRoot()` from ' +
    '`@cleocode/paths` instead.',
  optOut: OPT_OUT_WORKTREE_PATH,
  regex: /['"`][/\\]?cleo[/\\]worktrees['"`]/,
  scopeFilter: (/** @type {string} */ relPath) => !relPath.startsWith('packages/paths/'),
};

const ALL_RULES = [RULE_ENV_PATHS, RULE_XDG_RAW, RULE_WORKTREE_PATH];

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join(posix.sep);
}

/**
 * Strip TSDoc / JSDoc block lines and single-line `//` comments so mentions
 * inside documentation don't trip the linter. Accepts rare false negatives.
 *
 * @param {string} line
 */
function stripComments(line) {
  // TSDoc / JSDoc block line (starts with optional whitespace + `*`)
  if (/^\s*\*/.test(line)) return '';
  // Remove inline `/* … */` chunks first, then strip `//` comments.
  let stripped = line.replace(/\/\*[\s\S]*?\*\//g, '');
  const slashIdx = stripped.indexOf('//');
  if (slashIdx !== -1) stripped = stripped.slice(0, slashIdx);
  return stripped;
}

/** @param {string} name */
function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name);
}

// ============================================================================
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, ruleId: string, message: string, snippet: string}>} */
const violations = [];

/** @param {string} filePath */
function scanFile(filePath) {
  const relPath = toPosixRel(filePath);

  // Global file allowlist
  if (FILE_ALLOWLIST.has(relPath)) return;

  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const code = stripComments(original);
    if (!code.trim()) continue;

    for (const rule of ALL_RULES) {
      if (!rule.scopeFilter(relPath)) continue;
      if (original.includes(rule.optOut)) continue;
      if (!rule.regex.test(code)) continue;

      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: rule.id,
        message: rule.description,
        snippet: original.trim(),
      });
    }
  }
}

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
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

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');

// ============================================================================
// Run
// ============================================================================

for (const dir of SCAN_DIRS) {
  walk(dir);
}

// Build per-rule counts.
/** @type {Record<string, number>} */
const currentCounts = {};
for (const rule of ALL_RULES) {
  currentCounts[rule.id] = 0;
}
for (const v of violations) {
  currentCounts[v.ruleId] = (currentCounts[v.ruleId] ?? 0) + 1;
}

const totalViolations = violations.length;

// ============================================================================
// Strict mode
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-paths-ssot: STRICT OK (zero violations)');
    process.exit(0);
  }
  console.error(`lint-paths-ssot: STRICT FAIL — ${totalViolations} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
    console.error(`    -> ${v.message}`);
  }
  process.exit(1);
}

// ============================================================================
// Baseline mode
// ============================================================================

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-paths-ssot.mjs --update-baseline. ' +
          'DO NOT edit manually. See T9802 / E-WT-PATHS-SSOT for context.',
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-paths-ssot: baseline updated -> ${BASELINE_PATH} (${totalViolations} violations recorded)`,
  );
  process.exit(0);
}

// Load baseline.
/** @type {{counts: Record<string, number>, total: number} | null} */
let baseline = null;
if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error(`lint-paths-ssot: ERROR — could not parse baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }
} else {
  // No baseline yet — write it and succeed on first run.
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-paths-ssot.mjs. ' +
          'DO NOT edit manually. See T9802 / E-WT-PATHS-SSOT for context.',
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-paths-ssot: baseline created -> ${BASELINE_PATH} (${totalViolations} violations recorded). ` +
      'Re-run to check against baseline.',
  );
  process.exit(0);
}

// Compare current counts to baseline — fail on net-add.
/** @type {Array<{ruleId: string, baselineCount: number, currentCount: number, added: number}>} */
const regressions = [];
for (const rule of ALL_RULES) {
  const baselineCount = baseline.counts?.[rule.id] ?? 0;
  const currentCount = currentCounts[rule.id] ?? 0;
  if (currentCount > baselineCount) {
    regressions.push({
      ruleId: rule.id,
      baselineCount,
      currentCount,
      added: currentCount - baselineCount,
    });
  }
}

if (regressions.length === 0) {
  const saved = (baseline.total ?? 0) - totalViolations;
  const savedMsg = saved > 0 ? ` (${saved} violation(s) resolved vs baseline — great work!)` : '';
  console.info(
    `lint-paths-ssot: OK — ${totalViolations} violation(s) (baseline: ${baseline.total ?? 0})${savedMsg}`,
  );
  if (totalViolations > 0) {
    console.info(
      'Run `node scripts/lint-paths-ssot.mjs --update-baseline` after resolving violations to lower the baseline.',
    );
  }
  process.exit(0);
}

// Regressions detected.
console.error(`lint-paths-ssot: FAIL — ${regressions.length} rule(s) regressed vs baseline:\n`);
for (const r of regressions) {
  console.error(
    `  [${r.ruleId}] ${r.baselineCount} -> ${r.currentCount} (+${r.added} violations added)`,
  );
}

console.error('\nNew violations:\n');
for (const v of violations) {
  const reg = regressions.find((r) => r.ruleId === v.ruleId);
  if (!reg) continue;
  console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
  console.error(`    -> ${v.message}`);
}

console.error(
  '\nFix:\n' +
    "  • Rule `direct-env-paths-import`: replace `import envPaths from 'env-paths'` with\n" +
    '    `getCleoHome()` / `getCleoPlatformPaths()` from `@cleocode/paths`.\n' +
    "  • Rule `hand-rolled-xdg-read`: replace `process.env['XDG_DATA_HOME'] ?? join(...)`\n" +
    '    with `getCleoHome()` from `@cleocode/paths`.\n' +
    '  • Rule `hand-rolled-worktree-path`: replace hand-rolled worktree paths with\n' +
    '    `resolveWorktreeRootForHash()` / `getCleoWorktreesRoot()` from `@cleocode/paths`.\n' +
    '  • Per-line opt-out: append `// env-paths-ok: <reason>`, `// xdg-raw-ok: <reason>`,\n' +
    '    or `// worktree-path-ok: <reason>` for genuinely justified exceptions.\n' +
    '  • See packages/paths/src/worktree-paths.ts and cleo-paths.ts for the canonical API.\n',
);
process.exit(1);
