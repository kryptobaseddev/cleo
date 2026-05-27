#!/usr/bin/env node
/**
 * lint-no-cwd-walkup.mjs — CI gate: ban getCleoDirAbsolute outside the
 * deprecated shim (paths.ts) and reject manual CWD-walk-up patterns that
 * bypass getProjectRoot().
 *
 * Why this matters (Saga T10295 · Epic T10297 · Task T11019)
 * -----------------------------------------------------------
 * `getCleoDirAbsolute` is the legacy project-root resolver that walks up
 * from a provided `cwd` to find `.cleo/`. The T10297 epic is migrating
 * every internal callsite to `resolveCanonicalCleoDir(projectId)` +
 * `resolveProjectByCwd(cwd)`. Once the migration is complete,
 * `getCleoDirAbsolute` must only exist as a deprecated shim inside
 * `packages/core/src/paths.ts` — its own definition site.
 *
 * This gate enforces two rules:
 *
 *   RULE-1 (getCleoDirAbsolute): Any reference to `getCleoDirAbsolute`
 *   outside `packages/core/src/paths.ts` is a violation. Test files
 *   referencing the shim are exempt (they must test the shim until it is
 *   removed).
 *
 *   RULE-2 (CWD-walk-up): Passing `process.cwd()` directly to
 *   `getProjectRoot()` is a no-op anti-pattern — `getProjectRoot()` already
 *   defaults to `process.cwd()` when called without arguments.
 *
 * Modes
 * -----
 * (default / --strict)  Zero-tolerance — exit 1 on any violation.
 * --baseline            Write current violation counts to a baseline file;
 *                       always exits 0. Overwrites previous baseline.
 * --check               Compare against committed baseline; exit 1 only if
 *                       the total violation count INCREASES above baseline.
 * --json                Emit a JSON summary to stdout (combine with any mode).
 *
 * Baseline file: scripts/.lint-no-cwd-walkup-baseline.json
 *
 * Usage:
 *   node scripts/lint-no-cwd-walkup.mjs                    # strict check
 *   node scripts/lint-no-cwd-walkup.mjs --baseline         # record current
 *   node scripts/lint-no-cwd-walkup.mjs --check            # CI regression guard
 *   node scripts/lint-no-cwd-walkup.mjs --check --json     # CI + JSON output
 *
 * Exit codes:
 *   0 — clean (baseline/check modes: within baseline; strict: no violations)
 *   1 — violations found (strict) OR baseline regression (check)
 *   2 — usage / runtime error
 *
 * @task    T11019
 * @epic    T10297
 * @saga    T10295
 * @see     docs/project-root-conventions.md
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_CHECK = args.includes('--check');
const _MODE_STRICT = args.includes('--strict');
const MODE_JSON = args.includes('--json');
const MODE_HELP = args.includes('--help') || args.includes('-h');

// --files bypass: everything after --files is a literal file path (for testing).
const filesIdx = args.indexOf('--files');
const EXPLICIT_FILES = filesIdx >= 0 ? args.slice(filesIdx + 1).map((f) => resolve(f)) : null;

// Default mode: strict (zero tolerance — the target state post-migration).
const mode = MODE_BASELINE ? 'baseline' : MODE_CHECK ? 'check' : 'strict';

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'scripts', '.lint-no-cwd-walkup-baseline.json');

const SCAN_DIRS = ['packages'];

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  'coverage',
  '.next',
  '.svelte-kit',
  'fixtures',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);

const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

const GET_CLEO_DIR_ABSOLUTE_SHIM = 'packages/core/src/paths.ts';
const GET_CLEO_DIR_ABSOLUTE_RE = /\bgetCleoDirAbsolute\b/;
const GET_PROJECT_ROOT_CWD_RE = /\bgetProjectRoot\s*\(\s*process\.cwd\s*\(\s*\)/;

const ALLOW_INLINE = 'cwd-walkup-ok:';
const ALLOW_GET_CLEO_DIR = 'get-cleodir-ok:';

const RULE_1_FILE_ALLOWLIST = new Set([GET_CLEO_DIR_ABSOLUTE_SHIM]);

const RULE_2_FILE_ALLOWLIST = new Set([
  'packages/core/src/paths.ts',
  'packages/core/src/store/file-utils.ts',
  'packages/core/src/system/runtime.ts',
  'packages/core/src/discovery.ts',
]);

// ============================================================================
// Helpers
// ============================================================================

function isTestFile(relPath) {
  for (const suffix of TEST_FILE_SUFFIXES) {
    if (relPath.endsWith(suffix)) return true;
  }
  return relPath.includes('/__tests__/');
}

// ============================================================================
// Scanner (exportable for tests)
// ============================================================================

/**
 * @typedef {{ file: string, line: number, rule: string, text: string }} Violation
 */

