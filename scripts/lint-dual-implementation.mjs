#!/usr/bin/env node
/**
 * Lint rule: detect dual Rust+TS implementations of the same primitive.
 *
 * Why this matters (T10199 / Saga T10176 SG-BOUNDARY-REGISTRY / ADR-078)
 * ----------------------------------------------------------------------
 * The Boundary Registry (`packages/contracts/src/boundary.ts`) is the SSoT for
 * per-module Rust/TS layering decisions. When a Saga ships a Rust core (e.g.
 * `crates/worktrunk-core/`) the corresponding TS source MUST be deleted, kept
 * as a thin wrapper, or explicitly allowlisted via a registry amendment. The
 * partial-application failure mode caught by the Contrarian — "ship Rust, leave
 * the TS dupe in tree" — silently re-introduces the dual-implementation cost.
 *
 * This gate closes that failure mode: it detects when a `crates/<X>-core/`
 * exposes a `pub fn <name>` AND a TS file under `packages/<X>/` or
 * `packages/core/` exposes a function with the SAME name (after camelCase ↔
 * snake_case normalization). Hits that are NOT allowlisted by the boundary
 * registry fail the gate.
 *
 * What is flagged (RULE-DUP-1)
 * ---------------------------
 * - Rust function `pub fn copy_paths_parallel(...)` in `crates/<X>-core/src/**`
 *   AND TS function `export function copyPathsParallel(...)` in
 *   `packages/<X-base>/src/**` (or `packages/core/src/**`) AND the pair is NOT
 *   allowlisted.
 *
 * What is NOT flagged
 * -------------------
 * - Functions in test files (`*.test.ts`, files under `__tests__/`, type-only
 *   `*.d.ts` declaration files), or compiled outputs (`dist/`, `build/`).
 * - Pairs where the registry entry has `intent: 'ffi-surface'` AND BOTH `napiBinding`
 *   and `tsWrapper` are present — these are expected mirrors of the FFI surface.
 *   The TS wrapper is allowed to re-export a same-named symbol from the napi
 *   shim.
 * - Pairs where the registry entry has `intent: 'migrated-out'` or
 *   `'migration-pending'` and the `canonicalHome` is external — these are
 *   reference-only and not maintained dual implementations.
 * - Names matching the configured ALLOWLIST_PATTERNS (e.g. trivial
 *   utility names like `new`, `default`, `from_str`, getters/setters).
 *
 * Modes
 * -----
 * (default)   Scan and print violations; exit 1 if any found.
 * --json      Emit a JSON summary (combine with any mode).
 * --strict    Exit 1 on any violation regardless of allowlist (zero-tolerance debug).
 *
 * Heuristic
 * ---------
 * - Rust function names are extracted via `pub fn <name>(` regex (no full AST).
 * - TS function names are extracted via `export function <name>` and
 *   `export (async )?const <name> =` regexes.
 * - A Rust `<rust_name>` matches a TS `<tsName>` when the snake_case → camelCase
 *   normalization of `<rust_name>` equals `<tsName>` OR the reverse normalization
 *   of `<tsName>` equals `<rust_name>` (case-insensitive equality).
 *
 * Output is precise per match: Rust file:line + TS file:line + funcName + reason
 * + remediation hint.
 *
 * @task T10199
 * @epic T10193
 * @saga T10176 SG-BOUNDARY-REGISTRY
 * @adr ADR-078
 * @decision D010
 * @see packages/contracts/src/boundary.ts — BOUNDARY_REGISTRY SSoT
 * @see scripts/lint-boundary-registry.mjs (T10198) — orphan-detection sibling gate
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_JSON = args.includes('--json');
const MODE_STRICT = args.includes('--strict');

// ============================================================================
// Configuration
// ============================================================================

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = process.cwd();
const CRATES_DIR = join(ROOT, 'crates');
const PACKAGES_DIR = join(ROOT, 'packages');
const BOUNDARY_DIST_PATH = join(ROOT, 'packages', 'contracts', 'dist', 'boundary.js');

/**
 * Per-pair allowlist for name-collision false positives.
 *
 * Format:
 * {
 *   "version": 1,
 *   "note": "Pairs listed here are name-collisions with semantically distinct
 *            functions. Each entry MUST include a rationale.",
 *   "entries": [
 *     {
 *       "rustFile": "crates/cant-core/src/dsl/frontmatter.rs",
 *       "rustName": "parse_frontmatter",
 *       "tsFile": "packages/core/src/adrs/parse.ts",
 *       "tsName": "parseFrontmatter",
 *       "rationale": "Rust parses CANT DSL ---YAML--- frontmatter; TS parses
 *                     ADR bold-key '**Key**: value' frontmatter. Same name,
 *                     different format."
 *     }
 *   ]
 * }
 *
 * Entries with missing fields or empty rationale are REJECTED at load time.
 */
