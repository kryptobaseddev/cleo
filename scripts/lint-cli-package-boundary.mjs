#!/usr/bin/env node
/**
 * Lint rule: enforce CLI package boundary — no business-logic helpers > 30 LOC
 * in packages/cleo/src/cli/commands/*.ts.
 *
 * Why this matters (SG-ARCH-SOLID T9837e, E-SSOT-ENFORCEMENT T9837)
 * ------------------------------------------------------------------
 * The CLEO architecture mandates that `packages/cleo/` is a thin dispatch
 * layer. Every `commands/*.ts` file should only contain:
 *
 *   a) `defineCommand({...})` command-object declarations (citty definitions)
 *   b) Very small local wiring (<= 30 LOC) that parses CLI args and calls
 *      into `@cleocode/core` or `dispatchFromCli`.
 *
 * Business-logic helpers that grow beyond 30 LOC belong in `packages/core/`
 * where they can be unit-tested without spinning up the CLI, imported by other
 * packages, and kept separate from citty framework concerns.
 *
 * What is flagged (RULE-1)
 * -----------------------
 * Any standalone function declaration (named `function foo(...)`) inside
 * `packages/cleo/src/cli/commands/**\/*.ts` (excluding `__tests__/` and
 * `*.test.ts`) whose body spans > 30 lines is a violation. "Dispatch
 * wrappers" — functions that solely call `defineCommand`, `dispatchFromCli`,
 * or `showUsage` — are exempt.
 *
 * What is NOT flagged
 * -------------------
 * - `defineCommand({...})` assignments (dispatch definitions)
 * - Arrow-function variables assigned to a `defineCommand` shape
 * - Functions named `make*Command` or `*Command` (naming convention for
 *   command factory helpers that remain CLI-specific by design)
 * - Functions annotated with `// cli-boundary-ok: <reason>`
 * - Any file annotated with `// cli-boundary-file-ok: <reason>` at the top
 *
 * Modes
 * -----
 * (default)   Scan and print violations; exit 1 if any found.
 * --baseline  Write current violation set to scripts/.lint-cli-boundary-baseline.json;
 *             always exits 0. Overwrites any previous baseline.
 * --check     Compare against baseline; exit 1 only if the total violation
 *             count INCREASES above the baseline. Count decreases are accepted.
 * --strict    Exit 1 on any violation regardless of baseline (zero-tolerance).
 * --json      Emit a JSON summary to stdout (combine with any mode).
 *
 * Example violation and remediation
 * -----------------------------------
 * VIOLATION:
 *   packages/cleo/src/cli/commands/release.ts:42 [RULE-1]
 *   function buildChangelogSection (87 LOC) — extract to packages/core/
 *
 * REMEDIATION:
 *   1. Move `buildChangelogSection` to packages/core/src/release/changelog.ts
 *   2. Export it from the core barrel
 *   3. Import it back in the CLI command file
 *   4. Re-run: node scripts/lint-cli-package-boundary.mjs --baseline (update baseline)
 *
 * @task T10076
 * @epic T9837
 * @saga T9831 SG-ARCH-SOLID
 * @see AGENTS.md § "Architectural Boundary Check (SG-ARCH-SOLID)"
 * @see packages/cleo/src/cli/commands/ — scanned surface
 * @see packages/core/ — correct home for business-logic helpers
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_CHECK = args.includes('--check');
const MODE_STRICT = args.includes('--strict');
const MODE_JSON = args.includes('--json');

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'scripts', '.lint-cli-boundary-baseline.json');

/** LOC threshold above which a non-dispatch helper is flagged. */
const LOC_THRESHOLD = 30;

/** Directory segments that are never descended into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  '__tests__',
]);

/** File extensions to scan. */
const SCAN_EXTENSIONS = new Set(['.ts', '.mts']);

/** Directory to scan (relative to repo root). */
const SCAN_DIR = 'packages/cleo/src/cli/commands';

