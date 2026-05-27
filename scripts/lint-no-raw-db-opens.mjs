#!/usr/bin/env node
/**
 * Lint rule: reject raw `new DatabaseSync(` calls outside `packages/core/src/store/`.
 *
 * Why this matters (ADR-068, ADR-069, T9047)
 * -------------------------------------------
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
 * Allowlisted locations (legitimate `new DatabaseSync(` sites):
 *
 *   - `packages/core/src/store/**` — the canonical open site; everything routes here
 *   - `packages/core/src/migration/**` — migration runner (owns schema bootstrapping)
 *   - `packages/core/src/memory/claude-mem-migration.ts` — memory migration (one-shot)
 *   - `packages/core/src/memory/graph-memory-bridge.ts` — hot-path conduit open (T9023 sweep pending)
 *   - `packages/core/src/conduit/**` — conduit-sqlite is core-owned infrastructure
 *   - `packages/core/src/upgrade.ts` — one-shot signaldock migration (T9023 sweep pending)
 *   - `packages/core/src/init.ts` — bootstrap open before chokepoint is available
 *   - `packages/core/src/agents/seed-install.ts` — one-shot global install (T9023 sweep pending)
 *   - `packages/core/src/orchestration/classify.ts` — JSDoc @example blocks only (false positives)
 *   - `packages/brain/src/db-connections.ts` — package-boundary constraint (no core dep allowed)
 *   - `packages/studio/src/lib/server/db/connections.ts` — per-project ProjectContext-driven opens
 *   - Test files (all __tests__ dirs and .test.ts/.spec.ts files) — may open raw for seeding
 *
 * Opt-out for genuinely exceptional cases: append `// db-open-allowed` on the line.
 *
 * For read-only snapshot opens (backup verification, atomic validation, short-lived
 * registry reads from non-CLEO processes like Studio), use `openCleoDbSnapshot()`
 * from `@cleocode/core/store/open-cleo-db` — it routes through the chokepoint
 * while bypassing migrations and singleton management. See T9685-B3.
 *
 * @task T9047
 * @adr ADR-068, ADR-069
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const SCAN_DIRS = ['packages'];

/** Directory segments that are never scanned. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svelte-kit',
  '__snapshots__',
]);

/** File extensions to check. */
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs']);

/**
 * Path patterns that are ALLOWED to contain raw `new DatabaseSync(`.
 *
 * Each entry is either:
 *   - A string prefix (after the monorepo root), e.g. `packages/core/src/store/`
 *   - A regex tested against the relative path
 */
const ALLOW_PATH_PREFIXES = [
  // The chokepoint itself and all core/store sub-modules
  'packages/core/src/store/',
  // Migration runner — owns schema bootstrapping
  'packages/core/src/migration/',
  // Memory migration (one-shot)
  'packages/core/src/memory/claude-mem-migration.ts',
  // Hot-path conduit open — T9023 sweep complete (applyPerfPragmas applied)
  'packages/core/src/memory/graph-memory-bridge.ts',
  // Conduit infrastructure is core-owned
  'packages/core/src/conduit/',
  // One-shot signaldock migration — T9023 sweep complete (applyPerfPragmas applied)
  'packages/core/src/upgrade.ts',
  // Bootstrap open before chokepoint is available
  'packages/core/src/init.ts',
  // One-shot global install — T9023 sweep complete (applyPerfPragmas applied)
  'packages/core/src/agents/seed-install.ts',
  // classify.ts — contains JSDoc @example blocks with DatabaseSync (not actual code)
  'packages/core/src/orchestration/classify.ts',
  // T9685-B3 — `@cleocode/brain` MUST NOT depend on `@cleocode/core` (would
  // invert the layering — core depends on brain via the substrate adapters).
  // `db-connections.ts` is allowed to call `new DatabaseSync(...)` directly
  // with an inline `applyBrainPragmas` mirror of the SSoT. The cross-package
  // pragma drift is tracked as a follow-up to consolidate via a shared
  // contracts module (no core dep needed).
  'packages/brain/src/db-connections.ts',
  // Studio per-project getters (brain/tasks/conduit) take a ProjectContext —
  // they cannot route through `openCleoDb(role, cwd)` because they open
  // arbitrary registered project paths, not the active CWD's `.cleo/`. They
  // do apply pragma SSoT via `applyPerfPragmas`. The nexus.db opens in this
  // file are still here because they share the file with the per-project
  // getters; converting them on their own would require splitting the module.
  'packages/studio/src/lib/server/db/connections.ts',
];

/** Regex patterns (matched against relative path) that are always allowed. */
const ALLOW_PATH_REGEXES = [
  // All test files
  /__tests__\//,
  /\.test\.(ts|js|mts|mjs)$/,
  /\.spec\.(ts|js|mts|mjs)$/,
];

/** Inline opt-out marker. */
const ALLOW_INLINE = '// db-open-allowed';

/** The pattern we're hunting for. */
const VIOLATION_PATTERN = /new DatabaseSync\s*\(/;

// ============================================================================
// Scanner
// ============================================================================

const ROOT = process.cwd();
let violationCount = 0;
const violations = [];

function isAllowedPath(relPath) {
  const normalized = relPath.split(sep).join('/');
  if (ALLOW_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  if (ALLOW_PATH_REGEXES.some((rx) => rx.test(normalized))) {
    return true;
  }
  return false;
}

function scanFile(absPath) {
  const relPath = relative(ROOT, absPath);
  if (isAllowedPath(relPath)) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!VIOLATION_PATTERN.test(line)) continue;
    if (line.includes(ALLOW_INLINE)) continue;

    const lineNum = i + 1;
    violations.push({ file: relPath, line: lineNum, text: line.trim() });
    violationCount++;
    console.error(
      `${relPath}:${lineNum}  RAW_DB_OPEN  raw new DatabaseSync( outside packages/core/src/store/`,
    );
  }
}

function scanDir(dir) {
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
      scanDir(full);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      scanFile(full);
    }
  }
}

for (const dir of SCAN_DIRS) {
  scanDir(join(ROOT, dir));
}

if (violationCount > 0) {
  console.error('');
  console.error(`===================================================`);
  console.error(
    `ADR-068 DB-OPEN VIOLATION — ${violationCount} raw DatabaseSync( call(s) found outside core/store`,
  );
  console.error(`===================================================`);
  console.error('');
  console.error('Fix: route DB opens through openCleoDb(role, cwd) from @cleocode/core');
  console.error('     or annotate the line with // db-open-allowed with a justification.');
  console.error('');
  process.exit(1);
}

console.log(`✅ No raw DatabaseSync( violations found (ADR-068 chokepoint compliant).`);
process.exit(0);
