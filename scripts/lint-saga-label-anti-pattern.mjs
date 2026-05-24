#!/usr/bin/env node
/**
 * Lint rule: block NEW occurrences of the legacy "Saga as label" anti-pattern
 * in production code — AC1 of T10332 / Saga T10326 SG-SUBSTRATE-RECONCILIATION
 * Wave 3A.
 *
 * Why this matters (post-Wave 2)
 * ------------------------------
 * ADR-083 (Cleo persona + 3-role canon) §2.5 elevates "Saga" from a soft
 * label-on-Epic shape to a first-class `TaskType` ('saga'). The migration
 * proceeded through three waves:
 *
 *  - Wave 1 (T10328 + T10329, merged) — extended the TaskType union and
 *    applied the Drizzle migration. Both shapes are now legal in the store.
 *  - Wave 2 (T10330 + T10331, merged) — retyped invariants against `SagaTask`,
 *    added the `isSagaShape(task)` predicate (`type === 'saga' || (type ===
 *    'epic' && labels.includes('saga'))`), swept 28 production callsites
 *    from the legacy `SAGA_LABEL` / `labels.includes('saga')` shape to the
 *    new `isSagaType` / `isSagaShape` helpers, and marked `SAGA_LABEL`
 *    @deprecated.
 *  - Wave 3A (this gate, T10332) — CI regression gate: pin the residual 46
 *    production references as the baseline, fail on ANY net-add. The
 *    remaining references all live inside `packages/core/src/sagas/*`
 *    (the SSoT module itself) or in legitimate legacy-shape bridges
 *    (`isSagaEpic`, label-encoded reads in `tasks/list.ts`,
 *    `release/plan.ts`, `orchestrate/query-ops.ts`,
 *    `dispatch/domains/focus.ts`, `tasks/generic-tree.ts`).
 *  - Wave 3C (T10334, future) — full cutover removes the deprecated symbols
 *    entirely. THIS gate flips to `--strict` (zero-tolerance) at that point.
 *
 * Anti-patterns
 * -------------
 * The four patterns below were the canonical "Saga is just an Epic with a
 * label" idioms. Each MUST be replaced post-Wave 2:
 *
 *   1. `labels.includes('saga')` — legacy label-encoded discriminant.
 *      Replacement: `isSagaShape(task)` from
 *      `packages/core/src/sagas/enforcement.ts`, or `isSagaType(task.type)`
 *      from `packages/core/src/sagas/is-saga-type.ts` when the type axis
 *      alone is sufficient.
 *      Suppress with `// saga-label-ok: <reason>`.
 *
 *   2. `hasSagaLabel(labels)` — private helper inside `enforcement.ts`. New
 *      callers MUST use `isSagaShape(task)` (which inspects both `type` and
 *      `labels` in one call). Suppress with `// saga-label-ok: <reason>`.
 *
 *   3. `isSagaEpic(task)` — query-ops helper kept for the in-file callers
 *      of `query-ops.ts`. Reaching into it from new code re-couples callers
 *      to the legacy shape. New code MUST use `isSagaShape(task)` or
 *      `isSagaType(task.type)`. Suppress with `// saga-label-ok: <reason>`.
 *
 *   4. `SAGA_LABEL` — the string constant `'saga' as const`. Marked
 *      `@deprecated` in Wave 2. The SSoT module
 *      (`packages/core/src/sagas/*`) keeps it for backward compatibility
 *      until T10334; everything outside the SSoT must use `isSagaShape` /
 *      `isSagaType`. Suppress with `// saga-label-ok: <reason>`.
 *
 * Baseline mode (default)
 * -----------------------
 * The script reads `scripts/.lint-saga-label-baseline.json` (created by
 * `--baseline`) and fails when the per-rule count INCREASES (net-add).
 * Count decreases are always accepted — they reflect progress toward
 * Wave 3C cutover.
 *
 * Flags
 * -----
 *  - `--strict`           — fail on ANY violation (zero-tolerance, post-W3.C).
 *  - `--baseline`         — alias for `--update-baseline`; overwrite the
 *                           baseline JSON with the current counts.
 *  - `--update-baseline`  — same as `--baseline`.
 *
 * Opt-out
 * -------
 * Per-line: append `// saga-label-ok: <reason>` as a trailing comment.
 * Per-file: add an entry to FILE_ALLOWLIST below with a one-line rationale.
 *
 * @task T10332
 * @epic T10277 E-SAGA-TYPE-MIGRATION
 * @saga T10326 SG-SUBSTRATE-RECONCILIATION
 * @see packages/core/src/sagas/enforcement.ts — isSagaShape (canonical predicate)
 * @see packages/core/src/sagas/is-saga-type.ts — isSagaType (type-axis predicate)
 * @see .cleo/adrs/ADR-083-cleo-persona-and-three-role-canon.md §2.5
 * @see .cleo/adrs/ADR-073-above-epic-naming.md §1.2 (invariant I3)
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/** Directory roots to scan. */
const SCAN_DIRS = ['packages/core', 'packages/cleo', 'packages/contracts'];

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

