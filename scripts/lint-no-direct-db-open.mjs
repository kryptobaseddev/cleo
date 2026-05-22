#!/usr/bin/env node
/**
 * Lint rule: reject raw `new DatabaseSync(` and `new Database(` calls outside
 * the canonical DB open chokepoint at `packages/core/src/store/open-cleo-db.ts`.
 *
 * Why this matters (ADR-068, ADR-069, T9047, T10073)
 * ---------------------------------------------------
 * All CLEO SQLite opens MUST flow through `openCleoDb(role, cwd)` from
 * `@cleocode/core/store/open-cleo-db`. Bypassing this chokepoint means:
 *
 *   1. Pragma drift — the connection misses the SSoT pragma set from
 *      `specs/sqlite-pragmas.json` (busy_timeout, WAL, cache_size, …).
 *   2. Lifecycle divergence — consumers manage their own singletons and
 *      WAL state, causing lock contention when multiple processes share a DB.
 *   3. Topology opacity — a new DB opened outside core cannot be enumerated
 *      by the CleoDbRole type or audited by `cleo health`.
 *
 * Two patterns are detected:
 *
 *   1. `new DatabaseSync(` — Node.js built-in `node:sqlite` direct construction.
 *   2. `new Database(` — better-sqlite3 or other synchronous SQLite wrappers.
 *
 * Allowlisted locations (legitimate raw DB open sites):
 *
 *   - `packages/core/src/store/**` — canonical open site; everything routes here
 *   - `packages/core/src/migration/**` — migration runner (schema bootstrapping)
 *   - `packages/core/src/memory/claude-mem-migration.ts` — one-shot memory migration
 *   - `packages/core/src/memory/graph-memory-bridge.ts` — hot-path conduit open
 *   - `packages/core/src/conduit/**` — conduit-sqlite is core-owned infrastructure
 *   - `packages/core/src/upgrade.ts` — one-shot signaldock migration
 *   - `packages/core/src/init.ts` — bootstrap open before chokepoint is available
 *   - `packages/core/src/agents/seed-install.ts` — one-shot global install
 *   - `packages/core/src/orchestration/classify.ts` — JSDoc @example blocks (false-positives)
 *   - `packages/core/src/nexus/**` — nexus graph per-project opens (non-CLEO-metadata DBs)
 *   - `packages/brain/src/db-connections.ts` — package-boundary constraint (no core dep)
 *   - `packages/studio/src/lib/server/db/connections.ts` — per-project ProjectContext-driven opens
 *   - Test files (`__tests__/`, `.test.ts`, `.spec.ts`) — may open raw for seeding
 *   - Test factory/helper paths (see TEST_FACTORY_PREFIXES)
 *
 * Per-line opt-out: append `// db-open-allowed` on the line with a brief rationale.
 *
 * Modes
 * -----
 * --strict        Require zero violations — fail even if count matches baseline.
 * --baseline      Default mode — fail only if count INCREASES vs stored baseline.
 * --update-baseline Overwrite the baseline file with the current counts and exit 0.
 *
 * @task T10073
 * @epic T9837
 * @saga T9831 SG-ARCH-SOLID
 * @adr ADR-068, ADR-069
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

const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.tsx']);

/** Test file suffixes — whitelisted even outside __tests__ directories. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts'];

/**
 * Path prefixes (POSIX, from repo root) that are allowed to contain raw DB opens.
 * These correspond to the canonical exception sites documented above.
 */
const ALLOW_PATH_PREFIXES = [
  // Canonical chokepoint + all core/store sub-modules
  'packages/core/src/store/',
  // Migration runner — owns schema bootstrapping
  'packages/core/src/migration/',
  // One-shot memory migration
  'packages/core/src/memory/claude-mem-migration.ts',
  // Hot-path conduit open (T9023 sweep complete)
  'packages/core/src/memory/graph-memory-bridge.ts',
  // Conduit infrastructure is core-owned
  'packages/core/src/conduit/',
  // One-shot signaldock migration (T9023 sweep complete)
  'packages/core/src/upgrade.ts',
  // Bootstrap open before chokepoint is available
  'packages/core/src/init.ts',
  // One-shot global install (T9023 sweep complete)
  'packages/core/src/agents/seed-install.ts',
  // classify.ts — JSDoc @example blocks with DatabaseSync (not actual code)
  'packages/core/src/orchestration/classify.ts',
  // Nexus graph DB — per-project non-CLEO-metadata files (nexus/store.ts uses db-open-allowed)
  'packages/core/src/nexus/',
  // @cleocode/brain MUST NOT depend on @cleocode/core (package-boundary constraint).
  // Uses inline applyBrainPragmas mirror of SSoT; tracked for consolidation via contracts.
  'packages/brain/src/db-connections.ts',
  // Studio per-project getters take a ProjectContext and cannot route through openCleoDb;
  // they do apply pragma SSoT via applyPerfPragmas.
  'packages/studio/src/lib/server/db/connections.ts',
];

/** Regex patterns tested against the POSIX-relative path — always allowed. */
const ALLOW_PATH_REGEXES = [
  // All test directories
  /__tests__\//,
  // Test factory / helper files inside store (e.g. test-db-helper.ts)
  /\/store\/__tests__\//,
];

/** Inline opt-out marker (must appear on the same source line). */
const ALLOW_INLINE = '// db-open-allowed';

