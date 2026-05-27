#!/usr/bin/env node
/**
 * Lint rule: `process.stdout.write` outside the canonical renderer SSoT
 * paths MUST carry an explicit per-line allowlist comment.
 *
 * Why this matters (T9924 / Saga T9855 / E8.5)
 * --------------------------------------------
 * Sibling gate `lint-stdout-discipline` (T10135) uses **path prefix
 * allowlists** (scripts/, packages/animations/, packages/cleo/src/cli/
 * index.ts, etc.) so entire directories may freely write to stdout. That
 * keeps the boundary visible at the package layer but lets new render
 * logic sneak into permitted directories without ceremony.
 *
 * T9924 layers a stricter rule ON TOP of T10135:
 *
 *   - Renderer SSoT paths are still implicitly allowed:
 *       packages/cleo/src/cli/renderers/**
 *       packages/core/src/render/**
 *   - Every OTHER `process.stdout.write` call site — including the ones
 *     T10135 path-allowed (cleo-os/, scripts/, postinstall.ts, daemon.ts,
 *     MCP server, etc.) — MUST carry an explicit per-line opt-out comment:
 *       `// stdout-write-allowed: <short justification>`
 *
 * The bar is "every author who reaches for stdout outside the renderer
 * SSoT pauses to justify the choice in a comment a reviewer can read".
 *
 * This gate is **baseline-pinned**: it locks the current set of unannotated
 * call sites and fails CI only when the count INCREASES. Use the baseline
 * to ratchet the count down as call sites get migrated to the render SSoT
 * or annotated with explicit justifications.
 *
 * Modes
 * -----
 * --strict           Require zero unannotated violations — fail even if
 *                    count matches baseline. Use locally to audit.
 * --check            Default in CI. Baseline mode: fail only when NEW
 *                    unannotated violation identities appear vs baseline.
 * --baseline         Alias of --update-baseline (back-compat with the
 *                    sibling lint's vocabulary used in the task spec).
 * --update-baseline  Overwrite the baseline file and exit 0.
 *
 * Per-line opt-out
 * ----------------
 * Append `// stdout-write-allowed: <reason>` on the SAME source line as
 * the `process.stdout.write(` call. The justification is read by humans,
 * not parsed — keep it short and specific.
 *
 * @task T9924
 * @saga T9855
 * @adr ADR-077
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const SCAN_DIRS = ['packages'];

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svelte-kit',
  '__snapshots__',
  '__mocks__',
  'coverage',
  '.next',
  'fixtures',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);

/** Test file suffixes — exempt from the gate. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts'];

/**
 * Sibling lint test suite's fixture (lint-stdout-discipline.test.mjs) — must
 * be ignored here to prevent cross-contamination when tests run in parallel
 * (T10360 fix). Our own fixture file (matching this lint's marker) is still
 * scanned and validated.
 */
const SIBLING_FIXTURE_REGEX = /__stdout_violation_fixture(?:_\d+)?\.ts$/;

/**
 * The ONLY paths where `process.stdout.write` is implicitly allowed
 * without a per-line justification. This is intentionally narrower than
 * the T10135 sibling lint — only the renderer SSoT counts.
 */
const RENDERER_SSOT_PREFIXES = ['packages/cleo/src/cli/renderers/', 'packages/core/src/render/'];

/** Inline opt-out marker. */
const ALLOW_INLINE = '// stdout-write-allowed';

/** The pattern we hunt for. */
const PATTERN_STDOUT_WRITE = /process\.stdout\.write\s*\(/;

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-stdout-write-allowlist-baseline.json';

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline') || args.includes('--baseline');
// --check is the documented default name; treat absence-of-flags the same.
const CHECK = args.includes('--check') || (!STRICT && !UPDATE_BASELINE);

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join(posix.sep);
}

/** @param {string} relPath POSIX-relative path from repo root */
function isRendererSsot(relPath) {
  return RENDERER_SSOT_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** @param {string} filePath */
function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

// ============================================================================
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, snippet: string}>} */
const violations = [];

