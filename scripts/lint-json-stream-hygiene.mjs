#!/usr/bin/env node
/**
 * Lint rule: reject NEW `process.stderr.write` / `console.warn` / `console.error`
 * calls in JSON-emitting command paths.
 *
 * Why this matters
 * ----------------
 * CLEO's CLI surface is JSON-first: every command MUST emit a single LAFS
 * envelope on stdout, and any out-of-band write to stderr corrupts the
 * machine-readable contract that orchestrators, sub-agents, and CI scripts
 * depend on (ADR-039). The T9763 saga (T9768–T9774) migrated 13+ long-tail
 * production warnings off raw stderr/console.warn onto `pushWarning(...)`
 * which routes structured warnings into `meta.warnings` of the envelope.
 *
 * This linter is the regression gate. It runs against the JSON-emitting
 * surface (CLI commands + the core call paths they invoke):
 *
 *   • packages/cleo/src/cli/commands/**\/*.ts  — CLI envelope emitters
 *   • packages/core/src/memory/**\/*.ts        — JSON-handler call paths
 *   • packages/core/src/nexus/**\/*.ts
 *   • packages/core/src/sentient/ingesters/**\/*.ts
 *   • packages/core/src/skills/**\/*.ts
 *
 * It counts forbidden writes per file and compares against the
 * `scripts/json-stream-hygiene-allowlist.txt` baseline. Any NEW violation
 * (new file, or higher count in an existing file) fails CI with a
 * `pushWarning(...)` fix snippet.
 *
 * Baseline mode (T9685-B4 precedent)
 * ----------------------------------
 * As of T9775 the existing 169 long-tail sites are pinned in the allowlist
 * with one-line rationales for each file. New work MUST drive the count
 * down — additions ratchet the gate immediately. The eventual end state is
 * an empty allowlist + strict-by-default.
 *
 * Opt-out (single line)
 * ---------------------
 * Append `// json-stream-hygiene-allowed: <reason>` to a single offending
 * line. Use sparingly — usually the right answer is to route the message
 * through `pushWarning({ code, message, ... })` from `@cleocode/core`.
 *
 * Whole-file allowlist
 * --------------------
 * Files that are *inherently* interactive (OAuth UX, readline wizards) or
 * are NOT JSON-emitting command paths (background daemons, git-shim
 * subprocesses, fatal-error renderers) MUST be listed in
 * `scripts/json-stream-hygiene-allowlist.txt` with rationale. The
 * allowlist is the contract — every entry is auditable.
 *
 * @task T9775 / T-JH-8
 * @epic T9763 — JSON stream hygiene (JH)
 * @see scripts/json-stream-hygiene-allowlist.txt
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Paths
// ============================================================================

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const ALLOWLIST_PATH = join(SCRIPT_DIR, 'json-stream-hygiene-allowlist.txt');

// ============================================================================
// Configuration
// ============================================================================

/** Directory roots to scan (POSIX-style, relative to repo root). */
const SCAN_ROOTS = [
  'packages/cleo/src/cli/commands',
  'packages/core/src/memory',
  'packages/core/src/nexus',
  'packages/core/src/sentient/ingesters',
  'packages/core/src/skills',
];

/** Directory names we never descend into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  '__tests__',
  'coverage',
  'fixtures',
]);

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts']);

/** Suffixes that mark a test fixture file even outside __tests__. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

/** Per-line opt-out marker (placed in trailing comment). */
const OPT_OUT_MARKER = 'json-stream-hygiene-allowed';

// ============================================================================
// Patterns
// ============================================================================

/**
 * Forbidden write patterns in JSON-emitting paths.
 *
 * We match the bare CALLER expression — `console.warn(`, `console.error(`,
 * `process.stderr.write(` — not the full call site. This lets the regex
 * survive any argument shape (template literals, multi-line, etc.).
 */