/**
 * Scan a source string for RULE-1 and RULE-2 violations. Exportable for tests.
 */
export function scanSource(src, relPath) {
  /** @type {Violation[]} */
  const results = [];
  const lines = src.split('\n');
  const isTest = isTestFile(relPath);
  const isRule1Allowed = RULE_1_FILE_ALLOWLIST.has(relPath) || isTest;
  const isRule2Allowed = RULE_2_FILE_ALLOWLIST.has(relPath) || isTest;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;

    if (raw.includes(ALLOW_INLINE)) continue;

    if (!isRule1Allowed && !raw.includes(ALLOW_GET_CLEO_DIR)) {
      if (GET_CLEO_DIR_ABSOLUTE_RE.test(raw)) {
        results.push({
          file: relPath,
          line: lineNum,
          rule: 'RULE-1',
          text: raw.trim().substring(0, 120),
        });
      }
    }

    if (!isRule2Allowed) {
      if (GET_PROJECT_ROOT_CWD_RE.test(raw)) {
        results.push({
          file: relPath,
          line: lineNum,
          rule: 'RULE-2',
          text: raw.trim().substring(0, 120),
        });
      }
    }
  }
  return results;
}

/**
 * Parse argv slice. Exportable for tests.
 */
export function parseArgs(argv) {
  const opts = {
    baselineMode: argv.includes('--baseline'),
    checkMode: argv.includes('--check'),
    strictMode: argv.includes('--strict'),
    jsonMode: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
    explicitFiles: /** @type {string[] | null} */ (null),
  };
  const idx = argv.indexOf('--files');
  if (idx >= 0) opts.explicitFiles = argv.slice(idx + 1);
  return opts;
}

/**
 * Programmatic entry-point for testing.
 */
export function runLint(opts, cwd) {
  /** @type {Violation[]} */
  const results = [];

  if (opts.explicitFiles) {
    for (const relPath of opts.explicitFiles) {
      const absPath = join(cwd, relPath);
      try {
        results.push(...scanSource(readFileSync(absPath, 'utf-8'), relPath));
      } catch {
        /* skip unreadable */
      }
    }
  } else {
    for (const scanDir of SCAN_DIRS) {
      const absDir = join(cwd, scanDir);
      if (existsSync(absDir)) _scanTree(absDir, cwd, results);
    }
  }

  const byRule = { 'RULE-1': 0, 'RULE-2': 0 };
  for (const v of results) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;

  return {
    exitCode: results.length === 0 ? 0 : 1,
    violations: results,
    counts: {
      total: results.length,
      byRule,
      rule1Count: byRule['RULE-1'] ?? 0,
      rule2Count: byRule['RULE-2'] ?? 0,
    },
  };
}

function _scanTree(absDir, root, out) {
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(absDir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      _scanTree(full, root, out);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      const relPath = relative(root, full).split(sep).join('/');
      if (!SCAN_DIRS.some((d) => relPath.startsWith(d + '/'))) continue;
      try {
        out.push(...scanSource(readFileSync(full, 'utf-8'), relPath));
      } catch {
        /* skip unreadable */
      }
    }
  }
}

