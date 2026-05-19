#!/usr/bin/env node
/**
 * Lint rule: enforce CORE-first architecture boundaries.
 *
 * Why this matters (E-CORE-FIRST-ARCH, T9622, D-2, D-3, D-5)
 * -----------------------------------------------------------
 * The CLEO architecture requires that CLI commands and Studio routes act as
 * thin adapters — they must NOT reach into SQLite directly or import from
 * the internal CORE surface. Violations create:
 *
 *   1. Schema coupling — CLI/Studio files that issue raw SQL must be updated
 *      whenever the underlying schema changes, even if CORE already abstracts it.
 *   2. Bypass of public contracts — importing from `@cleocode/core/internal`
 *      bypasses the versioned public barrel and breaks refactor safety.
 *   3. Duplication — raw SQL in Studio routes duplicates logic already in
 *      `@cleocode/core/memory/`, `@cleocode/core/tasks/`, etc.
 *
 * Scanned surfaces:
 *   - packages/cleo/src/cli/commands/    (CLI command handlers)
 *   - packages/studio/src/routes/        (SvelteKit route files)
 *
 * Banned patterns:
 *   RULE-1  Raw `.prepare(` SQLite call in scanned files
 *   RULE-2  `new DatabaseSync(` constructor in scanned files
 *   RULE-3  Import from `@cleocode/core/internal` in CLI commands
 *
 * Modes:
 *   (default)   Scan and print violations; exit 1 if any found.
 *   --baseline  Scan, print violations, write baseline JSON to
 *               .cleo/core-first-baseline.json; always exits 0.
 *   --check     Scan and compare against baseline. Exits 1 only when the
 *               violation count for any rule+file pair EXCEEDS the baseline.
 *               New violations in files not on the baseline also trigger exit 1.
 *   --json      Emit violations as JSON to stdout (combines with any mode).
 *
 * Opt-out for genuinely exceptional cases: append `// core-first-allowed` on
 * the offending line. Use sparingly; add a justification comment.
 *
 * @task T9622
 * @epic T9592
 * @see docs/plans/E-CORE-FIRST-ARCH.md Task 8
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_CHECK = args.includes('--check');
const MODE_JSON = args.includes('--json');

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, '.cleo', 'core-first-baseline.json');

/** Directory segments that are never scanned. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svelte-kit',
  '__snapshots__',
  '__tests__',
]);

/** File extensions to check. */
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs']);

/**
 * Surfaces to scan, each with their own rule set.
 * Each entry: { dir, rules }
 * Rules: array of { id, description, pattern }
 */
const SCAN_SURFACES = [
  {
    dir: 'packages/cleo/src/cli/commands',
    rules: [
      {
        id: 'RULE-1',
        description: 'raw .prepare( SQLite call in CLI command',
        /**
         * Match `.prepare(` as a SQLite statement preparation call.
         * The pattern uses a word-boundary equivalent: the character before
         * `.prepare(` must not be alphanumeric/underscore (prevents false
         * positives like `isPrepared(`). The most reliable signal for raw SQLite.
         */
        pattern: /(?<![a-zA-Z0-9_])\.prepare\s*\(/,
      },
      {
        id: 'RULE-2',
        description: 'new DatabaseSync( constructor in CLI command',
        pattern: /new\s+DatabaseSync\s*\(/,
      },
      {
        id: 'RULE-3',
        description: "import from '@cleocode/core/internal' in CLI command",
        pattern: /from\s+['"]@cleocode\/core\/internal['"]/,
      },
    ],
  },
  {
    dir: 'packages/studio/src/routes',
    rules: [
      {
        id: 'RULE-1',
        description: 'raw .prepare( SQLite call in Studio route',
        pattern: /(?<![a-zA-Z0-9_])\.prepare\s*\(/,
      },
      {
        id: 'RULE-2',
        description: 'new DatabaseSync( constructor in Studio route',
        pattern: /new\s+DatabaseSync\s*\(/,
      },
    ],
  },
];

/** Inline opt-out marker. */
const ALLOW_INLINE = '// core-first-allowed';

/** Regex patterns (matched against relative path) that are always allowed. */
const ALLOW_PATH_REGEXES = [
  // All test files
  /__tests__\//,
  /\.test\.(ts|js|mts|mjs)$/,
  /\.spec\.(ts|js|mts|mjs)$/,
  // Generated files
  /\.generated\.(ts|js)$/,
  /\/generated\//,
];

// ============================================================================
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, rule: string, description: string, text: string}>} */
const violations = [];

function isAllowedPath(relPath) {
  const normalized = relPath.split(sep).join('/');
  return ALLOW_PATH_REGEXES.some((rx) => rx.test(normalized));
}

function scanFile(absPath, rules) {
  const relPath = relative(ROOT, absPath);
  if (isAllowedPath(relPath)) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!rule.pattern.test(line)) continue;
      if (line.includes(ALLOW_INLINE)) continue;

      const lineNum = i + 1;
      violations.push({
        file: relPath,
        line: lineNum,
        rule: rule.id,
        description: rule.description,
        text: line.trim(),
      });
    }
  }
}

