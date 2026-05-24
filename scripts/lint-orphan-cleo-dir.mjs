#!/usr/bin/env node
/**
 * lint-orphan-cleo-dir.mjs — CI gate against the T9550/T9580 orphan-`.cleo/`
 * regression class.
 *
 * Why this matters (Saga T9862 Wave 5 · T10155)
 * ---------------------------------------------
 * Twice now CLEO has shipped a release where a `getCleoDirAbsolute`-class
 * regression caused agent workflows to materialise a rogue `.cleo/` directory
 * inside an unrelated worktree (typically Claude Code Agent's
 * `.claude/worktrees/<sessionId>/`). The result is a split-brain CLEO state
 * machine:
 *
 *   - The orphan `.cleo/` holds tasks the operator can never `cleo show`
 *     (the canonical project root is somewhere else entirely).
 *   - BRAIN observations and memory writes vanish into the orphan.
 *   - `cleo doctor` from the wrong cwd repeats the offence.
 *
 * Historical incidents:
 *   - T9550 — original sighting (Saga T9580 SG-PROJECT-ROOT). Long-tail
 *     batches T9685-B1/B2/B3 drove the in-source baseline to zero.
 *   - T9580 — closeout for the SAGA. Strict-mode flip locked
 *     `lint-project-root-anti-pattern.mjs` at zero violations.
 *
 * `lint-project-root-anti-pattern.mjs` (T9584) regression-locks the
 * SOURCE-CODE level (anti-patterns that synthesise the orphan path). This
 * script regression-locks the OBSERVED-EFFECT level (the orphan directory
 * itself, materialised on disk and accidentally committed in a PR). The two
 * gates are complementary: the first catches drift before any code runs; the
 * second catches the materialised symptom in case a brand-new anti-pattern
 * slips past the source linter.
 *
 * Rule
 * ----
 * Any file added in the PR (`git diff --diff-filter=A <base>...HEAD`) whose
 * path matches the glob `.claude/worktrees/<sessionId>/.cleo/...` fails the
 * gate. The match is rooted (must start with `.claude/worktrees/`), the
 * second segment is the session ID (free-form, no `/`), and the third
 * segment is the literal `.cleo`.
 *
 * Usage:
 *   node scripts/lint-orphan-cleo-dir.mjs                 # diff against origin/main
 *   node scripts/lint-orphan-cleo-dir.mjs --base origin/main
 *   node scripts/lint-orphan-cleo-dir.mjs --base HEAD~1
 *   node scripts/lint-orphan-cleo-dir.mjs --files <file1> <file2>   # test-only
 *
 * Exit codes:
 *   0 — clean (no orphan `.cleo/` paths in PR-added files)
 *   1 — at least one orphan path detected
 *   2 — usage / runtime error
 *
 * @task T10155
 * @epic T9862
 * @saga SG-WORKTREE-CANON
 * @adr ADR-055
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The orphan-detection regex. Matches paths beginning with `.claude/worktrees/`,
 * then exactly one non-slash session-id segment, then `/.cleo/`, then anything.
 *
 * Examples that MATCH (rejected):
 *   .claude/worktrees/abc123/.cleo/tasks.db
 *   .claude/worktrees/T9550-foo/.cleo/config.json
 *   .claude/worktrees/x/.cleo/audit/force-bypass.jsonl
 *
 * Examples that DO NOT match (accepted):
 *   .claude/worktrees/abc123/src/foo.ts         — no .cleo segment
 *   .cleo/tasks.db                              — top-level .cleo (canonical)
 *   .claude/agents/foo.json                     — not under worktrees/
 *   .claude/worktrees/.cleo/tasks.db            — missing session-id segment
 */
const ORPHAN_PATTERN = /^\.claude\/worktrees\/[^/]+\/\.cleo(?:\/|$)/;

const DEFAULT_BASE_REF = 'origin/main';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Options
 * @property {string} baseRef
 * @property {string[] | null} explicitFiles
 * @property {boolean} help
 */

/**
 * Parse argv slice into a structured config object.
 *
 * @param {string[]} argv - Already-sliced argv (no `node` / script path).
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const opts = { baseRef: DEFAULT_BASE_REF, explicitFiles: null, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base' || arg === '--base-ref') {
      const next = argv[i + 1];
      if (!next) throw new Error('--base requires a git ref argument');
      opts.baseRef = next;
      i += 1;
    } else if (arg === '--files') {
      // Everything after --files is treated as a literal file path. Used by
      // the unit tests to avoid shelling out to git.
      opts.explicitFiles = argv.slice(i + 1);
      break;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

const HELP_TEXT = `lint-orphan-cleo-dir.mjs — reject newly-added .claude/worktrees/<id>/.cleo/** files.

Usage:
  node scripts/lint-orphan-cleo-dir.mjs [--base <git-ref>]
  node scripts/lint-orphan-cleo-dir.mjs --files <path1> <path2> ...

Options:
  --base <ref>     Git ref to diff against (default: origin/main)
  --files <list>   Bypass git diff and check the given paths literally (testing)
  --help           Show this message

Exit codes:
  0 — no orphan paths in PR-added files
  1 — orphan path(s) detected
  2 — usage / runtime error

@task T10155`;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Return TRUE if `path` matches the orphan `.cleo/` glob.
 *
 * @param {string} path - Repo-relative POSIX path (forward slashes).
 * @returns {boolean}
 */