/** The patterns we hunt for. Rule 1: node:sqlite direct construction. */
const PATTERN_DATABASE_SYNC = /new\s+DatabaseSync\s*\(/;

/** Rule 2: better-sqlite3 or similar wrappers. */
const PATTERN_DATABASE = /new\s+Database\s*\(/;

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-no-direct-db-open-baseline.json';

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

/** @type {Array<{file: string, line: number, ruleId: string, snippet: string}>} */
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

    // Skip comment lines (TSDoc / JSDoc block lines)
    if (/^\s*\*/.test(line)) continue;
    // Strip inline comments to avoid matching in JSDoc prose
    const code = (() => {
      const s = line.replace(/\/\*[\s\S]*?\*\//g, '');
      const idx = s.indexOf('//');
      return idx !== -1 ? s.slice(0, idx) : s;
    })();

    if (!code.trim()) continue;
    if (line.includes(ALLOW_INLINE)) continue;

    if (PATTERN_DATABASE_SYNC.test(code)) {
      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: 'raw-database-sync',
        snippet: line.trim(),
      });
      continue;
    }
    if (PATTERN_DATABASE.test(code)) {
      violations.push({ file: relPath, line: i + 1, ruleId: 'raw-database', snippet: line.trim() });
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

// ============================================================================
// Count violations per rule
// ============================================================================

const RULE_IDS = ['raw-database-sync', 'raw-database'];

/** @type {Record<string, number>} */
const currentCounts = Object.fromEntries(RULE_IDS.map((id) => [id, 0]));
for (const v of violations) {
  currentCounts[v.ruleId] = (currentCounts[v.ruleId] ?? 0) + 1;
}
const totalViolations = violations.length;

// ============================================================================
// Strict mode — require zero violations
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-no-direct-db-open: STRICT OK — zero violations.');
    process.exit(0);
  }
  console.error(`lint-no-direct-db-open: STRICT FAIL — ${totalViolations} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    '\nFix: route all DB opens through openCleoDb(role, cwd) from @cleocode/core/store/open-cleo-db\n' +
      '     or annotate the line with // db-open-allowed with a brief justification.',
  );
  process.exit(1);
}

// ============================================================================
// Update-baseline mode — write new baseline and exit
// ============================================================================

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-no-direct-db-open.mjs --update-baseline. ' +
          'DO NOT edit manually. See T10073 / Epic T9837 / Saga T9831 for context.',
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-no-direct-db-open: baseline updated -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded)`,
  );
  process.exit(0);
}

// ============================================================================
// Baseline mode (default) — fail only on net-add
// ============================================================================

/** @type {{counts: Record<string, number>, total: number} | null} */
let baseline = null;

if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(`lint-no-direct-db-open: ERROR — could not parse baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }
} else {
  // No baseline yet — write it on first run and exit 0 so CI bootstraps cleanly.
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-no-direct-db-open.mjs. ' +
          'DO NOT edit manually. See T10073 / Epic T9837 / Saga T9831 for context.',
        counts: currentCounts,
        total: totalViolations,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-no-direct-db-open: baseline created -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded). ` +
      'Re-run to check against baseline.',
  );
  process.exit(0);
}

// Compare current counts to baseline — fail on net-add.
/** @type {Array<{ruleId: string, baselineCount: number, currentCount: number, added: number}>} */
const regressions = [];
for (const ruleId of RULE_IDS) {
  const baselineCount = baseline.counts?.[ruleId] ?? 0;
  const currentCount = currentCounts[ruleId] ?? 0;
  if (currentCount > baselineCount) {
    regressions.push({ ruleId, baselineCount, currentCount, added: currentCount - baselineCount });
  }
}

if (regressions.length === 0) {
  const saved = (baseline.total ?? 0) - totalViolations;
  const savedMsg = saved > 0 ? ` (${saved} violation(s) resolved vs baseline — great work!)` : '';
  console.info(
    `lint-no-direct-db-open: OK — ${totalViolations} violation(s) (baseline: ${baseline.total ?? 0})${savedMsg}`,
  );
  if (totalViolations > 0) {
    console.info(
      'Run `node scripts/lint-no-direct-db-open.mjs --update-baseline` after resolving violations to lower the baseline.',
    );
  }
  process.exit(0);
}

// Regressions detected.
console.error(
  `lint-no-direct-db-open: FAIL — ${regressions.length} rule(s) regressed vs baseline:\n`,
);
for (const r of regressions) {
  console.error(
    `  [${r.ruleId}] baseline: ${r.baselineCount} -> current: ${r.currentCount} (+${r.added} new violation(s))`,
  );
}

console.error('\nNew violations:\n');
const regressionRuleIds = new Set(regressions.map((r) => r.ruleId));
for (const v of violations) {
  if (!regressionRuleIds.has(v.ruleId)) continue;
  console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
}

console.error(
  '\nFix:\n' +
    '  • Route DB opens through openCleoDb(role, cwd) from @cleocode/core/store/open-cleo-db.\n' +
    '  • For snapshot reads, use openCleoDbSnapshot() from the same module.\n' +
    '  • Per-line opt-out: append `// db-open-allowed: <reason>` for justified exceptions.\n' +
    '  • See packages/core/src/store/open-cleo-db.ts for the canonical API.\n',
);
process.exit(1);
