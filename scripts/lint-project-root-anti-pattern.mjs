#!/usr/bin/env node
/**
 * Lint rule: reject the T9550/T9580 project-root anti-pattern.
 *
 * Why this matters
 * ----------------
 * The `E-PROJECT-ROOT-AUDIT` saga (T9580–T9584) routed every project-root
 * resolution in CORE through `getProjectRoot()` / `resolveOrCwd()` so the
 * canonical 5-tier chain (worktreeScope > CLEO_ROOT > CLEO_DIR > gitlink
 * walk-up > ancestor walk) is honoured wherever an `opts.root` is absent.
 * That migration is only useful if it stays migrated — a single
 * `opts.root ?? process.cwd()` slipping back into core re-opens the T9550
 * bug class (rogue `<subdir>/.cleo/` materialising under a monorepo
 * subdirectory).
 *
 * This linter is the regression gate. It scans the package tree for three
 * patterns and fails CI on any un-annotated match:
 *
 *   1. Bare `process.cwd()` inside `packages/core/src/...` (CORE must route
 *      through `getProjectRoot()` / `resolveOrCwd()`). Genuine exceptions
 *      (e.g. discovering the running binary's package.json) may opt out
 *      with a `// CWD-OK: <reason>` trailing comment.
 *   2. `join(<anything>process.cwd()<anything>, '.cleo', ...)` constructions
 *      ANYWHERE in `packages/` — there is never a legitimate reason to
 *      build a `.cleo/` path from `process.cwd()` directly.
 *   3. `homedir()` constructions of `~/.cleo` paths outside the canonical
 *      resolvers in `packages/core/src/paths.ts` and `packages/paths/`.
 *      Replacement: `getCleoHome()` from `@cleocode/paths`.
 *
 * Opt-out
 * -------
 * Genuinely-justified exceptions can append `// CWD-OK: <reason>` (rule 1)
 * or `// path-drift-allowed` (rule 3) as a trailing comment on the
 * offending line. Use sparingly. Long-lived exceptions should be added to
 * the FILE_ALLOWLIST below with a one-line rationale.
 *
 * @task T9584
 * @epic E-PROJECT-ROOT-AUDIT
 * @see docs/project-root-conventions.md
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/** Directory roots to scan. */
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
  '.next',
  '.svelte-kit',
  'fixtures',
]);

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts']);

/** Suffixes that mark a test fixture file even outside __tests__. */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

/** Per-line opt-out markers (must appear in the trailing-comment region). */
const CWD_OK_MARKER = 'CWD-OK';
const PATH_DRIFT_ALLOWED_MARKER = 'path-drift-allowed';

// Files exempt from rule 1 (bare process.cwd() in core/src).
// These are the canonical resolvers themselves — paths.ts IS the source of
// process.cwd() defaults for the rest of the codebase. Any new entry here
// requires a peer-review note explaining why the file cannot route through
// the canonical resolver. Paths are POSIX-style relative to repo root.
const RULE_1_FILE_ALLOWLIST = new Set([
  // Canonical resolver — this IS where process.cwd() lives.
  'packages/core/src/paths.ts',
  // Legacy resolver kept for backwards compatibility with bash-era callers.
  'packages/core/src/store/file-utils.ts',
  // System/runtime info — binds to the operator's invocation cwd to discover
  // the running npm package, NOT to resolve a CLEO project root.
  'packages/core/src/system/runtime.ts',
  // OTel emitter directory derivation — runs before the project-info bootstrap.
  'packages/core/src/otel/index.ts',
  // Discovery walks from a user-provided directory (public CLI utility).
  'packages/core/src/discovery.ts',
  // Identity detection runs in bootstrap windows that pre-date the resolver.
  'packages/core/src/identity/cleo-identity.ts',
  // Audit log file-existence check — writes through canonical helpers downstream.
  'packages/core/src/audit.ts',
  // Aggregation reads cwd to derive a display name (NOT project-root resolution).
  'packages/core/src/metrics/aggregation.ts',
]);