function scanDir(dir, rules) {
  const absDir = join(ROOT, dir);
  if (!existsSync(absDir)) {
    if (!MODE_JSON) {
      process.stderr.write(`[core-first-lint] WARNING: scan directory not found: ${dir}\n`);
    }
    return;
  }
  walkDir(absDir, rules);
}

function walkDir(dir, rules) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(full, rules);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      scanFile(full, rules);
    }
  }
}

// Run all surfaces
for (const surface of SCAN_SURFACES) {
  scanDir(surface.dir, surface.rules);
}

// ============================================================================
// Output helpers
// ============================================================================

/**
 * Build a summary map keyed by "rule:file" → count.
 * Used for baseline comparison.
 * @param {typeof violations} viols
 * @returns {Record<string, number>}
 */
function buildCountMap(viols) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const v of viols) {
    const key = `${v.rule}::${v.file}`;
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

// ============================================================================
// Mode: --json
// ============================================================================

if (MODE_JSON) {
  process.stdout.write(
    JSON.stringify(
      {
        violations,
        total: violations.length,
        byRule: buildCountMap(violations),
      },
      null,
      2,
    ) + '\n',
  );
}

// ============================================================================
// Mode: --baseline
// ============================================================================

if (MODE_BASELINE) {
  const baselineData = {
    generatedAt: new Date().toISOString(),
    note: 'Generated by scripts/lint-core-first.mjs --baseline. Run --check to detect regressions.',
    total: violations.length,
    counts: buildCountMap(violations),
    violations: violations.map((v) => ({ file: v.file, line: v.line, rule: v.rule })),
  };

  const dir = join(ROOT, '.cleo');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(baselineData, null, 2) + '\n');

  if (!MODE_JSON) {
    process.stdout.write(`[core-first-lint] Baseline written to ${BASELINE_PATH}\n`);
    process.stdout.write(
      `[core-first-lint] ${violations.length} existing violation(s) recorded as baseline.\n`,
    );
    process.stdout.write(
      `[core-first-lint] Use --check in CI to fail only on NEW violations above this count.\n`,
    );
  }
  process.exit(0);
}

// ============================================================================
// Mode: --check (compare against baseline)
// ============================================================================

