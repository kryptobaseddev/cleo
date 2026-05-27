#!/usr/bin/env node
/**
 * lint-worktree-project-info.mjs — CI gate: reject worktrees missing
 * project-info.json (prevent identity-less worktrees).
 *
 * Why this matters (Saga T10295 · Epic T10299 · Task T11038)
 * -----------------------------------------------------------
 * T11033 added project-info.json to worktree .cleo/ at provision time,
 * giving every worktree a durable binding back to its parent project ID
 * and enabling deterministic project resolution from any worktree path
 * (T11034 / T11035). Worktrees created BEFORE T11033 lack this file
 * and will be backfilled by T11036.
 *
 * This gate prevents NEW identity-less worktrees from appearing. Once
 * T11036 backfills the existing population, strict mode will enforce
 * zero tolerance.
 *
 * Rules
 * -----
 *   RULE-1 (MISSING):  A non-primary git worktree with a .cleo/ directory
 *                      but no .cleo/project-info.json.
 *   RULE-2 (INVALID):  project-info.json exists but has no projectId field
 *                      or is unparseable JSON.
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
 * Baseline file: scripts/.lint-worktree-project-info-baseline.json
 *
 * Usage:
 *   node scripts/lint-worktree-project-info.mjs                    # strict check
 *   node scripts/lint-worktree-project-info.mjs --baseline         # record current
 *   node scripts/lint-worktree-project-info.mjs --check            # CI regression guard
 *   node scripts/lint-worktree-project-info.mjs --check --json     # CI + JSON output
 *
 * Exit codes:
 *   0 — clean (baseline/check modes: within baseline; strict: no violations)
 *   1 — violations found (strict) OR baseline regression (check)
 *   2 — usage / runtime error
 *
 * @task    T11038
 * @epic    T10299
 * @saga    T10295
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_CHECK = args.includes('--check');
const MODE_STRICT = args.includes('--strict');
const MODE_JSON = args.includes('--json');
const MODE_HELP = args.includes('--help') || args.includes('-h');

const mode = MODE_BASELINE ? 'baseline' : MODE_CHECK ? 'check' : 'strict';

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'scripts', '.lint-worktree-project-info-baseline.json');

// Helper to check if a path is under a parent directory.
function isUnder(parent, child) {
  const p = parent.endsWith('/') ? parent : parent + '/';
  const c = child.endsWith('/') ? child : child + '/';
  return c.startsWith(p);
}

// ============================================================================
// Scanner (exportable for tests)
// ============================================================================

/**
 * @typedef {{ file: string, rule: string, text: string }} Violation
 */

/**
 * Parse `git worktree list --porcelain` output. Exported for tests.
 * @param {string} raw - raw output from git worktree list --porcelain
 * @returns {Array<{ worktree: string, bare: boolean, head?: string }>}
 */