// ============================================================================
// Run the scan
// ============================================================================

/** @type {Violation[]} */
const violations = [];

if (EXPLICIT_FILES) {
  for (const absPath of EXPLICIT_FILES) {
    const relPath = absPath.startsWith(ROOT + sep)
      ? relative(ROOT, absPath).split(sep).join('/')
      : (absPath.split('/').pop() ?? absPath);
    try {
      violations.push(...scanSource(readFileSync(absPath, 'utf-8'), relPath));
    } catch {
      /* skip */
    }
  }
} else {
  for (const scanDir of SCAN_DIRS) {
    const absDir = join(ROOT, scanDir);
    if (existsSync(absDir)) _scanTree(absDir, ROOT, violations);
  }
}

// ============================================================================
// Counts
// ============================================================================

function buildCounts() {
  const byRule = { 'RULE-1': 0, 'RULE-2': 0 };
  for (const v of violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  return {
    total: violations.length,
    byRule,
    rule1Count: byRule['RULE-1'] ?? 0,
    rule2Count: byRule['RULE-2'] ?? 0,
  };
}

// ============================================================================
// CLI bootstrap guard
// ============================================================================

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

// Only run mode handlers when invoked directly (not imported by tests).
if (!invokedDirectly && process.env['VITEST'] === 'true') {
  // Imported by vitest — skip mode handlers, exports are available.
} else if (!invokedDirectly) {
  // Imported by another module — skip mode handlers.
} else {
  // Directly invoked — run mode handlers.

  // --- JSON (early, combined with any mode) ---
  if (MODE_JSON) {
    const counts = buildCounts();
    process.stdout.write(
      JSON.stringify({ gate: 'lint-no-cwd-walkup', mode, ...counts, violations }, null, 2) + '\n',
    );
  }

  // --- Help ---
  if (MODE_HELP) {
    process.stdout.write(
      [
        'lint-no-cwd-walkup.mjs — CI gate: ban getCleoDirAbsolute outside paths.ts',
        '                                and reject getProjectRoot(process.cwd())',
        '',
        'Usage:',
        '  node scripts/lint-no-cwd-walkup.mjs                     # strict (zero tolerance)',
        '  node scripts/lint-no-cwd-walkup.mjs --baseline           # record current state',
        '  node scripts/lint-no-cwd-walkup.mjs --check              # CI regression guard',
        '  node scripts/lint-no-cwd-walkup.mjs --check --json       # CI + JSON output',
        '  node scripts/lint-no-cwd-walkup.mjs --files <p1> <p2>    # check explicit files',
        '',
        'Options:',
        '  --strict   Zero tolerance (default)',
        '  --baseline Write current counts to baseline file',
        '  --check    Compare against baseline; fail only on regressions',
        '  --json     Emit JSON summary to stdout',
        '  --files    Bypass directory walk (testing)',
        '  --help     Show this message',
        '',
        'Exit codes: 0 = clean, 1 = violations/regression, 2 = error',
        '',
        '@task T11019',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }

  // --- Baseline ---
  if (MODE_BASELINE) {
    const counts = buildCounts();
    const data = {
      generatedAt: new Date().toISOString(),
      note: 'Generated by scripts/lint-no-cwd-walkup.mjs --baseline. Run --check in CI to detect regressions.',
      gate: 'lint-no-cwd-walkup',
      total: counts.total,
      rule1Count: counts.rule1Count,
      rule2Count: counts.rule2Count,
      violations: violations.map((v) => ({ file: v.file, line: v.line, rule: v.rule })),
    };
    const scriptsDir = join(ROOT, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
    if (!MODE_JSON) {
      process.stdout.write(
        `[lint-no-cwd-walkup] Baseline written to scripts/.lint-no-cwd-walkup-baseline.json\n`,
      );
      process.stdout.write(
        `[lint-no-cwd-walkup] RULE-1: ${counts.rule1Count} getCleoDirAbsolute reference(s) outside paths.ts\n`,
      );
      process.stdout.write(
        `[lint-no-cwd-walkup] RULE-2: ${counts.rule2Count} getProjectRoot(process.cwd()) anti-pattern(s)\n`,
      );
      process.stdout.write(
        `[lint-no-cwd-walkup] Use --check in CI to fail only on NEW violations above this baseline.\n`,
      );
    }
    process.exit(0);
  }

  // --- Check ---
  if (MODE_CHECK) {
    if (!existsSync(BASELINE_PATH)) {
      process.stderr.write(
        `[lint-no-cwd-walkup] ERROR: baseline not found at ${BASELINE_PATH}. Run --baseline first.\n`,
      );
      process.exit(1);
    }
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
    } catch (e) {
      process.stderr.write(`[lint-no-cwd-walkup] ERROR: bad baseline: ${e.message}\n`);
      process.exit(1);
    }
    const blR1 = baseline.rule1Count ?? 0;
    const blR2 = baseline.rule2Count ?? 0;
    const current = buildCounts();
    const r1Bad = current.rule1Count > blR1;
    const r2Bad = current.rule2Count > blR2;

    if (!r1Bad && !r2Bad) {
      if (!MODE_JSON) {
        const r1d = blR1 - current.rule1Count;
        const r2d = blR2 - current.rule2Count;
        process.stdout.write(
          `[lint-no-cwd-walkup] PASS — RULE-1: ${current.rule1Count} (bl=${blR1})${r1d > 0 ? ` (${r1d} resolved)` : ''} | RULE-2: ${current.rule2Count} (bl=${blR2})${r2d > 0 ? ` (${r2d} resolved)` : ''}\n`,
        );
      }
      process.exit(0);
    }

    if (!MODE_JSON) {
      process.stderr.write(`\n=============================================================\n`);
      process.stderr.write(`CWD-WALKUP REGRESSION — violations increased above baseline\n`);
      process.stderr.write(`=============================================================\n\n`);
      if (r1Bad)
        process.stderr.write(
          `RULE-1: ${blR1}→${current.rule1Count} (+${current.rule1Count - blR1}) getCleoDirAbsolute outside paths.ts\n`,
        );
      if (r2Bad)
        process.stderr.write(
          `RULE-2: ${blR2}→${current.rule2Count} (+${current.rule2Count - blR2}) getProjectRoot(process.cwd())\n`,
        );
      process.stderr.write(
        `\nRemediation: migrate to resolveCanonicalCleoDir (Epic T10297) or remove process.cwd() arg.\n`,
      );
      process.stderr.write(`Baseline update: node scripts/lint-no-cwd-walkup.mjs --baseline\n\n`);
    }
    process.exit(1);
  }

  // --- Strict (default) ---
  if (violations.length === 0) {
    if (!MODE_JSON)
      process.stdout.write(`[lint-no-cwd-walkup] PASS — no CWD-walk-up violations found.\n`);
    process.exit(0);
  }

  if (!MODE_JSON) {
    const counts = buildCounts();
    process.stderr.write(`\n=============================================================\n`);
    process.stderr.write(
      `CWD-WALKUP VIOLATION — ${counts.total} violation(s) (RULE-1: ${counts.rule1Count}, RULE-2: ${counts.rule2Count})\n`,
    );
    process.stderr.write(`=============================================================\n\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.text}\n`);
    }
    process.stderr.write(
      `\nRULE-1: getCleoDirAbsolute must only exist in packages/core/src/paths.ts.\n`,
    );
    process.stderr.write(`        See Epic T10297 for the migration plan.\n\n`);
    process.stderr.write(`RULE-2: getProjectRoot(process.cwd()) is a no-op anti-pattern.\n`);
    process.stderr.write(`        getProjectRoot() defaults to process.cwd() internally.\n\n`);
    process.stderr.write(`Opt-out: // cwd-walkup-ok: <reason> or // get-cleodir-ok: <reason>\n\n`);
  }
  process.exit(1);
}