// Files exempt from rule 3 (homedir() constructing .cleo paths).
const RULE_3_FILE_ALLOWLIST = new Set([
  // Canonical resolver.
  'packages/core/src/paths.ts',
  // The @cleocode/paths leaf package — canonical home of homedir-based paths.
  'packages/paths/src/cleo-paths.ts',
  // Brain is a leaf package that depends only on @cleocode/paths +
  // @cleocode/contracts. Its CLEO_ROOT||cwd fallback is annotated in source.
  'packages/brain/src/cleo-home.ts',
]);

// ============================================================================
// Patterns
// ============================================================================

// Rule 1 — bare `process.cwd()` calls in CORE source.
// Scope: packages/core/src TypeScript files only.
// Suppress with `// CWD-OK: <reason>`.
const RULE_1_CORE_PROCESS_CWD = {
  id: 'core-process-cwd',
  description:
    'Bare `process.cwd()` in packages/core/src bypasses `getProjectRoot()` — use `resolveOrCwd(...)` (T9584) or annotate with `// CWD-OK: <reason>`',
  regex: /\bprocess\.cwd\s*\(/,
};

// Rule 2 — `join(...process.cwd()..., '.cleo', ...)` constructions ANYWHERE.
const RULE_2_JOIN_CWD_DOT_CLEO = {
  id: 'join-cwd-dot-cleo',
  description:
    "`join(..., process.cwd(), ..., '.cleo', ...)` materialises a rogue `.cleo/` under whatever directory the CLI was invoked from — use `getProjectRoot()` or a `pathForCleo*` helper",
  regex: /process\.cwd\s*\(\s*\)[^\n]*?['"]\.cleo['"]/,
};

// Rule 3 — `homedir()` constructing `~/.cleo` paths outside canonical resolvers.
const RULE_3_HOMEDIR_DOT_CLEO = {
  id: 'homedir-dot-cleo',
  description:
    '`homedir()` constructing `.cleo` paths bypasses `getCleoHome()` from `@cleocode/paths` — use the canonical helper (T9584)',
  regex: /\bhomedir\s*\(\s*\)[^\n]*?['"]\.cleo['"]/,
};

// ============================================================================
// Helpers
// ============================================================================

const violations = [];

function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join(posix.sep);
}

/**
 * Strip line-level comment trailers so a mention of `process.cwd()` inside
 * a TSDoc `@param` note never trips the linter. We intentionally accept
 * rare false negatives over false positives.
 */
function stripComments(line) {
  // Lines whose first non-whitespace is `*` belong to a TSDoc / JSDoc block.
  if (/^\s*\*/.test(line)) {
    return '';
  }
  // Single-line `// ...`
  const slashIdx = line.indexOf('//');
  let stripped = slashIdx === -1 ? line : line.slice(0, slashIdx);
  // Inline `/* ... */` and `/** ... */` — non-greedy any-char match.
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped;
}

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name);
}

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
      if (isTestFile(full)) continue;
      scanFile(full);
    }
  }
}

