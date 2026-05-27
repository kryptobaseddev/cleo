#!/usr/bin/env node
/**
 * Lint rule: reject `cliOutput(formatError(...))` and `cliError(formatError(...))`
 * double-wrap calls in CLI command handlers.
 *
 * Why this matters
 * ----------------
 * `formatError` already serialises a `{success:false, error, meta}` LAFS
 * envelope to a JSON string (ADR-039). Feeding that string into:
 *
 *   - `cliOutput(...)` produces `{success:true, data:"<json-string>"}`
 *     — a FAKE-success envelope that masks failures from agents and
 *     pipelines.
 *
 *   - `cliError(formatError(err), ...)` overrides the human-readable
 *     `message` field with a stringified JSON blob — unreadable noise
 *     instead of a clean error.
 *
 * The correct pattern is:
 *
 *   ```ts
 *   } catch (err) {
 *     const message = err instanceof Error ? err.message : String(err);
 *     cliError(`<verb> failed: ${message}`, ExitCode.GENERAL_ERROR, {
 *       name: 'E_<VERB>_FAILED',
 *     });
 *     process.exit(ExitCode.GENERAL_ERROR);
 *   }
 *   ```
 *
 * Opt-out
 * -------
 * Trailing comment `// format-error-allowed` on the same line suppresses
 * the check. Use sparingly — there is no legitimate use of this pattern
 * in a CLI command handler today.
 *
 * @task T9789
 * @epic E-DOCS-FORMATERR-FIX (T9789)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/** Directory roots to scan. Every package's `src/` is in scope. */
const SCAN_DIRS = ['packages'];

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
  'fixtures',
]);

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mjs', '.mts', '.js', '.cjs']);

/** Skip test/spec files — they may legitimately reference the bad pattern in fixtures. */
const SKIP_FILE_PATTERNS = [/\.test\.(ts|tsx|js|mjs)$/, /\.spec\.(ts|tsx|js|mjs)$/];

/**
 * Pattern matches `cliOutput(formatError(` or `cliError(formatError(`.
 * Whitespace permitted between identifier and paren, and between paren
 * and inner identifier. Matches occurrences anywhere on a line.
 */
const DOUBLE_WRAP_REGEX = /\b(cliOutput|cliError)\s*\(\s*formatError\s*\(/;

/** Comment marker that suppresses the check for one line. */
const OPT_OUT_MARKER = 'format-error-allowed';

/**
 * Baseline allowlist — pre-existing sites that ship before T9789's fix
 * was authored. These are scoped follow-up work (filed under Saga T9787)
 * and must NOT cause new merges to fail. Any NEW site outside this list
 * is a hard fail.
 *
 * Format: `<repo-relative path>:<line>` keyed at the time the baseline
 * was captured. When fixing one of these, remove the matching entry —
 * the lint will then guard the file going forward.
 *
 * The baseline is intentionally narrow: each entry is path+line, so a
 * fix that changes line numbers will (correctly) re-trigger the lint
 * and force the entry to be removed.
 */
const BASELINE_ALLOWLIST = new Set([
  'packages/cleo/src/cli/commands/checkpoint.ts:129',
  'packages/cleo/src/cli/commands/config.ts:97',
  'packages/cleo/src/cli/commands/generate-changelog.ts:309',
  'packages/cleo/src/cli/commands/init.ts:197',
  'packages/cleo/src/cli/commands/otel.ts:43',
  'packages/cleo/src/cli/commands/otel.ts:60',
  'packages/cleo/src/cli/commands/otel.ts:90',
  'packages/cleo/src/cli/commands/otel.ts:120',
  'packages/cleo/src/cli/commands/otel.ts:150',
  'packages/cleo/src/cli/commands/otel.ts:167',
]);

/**
 * Normalise an absolute path to a repo-relative key for allowlist lookup.
 * The lint is invoked from the repo root, so cwd-anchored relative paths
 * match the keys above byte-for-byte.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normaliseKey(filePath) {
  // readdirSync returns names relative to the dir we passed (e.g. "packages"),
  // so join'd paths are already relative to cwd. Strip a leading "./" if any.
  return filePath.startsWith('./') ? filePath.slice(2) : filePath;
}

// ============================================================================
// Walker
// ============================================================================

const violations = [];

/**
 * Determine whether a directory entry name should be skipped.
 *
 * @param {string} name - directory entry name
 * @returns {boolean}
 */
function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name);
}

/**
 * Determine whether a file path should be skipped (test files, etc.).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldSkipFile(filePath) {
  return SKIP_FILE_PATTERNS.some((re) => re.test(filePath));
}

/**
 * Recursively walk a directory, scanning each eligible file.
 *
 * @param {string} dir
 */
function walk(dir) {
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
      if (shouldSkipFile(full)) continue;
      scanFile(full);
    }
  }
}

/**
 * Scan a single file for the double-wrap pattern.
 *
 * @param {string} filePath
 */
function scanFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  if (!text.includes('formatError')) return;
  const lines = text.split('\n');
  const key = normaliseKey(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DOUBLE_WRAP_REGEX.test(line)) continue;
    if (line.includes(OPT_OUT_MARKER)) continue;
    // Ignore lines that are pure comments (// or *) explaining the rule.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const allowlistKey = `${key}:${i + 1}`;
    if (BASELINE_ALLOWLIST.has(allowlistKey)) {
      // Pinned legacy site — recorded for follow-up under Saga T9787.
      continue;
    }
    violations.push({ file: filePath, line: i + 1, snippet: line.trim() });
  }
}

// ============================================================================
// Run
// ============================================================================

for (const dir of SCAN_DIRS) {
  walk(dir);
}

if (violations.length === 0) {
  console.info(
    'lint-format-error-misuse: OK (no cliOutput(formatError) / cliError(formatError) double-wraps).',
  );
  process.exit(0);
}

console.error(`lint-format-error-misuse: FAIL — found ${violations.length} double-wrap call(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
}
console.error(
  `\nFix: replace the wrapper with the canonical pattern:\n\n` +
    `  } catch (err) {\n` +
    `    const message = err instanceof Error ? err.message : String(err);\n` +
    `    cliError(\`<verb> failed: \${message}\`, ExitCode.GENERAL_ERROR, {\n` +
    `      name: 'E_<VERB>_FAILED',\n` +
    `    });\n` +
    `    process.exit(ExitCode.GENERAL_ERROR);\n` +
    `  }\n\n` +
    `If genuinely necessary (e.g. a fixture), append a trailing "// ${OPT_OUT_MARKER}" comment.\n`,
);
process.exit(1);