/** Per-line opt-out marker. */
const OPT_OUT_SAGA_LABEL = 'saga-label-ok';

/**
 * Files that are explicitly exempt from ALL rules in this linter.
 * Entries use POSIX-style relative paths from the repo root.
 * Keep this list minimal — prefer per-line opt-outs for true one-liners.
 *
 * The SSoT module itself (`packages/core/src/sagas/`) is NOT allowlisted
 * because the baseline already pins its residual references. Allowlisting
 * would defeat the regression gate when new SSoT internals add fresh refs.
 */
const FILE_ALLOWLIST = new Set([
  // (intentionally empty — current state encoded as baseline)
]);

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-saga-label-baseline.json';

// ============================================================================
// Patterns
// ============================================================================

/**
 * Rule 1 — `labels.includes('saga')` outside opt-outs.
 *
 * Matches the literal call shape. We deliberately match the string `'saga'`
 * with single OR double quotes; the SAGA_LABEL identifier is covered by
 * Rule 4. TSDoc / `//` comments are stripped before matching.
 */
const RULE_LABELS_INCLUDES_SAGA = {
  id: 'labels-includes-saga',
  description:
    "`labels.includes('saga')` is the legacy label-encoded saga discriminant. " +
    'Use `isSagaShape(task)` from packages/core/src/sagas/enforcement.ts, or ' +
    '`isSagaType(task.type)` from packages/core/src/sagas/is-saga-type.ts.',
  optOut: OPT_OUT_SAGA_LABEL,
  regex: /labels\s*(?:\?\.)?\.includes\s*\(\s*['"]saga['"]\s*\)/,
};

/**
 * Rule 2 — `hasSagaLabel(` call sites (the private helper inside enforcement).
 */
const RULE_HAS_SAGA_LABEL = {
  id: 'has-saga-label',
  description:
    '`hasSagaLabel(labels)` re-couples callers to the legacy label-encoded ' +
    'shape. Use `isSagaShape(task)` which inspects both `type` and `labels`.',
  optOut: OPT_OUT_SAGA_LABEL,
  regex: /\bhasSagaLabel\s*\(/,
};

/**
 * Rule 3 — `isSagaEpic(` call sites (the query-ops legacy helper).
 */
const RULE_IS_SAGA_EPIC = {
  id: 'is-saga-epic',
  description:
    '`isSagaEpic(task)` is the legacy query-ops helper. Use `isSagaShape(task)` ' +
    'or `isSagaType(task.type)` from packages/core/src/sagas/.',
  optOut: OPT_OUT_SAGA_LABEL,
  regex: /\bisSagaEpic\s*\(/,
};

/**
 * Rule 4 — `SAGA_LABEL` identifier references.
 *
 * Matches the bare identifier as a token (word-boundary anchored). Comment
 * stripping handles TSDoc mentions; opt-out handles legitimate SSoT-internal
 * references not yet captured by the baseline.
 */
const RULE_SAGA_LABEL_IDENT = {
  id: 'saga-label-identifier',
  description:
    '`SAGA_LABEL` is marked @deprecated post-Wave 2 (T10331). Use ' +
    '`isSagaShape(task)` for the discriminant and the literal `"saga"` only ' +
    'in storage layers (Drizzle TASK_TYPES, label inserts in sagas/create.ts).',
  optOut: OPT_OUT_SAGA_LABEL,
  regex: /\bSAGA_LABEL\b/,
};

const ALL_RULES = [
  RULE_LABELS_INCLUDES_SAGA,
  RULE_HAS_SAGA_LABEL,
  RULE_IS_SAGA_EPIC,
  RULE_SAGA_LABEL_IDENT,
];

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
const UPDATE_BASELINE = args.includes('--update-baseline') || args.includes('--baseline');

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
    console.info('lint-saga-label-anti-pattern: STRICT OK (zero violations)');
    process.exit(0);
  }
  console.error(`lint-saga-label-anti-pattern: STRICT FAIL — ${totalViolations} violation(s):\n`);
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
          'Auto-generated by scripts/lint-saga-label-anti-pattern.mjs --baseline. ' +
          'DO NOT edit manually. See T10332 / Saga T10326 W3.A for context.',
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-saga-label-anti-pattern: baseline updated -> ${BASELINE_PATH} (${totalViolations} violations recorded)`,
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
    console.error(
      `lint-saga-label-anti-pattern: ERROR — could not parse baseline at ${BASELINE_PATH}`,
    );
    process.exit(1);
  }
} else {
  // No baseline yet — write it and succeed on first run.
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-saga-label-anti-pattern.mjs. ' +
          'DO NOT edit manually. See T10332 / Saga T10326 W3.A for context.',
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-saga-label-anti-pattern: baseline created -> ${BASELINE_PATH} (${totalViolations} violations recorded). ` +
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
    `lint-saga-label-anti-pattern: OK — ${totalViolations} violation(s) (baseline: ${baseline.total ?? 0})${savedMsg}`,
  );
  if (totalViolations > 0) {
    console.info(
      'Run `node scripts/lint-saga-label-anti-pattern.mjs --baseline` after resolving violations to lower the baseline.',
    );
  }
  process.exit(0);
}

// Regressions detected.
console.error(
  `lint-saga-label-anti-pattern: FAIL — ${regressions.length} rule(s) regressed vs baseline:\n`,
);
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
    "  • Rule `labels-includes-saga`: replace `task.labels.includes('saga')` with\n" +
    '    `isSagaShape(task)` from `packages/core/src/sagas/enforcement.ts`.\n' +
    '  • Rule `has-saga-label`: replace `hasSagaLabel(labels)` with\n' +
    '    `isSagaShape(task)` (inspects both `type` and `labels`).\n' +
    '  • Rule `is-saga-epic`: replace `isSagaEpic(task)` with `isSagaShape(task)` or\n' +
    '    `isSagaType(task.type)` from `packages/core/src/sagas/is-saga-type.ts`.\n' +
    '  • Rule `saga-label-identifier`: replace `SAGA_LABEL` references with\n' +
    '    `isSagaShape(task)`/`isSagaType(task.type)`; the literal `"saga"` belongs only in\n' +
    '    storage layers (TASK_TYPES const, label inserts in `sagas/create.ts`).\n' +
    '  • Per-line opt-out: append `// saga-label-ok: <reason>` for justified exceptions.\n' +
    '  • Background: see ADR-083 §2.5 and ADR-073 §1.2 (invariant I3).\n',
);
process.exit(1);