/** @param {string} absPath */
function scanFile(absPath) {
  const relPath = toPosixRel(absPath);

  if (isRendererSsot(relPath)) return;
  if (isTestFile(relPath)) return;
  if (SIBLING_FIXTURE_REGEX.test(relPath)) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*\*/.test(line)) continue;

    const code = (() => {
      const s = line.replace(/\/\*[\s\S]*?\*\//g, '');
      const idx = s.indexOf('//');
      return idx !== -1 ? s.slice(0, idx) : s;
    })();

    if (!code.trim()) continue;
    if (line.includes(ALLOW_INLINE)) continue;

    if (PATTERN_STDOUT_WRITE.test(code)) {
      violations.push({ file: relPath, line: i + 1, snippet: line.trim() });
    }
  }
}

/** @param {string} dir */
function walkDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      scanFile(full);
    }
  }
}

for (const dir of SCAN_DIRS) {
  walkDir(join(process.cwd(), dir));
}

const totalViolations = violations.length;

// ============================================================================
// Strict mode — require zero unannotated violations
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-stdout-write-allowlist: STRICT OK — zero unannotated violations.');
    process.exit(0);
  }
  console.error(
    `lint-stdout-write-allowlist: STRICT FAIL — ${totalViolations} unannotated violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    '\nFix: move rendering to packages/cleo/src/cli/renderers/ or packages/core/src/render/,\n' +
      '     or annotate the line with `// stdout-write-allowed: <reason>`.',
  );
  process.exit(1);
}

// ============================================================================
// Update-baseline mode — write new baseline and exit 0
// ============================================================================

if (UPDATE_BASELINE) {
  const items = violations.map((v) => `${v.file}:${v.line}`).sort();
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-stdout-write-allowlist.mjs --update-baseline. ' +
          'DO NOT edit manually. See T9924 / Saga T9855 / ADR-077.',
        total: totalViolations,
        items,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    `lint-stdout-write-allowlist: baseline updated -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded)`,
  );
  process.exit(0);
}

// ============================================================================
// Check mode (default) — fail only on NEW unannotated violation identities
// ============================================================================

/** @type {{total: number, items: string[]} | null} */
let baseline = null;

if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(
      `lint-stdout-write-allowlist: ERROR — could not parse baseline at ${BASELINE_PATH}`,
    );
    process.exit(1);
  }
} else {
  // No baseline yet — write it on first run and exit 0 so CI bootstraps cleanly.
  const items = violations.map((v) => `${v.file}:${v.line}`).sort();
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-stdout-write-allowlist.mjs. ' +
          'DO NOT edit manually. See T9924 / Saga T9855 / ADR-077.',
        total: totalViolations,
        items,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    `lint-stdout-write-allowlist: baseline created -> ${BASELINE_PATH} ` +
      `(${totalViolations} violation(s) recorded). Re-run to check against baseline.`,
  );
  process.exit(0);
}

const current = violations.map((v) => `${v.file}:${v.line}`).sort();
const baselineSet = new Set(baseline.items ?? []);
const newViolations = current.filter((id) => !baselineSet.has(id));

if (newViolations.length === 0) {
  const reductions = (baseline.items ?? []).filter((id) => !current.includes(id));
  const reducMsg =
    reductions.length > 0 ? ` (${reductions.length} prior violation(s) removed — great work!)` : '';
  console.info(
    `lint-stdout-write-allowlist: OK — ${totalViolations} violation(s) ` +
      `(baseline: ${baseline.total ?? 0})${reducMsg}`,
  );
  if (reductions.length > 0) {
    console.info(
      'Run `node scripts/lint-stdout-write-allowlist.mjs --update-baseline` to lower the baseline.',
    );
  }
  process.exit(0);
}

console.error(
  `lint-stdout-write-allowlist: FAIL — ${newViolations.length} NEW unannotated violation(s) above baseline:\n`,
);
for (const id of newViolations) {
  const v = violations.find((x) => `${x.file}:${x.line}` === id);
  console.error(`  ${id}`);
  if (v) console.error(`    ${v.snippet}`);
}

console.error(
  '\nFix:\n' +
    '  • Move rendering to packages/cleo/src/cli/renderers/ or packages/core/src/render/.\n' +
    '  • Per-line opt-out: append `// stdout-write-allowed: <reason>`.\n' +
    '  • See ADR-077 for the canonical render contract.\n',
);
// Suppress "unused" lint for the documented default mode.
void CHECK;
process.exit(1);