/**
 * Function names matching these patterns are treated as dispatch-related
 * and exempt from the rule, regardless of their LOC.
 *
 * Rationale: `make*Command` / `*Command` are naming conventions for
 * citty command-factory helpers that MUST remain in the CLI package
 * because they reference `defineCommand` directly.
 */
const EXEMPT_NAME_RE = /(?:Command|makeCommand|make[A-Z]\w*Command)$/;

/**
 * Per-line opt-out marker. Append to the function declaration line.
 * Must include a non-empty reason after the colon.
 */
const ALLOW_INLINE = '// cli-boundary-ok:';

/**
 * Per-file opt-out marker. Place in a comment anywhere in the first 20 lines.
 * Must include a non-empty reason after the colon.
 */
const ALLOW_FILE = '// cli-boundary-file-ok:';

// ============================================================================
// Function body parser
// ============================================================================

/**
 * Count lines in a function body starting at `startLine` (0-indexed).
 * Uses brace depth tracking. Returns the 0-indexed end line.
 *
 * @param {string[]} lines
 * @param {number} startLine
 * @returns {number} 0-indexed end line index, or startLine if parsing fails.
 */
function findFunctionEnd(lines, startLine) {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        foundOpen = true;
      } else if (ch === '}') {
        depth--;
        if (foundOpen && depth === 0) return i;
      }
    }
  }
  return startLine;
}

/**
 * Detect whether a file opts out entirely from this lint rule.
 * Checks only the first 20 lines for the ALLOW_FILE marker.
 *
 * @param {string[]} lines
 * @returns {boolean}
 */
function fileIsAllowed(lines) {
  const checkUntil = Math.min(lines.length, 20);
  for (let i = 0; i < checkUntil; i++) {
    if (lines[i].includes(ALLOW_FILE)) return true;
  }
  return false;
}

// ============================================================================
// Scanner
// ============================================================================

/**
 * @typedef {{
 *   file: string;
 *   line: number;
 *   rule: string;
 *   funcName: string;
 *   loc: number;
 *   text: string;
 * }} Violation
 */

/** @type {Violation[]} */
const violations = [];

/**
 * Named-function declaration pattern.
 * Matches:
 *   function foo(
 *   async function foo(
 *   export function foo(
 *   export async function foo(
 *
 * Does NOT match arrow functions assigned to `const`, since those are
 * typically either very short wrappers or `defineCommand` shapes.
 */
const FUNC_DECL_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/;

/**
 * Scan a single TypeScript file for oversized non-dispatch helper functions.
 *
 * @param {string} absPath
 */
function scanFile(absPath) {
  const relPath = relative(ROOT, absPath).split(sep).join('/');

  // Skip test files
  if (relPath.includes('__tests__/') || relPath.endsWith('.test.ts')) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  // Per-file opt-out
  if (fileIsAllowed(lines)) return;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = FUNC_DECL_RE.exec(line.trimStart());

    if (!match) {
      i++;
      continue;
    }

    const funcName = match[1];

    // Skip exempt command-factory names
    if (EXEMPT_NAME_RE.test(funcName)) {
      i++;
      continue;
    }

    // Per-line opt-out
    if (line.includes(ALLOW_INLINE)) {
      i++;
      continue;
    }

    const endLine = findFunctionEnd(lines, i);
    const loc = endLine - i + 1;

    if (loc > LOC_THRESHOLD) {
      violations.push({
        file: relPath,
        line: i + 1,
        rule: 'RULE-1',
        funcName,
        loc,
        text: line.trim(),
      });
    }

    i = endLine + 1;
  }
}

/**
 * Walk a directory recursively, scanning `.ts` / `.mts` files.
 *
 * @param {string} absDir
 */
function walkDir(absDir) {
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(absDir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(full);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      scanFile(full);
    }
  }
}