const FORBIDDEN_PATTERNS = [
  {
    id: 'process-stderr-write',
    regex: /\bprocess\.stderr\.write\s*\(/,
    fix: 'process.stderr.write(...)',
  },
  {
    id: 'console-warn',
    regex: /\bconsole\.warn\s*\(/,
    fix: 'console.warn(...)',
  },
  {
    id: 'console-error',
    regex: /\bconsole\.error\s*\(/,
    fix: 'console.error(...)',
  },
];

// ============================================================================
// Allowlist loader
// ============================================================================

/**
 * Parse the allowlist file.
 *
 * Format: `<posix-relative-path> <count>` per line, `#` lines and blank
 * lines ignored. A file with count `*` is whole-file exempt (every write
 * inside it is suppressed).
 *
 * @returns {{ counts: Map<string, number>, whole: Set<string>, totalCounted: number }}
 */
function loadAllowlist() {
  let raw;
  try {
    raw = readFileSync(ALLOWLIST_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { counts: new Map(), whole: new Set(), totalCounted: 0 };
    }
    throw err;
  }

  const counts = new Map();
  const whole = new Set();
  let totalCounted = 0;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Split on whitespace; first token = path, second = count (or '*').
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(
        `[lint-json-stream-hygiene] allowlist parse error (${ALLOWLIST_PATH}:${i + 1}): expected "<path> <count|*>", got "${trimmed}"`,
      );
    }
    const [path, rawCount] = parts;
    if (rawCount === '*') {
      whole.add(path);
      continue;
    }
    const n = Number.parseInt(rawCount, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== rawCount) {
      throw new Error(
        `[lint-json-stream-hygiene] allowlist parse error (${ALLOWLIST_PATH}:${i + 1}): expected non-negative integer count, got "${rawCount}"`,
      );
    }
    counts.set(path, n);
    totalCounted += n;
  }
  return { counts, whole, totalCounted };
}

// ============================================================================
// Walker
// ============================================================================

function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function toPosixRel(filePath) {
  const rel = relative(REPO_ROOT, filePath);
  return rel.split(sep).join(posix.sep);
}

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name);
}

/**
 * Strip line-level comment trailers so a mention of `console.warn(` inside
 * a TSDoc `@param` note never trips the linter. We intentionally accept
 * rare false negatives over false positives.
 */
function stripComments(line) {
  if (/^\s*\*/.test(line)) return '';
  const slashIdx = line.indexOf('//');
  let stripped = slashIdx === -1 ? line : line.slice(0, slashIdx);
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped;
}

/**
 * @param {string} dir absolute directory
 * @returns {Generator<string>} absolute file paths
 */
function* walk(dir) {
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
      yield* walk(full);
    } else if (stat.isFile()) {
      if (!SCAN_EXTS.has(extname(name))) continue;
      if (isTestFile(full)) continue;
      yield full;
    }
  }
}

/**
 * Count forbidden writes in one file, ignoring opted-out lines and comments.
 *
 * @param {string} absPath
 * @returns {{ count: number, hits: Array<{ line: number, ruleId: string, snippet: string }> }}
 */
function scanFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    if (original.includes(OPT_OUT_MARKER)) continue;
    const code = stripComments(original);
    if (!code.trim()) continue;
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(code)) {
        hits.push({ line: i + 1, ruleId: pattern.id, snippet: original.trim() });
        break; // one rule per line is enough — keep output tight
      }
    }
  }
  return { count: hits.length, hits };
}

// ============================================================================
// Run
// ============================================================================

/** @type {Map<string, { count: number, hits: Array<{ line: number, ruleId: string, snippet: string }> }>} */
const observed = new Map();

for (const root of SCAN_ROOTS) {
  const absRoot = join(REPO_ROOT, root);
  for (const file of walk(absRoot)) {
    const rel = toPosixRel(file);
    const result = scanFile(file);
    if (result.count > 0) {
      observed.set(rel, result);
    }
  }
}

const allowlist = loadAllowlist();

// ----------------------------------------------------------------------------
// Compare observed vs allowlist
// ----------------------------------------------------------------------------

/** Files with NEW violations (delta > 0). */
const newOrIncreased = [];
/** Files where the count dropped — allowlist can be tightened. */
const decreased = [];
/** Files in the allowlist that no longer have any violations. */
const eliminated = [];

let totalObserved = 0;
let totalWholeFileExempt = 0;
const observedFiles = new Set(observed.keys());

