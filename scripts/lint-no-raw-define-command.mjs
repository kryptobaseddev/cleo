#!/usr/bin/env node
/**
 * Lint rule: reject raw `import { defineCommand } from 'citty'` outside the
 * canonical SSoT wrapper.
 *
 * Why this matters (T10072 · Epic T9837 · Saga T9831 SG-ARCH-SOLID)
 * -----------------------------------------------------------------
 * `defineCommand` is citty's command factory. Every CLI command in
 * `packages/cleo/src/` calls it, but nothing prevents developers from
 * importing it directly from 'citty' and bypassing any future wrapping,
 * augmentation, or validation logic added to the SSoT layer.
 *
 * The single source of truth for `defineCommand` is:
 *   packages/cleo/src/cli/lib/define-cli-command.ts
 *
 * That wrapper re-exports `defineCommand` (and will add middleware hooks
 * as the SG-ARCH-SOLID refactor progresses). All other files in
 * `packages/cleo/src/` MUST import from the wrapper, not from 'citty'
 * directly.
 *
 * Modes
 * -----
 *   (default / --strict)  Fail on ANY violation; exit 1.
 *   --baseline            Write current violation count to baseline file;
 *                         always exits 0. Use once to capture the legacy debt.
 *   --check               Fail only when current count EXCEEDS baseline count.
 *                         Use in CI while the migration is in-flight.
 *
 * Opt-out
 * -------
 * Append `// define-command-ssot-allowed` on the offending import line for
 * genuinely exceptional cases (e.g. polyfill files). Use sparingly.
 *
 * @task T10072
 * @epic T9837
 * @saga T9831
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_CHECK = args.includes('--check');
const _MODE_STRICT = args.includes('--strict') || (!MODE_BASELINE && !MODE_CHECK);

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, '.cleo', 'define-command-ssot-baseline.json');

/**
 * The canonical SSoT file that is ALLOWED to import `defineCommand` from citty.
 * Expressed as the path relative to ROOT, using forward slashes.
 */
const SSOT_REL_PATH = 'packages/cleo/src/cli/lib/define-cli-command.ts';

/** Directory to scan for violations. */
const SCAN_DIR = 'packages/cleo/src';

/** Directory segments that are never descended into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  'coverage',
]);

/** File extensions to scan. */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs']);

/** Inline opt-out marker — suppresses the check for that one import line. */
const OPT_OUT_MARKER = 'define-command-ssot-allowed';

/**
 * Matches any import statement that brings `defineCommand` in from 'citty'
 * (single or double quotes). Handles multi-name destructuring.
 *
 *   import { defineCommand } from 'citty';
 *   import { defineCommand, showUsage } from "citty";
 *   import { showUsage, defineCommand } from 'citty';
 */
const RAW_IMPORT_REGEX = /\bimport\s*\{[^}]*\bdefineCommand\b[^}]*\}\s*from\s*['"]citty['"]/;

// ============================================================================
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name);
}

function walkDir(absDir) {
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (shouldSkipDir(name)) continue;
    const full = join(absDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(name))) {
      scanFile(full);
    }
  }
}

function scanFile(absPath) {
  const relPath = relative(ROOT, absPath).split(sep).join('/');

  // The SSoT file itself is always allowed.
  if (relPath === SSOT_REL_PATH) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RAW_IMPORT_REGEX.test(line)) continue;
    if (line.includes(OPT_OUT_MARKER)) continue;
    violations.push({ file: relPath, line: i + 1, text: line.trim() });
  }
}

// Run the scan
const scanAbsDir = join(ROOT, SCAN_DIR);
if (existsSync(scanAbsDir)) {
  walkDir(scanAbsDir);
} else {
  process.stderr.write(
    `[lint-no-raw-define-command] WARNING: scan directory not found: ${SCAN_DIR}\n`,
  );
}

// ============================================================================
// Mode: --baseline
// ============================================================================

if (MODE_BASELINE) {
  const cleoDir = join(ROOT, '.cleo');
  if (!existsSync(cleoDir)) mkdirSync(cleoDir, { recursive: true });

  const baselineData = {
    generatedAt: new Date().toISOString(),
    note: 'Generated by scripts/lint-no-raw-define-command.mjs --baseline. Run --check to detect regressions.',
    total: violations.length,
    ssotRelPath: SSOT_REL_PATH,
    violations: violations.map((v) => ({ file: v.file, line: v.line })),
  };

  writeFileSync(BASELINE_PATH, JSON.stringify(baselineData, null, 2) + '\n');

  process.stdout.write(
    `[lint-no-raw-define-command] Baseline written to ${relative(ROOT, BASELINE_PATH)}\n`,
  );
  process.stdout.write(
    `[lint-no-raw-define-command] ${violations.length} existing violation(s) recorded as baseline.\n`,
  );
  process.stdout.write(
    `[lint-no-raw-define-command] Use --check in CI to fail only on NEW violations above this count.\n`,
  );
  process.exit(0);
}