export function parseWorktreeList(raw) {
  const entries = [];
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { worktree: line.slice('worktree '.length).trim(), bare: false };
    } else if (line === 'bare') {
      if (current) current.bare = true;
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Run the full scan. Exportable for tests.
 * @param {{ cwd?: string }} opts
 * @returns {{ exitCode: number, violations: Violation[], counts: { total: number, missing: number, invalid: number } }}
 */
export function runLint(opts = {}) {
  const cwd = opts.cwd ?? ROOT;

  /** @type {Violation[]} */
  const violations = [];

  let raw;
  try {
    raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    process.stderr.write(`[lint-worktree-project-info] git worktree list failed: ${err.message}\n`);
    return { exitCode: 2, violations: [], counts: { total: 0, missing: 0, invalid: 0 } };
  }

  const entries = parseWorktreeList(raw);
  if (entries.length === 0) {
    return { exitCode: 0, violations: [], counts: { total: 0, missing: 0, invalid: 0 } };
  }

  // First entry is the primary worktree — skip it.
  const primaryWorktree = entries[0].worktree;

  for (let i = 1; i < entries.length; i++) {
    const { worktree } = entries[i];
    const cleoDir = join(worktree, '.cleo');
    const projectInfoPath = join(cleoDir, 'project-info.json');

    // If the worktree doesn't have a .cleo/ directory at all,
    // it hasn't been provisioned by CLEO — skip it.
    if (!existsSync(cleoDir)) continue;

    if (!existsSync(projectInfoPath)) {
      violations.push({
        file: worktree,
        rule: 'RULE-1',
        text: `Missing .cleo/project-info.json — worktree has no project identity binding`,
      });
      continue;
    }

    // RULE-2: file exists but is invalid.
    try {
      const content = readFileSync(projectInfoPath, 'utf-8');
      const data = JSON.parse(content);
      if (!data.projectId || typeof data.projectId !== 'string') {
        violations.push({
          file: worktree,
          rule: 'RULE-2',
          text: `Invalid project-info.json: missing or non-string projectId field`,
        });
      }
    } catch {
      violations.push({
        file: worktree,
        rule: 'RULE-2',
        text: `Unparseable .cleo/project-info.json`,
      });
    }
  }

  const missingCount = violations.filter((v) => v.rule === 'RULE-1').length;
  const invalidCount = violations.filter((v) => v.rule === 'RULE-2').length;

  return {
    exitCode: violations.length === 0 ? 0 : 1,
    violations,
    counts: {
      total: violations.length,
      missing: missingCount,
      invalid: invalidCount,
    },
  };
}

// ============================================================================
// CLI bootstrap guard
// ============================================================================

const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

// Only run mode handlers when invoked directly (not imported by tests).
if (!invokedDirectly && process.env['VITEST'] === 'true') {
  // Imported by vitest — skip mode handlers, exports are available.
} else if (!invokedDirectly) {
  // Imported by another module — skip mode handlers.
} else {
  // Directly invoked — run mode handlers.
  const result = runLint();
  const { violations, counts } = result;

  // --- JSON (early, combined with any mode) ---
  if (MODE_JSON) {
    process.stdout.write(JSON.stringify({ gate: 'lint-worktree-project-info', mode, ...counts, violations }, null, 2) + '\n');
  }

  // --- Help ---
  if (MODE_HELP) {
    process.stdout.write([
      'lint-worktree-project-info.mjs — CI gate: reject worktrees missing project-info.json',
      '',
      'Usage:',
      '  node scripts/lint-worktree-project-info.mjs                     # strict (zero tolerance)',
      '  node scripts/lint-worktree-project-info.mjs --baseline           # record current state',
      '  node scripts/lint-worktree-project-info.mjs --check              # CI regression guard',
      '  node scripts/lint-worktree-project-info.mjs --check --json       # CI + JSON output',
      '',
      'Options:',
      '  --strict   Zero tolerance (default)',
      '  --baseline Write current counts to baseline file',
      '  --check    Compare against baseline; fail only on regressions',
      '  --json     Emit JSON summary to stdout',
      '  --help     Show this message',
      '',
      'Exit codes: 0 = clean, 1 = violations/regression, 2 = error',
      '',
      '@task T11038',
    ].join('\n') + '\n');
    process.exit(0);
  }

  // --- Baseline ---
  if (MODE_BASELINE) {
    const data = {
      generatedAt: new Date().toISOString(),
      note: 'Generated by scripts/lint-worktree-project-info.mjs --baseline. Run --check in CI to detect regressions.',
      gate: 'lint-worktree-project-info',
      total: counts.total,
      missing: counts.missing,
      invalid: counts.invalid,
      violations: violations.map((v) => ({ file: v.file, rule: v.rule })),
    };
    const scriptsDir = join(ROOT, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
    if (!MODE_JSON) {
      process.stdout.write(`[lint-worktree-project-info] Baseline written to scripts/.lint-worktree-project-info-baseline.json\n`);
      process.stdout.write(`[lint-worktree-project-info] RULE-1 (missing): ${counts.missing} worktree(s) without project-info.json\n`);
      process.stdout.write(`[lint-worktree-project-info] RULE-2 (invalid): ${counts.invalid} worktree(s) with invalid project-info.json\n`);
      process.stdout.write(`[lint-worktree-project-info] Use --check in CI to fail only on NEW violations above this baseline.\n`);
    }
    process.exit(0);
  }

  // --- Check ---
  if (MODE_CHECK) {
    if (!existsSync(BASELINE_PATH)) {
      process.stderr.write(`[lint-worktree-project-info] ERROR: baseline not found at ${BASELINE_PATH}. Run --baseline first.\n`);
      process.exit(1);
    }
    let baseline;
    try { baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')); } catch (e) {
      process.stderr.write(`[lint-worktree-project-info] ERROR: bad baseline: ${e.message}\n`);
      process.exit(1);
    }
    const blTotal = baseline.total ?? 0;
    const currentTotal = counts.total;

    if (currentTotal <= blTotal) {
      if (!MODE_JSON) {
        const diff = blTotal - currentTotal;
        process.stdout.write(
          `[lint-worktree-project-info] PASS — ${currentTotal} violation(s) (bl=${blTotal})${diff > 0 ? ` (${diff} resolved)` : ''}\n`
        );
      }
      process.exit(0);
    }

    if (!MODE_JSON) {
      process.stderr.write(`\n=============================================================\n`);
      process.stderr.write(`WORKTREE PROJECT-INFO REGRESSION — violations increased above baseline\n`);
      process.stderr.write(`=============================================================\n\n`);
      process.stderr.write(`Total: ${blTotal}→${currentTotal} (+${currentTotal - blTotal})\n`);
      process.stderr.write(`RULE-1 (missing): ${counts.missing}\n`);
      process.stderr.write(`RULE-2 (invalid): ${counts.invalid}\n`);
      process.stderr.write(`\nRemediation: ensure cleo orchestrate spawn / cleo worktree adopt\n`);
      process.stderr.write(`             copies project-info.json (T11033). Backfill with T11036.\n`);
      process.stderr.write(`Baseline update: node scripts/lint-worktree-project-info.mjs --baseline\n\n`);
    }
    process.exit(1);
  }

  // --- Strict (default) ---
  if (violations.length === 0) {
    if (!MODE_JSON) process.stdout.write(`[lint-worktree-project-info] PASS — all worktrees have valid project-info.json.\n`);
    process.exit(0);
  }

  if (!MODE_JSON) {
    process.stderr.write(`\n=============================================================\n`);
    process.stderr.write(`WORKTREE PROJECT-INFO VIOLATION — ${counts.total} violation(s) (MISSING: ${counts.missing}, INVALID: ${counts.invalid})\n`);
    process.stderr.write(`=============================================================\n\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}  [${v.rule}]\n    ${v.text}\n`);
    }
    process.stderr.write(`\nRULE-1: Every non-primary worktree with .cleo/ must have .cleo/project-info.json.\n`);
    process.stderr.write(`RULE-2: project-info.json must be valid JSON with a projectId string field.\n`);
    process.stderr.write(`\nRemediation: see Epic T10299 (Worktree Project Identity Binding).\n`);
    process.stderr.write(`             T11033 adds project-info.json at provision time.\n`);
    process.stderr.write(`             T11036 backfills existing worktrees.\n\n`);
  }
  process.exit(1);
}