// Run the scan
const scanAbsDir = join(ROOT, SCAN_DIR);
if (!existsSync(scanAbsDir)) {
  if (!MODE_JSON) {
    process.stderr.write(`[cli-boundary-lint] WARNING: scan directory not found: ${SCAN_DIR}\n`);
  }
} else {
  walkDir(scanAbsDir);
}

// ============================================================================
// Output helpers
// ============================================================================

/** @returns {Record<string, number>} map of "RULE-1::file:funcName" → count */
function buildCountMap() {
  /** @type {Record<string, number>} */
  const map = {};
  for (const v of violations) {
    const key = `${v.rule}::${v.file}::${v.funcName}`;
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
        gate: 'cli-package-boundary',
        threshold: LOC_THRESHOLD,
        total: violations.length,
        violations,
        byKey: buildCountMap(),
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
    note: 'Generated by scripts/lint-cli-package-boundary.mjs --baseline. Run --check to detect regressions.',
    gate: 'cli-package-boundary',
    threshold: LOC_THRESHOLD,
    total: violations.length,
    violations: violations.map((v) => ({
      file: v.file,
      line: v.line,
      funcName: v.funcName,
      loc: v.loc,
      rule: v.rule,
    })),
  };

  const scriptsDir = join(ROOT, 'scripts');
  if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(baselineData, null, 2) + '\n');

  if (!MODE_JSON) {
    process.stdout.write(
      `[cli-boundary-lint] Baseline written to scripts/.lint-cli-boundary-baseline.json\n`,
    );
    process.stdout.write(
      `[cli-boundary-lint] ${violations.length} existing violation(s) recorded as baseline.\n`,
    );
    process.stdout.write(
      `[cli-boundary-lint] Use --check in CI to fail only on NEW violations above this count.\n`,
    );
  }
  process.exit(0);
}

// ============================================================================
// Mode: --strict (zero tolerance, ignore baseline)
// ============================================================================

if (MODE_STRICT) {
  if (violations.length === 0) {
    if (!MODE_JSON) {
      process.stdout.write(
        `[cli-boundary-lint] PASS — no CLI boundary violations found (strict mode).\n`,
      );
    }
    process.exit(0);
  }

  if (!MODE_JSON) {
    process.stderr.write(`\n`);
    process.stderr.write(`=============================================================\n`);
    process.stderr.write(
      `CLI-BOUNDARY VIOLATION — ${violations.length} helper function(s) > ${LOC_THRESHOLD} LOC\n`,
    );
    process.stderr.write(`=============================================================\n\n`);

    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]  ${v.funcName} (${v.loc} LOC)\n`);
      process.stderr.write(`    ${v.text}\n`);
    }

    process.stderr.write(`\n`);
    process.stderr.write(`Remediation: move the helper to packages/core/ and re-export.\n`);
    process.stderr.write(
      `Opt-out: append \`// cli-boundary-ok: <reason>\` on the function declaration line.\n`,
    );
    process.stderr.write(`\n`);
  }
  process.exit(1);
}

// ============================================================================
// Mode: --check (compare against baseline)
// ============================================================================