if (MODE_CHECK) {
  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write(`[core-first-lint] ERROR: baseline file not found at ${BASELINE_PATH}\n`);
    process.stderr.write(
      `[core-first-lint] Run: node scripts/lint-core-first.mjs --baseline > /dev/null\n`,
    );
    process.stderr.write(
      `[core-first-lint] Then commit ${relative(ROOT, BASELINE_PATH)} to track the baseline.\n`,
    );
    process.exit(1);
  }

  /** @type {{total: number, counts: Record<string, number>}} */
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[core-first-lint] ERROR: could not parse baseline file: ${err.message}\n`,
    );
    process.exit(1);
  }

  const current = buildCountMap(violations);
  const baselineCounts = baseline.counts ?? {};

  /** @type {Array<{key: string, baseline: number, current: number, delta: number}>} */
  const regressions = [];

  // Check for counts that exceed the baseline
  for (const [key, count] of Object.entries(current)) {
    const baselineCount = baselineCounts[key] ?? 0;
    if (count > baselineCount) {
      regressions.push({
        key,
        baseline: baselineCount,
        current: count,
        delta: count - baselineCount,
      });
    }
  }

  if (regressions.length === 0) {
    if (!MODE_JSON) {
      process.stdout.write(
        `[core-first-lint] PASS — no new CORE-first violations above baseline (${violations.length} known).\n`,
      );
    }
    process.exit(0);
  }

  if (!MODE_JSON) {
    process.stderr.write(`\n`);
    process.stderr.write(`==========================================================\n`);
    process.stderr.write(`CORE-FIRST VIOLATION — new violations detected above baseline\n`);
    process.stderr.write(`==========================================================\n`);
    process.stderr.write(`\n`);

    for (const reg of regressions) {
      const [rule, file] = reg.key.split('::');
      process.stderr.write(
        `  ${file}  [${rule}]  baseline=${reg.baseline} current=${reg.current} (+${reg.delta})\n`,
      );
    }

    // Also print the actual new violation lines
    const baselineViolSet = new Set(
      (baseline.violations ?? []).map((v) => `${v.file}:${v.line}:${v.rule}`),
    );
    const newViols = violations.filter(
      (v) => !baselineViolSet.has(`${v.file}:${v.line}:${v.rule}`),
    );

    if (newViols.length > 0) {
      process.stderr.write(`\nNew violation lines:\n`);
      for (const v of newViols) {
        process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]  ${v.description}\n`);
        process.stderr.write(`    ${v.text}\n`);
      }
    }

    process.stderr.write(`\n`);
    process.stderr.write(`Fix: route DB access through @cleocode/core operations.\n`);
    process.stderr.write(`     See docs/plans/E-CORE-FIRST-ARCH.md for migration patterns.\n`);
    process.stderr.write(
      `     Opt-out: append \`// core-first-allowed\` with a justification comment.\n`,
    );
    process.stderr.write(`\n`);
  }

  process.exit(1);
}

// ============================================================================
// Default mode: fail on any violation
// ============================================================================

if (violations.length > 0) {
  if (!MODE_JSON) {
    process.stderr.write(`\n`);
    for (const v of violations) {
      process.stderr.write(`${v.file}:${v.line}  [${v.rule}]  ${v.description}\n`);
    }
    process.stderr.write(`\n`);
    process.stderr.write(`============================================================\n`);
    process.stderr.write(
      `CORE-FIRST VIOLATION — ${violations.length} violation(s) found across scanned surfaces\n`,
    );
    process.stderr.write(`============================================================\n`);
    process.stderr.write(`\n`);
    process.stderr.write(`RULE-1: route DB access through @cleocode/core operations.\n`);
    process.stderr.write(
      `RULE-2: use openCleoDb(role, cwd) from @cleocode/core/store/open-cleo-db.\n`,
    );
    process.stderr.write(`RULE-3: import from @cleocode/core (public barrel), not /internal.\n`);
    process.stderr.write(`\n`);
    process.stderr.write(`See docs/plans/E-CORE-FIRST-ARCH.md for migration patterns.\n`);
    process.stderr.write(
      `Opt-out: append \`// core-first-allowed\` with a justification comment.\n`,
    );
    process.stderr.write(`\n`);
    process.stderr.write(
      `Tip: while T9616-T9621 are in-flight, use --baseline + --check mode in CI.\n`,
    );
    process.stderr.write(`     node scripts/lint-core-first.mjs --baseline\n`);
    process.stderr.write(`     node scripts/lint-core-first.mjs --check\n`);
    process.stderr.write(`\n`);
  }
  process.exit(1);
}

if (!MODE_JSON) {
  process.stdout.write(
    `[core-first-lint] PASS — no CORE-first violations found in scanned surfaces.\n`,
  );
}
process.exit(0);