for (const [path, { count, hits }] of observed) {
  totalObserved += count;
  if (allowlist.whole.has(path)) {
    totalWholeFileExempt += count;
    continue; // whole-file exempt
  }
  const allowed = allowlist.counts.get(path) ?? 0;
  const delta = count - allowed;
  if (delta > 0) {
    newOrIncreased.push({ path, allowed, count, delta, hits });
  } else if (delta < 0) {
    decreased.push({ path, allowed, count, delta });
  }
}

for (const path of allowlist.counts.keys()) {
  if (!observedFiles.has(path)) {
    eliminated.push({ path, allowed: allowlist.counts.get(path) ?? 0 });
  }
}

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------

const totalCountedObserved = totalObserved - totalWholeFileExempt;
const lines = [];
lines.push(
  `lint-json-stream-hygiene: scanned ${SCAN_ROOTS.length} root(s), found ${totalObserved} forbidden write(s) across ${observed.size} file(s)`,
);
lines.push(
  `  counted: ${totalCountedObserved} observed vs ${allowlist.totalCounted} pinned in allowlist`,
);
lines.push(
  `  whole-file exempt: ${totalWholeFileExempt} observed across ${allowlist.whole.size} file(s)`,
);

if (decreased.length > 0) {
  lines.push('');
  lines.push(
    `  ${decreased.length} file(s) IMPROVED below allowlist baseline — please tighten the allowlist:`,
  );
  for (const d of decreased) {
    lines.push(`    ${d.path}: ${d.count} actual < ${d.allowed} allowed`);
  }
}

if (eliminated.length > 0) {
  lines.push('');
  lines.push(
    `  ${eliminated.length} file(s) ELIMINATED all violations — please remove from the allowlist:`,
  );
  for (const e of eliminated) {
    lines.push(`    ${e.path} (was ${e.allowed})`);
  }
}

if (newOrIncreased.length === 0) {
  console.info(lines.join('\n'));
  console.info('lint-json-stream-hygiene: OK (no new violations)');
  process.exit(0);
}

// Failure path.
console.error(lines.join('\n'));
console.error('');
console.error(
  `lint-json-stream-hygiene: FAIL — ${newOrIncreased.length} file(s) introduced NEW forbidden write(s):`,
);
console.error('');
for (const v of newOrIncreased) {
  console.error(`  ${v.path}: ${v.count} actual > ${v.allowed} allowed (+${v.delta})`);
  for (const hit of v.hits.slice(0, Math.min(v.hits.length, 5))) {
    console.error(`    L${hit.line} [${hit.ruleId}]  ${hit.snippet}`);
  }
  if (v.hits.length > 5) {
    console.error(`    ... ${v.hits.length - 5} more`);
  }
}
console.error('');
console.error('Fix:');
console.error('  • Replace the stderr/console call with `pushWarning({ ... })` from');
console.error('    `@cleocode/core` (re-exported as `pushWarning` from the package root).');
console.error('    Example:');
console.error('      import { pushWarning } from "@cleocode/core";');
console.error('      pushWarning({');
console.error('        code: "W_YOUR_CATEGORY",');
// biome-ignore lint/suspicious/noTemplateCurlyInString: example code string demonstrating template-literal usage to the operator
console.error('        message: `Human-readable summary: ${detail}`,');
console.error('        severity: "warning",   // or "info" / "error"');
console.error('        meta: { ...structured context... },');
console.error('      });');
console.error('  • The CLI renderer drains warnings from the active ALS WarningCollector');
console.error('    into `envelope.meta.warnings` (T9768 / T9769) — no stderr noise.');
console.error('  • If the write is genuinely outside the JSON envelope contract');
console.error('    (interactive UX, background daemon, fatal-error renderer), append');
console.error(`    \`// ${OPT_OUT_MARKER}: <reason>\` to the offending line OR`);
console.error('    add the whole file to scripts/json-stream-hygiene-allowlist.txt');
console.error('    with a one-line rationale.');
console.error('  • See ADR-039 (LAFS envelope) and the T9763 saga history for canon.');
process.exit(1);