if (MODE_CHECK) {
  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write(
      `[cli-boundary-lint] ERROR: baseline file not found at scripts/.lint-cli-boundary-baseline.json\n`,
    );
    process.stderr.write(
      `[cli-boundary-lint] Run: node scripts/lint-cli-package-boundary.mjs --baseline\n`,
    );
    process.stderr.write(
      `[cli-boundary-lint] Then commit scripts/.lint-cli-boundary-baseline.json.\n`,
    );
    process.exit(1);
  }

  /** @type {{total: number, violations: Array<{file: string, line: number, funcName: string, loc: number, rule: string}>}} */
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[cli-boundary-lint] ERROR: could not parse baseline file: ${err.message}\n`,
    );
    process.exit(1);
  }

  const baselineTotal = baseline.total ?? 0;
  const currentTotal = violations.length;

  if (currentTotal <= baselineTotal) {
    if (!MODE_JSON) {
      const delta = baselineTotal - currentTotal;
      const suffix =
        delta > 0
          ? ` (${delta} resolved since baseline — great work!)`
          : ` (matches baseline of ${baselineTotal})`;
      process.stdout.write(
        `[cli-boundary-lint] PASS — ${currentTotal} violation(s), baseline=${baselineTotal}${suffix}\n`,
      );
    }
    process.exit(0);
  }

  // Regressions: total exceeded baseline
  const newCount = currentTotal - baselineTotal;

  if (!MODE_JSON) {
    process.stderr.write(`\n`);
    process.stderr.write(`=============================================================\n`);
    process.stderr.write(
      `CLI-BOUNDARY REGRESSION — ${newCount} new violation(s) above baseline (${baselineTotal}→${currentTotal})\n`,
    );
    process.stderr.write(`=============================================================\n\n`);

    // Identify new violations by diffing against baseline set
    const baselineSet = new Set((baseline.violations ?? []).map((v) => `${v.file}:${v.funcName}`));
    const newViols = violations.filter((v) => !baselineSet.has(`${v.file}:${v.funcName}`));

    if (newViols.length > 0) {
      process.stderr.write(`New violations:\n`);
      for (const v of newViols) {
        process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]  ${v.funcName} (${v.loc} LOC)\n`);
        process.stderr.write(`    ${v.text}\n`);
      }
      process.stderr.write(`\n`);
    }

    process.stderr.write(`Remediation: move the helper to packages/core/ and re-export.\n`);
    process.stderr.write(
      `Opt-out: append \`// cli-boundary-ok: <reason>\` on the function declaration line.\n`,
    );
    process.stderr.write(
      `Baseline update: node scripts/lint-cli-package-boundary.mjs --baseline (after fixing).\n`,
    );
    process.stderr.write(`\n`);
  }

  process.exit(1);
}

// ============================================================================
// Default mode: fail on any violation
// ============================================================================

if (violations.length === 0) {
  if (!MODE_JSON) {
    process.stdout.write(`[cli-boundary-lint] PASS — no CLI boundary violations found.\n`);
  }
  process.exit(0);
}

if (!MODE_JSON) {
  process.stderr.write(`\n`);
  for (const v of violations) {
    process.stderr.write(`${v.file}:${v.line}  [${v.rule}]  ${v.funcName} (${v.loc} LOC)\n`);
    process.stderr.write(`  ${v.text}\n`);
  }
  process.stderr.write(`\n`);
  process.stderr.write(`=============================================================\n`);
  process.stderr.write(
    `CLI-BOUNDARY VIOLATION — ${violations.length} helper function(s) > ${LOC_THRESHOLD} LOC in CLI commands\n`,
  );
  process.stderr.write(`=============================================================\n\n`);
  process.stderr.write(
    `RULE-1: helper functions > ${LOC_THRESHOLD} LOC must be extracted to packages/core/\n`,
  );
  process.stderr.write(`\n`);
  process.stderr.write(`Remediation:\n`);
  process.stderr.write(`  1. Move the helper to packages/core/src/<domain>/<module>.ts\n`);
  process.stderr.write(`  2. Export it from the core barrel (packages/core/src/index.ts)\n`);
  process.stderr.write(`  3. Import it back in the CLI command file via @cleocode/core\n`);
  process.stderr.write(`  4. Re-run: node scripts/lint-cli-package-boundary.mjs --baseline\n`);
  process.stderr.write(`\n`);
  process.stderr.write(
    `Opt-out (sparingly): append \`// cli-boundary-ok: <reason>\` on the function declaration line.\n`,
  );
  process.stderr.write(`\n`);
  process.stderr.write(
    `Tip: while T9833-T9834 migrations are in-flight, use --baseline + --check:\n`,
  );
  process.stderr.write(`     node scripts/lint-cli-package-boundary.mjs --baseline\n`);
  process.stderr.write(`     node scripts/lint-cli-package-boundary.mjs --check\n`);
  process.stderr.write(`\n`);
}
process.exit(1);