// ============================================================================
// Mode: --check (compare against baseline)
// ============================================================================

if (MODE_CHECK) {
  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write(
      `[lint-no-raw-define-command] ERROR: baseline file not found at ${relative(ROOT, BASELINE_PATH)}\n`,
    );
    process.stderr.write(
      `[lint-no-raw-define-command] Run: node scripts/lint-no-raw-define-command.mjs --baseline\n`,
    );
    process.stderr.write(
      `[lint-no-raw-define-command] Then commit the baseline file to track existing debt.\n`,
    );
    process.exit(1);
  }

  /** @type {{total: number, violations: Array<{file: string, line: number}>}} */
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[lint-no-raw-define-command] ERROR: could not parse baseline: ${err.message}\n`,
    );
    process.exit(1);
  }

  const baselineTotal = baseline.total ?? 0;
  const currentTotal = violations.length;

  if (currentTotal <= baselineTotal) {
    process.stdout.write(
      `[lint-no-raw-define-command] PASS — ${currentTotal} violation(s) (baseline: ${baselineTotal}). No regression.\n`,
    );
    process.exit(0);
  }

  const delta = currentTotal - baselineTotal;
  const baselineSet = new Set((baseline.violations ?? []).map((v) => `${v.file}:${v.line}`));
  const newViols = violations.filter((v) => !baselineSet.has(`${v.file}:${v.line}`));

  process.stderr.write(`\n`);
  process.stderr.write(`=================================================================\n`);
  process.stderr.write(
    `defineCommand SSoT REGRESSION — ${delta} new raw import(s) above baseline\n`,
  );
  process.stderr.write(`=================================================================\n`);
  process.stderr.write(`\n`);
  process.stderr.write(`Baseline: ${baselineTotal}  Current: ${currentTotal}  Delta: +${delta}\n`);
  process.stderr.write(`\n`);
  process.stderr.write(`New violations:\n`);
  for (const v of newViols) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
    process.stderr.write(`    ${v.text}\n`);
  }
  process.stderr.write(`\n`);
  process.stderr.write(
    `Fix: import defineCommand from '${SSOT_REL_PATH.replace('packages/cleo/src/', '../lib/')}'\n`,
  );
  process.stderr.write(
    `     (adjust relative path as needed; see packages/cleo/src/cli/lib/define-cli-command.ts)\n`,
  );
  process.stderr.write(
    `     Opt-out: append \`// ${OPT_OUT_MARKER}\` with a justification comment.\n`,
  );
  process.stderr.write(`\n`);
  process.exit(1);
}

// ============================================================================
// Default / --strict mode: fail on any violation
// ============================================================================

if (violations.length === 0) {
  process.stdout.write(
    `[lint-no-raw-define-command] PASS — no raw defineCommand imports from 'citty' outside SSoT.\n`,
  );
  process.exit(0);
}

process.stderr.write(`\n`);
process.stderr.write(`=================================================================\n`);
process.stderr.write(
  `defineCommand SSoT VIOLATION — ${violations.length} raw import(s) found in ${SCAN_DIR}\n`,
);
process.stderr.write(`=================================================================\n`);
process.stderr.write(`\n`);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n`);
  process.stderr.write(`    ${v.text}\n`);
}
process.stderr.write(`\n`);
process.stderr.write(
  `Fix: import from packages/cleo/src/cli/lib/define-cli-command.ts (the SSoT wrapper).\n`,
);
process.stderr.write(`     Do NOT import defineCommand directly from 'citty'.\n`);
process.stderr.write(
  `     Opt-out: append \`// ${OPT_OUT_MARKER}\` with a justification comment.\n`,
);
process.stderr.write(`\n`);
process.stderr.write(
  `Tip: while the migration is in-flight, use --baseline + --check mode in CI.\n`,
);
process.stderr.write(`     node scripts/lint-no-raw-define-command.mjs --baseline\n`);
process.stderr.write(`     node scripts/lint-no-raw-define-command.mjs --check\n`);
process.stderr.write(`\n`);
process.exit(1);
