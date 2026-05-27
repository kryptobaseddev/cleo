#!/usr/bin/env node
/**
 * scripts/lint-contracts-fan-out.mjs
 *
 * Detects `export interface` and `export type` declarations in
 * `packages/cleo/src/` and `packages/core/src/` that are imported by more
 * than 2 other packages (fan-out > 2). High-fan-out types should live in
 * `packages/contracts/` so consumers can import a leaf package instead of
 * pulling the full cleo or core dependency graph.
 *
 * Modes
 * -----
 *   (default)       Scan and report findings. Exit 0 always (advisory).
 *   --strict        Exit 1 if any violation found (CI gate).
 *   --baseline      Scan, write current counts to baseline file, exit 0.
 *   --update-baseline  Alias for --baseline.
 *
 * Opt-out
 * -------
 * Append `// fan-out-ok: <reason>` on the export declaration line to
 * suppress a violation for a specific export.
 *
 * Threshold
 * ---------
 * Default: fan-out > 2 (imported by more than 2 distinct packages).
 * Override with: --threshold N
 *
 * @task T10074
 * @epic T9837 (E-SSOT-ENFORCEMENT)
 * @saga T9831 (SG-ARCH-SOLID)
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();

/** Source packages to scan for fan-out types (path relative to ROOT). */
const SOURCE_PACKAGES = ['packages/cleo/src', 'packages/core/src'];

/** Packages that are excluded from BOTH the scan and the importer count.
 *  contracts is the target — it should not be counted as a violating importer.
 *  The source packages themselves are excluded from importer counts.
 */
const EXCLUDED_FROM_IMPORTERS = new Set(['packages/contracts', 'packages/cleo', 'packages/core']);

/** Fan-out threshold: types imported by > this many packages are flagged. */
const DEFAULT_THRESHOLD = 2;

/** Baseline file path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-contracts-fan-out-baseline.json';

/** Directory segments that are never descended into. */
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

/** Suffixes that mark test files. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

/** Per-export opt-out marker. */
const OPT_OUT_MARKER = 'fan-out-ok';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const WRITE_BASELINE = args.includes('--baseline') || args.includes('--update-baseline');

const thresholdFlag = args.find((a) => a.startsWith('--threshold'));
let THRESHOLD = DEFAULT_THRESHOLD;
if (thresholdFlag) {
  if (thresholdFlag.includes('=')) {
    THRESHOLD = parseInt(thresholdFlag.split('=')[1], 10);
  } else {
    const idx = args.indexOf(thresholdFlag);
    if (args[idx + 1] !== undefined) {
      THRESHOLD = parseInt(args[idx + 1], 10);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Convert an absolute path to a POSIX-style relative path from repo root.
 * @param {string} filePath
 */
function toPosixRel(filePath) {
  const rel = relative(ROOT, filePath);
  return rel.split(sep).join(posix.sep);
}

/**
 * Return the package root (e.g. "packages/core") for a given absolute path.
 * @param {string} absPath
 */
function packageOf(absPath) {
  const rel = toPosixRel(absPath);
  const parts = rel.split('/');
  // packages/<name>/... -> packages/<name>
  if (parts[0] === 'packages' && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/**
 * Walk a directory recursively, calling onFile for each matching file.
 * @param {string} dir
 * @param {(path: string) => void} onFile
 */
function walk(dir, onFile) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, onFile);
    } else if (st.isFile()) {
      if (!SCAN_EXTS.has(extname(name))) continue;
      if (isTestFile(full)) continue;
      onFile(full);
    }
  }
}

/**
 * Read a file safely; return empty string on error.
 * @param {string} filePath
 */
function readSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Strip single-line comments and TSDoc/JSDoc block comment lines so that
 * references in documentation don't cause false positives.
 * @param {string} line
 */
function stripComments(line) {
  if (/^\s*\*/.test(line)) return '';
  let s = line.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = s.indexOf('//');
  if (idx !== -1) s = s.slice(0, idx);
  return s;
}

// ============================================================================
// Phase 1 — Collect exported interface/type names from source packages
// ============================================================================

/**
 * @typedef {{
 *   name: string;
 *   file: string;
 *   line: number;
 *   optOut: boolean;
 * }} ExportedType
 */

/** @type {Map<string, ExportedType>} name -> export info */
const exportedTypes = new Map();

/**
 * Scan a source file for `export interface Foo` and `export type Foo`.
 * Ignores re-exports (`export type { X } from '...'`).
 * @param {string} filePath
 */
function collectExports(filePath) {
  const content = readSafe(filePath);
  if (!content) return;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComments(raw);
    if (!code.trim()) continue;

    // Match: export interface FooBar or export type FooBar =
    // Do NOT match re-exports like: export type { Foo } from '...'
    const m = code.match(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)\b/);
    if (!m) continue;

    const name = m[1];
    const optOut = raw.includes(OPT_OUT_MARKER);

    // Last definition wins if duplicated across files (edge case)
    exportedTypes.set(name, {
      name,
      file: toPosixRel(filePath),
      line: i + 1,
      optOut,
    });
  }
}

