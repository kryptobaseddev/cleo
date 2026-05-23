#!/usr/bin/env node
/**
 * Lint rule: reject `process.stdout.write` calls outside the canonical
 * rendering allowlist established by ADR-077 (E11-HUMAN-RENDER-CONTRACT).
 *
 * Why this matters (Epic T10114 / Saga T9855)
 * -------------------------------------------
 * Human-readable rendering is the SOLE responsibility of:
 *
 *   1. `packages/core/src/render/**` — the canonical render SSoT
 *      (renderEnvelopeForHuman + registry + fallback + per-domain renderers).
 *   2. `packages/animations/**` — animation + render primitives (B3) used
 *      directly by the render layer.
 *   3. `packages/cleo/src/cli/animation-bridge.ts` — the only bridge
 *      between cleo's CLI runtime and the animations runtime.
 *   4. `packages/cleo/src/cli/renderers/index.ts` — the thin dispatcher
 *      that delegates to the render SSoT.
 *
 * Anywhere else in `packages/cleo/` writing to stdout means render logic
 * is leaking back into the CLI layer — exactly what B6/B7/B8 migrated
 * out of. This gate locks in the boundary.
 *
 * Allowlisted locations (legitimate stdout-writing sites):
 *
 *   - `packages/core/src/render/**` — SSoT for human-readable rendering.
 *   - `packages/animations/**` — animation + render primitives (B3).
 *   - `packages/cleo/src/cli/animation-bridge.ts` — animations runtime bridge.
 *   - `packages/cleo/src/cli/renderers/index.ts` — thin dispatcher.
 *   - `packages/cleo/src/cli/index.ts` — top-level CLI entry.
 *   - `scripts/**` — operational scripts may write to stdout.
 *   - Test files (`__tests__/`, `.test.ts`, `.spec.ts`, `.test.tsx`,
 *     `.spec.tsx`, `.test.mts`) — may exercise stdout behaviour.
 *
 * Pre-existing baseline (T10135, post-B6/B7/B8):
 *   The B6/B7/B8 migration moved the bulk of render logic out of
 *   `packages/cleo/src/cli/commands/` but ~76 callsites remain across:
 *     - `packages/cleo/src/cli/commands/*.ts` (22 files) — domain commands
 *       that still write directly to stdout pending follow-up migration.
 *     - `packages/cleo-os/src/{cli,health,postinstall}.ts` — cleo-os layer
 *       (separate binary) not yet migrated to the render SSoT.
 *     - `packages/core/src/sentient/daemon.ts` — daemon log lines
 *       (not user-facing rendering; could move to logger).
 *     - `packages/mcp-adapter/src/server.ts` — MCP stdio framing
 *       (protocol-level, not rendering).
 *     - `packages/caamp/scripts/provider-research.ts` — script in package
 *       (research output, fits scripts/ rationale by intent).
 *
 *   These are tracked in `scripts/.lint-stdout-discipline-baseline.json`
 *   and follow-up cleanup tasks should drive the count to zero.
 *
 * Per-line opt-out: append `// stdout-discipline-allowed: <reason>` on
 * the same line.
 *
 * Modes
 * -----
 * --strict        Require zero violations — fail even if count matches baseline.
 * --baseline      Default mode — fail only if count INCREASES vs stored baseline.
 * --update-baseline Overwrite the baseline file with the current counts and exit 0.
 *
 * @task T10135
 * @epic T10114
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

// Scan TypeScript sources only. Generated `.js` / `.js.map` siblings of TS
// sources (e.g. packages/cleo-os/bin/postinstall.js) would double-count the
// same violation in two places.
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);

/** Test file suffixes — allowlisted regardless of directory. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts'];

/**
 * POSIX-relative path prefixes / exact paths that are allowed to call
 * `process.stdout.write`. See ADR-077 §8 for the rationale.
 */