function scanFile(filePath) {
  const relPath = toPosixRel(filePath);
  const inCore = relPath.startsWith('packages/core/src/');
  const rule1Allowlisted = RULE_1_FILE_ALLOWLIST.has(relPath);
  const rule3Allowlisted = RULE_3_FILE_ALLOWLIST.has(relPath);

  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const code = stripComments(original);
    if (!code.trim()) continue;

    const hasCwdOk = original.includes(CWD_OK_MARKER);
    const hasPathDriftAllowed = original.includes(PATH_DRIFT_ALLOWED_MARKER);

    // Rule 1: CORE-only, bare process.cwd().
    if (inCore && !rule1Allowlisted && !hasCwdOk && RULE_1_CORE_PROCESS_CWD.regex.test(code)) {
      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: RULE_1_CORE_PROCESS_CWD.id,
        message: RULE_1_CORE_PROCESS_CWD.description,
        snippet: original.trim(),
      });
    }

    // Rule 2: anywhere, join+cwd+.cleo composition.
    if (!hasCwdOk && RULE_2_JOIN_CWD_DOT_CLEO.regex.test(code)) {
      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: RULE_2_JOIN_CWD_DOT_CLEO.id,
        message: RULE_2_JOIN_CWD_DOT_CLEO.description,
        snippet: original.trim(),
      });
    }

    // Rule 3: anywhere, homedir+.cleo composition.
    if (!rule3Allowlisted && !hasPathDriftAllowed && RULE_3_HOMEDIR_DOT_CLEO.regex.test(code)) {
      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: RULE_3_HOMEDIR_DOT_CLEO.id,
        message: RULE_3_HOMEDIR_DOT_CLEO.description,
        snippet: original.trim(),
      });
    }
  }
}

// ============================================================================
// Baseline mode (T9584)
// ============================================================================
//
// The migration is incremental — long-tail files will land in follow-up PRs.
// To avoid blocking the helper + doc + guard merge on every last callsite,
// the linter runs in `--baseline` mode: it accepts the current violation
// count as the upper bound and only fails when a NEW violation is added
// beyond what `.cleo/project-root-baseline.json` records.
//
// Pass `--strict` to enforce zero violations. Once the long-tail batches
// land the workflow flips to --strict and the baseline file is deleted.

const args = process.argv.slice(2);
const STRICT_MODE = args.includes('--strict');
const BASELINE_FILE = '.cleo/project-root-baseline.json';

// ============================================================================
// Run
// ============================================================================

for (const dir of SCAN_DIRS) {
  walk(dir);
}

let baselineCount = 0;
try {
  const raw = readFileSync(BASELINE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  baselineCount = typeof parsed.violationCount === 'number' ? parsed.violationCount : 0;
} catch {
  // No baseline file — treat as 0.
}

if (STRICT_MODE) {
  if (violations.length === 0) {
    console.info('lint-project-root-anti-pattern: STRICT OK (zero violations)');
    process.exit(0);
  }
} else {
  if (violations.length <= baselineCount) {
    console.info(
      `lint-project-root-anti-pattern: OK — ${violations.length} violation(s) (baseline ${baselineCount}). Strict mode pending T9584 long-tail follow-up.`,
    );
    process.exit(0);
  }
  console.error(
    `lint-project-root-anti-pattern: REGRESSION — ${violations.length} violations exceed baseline ${baselineCount}. New anti-pattern instances must be fixed before merge.`,
  );
}

console.error(
  `lint-project-root-anti-pattern: FAIL — found ${violations.length} project-root anti-pattern violation(s):\n`,
);
for (const v of violations) {
  console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
  console.error(`    -> ${v.message}`);
}
console.error(
  `\nFix:\n` +
    `  • Replace \`opts.root ?? process.cwd()\` with \`resolveOrCwd(opts.root)\`\n` +
    `    from \`@cleocode/core\`.\n` +
    `  • Replace \`join(process.cwd(), '.cleo', ...)\` with\n` +
    `    \`join(getProjectRoot(), '.cleo', ...)\` or a \`pathForCleo*\`\n` +
    `    helper from \`@cleocode/core/paths\`.\n` +
    `  • Replace \`join(homedir(), '.cleo', ...)\` with \`getCleoHome()\`\n` +
    `    from \`@cleocode/paths\`.\n` +
    `  • For genuinely-justified exceptions, append \`// ${CWD_OK_MARKER}: <reason>\`\n` +
    `    (rule 1 / 2) or \`// ${PATH_DRIFT_ALLOWED_MARKER}\` (rule 3) to the offending\n` +
    `    line, OR add the file to the allowlist in this script with a one-line\n` +
    `    rationale.\n` +
    `  • See docs/project-root-conventions.md for the full canon.\n`,
);
process.exit(1);