for (const srcDir of SOURCE_PACKAGES) {
  const absDir = join(ROOT, srcDir);
  if (existsSync(absDir)) {
    walk(absDir, collectExports);
  }
}

// ============================================================================
// Phase 2 — Scan all other packages for imports of those type names
// ============================================================================

/**
 * Build an import pattern set:
 * For each exported type name, track which packages import it.
 * @type {Map<string, Set<string>>} name -> Set of package roots
 */
const importersByType = new Map();

for (const name of exportedTypes.keys()) {
  importersByType.set(name, new Set());
}

/**
 * Resolve an import specifier relative to a file's directory to find the
 * absolute source path. Returns null if unresolvable.
 * @param {string} fromFile absolute path of importing file
 * @param {string} specifier import specifier
 */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    // .js extension -> .ts source (ESM convention)
    base.replace(/\.js$/, '.ts'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Scan a file for imports of our tracked exported types.
 * Counts the importing package (not file).
 * @param {string} filePath absolute path
 */
function scanForImports(filePath) {
  const pkgRoot = packageOf(filePath);
  if (EXCLUDED_FROM_IMPORTERS.has(pkgRoot)) return;

  const content = readSafe(filePath);
  if (!content) return;

  // Strategy: find all import declarations, then check if the resolved source
  // file lives inside one of our SOURCE_PACKAGES, then extract names.

  // Match import { ... } from '...' blocks (multi-line collapsed to single via split strategy)
  // We work line-by-line for simplicity since imports are rarely deeply multi-line.
  const importBlockRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

  for (const m of content.matchAll(importBlockRe)) {
    const block = m[1];
    const specifier = m[2];

    // Determine if this import comes from one of our source packages
    let isFromSourcePkg = false;

    if (specifier.startsWith('.')) {
      // Relative import — resolve to absolute and check if it's inside a SOURCE_PACKAGES dir
      const resolved = resolveSpecifier(filePath, specifier);
      if (resolved) {
        const resolvedRel = toPosixRel(resolved);
        isFromSourcePkg = SOURCE_PACKAGES.some((src) => resolvedRel.startsWith(src));
      }
    } else if (specifier === '@cleocode/cleo' || specifier === '@cleocode/core') {
      isFromSourcePkg = true;
    } else if (specifier.startsWith('@cleocode/cleo/') || specifier.startsWith('@cleocode/core/')) {
      isFromSourcePkg = true;
    }

    if (!isFromSourcePkg) continue;

    // Extract individual imported names
    for (const part of block.split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (!name) continue;

      if (importersByType.has(name)) {
        importersByType.get(name).add(pkgRoot);
      }
    }
  }
}

// Scan all packages (except the source packages themselves and contracts)
const packagesDir = join(ROOT, 'packages');
const packageNames = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  : [];

for (const pkgName of packageNames) {
  const pkgDir = join(packagesDir, pkgName);
  const pkgRoot = `packages/${pkgName}`;
  if (EXCLUDED_FROM_IMPORTERS.has(pkgRoot)) continue;
  const srcDir = join(pkgDir, 'src');
  if (existsSync(srcDir)) {
    walk(srcDir, scanForImports);
  }
}

// ============================================================================
// Phase 3 — Identify violations (fan-out > THRESHOLD)
// ============================================================================

/**
 * @typedef {{
 *   name: string;
 *   file: string;
 *   line: number;
 *   importers: string[];
 *   fanOut: number;
 * }} Violation
 */

/** @type {Violation[]} */
const violations = [];

for (const [name, info] of exportedTypes.entries()) {
  if (info.optOut) continue;
  const importers = importersByType.get(name) ?? new Set();
  if (importers.size > THRESHOLD) {
    violations.push({
      name,
      file: info.file,
      line: info.line,
      importers: [...importers].sort(),
      fanOut: importers.size,
    });
  }
}

// Sort by fan-out descending, then name ascending for stable output
violations.sort((a, b) => b.fanOut - a.fanOut || a.name.localeCompare(b.name));

// ============================================================================
// Phase 4 — Output
// ============================================================================

/** @param {Violation[]} vs */
function printViolations(vs) {
  for (const v of vs) {
    console.error(
      `[FAN-OUT] ${v.file}:${v.line}  ${v.name}  (fan-out=${v.fanOut}, threshold=${THRESHOLD})`,
    );
    console.error(`  Imported by: ${v.importers.join(', ')}`);
    console.error(`  Suggestion: move ${v.name} to packages/contracts/src/`);
    console.error('');
  }
}

if (WRITE_BASELINE) {
  /** @type {Record<string, {file: string, line: number, fanOut: number, importers: string[]}>} */
  const baselineEntries = {};
  for (const v of violations) {
    baselineEntries[v.name] = {
      file: v.file,
      line: v.line,
      fanOut: v.fanOut,
      importers: v.importers,
    };
  }
  const baselineData = {
    _comment:
      'Auto-generated by scripts/lint-contracts-fan-out.mjs --baseline. ' +
      'DO NOT edit manually. See T10074 / E-SSOT-ENFORCEMENT for context.',
    threshold: THRESHOLD,
    total: violations.length,
    updatedAt: new Date().toISOString(),
    entries: baselineEntries,
  };
  writeFileSync(join(ROOT, BASELINE_PATH), JSON.stringify(baselineData, null, 2) + '\n');
  console.info(
    `lint-contracts-fan-out: baseline written -> ${BASELINE_PATH} (${violations.length} findings, threshold=${THRESHOLD})`,
  );
  process.exit(0);
}

if (violations.length === 0) {
  console.info(
    `lint-contracts-fan-out: OK — no types in packages/cleo or packages/core have fan-out > ${THRESHOLD}`,
  );
  process.exit(0);
}

console.error(
  `lint-contracts-fan-out: ${violations.length} type(s) with fan-out > ${THRESHOLD}:\n`,
);
printViolations(violations);

if (STRICT) {
  console.error(
    `lint-contracts-fan-out: FAIL (--strict) — ${violations.length} type(s) should be promoted to packages/contracts/`,
  );
  process.exit(1);
}

// Load baseline and compare (baseline mode: advisory with regression detection)
const baselineFullPath = join(ROOT, BASELINE_PATH);
if (existsSync(baselineFullPath)) {
  /** @type {{total: number, entries: Record<string, {fanOut: number}>} | null} */
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(baselineFullPath, 'utf8'));
  } catch {
    console.error(`lint-contracts-fan-out: ERROR — could not parse baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }

  const prevTotal = baseline?.total ?? 0;
  const currTotal = violations.length;

  if (currTotal > prevTotal) {
    console.error(
      `lint-contracts-fan-out: REGRESSION — ${currTotal} findings vs baseline ${prevTotal} ` +
        `(+${currTotal - prevTotal} new). Run with --baseline to update.`,
    );
    process.exit(1);
  }

  if (currTotal < prevTotal) {
    console.info(
      `lint-contracts-fan-out: IMPROVED — ${currTotal} findings vs baseline ${prevTotal} ` +
        `(-${prevTotal - currTotal}). Run with --baseline to lock in progress.`,
    );
  } else {
    console.info(
      `lint-contracts-fan-out: STABLE — ${currTotal} findings, baseline=${prevTotal} (no regression)`,
    );
  }
  process.exit(0);
}

// No baseline yet — advisory mode, exit 0
console.info(
  `lint-contracts-fan-out: advisory — ${violations.length} finding(s). ` +
    `Run with --baseline to establish a baseline for regression tracking.`,
);
process.exit(0);