const ALLOW_PATH_PREFIXES = [
  // Canonical render SSoT
  'packages/core/src/render/',
  // Animation + render primitives (B3) — render layer dependency
  'packages/animations/',
  // The only bridge between cleo runtime and animations runtime
  'packages/cleo/src/cli/animation-bridge.ts',
  // Thin dispatcher that delegates to the render SSoT
  'packages/cleo/src/cli/renderers/index.ts',
  // Top-level CLI entry (root-level prints — startup banner, errors)
  'packages/cleo/src/cli/index.ts',
  // Operational scripts — by convention may write to stdout
  'scripts/',
];

/** Regex patterns tested against POSIX-relative paths — always allowed. */
const ALLOW_PATH_REGEXES = [
  // All test directories
  /__tests__\//,
];

/** Inline opt-out marker (must appear on the same source line). */
const ALLOW_INLINE = '// stdout-discipline-allowed';

/** The pattern we hunt for. */
const PATTERN_STDOUT_WRITE = /process\.stdout\.write\s*\(/;

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-stdout-discipline-baseline.json';

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join(posix.sep);
}

/** @param {string} relPath POSIX-relative path from repo root */
function isAllowedPath(relPath) {
  if (ALLOW_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  if (ALLOW_PATH_REGEXES.some((rx) => rx.test(relPath))) return true;
  return false;
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

  if (isAllowedPath(relPath)) return;
  if (isTestFile(relPath)) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip JSDoc/TSDoc continuation lines
    if (/^\s*\*/.test(line)) continue;

    // Strip inline comments so we don't match `// process.stdout.write(...)` prose
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
// Strict mode — require zero violations
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-stdout-discipline: STRICT OK — zero violations.');
    process.exit(0);
  }
  console.error(`lint-stdout-discipline: STRICT FAIL — ${totalViolations} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    '\nFix: move rendering to packages/core/src/render/ or packages/animations/,\n' +
      '     or annotate the line with // stdout-discipline-allowed: <reason>.',
  );
  process.exit(1);
}

// ============================================================================
// Update-baseline mode — write new baseline and exit
// ============================================================================

if (UPDATE_BASELINE) {
  const items = violations.map((v) => `${v.file}:${v.line}`).sort();
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-stdout-discipline.mjs --update-baseline. ' +
          'DO NOT edit manually. See T10135 / Epic T10114 / Saga T9855 / ADR-077.',
        total: totalViolations,
        items,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    `lint-stdout-discipline: baseline updated -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded)`,
  );
  process.exit(0);
}

// ============================================================================
// Baseline mode (default) — fail only on NEW violation identities
// ============================================================================

/** @type {{total: number, items: string[]} | null} */
let baseline = null;

if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(`lint-stdout-discipline: ERROR — could not parse baseline at ${BASELINE_PATH}`);
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
          'Auto-generated by scripts/lint-stdout-discipline.mjs. ' +
          'DO NOT edit manually. See T10135 / Epic T10114 / Saga T9855 / ADR-077.',
        total: totalViolations,
        items,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    `lint-stdout-discipline: baseline created -> ${BASELINE_PATH} ` +
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
    `lint-stdout-discipline: OK — ${totalViolations} violation(s) ` +
      `(baseline: ${baseline.total ?? 0})${reducMsg}`,
  );
  if (reductions.length > 0) {
    console.info(
      'Run `node scripts/lint-stdout-discipline.mjs --update-baseline` to lower the baseline.',
    );
  }
  process.exit(0);
}

// Regressions detected.
console.error(
  `lint-stdout-discipline: FAIL — ${newViolations.length} NEW violation(s) above baseline:\n`,
);
for (const id of newViolations) {
  const v = violations.find((x) => `${x.file}:${x.line}` === id);
  console.error(`  ${id}`);
  if (v) console.error(`    ${v.snippet}`);
}

console.error(
  '\nFix:\n' +
    '  • Move rendering to packages/core/src/render/ or packages/animations/.\n' +
    '  • Use the render SSoT via packages/cleo/src/cli/renderers/index.ts dispatcher.\n' +
    '  • Per-line opt-out: append `// stdout-discipline-allowed: <reason>`.\n' +
    '  • See ADR-077 §8 for the canonical allowlist + rationale.\n',
);
process.exit(1);