const ALLOWLIST_PATH = join(ROOT, 'scripts', '.lint-dual-impl-allowlist.json');

/** Directory segments never descended into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'target',
  '__snapshots__',
  '__mocks__',
  '__tests__',
]);

/** TS file extensions to scan. */
const TS_EXTENSIONS = new Set(['.ts', '.mts']);

/**
 * Names that are too generic / utility-shaped to be meaningful dupe signal.
 * A match on one of these names alone is NOT a violation.
 */
const ALLOWLIST_PATTERNS = new Set([
  'new',
  'default',
  'from_str',
  'to_string',
  'fromString',
  'toString',
  'from',
  'into',
  'as_str',
  'as_ref',
  'len',
  'is_empty',
  'isEmpty',
  'clone',
  'eq',
  'hash',
  'fmt',
  'parse',
  'serialize',
  'deserialize',
  'next',
  'iter',
  'iterator',
  'create',
  'destroy',
  'list',
  'add',
  'remove',
  'update',
  'get',
  'set',
  'main',
  'run',
  'init',
  'open',
  'close',
  'read',
  'write',
]);

// ============================================================================
// Name normalization
// ============================================================================

/**
 * Convert camelCase → snake_case. `copyPathsParallel` → `copy_paths_parallel`.
 *
 * @param {string} s
 * @returns {string}
 */
function camelToSnake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Build a canonical lowercased identity for cross-language comparison.
 * Both `copy_paths_parallel` and `copyPathsParallel` collapse to
 * `copypathsparallel`.
 *
 * @param {string} name
 * @returns {string}
 */
function canonicalize(name) {
  return camelToSnake(name).replace(/_/g, '').toLowerCase();
}

// ============================================================================
// Boundary registry loading
// ============================================================================

/**
 * Load `BOUNDARY_REGISTRY` from the compiled contracts package.
 *
 * @returns {Promise<readonly import('../packages/contracts/src/boundary.ts').BoundaryEntry[]>}
 */
async function loadBoundaryRegistry() {
  if (!existsSync(BOUNDARY_DIST_PATH)) {
    throw new Error(
      `Boundary registry not built at ${relative(ROOT, BOUNDARY_DIST_PATH)}.\n` +
        `Run: pnpm --filter @cleocode/contracts run build`,
    );
  }
  const mod = await import(pathToFileURL(BOUNDARY_DIST_PATH).href);
  if (!mod.BOUNDARY_REGISTRY || !Array.isArray(mod.BOUNDARY_REGISTRY)) {
    throw new Error(`Loaded boundary.js but BOUNDARY_REGISTRY export missing or not an array.`);
  }
  return mod.BOUNDARY_REGISTRY;
}

/**
 * @typedef {{
 *   rustFile: string;
 *   rustName: string;
 *   tsFile: string;
 *   tsName: string;
 *   rationale: string;
 * }} AllowlistEntry
 */

/**
 * Load the per-pair allowlist from `scripts/.lint-dual-impl-allowlist.json`.
 * Returns an empty array if the file is absent. Throws on malformed JSON or
 * on entries missing required fields or rationale.
 *
 * @returns {AllowlistEntry[]}
 */
function loadInlineAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  let raw;
  try {
    raw = readFileSync(ALLOWLIST_PATH, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read allowlist file ${relative(ROOT, ALLOWLIST_PATH)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed JSON in ${relative(ROOT, ALLOWLIST_PATH)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed.entries || !Array.isArray(parsed.entries)) {
    throw new Error(`Allowlist must have an 'entries' array at top level.`);
  }
  /** @type {AllowlistEntry[]} */
  const out = [];
  for (const [idx, e] of parsed.entries.entries()) {
    const fields = ['rustFile', 'rustName', 'tsFile', 'tsName', 'rationale'];
    for (const f of fields) {
      if (typeof e[f] !== 'string' || e[f].trim() === '') {
        throw new Error(
          `Allowlist entry #${idx} missing or empty field '${f}'. ` +
            `Every entry MUST declare rustFile, rustName, tsFile, tsName, rationale.`,
        );
      }
    }
    out.push({
      rustFile: e.rustFile,
      rustName: e.rustName,
      tsFile: e.tsFile,
      tsName: e.tsName,
      rationale: e.rationale,
    });
  }
  return out;
}

/**
 * Check whether a Rust+TS pair appears in the inline allowlist.
 *
 * @param {RustSymbol} rust
 * @param {TsSymbol} ts
 * @param {AllowlistEntry[]} entries
 * @returns {{ allowed: boolean; reason: string } | null}
 */
function checkInlineAllowlist(rust, ts, entries) {
  for (const e of entries) {
    if (
      e.rustFile === rust.file &&
      e.rustName === rust.name &&
      e.tsFile === ts.file &&
      e.tsName === ts.name
    ) {
      return {
        allowed: true,
        reason: `inline allowlist: ${e.rationale}`,
      };
    }
  }
  return null;
}

// ============================================================================
// Filesystem scanning
// ============================================================================

/**
 * Walk a directory recursively, yielding absolute paths of files whose extension
 * is in `extensions`.
 *
 * @param {string} absDir
 * @param {Set<string>} extensions
 * @returns {string[]}
 */
function walkDir(absDir, extensions) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(absDir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkDir(full, extensions));
    } else if (st.isFile() && extensions.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

// ============================================================================
// Symbol extraction
// ============================================================================

/**
 * @typedef {{
 *   name: string;
 *   file: string;
 *   line: number;
 *   crate: string;
 * }} RustSymbol
 */

/**
 * @typedef {{
 *   name: string;
 *   file: string;
 *   line: number;
 *   pkg: string;
 * }} TsSymbol
 */

/**
 * Match `pub fn <name>(...)` — async, unsafe, const, generics included.
 * Captures: 1 = name.
 */
const RUST_FN_RE =
  /^\s*pub(?:\s*\([^)]*\))?\s+(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/;

/**
 * Match `export function <name>(...)` or `export async function <name>(...)`.
 * Captures: 1 = name.
 */
const TS_FN_DECL_RE = /^\s*export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[<(]/;

/**
 * Match `export const <name> = (...)` or `export const <name> = async (...)`.
 * Captures: 1 = name. Heuristic: arrow-function-like RHS.
 */
const TS_CONST_FN_RE =
  /^\s*export\s+const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=][^=]*?(?:=>|function\s*\()/;

/**
 * Extract Rust public function symbols from a crate directory.
 *
 * @param {string} crateDir absolute path to e.g. `crates/worktrunk-core/`
 * @returns {RustSymbol[]}
 */
function extractRustSymbols(crateDir) {
  /** @type {RustSymbol[]} */
  const out = [];
  const srcDir = join(crateDir, 'src');
  if (!existsSync(srcDir)) return out;

  const crate = relative(CRATES_DIR, crateDir).split(sep)[0];
  const files = walkDir(srcDir, new Set(['.rs']));

  for (const absPath of files) {
    const rel = relative(ROOT, absPath).split(sep).join('/');
    let src;
    try {
      src = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = RUST_FN_RE.exec(lines[i]);
      if (m) {
        const name = m[1];
        if (name.startsWith('_')) continue; // private convention
        out.push({ name, file: rel, line: i + 1, crate });
      }
    }
  }
  return out;
}

/**
 * Extract TS exported function symbols from a package's `src/` directory.
 * Excludes tests, snapshots, mocks, and `.d.ts` declaration files.
 *
 * @param {string} pkgDir absolute path to e.g. `packages/worktree/`
 * @returns {TsSymbol[]}
 */
function extractTsSymbols(pkgDir) {
  /** @type {TsSymbol[]} */
  const out = [];
  const srcDir = join(pkgDir, 'src');
  if (!existsSync(srcDir)) return out;

  const pkg = relative(PACKAGES_DIR, pkgDir).split(sep)[0];
  const files = walkDir(srcDir, TS_EXTENSIONS);

  for (const absPath of files) {
    const rel = relative(ROOT, absPath).split(sep).join('/');
    // Defense in depth: walkDir already skips __tests__, but explicit checks here.
    if (rel.endsWith('.d.ts')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.mts')) continue;
    if (rel.endsWith('.spec.ts') || rel.endsWith('.spec.mts')) continue;

    let src;
    try {
      src = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const mFn = TS_FN_DECL_RE.exec(line);
      if (mFn) {
        out.push({ name: mFn[1], file: rel, line: i + 1, pkg });
        continue;
      }
      const mConst = TS_CONST_FN_RE.exec(line);
      if (mConst) {
        out.push({ name: mConst[1], file: rel, line: i + 1, pkg });
      }
    }
  }
  return out;
}

// ============================================================================
// Allowlist resolution from BOUNDARY_REGISTRY
// ============================================================================

/**
 * Strip `-core`, `-napi` suffix from a Rust crate name to get the base shared
 * with a TS package. `worktrunk-core` → `worktrunk`, `lafs-napi` → `lafs`.
 * Returns the original string if no canonical suffix is found.
 *
 * @param {string} crate
 * @returns {string}
 */
function crateBaseName(crate) {
  return crate.replace(/-(?:core|napi)$/, '');
}

/**
 * Decide whether a Rust+TS function name pair is allowlisted by BOUNDARY_REGISTRY.
 *
 * Rule:
 *   - If the Rust crate has a registry entry with `intent: 'ffi-surface'` AND
 *     `napiBinding` + `tsWrapper` both set, AND the TS package matches the
 *     declared `tsWrapper`, the pair is allowlisted.
 *   - If the Rust crate's registry entry has `intent: 'migrated-out'` OR
 *     `'migration-pending'` (i.e. the canonical home is external), the pair is
 *     allowlisted: the dupe is acknowledged as transitory.
 *   - Otherwise, the pair is NOT allowlisted (it's a real dual implementation).
 *
 * @param {RustSymbol} rust
 * @param {TsSymbol} ts
 * @param {readonly import('../packages/contracts/src/boundary.ts').BoundaryEntry[]} registry
 * @returns {{ allowed: boolean; reason: string }}
 */
function checkAllowlist(rust, ts, registry) {
  // Look up the Rust crate's registry entry
  const rustEntry = registry.find(
    (e) => e.module === rust.crate || e.rustCore === `crates/${rust.crate}`,
  );
  if (!rustEntry) {
    return {
      allowed: false,
      reason: `Rust crate '${rust.crate}' has no BOUNDARY_REGISTRY entry — file via boundary registry amendment`,
    };
  }

  // Migration-pending or migrated-out: external canonical home, not a real dupe.
  if (rustEntry.intent === 'migration-pending' || rustEntry.intent === 'migrated-out') {
    return {
      allowed: true,
      reason: `crate intent='${rustEntry.intent}' (canonicalHome=external) — transitory dupe`,
    };
  }

  // ffi-surface with both napiBinding + tsWrapper: TS is allowed to mirror Rust names.
  if (rustEntry.intent === 'ffi-surface' && rustEntry.napiBinding && rustEntry.tsWrapper) {
    const expectedTsPkgPath = rustEntry.tsWrapper.replace(/^packages\//, '');
    if (ts.pkg === expectedTsPkgPath) {
      return {
        allowed: true,
        reason: `ffi-surface (napi binding) — TS wrapper '${rustEntry.tsWrapper}' permitted to mirror crate '${rust.crate}'`,
      };
    }
  }

  // If the crate has tsWrapper set (intentional Rust+TS pairing per registry),
  // and the TS package matches, the pair is allowlisted regardless of intent.
  // This covers the "Rust core + TS thin wrapper" pattern (e.g. cant-core ↔ packages/cant).
  if (rustEntry.tsWrapper) {
    const expectedTsPkgPath = rustEntry.tsWrapper.replace(/^packages\//, '');
    if (ts.pkg === expectedTsPkgPath) {
      return {
        allowed: true,
        reason: `registry declares tsWrapper='${rustEntry.tsWrapper}' for crate '${rust.crate}' — thin wrapper expected`,
      };
    }
  }

  return {
    allowed: false,
    reason: `crate intent='${rustEntry.intent}' has no tsWrapper allowlist for package '${ts.pkg}' — declare allowlist via boundary registry amendment OR delete the TS dupe`,
  };
}

// ============================================================================
// Match computation
// ============================================================================

/**
 * @typedef {{
 *   rust: RustSymbol;
 *   ts: TsSymbol;
 *   canonical: string;
 *   allowed: boolean;
 *   reason: string;
 * }} DupePair
 */

/**
 * Compute Rust+TS name overlaps (modulo naming convention).
 * Returns pairs along with their allowlist disposition.
 *
 * @param {RustSymbol[]} rustSymbols
 * @param {TsSymbol[]} tsSymbols
 * @param {readonly import('../packages/contracts/src/boundary.ts').BoundaryEntry[]} registry
 * @param {AllowlistEntry[]} [inlineEntries=[]]
 * @returns {DupePair[]}
 */
function computeDupes(rustSymbols, tsSymbols, registry, inlineEntries = []) {
  // Index TS by canonical name for O(N+M) match.
  /** @type {Map<string, TsSymbol[]>} */
  const tsByCanon = new Map();
  for (const t of tsSymbols) {
    const c = canonicalize(t.name);
    if (ALLOWLIST_PATTERNS.has(t.name) || ALLOWLIST_PATTERNS.has(c)) continue;
    const bucket = tsByCanon.get(c);
    if (bucket) bucket.push(t);
    else tsByCanon.set(c, [t]);
  }

  /** @type {DupePair[]} */
  const pairs = [];

  for (const r of rustSymbols) {
    const c = canonicalize(r.name);
    if (ALLOWLIST_PATTERNS.has(r.name) || ALLOWLIST_PATTERNS.has(c)) continue;

    const tsHits = tsByCanon.get(c);
    if (!tsHits) continue;

    const base = crateBaseName(r.crate);
    for (const t of tsHits) {
      // Only consider TS hits in packages/<crate-base>/ or packages/core/.
      // This avoids cross-package noise (e.g. `parse()` in unrelated packages).
      if (t.pkg !== base && t.pkg !== 'core') continue;

      // Inline allowlist takes precedence over boundary-registry check.
      const inlineVerdict = checkInlineAllowlist(r, t, inlineEntries);
      const verdict = inlineVerdict ?? checkAllowlist(r, t, registry);
      pairs.push({
        rust: r,
        ts: t,
        canonical: c,
        allowed: verdict.allowed,
        reason: verdict.reason,
      });
    }
  }

  return pairs;
}

// ============================================================================
// Main scan
// ============================================================================

/**
 * Enumerate crates, packages, extract symbols, compute dupes, and return the
 * result triple ready for output.
 *
 * @returns {Promise<{
 *   rustSymbols: RustSymbol[];
 *   tsSymbols: TsSymbol[];
 *   allPairs: DupePair[];
 *   violations: DupePair[];
 *   allowed: DupePair[];
 * }>}
 */
async function runScan() {
  const registry = await loadBoundaryRegistry();
  const inlineEntries = loadInlineAllowlist();

  // Enumerate all crates under crates/ (only those ending in -core, per spec).
  /** @type {RustSymbol[]} */
  const rustSymbols = [];
  if (existsSync(CRATES_DIR)) {
    for (const entry of readdirSync(CRATES_DIR)) {
      if (!entry.endsWith('-core')) continue;
      const crateDir = join(CRATES_DIR, entry);
      const st = statSync(crateDir);
      if (!st.isDirectory()) continue;
      rustSymbols.push(...extractRustSymbols(crateDir));
    }
  }

  // Enumerate all packages under packages/.
  /** @type {TsSymbol[]} */
  const tsSymbols = [];
  if (existsSync(PACKAGES_DIR)) {
    for (const entry of readdirSync(PACKAGES_DIR)) {
      const pkgDir = join(PACKAGES_DIR, entry);
      let st;
      try {
        st = statSync(pkgDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      tsSymbols.push(...extractTsSymbols(pkgDir));
    }
  }

  const allPairs = computeDupes(rustSymbols, tsSymbols, registry, inlineEntries);
  const violations = allPairs.filter((p) => !p.allowed);
  const allowed = allPairs.filter((p) => p.allowed);

  return { rustSymbols, tsSymbols, allPairs, violations, allowed };
}

// ============================================================================
// Output
// ============================================================================

/**
 * Print a single dupe pair to stderr in human-readable form.
 *
 * @param {DupePair} p
 */
function printPair(p) {
  process.stderr.write(`  ${p.rust.file}:${p.rust.line}  pub fn ${p.rust.name}\n`);
  process.stderr.write(`    ↔ ${p.ts.file}:${p.ts.line}  export ${p.ts.name}\n`);
  process.stderr.write(`    reason: ${p.reason}\n`);
}

/**
 * Print the final report and exit with the appropriate code.
 *
 * @param {{ violations: DupePair[]; allowed: DupePair[]; rustSymbols: RustSymbol[]; tsSymbols: TsSymbol[]; allPairs: DupePair[] }} scan
 */
function reportAndExit(scan) {
  if (MODE_JSON) {
    process.stdout.write(
      JSON.stringify(
        {
          gate: 'dual-implementation',
          totals: {
            rustSymbols: scan.rustSymbols.length,
            tsSymbols: scan.tsSymbols.length,
            matches: scan.allPairs.length,
            allowed: scan.allowed.length,
            violations: scan.violations.length,
          },
          violations: scan.violations.map((p) => ({
            rustFile: p.rust.file,
            rustLine: p.rust.line,
            rustName: p.rust.name,
            rustCrate: p.rust.crate,
            tsFile: p.ts.file,
            tsLine: p.ts.line,
            tsName: p.ts.name,
            tsPkg: p.ts.pkg,
            canonical: p.canonical,
            reason: p.reason,
          })),
          allowed: scan.allowed.map((p) => ({
            rustFile: p.rust.file,
            rustLine: p.rust.line,
            rustName: p.rust.name,
            tsFile: p.ts.file,
            tsLine: p.ts.line,
            tsName: p.ts.name,
            reason: p.reason,
          })),
        },
        null,
        2,
      ) + '\n',
    );
  }

  const shouldFail = MODE_STRICT ? scan.allPairs.length > 0 : scan.violations.length > 0;

  if (!shouldFail) {
    if (!MODE_JSON) {
      process.stdout.write(
        `[dual-impl-lint] PASS — scanned ${scan.rustSymbols.length} Rust + ${scan.tsSymbols.length} TS symbols; ${scan.allPairs.length} match(es), ${scan.allowed.length} allowed, ${scan.violations.length} violation(s).\n`,
      );
    }
    process.exit(0);
  }

  if (!MODE_JSON) {
    process.stderr.write('\n');
    process.stderr.write('=============================================================\n');
    process.stderr.write(
      `DUAL-IMPLEMENTATION VIOLATION — ${scan.violations.length} un-allowlisted Rust+TS dupe(s)\n`,
    );
    process.stderr.write('=============================================================\n\n');
    process.stderr.write(
      `Scanned: ${scan.rustSymbols.length} Rust symbols + ${scan.tsSymbols.length} TS symbols.\n`,
    );
    process.stderr.write(
      `Total matches: ${scan.allPairs.length} (${scan.allowed.length} allowlisted, ${scan.violations.length} flagged).\n\n`,
    );

    if (scan.violations.length > 0) {
      process.stderr.write('Violations:\n');
      for (const p of scan.violations) printPair(p);
      process.stderr.write('\n');
    }
    if (MODE_STRICT && scan.allowed.length > 0) {
      process.stderr.write('Allowlisted (shown in --strict):\n');
      for (const p of scan.allowed) printPair(p);
      process.stderr.write('\n');
    }

    process.stderr.write('Remediation options:\n');
    process.stderr.write('  1. Delete the TS dupe (preferred when Rust is canonical).\n');
    process.stderr.write(
      "  2. Add a boundary registry amendment: set the crate's BOUNDARY_REGISTRY\n",
    );
    process.stderr.write(
      "     entry to `intent: 'ffi-surface'` with `tsWrapper` set, OR add it as a\n",
    );
    process.stderr.write(
      "     migration-pending entry with `canonicalHome: { external: '...' }`.\n",
    );
    process.stderr.write(
      '  3. File a follow-up task via `cleo add --kind work --acceptance "..."`\n',
    );
    process.stderr.write(
      '     to delete the dupe; this is the Contrarian failure mode being closed.\n\n',
    );
    process.stderr.write('See ADR-078 for the boundary-registry policy.\n\n');
  }
  process.exit(1);
}

// ============================================================================
// Entry point
// ============================================================================

const isMain = process.argv[1] === SCRIPT_PATH;

if (isMain) {
  runScan()
    .then(reportAndExit)
    .catch((err) => {
      process.stderr.write(
        `[dual-impl-lint] ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
}

export {
  canonicalize,
  checkAllowlist,
  checkInlineAllowlist,
  computeDupes,
  crateBaseName,
  loadInlineAllowlist,
  runScan,
};