export function isOrphanCleoPath(path) {
  return ORPHAN_PATTERN.test(path);
}

/**
 * List files added (status `A`) between `baseRef` and `HEAD`. Falls back to
 * an empty list on git failure (e.g. the base ref does not exist locally),
 * because the gate should be a no-op on broken setups rather than emit a
 * spurious failure.
 *
 * @param {string} baseRef - The ref to diff against.
 * @param {string} cwd - Working directory (must be inside a git repo).
 * @returns {string[]} Repo-relative paths (POSIX-style).
 */
export function listAddedFiles(baseRef, cwd) {
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    // base ref unavailable or git not present — emit a single stderr line so
    // CI logs explain the no-op, then return an empty list.
    console.warn(
      `[lint-orphan-cleo-dir] WARN: git diff against "${baseRef}" failed (status ${result.status}). Skipping.`,
    );
    return [];
  }
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Filter the file list to only those matching the orphan-`.cleo/` pattern.
 *
 * @param {string[]} files - Repo-relative paths (POSIX-style).
 * @returns {string[]} The offending paths (subset of `files`).
 */
export function findOrphanPaths(files) {
  return files.filter((f) => isOrphanCleoPath(f));
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

/**
 * Print the failure banner explaining why CI rejected the PR.
 *
 * @param {string[]} offenders - The matched orphan paths.
 */
function reportViolations(offenders) {
  const ghaAnnot = process.env['GITHUB_ACTIONS'] === 'true';
  const banner = `Orphan .cleo/ directory creation detected — this indicates getCleoDirAbsolute regression like T9550/T9580. Verify your code does not synthesize a .cleo/ inside a worktree.`;

  console.error(`[lint-orphan-cleo-dir] FAIL — ${offenders.length} orphan path(s):`);
  for (const path of offenders) {
    if (ghaAnnot) {
      console.error(`::error file=${path}::${banner}`);
    } else {
      console.error(`  - ${path}`);
    }
  }
  if (!ghaAnnot) {
    console.error(`\n${banner}\n`);
  }
  console.error(
    'Fix:\n' +
      '  1. Find the code path that materialised "<repo>/.claude/worktrees/<id>/.cleo/".\n' +
      '     Search for recent edits to packages/core/src/paths.ts or any\n' +
      '     `process.cwd()`-based path resolver that bypasses getProjectRoot().\n' +
      '  2. Remove the rogue .cleo/ from your working tree:\n' +
      '       rm -rf .claude/worktrees/<sessionId>/.cleo/\n' +
      '  3. Re-run `cleo doctor` from the project root and verify only the\n' +
      '     canonical .cleo/ at the repo root exists.\n' +
      '  4. See:\n' +
      '       - scripts/lint-project-root-anti-pattern.mjs (T9584) for the\n' +
      '         in-source regression gate.\n' +
      '       - docs/project-root-conventions.md for the canonical resolution\n' +
      '         chain.\n' +
      '       - Saga T9580 / T9685 history for prior incidents.\n',
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Programmatic entry-point. Exposed so the unit tests can invoke the script
 * without spawning a subprocess for the cheap paths.
 *
 * @param {Options} opts
 * @param {string} cwd
 * @returns {{ exitCode: number, offenders: string[] }}
 */
export function runLint(opts, cwd) {
  const files = opts.explicitFiles ?? listAddedFiles(opts.baseRef, cwd);
  const offenders = findOrphanPaths(files);
  return { exitCode: offenders.length === 0 ? 0 : 1, offenders };
}

// ---------------------------------------------------------------------------
// CLI bootstrap
// ---------------------------------------------------------------------------

// Only run when invoked directly (not when imported by the test suite).
// Equivalent to `if (require.main === module)` for ESM.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[lint-orphan-cleo-dir] ERROR: ${err.message}`);
    console.error(HELP_TEXT);
    process.exit(2);
  }

  if (opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const { exitCode, offenders } = runLint(opts, process.cwd());
  if (exitCode === 0) {
    console.log('[lint-orphan-cleo-dir] OK — no orphan .cleo/ paths added.');
  } else {
    reportViolations(offenders);
  }
  process.exit(exitCode);
}
