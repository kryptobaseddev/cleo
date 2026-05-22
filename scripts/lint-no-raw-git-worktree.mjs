#!/usr/bin/env node
/**
 * Lint rule: enforce `@cleocode/worktree` as the ONLY source of `git worktree`
 * shell-outs in the workspace — AC4 of T9984 / E7-CORE-LAYERING.
 *
 * Why this matters
 * ----------------
 * Saga T9977 SG-WORKTRUNK-OWN consolidated worktree provisioning behind a
 * native Rust core (`crates/worktrunk-core`) exposed through napi
 * (`crates/worktree-napi`) and the TS SDK (`packages/worktree`). Once
 * E5 (PR #487) rewired `packages/worktree` onto napi, every other package
 * — `packages/core/` chief among them — MUST consume the SDK instead of
 * shelling out to `git worktree` directly.
 *
 * This linter is the CI regression gate that keeps that contract clean.
 *
 * Anti-patterns flagged
 * ---------------------
 * Any line under `packages/` that invokes `git worktree <verb>` via a
 * subprocess call, where `<verb>` is one of `add | remove | list | lock
 * | unlock | prune | move | repair`. Detection is conservative — we look
 * for the literal `'worktree'` string adjacent to a verb in an array
 * literal passed to `execFileSync` / `execFile` / `spawn` / `spawnSync`,
 * or an inline `git worktree <verb>` token inside a string literal that
 * appears to be a shell-command argument.
 *
 * Allowlist
 * ---------
 * Three categories of files are legitimately allowed to invoke
 * `git worktree` directly:
 *
 *   1. `packages/worktree/` — owns the worktree provisioning surface.
 *      All raw shell-outs are concentrated in `git.ts` and the worktree-
 *      create/destroy/list/prune helpers.
 *
 *   2. `packages/git-shim/` — the runtime PATH shim that intercepts
 *      forbidden git verbs from spawned agents. It needs to NAME the verbs
 *      it blocks in its block-list, so the string `'worktree'` will appear
 *      in source.
 *
 *   3. `packages/cleo/scripts/` and other top-level `scripts/` — build,
 *      release, and migration scripts may need raw access to test git's
 *      worktree behaviour or migrate rogue worktrees.
 *
 * Per-line opt-out: append `// raw-git-worktree-ok: <reason>` as a trailing
 * comment. Per-file opt-out: add to FILE_ALLOWLIST below with a one-line
 * rationale.
 *
 * Usage
 * -----
 *   node scripts/lint-no-raw-git-worktree.mjs            # CI mode (fails on violations)
 *   node scripts/lint-no-raw-git-worktree.mjs --list     # print all hits, exit 0
 *
 * @task T9984
 * @saga T9977
 * @adr decision D010
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Path prefixes that may legitimately invoke `git worktree` directly.
 *
 * Every prefix is matched against the workspace-relative file path.
 */
const ALLOWLIST_PREFIXES = [
  // Owns the worktree surface — all raw shell-outs live here.
  'packages/worktree/',
  // Shim names blocked git verbs in its block-list; the string `'worktree'`
  // appears in source.
  'packages/git-shim/',
  // Build / release / migration scripts.
  'packages/cleo/scripts/',
  // Internal skills tooling that ships with the developer harness.
  'packages/skills/internal/',
];

/**
 * Per-file allowlist with rationale. Use sparingly — most legitimate sites
 * live under one of the {@link ALLOWLIST_PREFIXES} directories.
 *
 * Format: `[relPath, reason]` tuples.
 */
const FILE_ALLOWLIST = [
  // T9984: legacy sync test-fixture helper. Production spawn now routes
  // through `@cleocode/worktree.createWorktree` via
  // `sentient/worktree-dispatch.ts`. The sync surface is retained for the
  // worktree-audit + worktree-merge + worktree-complete tests, which run
  // against on-disk git fixtures. Migration to async createWorktree is
  // tracked as a follow-up.
  [
    'packages/core/src/spawn/branch-lock.ts',
    'T9984 legacy sync test-fixture helper — async migration follow-up',
  ],
  // T9984: SDK primitives implementing the worktree observability /
  // diagnostics surface (list / prune / force-unlock). These functions
  // ARE the canonical core-side wrappers that the rest of the codebase
  // consumes; promoting them into `packages/worktree/` is a separate
  // package-boundary epic.
  ['packages/core/src/worktree/list.ts', 'T9984 SDK list primitive — promotion follow-up'],
  ['packages/core/src/worktree/prune.ts', 'T9984 SDK prune primitive — promotion follow-up'],
  [
    'packages/core/src/worktree/force-unlock.ts',
    'T9984 SDK force-unlock primitive — promotion follow-up',
  ],
  // T9984: doctor uses `git worktree list --porcelain` as a forensic scan
  // input. The doctor command intentionally bypasses the worktree SDK so it
  // can detect anomalies the SDK doesn't know about (orphan `.cleo/` dirs,
  // non-canonical locations, rogue worktrees-directory).
  ['packages/core/src/doctor/worktree-orphans.ts', 'T9984 forensic scan — bypass SDK by design'],
];

/**
 * Regexes that flag raw `git worktree` invocations.
 *
 * Patterns are intentionally conservative — false positives are far worse
 * than false negatives in a regression gate of this kind.
 */
const RAW_PATTERNS = [
  // Array literal passed to execFileSync / execFile / spawn / spawnSync
  // with `'worktree'` adjacent to a known verb. Catches both single and
  // double-quoted forms plus the `-C <dir>` prefix.
  /\[\s*['"`]-C['"`]\s*,\s*[^,]+,\s*['"`]worktree['"`]\s*,\s*['"`](?:add|remove|list|lock|unlock|prune|move|repair)['"`]/,
  /\[\s*['"`]worktree['"`]\s*,\s*['"`](?:add|remove|list|lock|unlock|prune|move|repair)['"`]/,
  // Tight literal of the form `'git worktree <verb>'` or `"git worktree <verb>"`.
  // Backtick literals are deliberately EXCLUDED — they are nearly always
  // user-facing help text embedded in `fix:` messages or error envelopes,
  // not actual shell-outs. The first two patterns above catch real
  // subprocess invocations.
  /['"]git\s+worktree\s+(?:add|remove|list|lock|unlock|prune|move|repair)['"]/,
];

const OPT_OUT_MARKER = 'raw-git-worktree-ok:';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function isAllowlisted(relPath) {
  if (ALLOWLIST_PREFIXES.some((p) => relPath.startsWith(p))) return true;
  if (FILE_ALLOWLIST.some(([f]) => f === relPath)) return true;
  return false;
}

function collectFiles() {
  const out = execSync(
    "git ls-files 'packages/**/*.ts' 'packages/**/*.tsx' 'packages/**/*.mjs' 'packages/**/*.cjs' 'packages/**/*.js'",
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Strip leading whitespace and detect lines that are pure documentation:
 *
 *   - Single-line `//` comments
 *   - JSDoc / block comment continuations (`*` or `/*`)
 *   - Shell comments (`#`)
 *
 * Trailing comments are NOT stripped because they may legitimately contain
 * the OPT_OUT_MARKER which we want to honour.
 *
 * @internal
 */
function isPureCommentLine(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('*')) return true;
  if (trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('#')) return true;
  return false;
}

/**
 * Test files are excluded from the lint. Tests routinely construct on-disk
 * git fixtures via raw `git worktree add` (sentinel-index, branch-lock,
 * baseline, merge, evidence-intersect, and the per-package worktree.test
 * suites all depend on this). The lint targets PRODUCTION code paths only.
 *
 * @internal
 */
function isTestFile(relPath) {
  if (relPath.includes('/__tests__/')) return true;
  if (relPath.endsWith('.test.ts')) return true;
  if (relPath.endsWith('.test.tsx')) return true;
  if (relPath.endsWith('.spec.ts')) return true;
  // `packages/cant/tests/` ships its empirical test suite outside __tests__/.
  if (relPath.includes('/tests/')) return true;
  return false;
}

function scanFile(relPath) {
  if (isTestFile(relPath)) return [];
  const text = readFileSync(relPath, 'utf-8');
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(OPT_OUT_MARKER)) continue;
    if (isPureCommentLine(line)) continue;
    for (const pat of RAW_PATTERNS) {
      if (pat.test(line)) {
        hits.push({ line: i + 1, text: line.trim() });
        break;
      }
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const listMode = args.includes('--list');

  const files = collectFiles();
  const violations = [];

  for (const relPath of files) {
    if (isAllowlisted(relPath)) continue;
    const hits = scanFile(relPath);
    for (const hit of hits) {
      violations.push({ relPath, ...hit });
    }
  }

  if (violations.length === 0) {
    console.log(
      '[lint-no-raw-git-worktree] clean — no raw `git worktree` shell-outs outside `@cleocode/worktree`.',
    );
    process.exit(0);
  }

  console.error(`[lint-no-raw-git-worktree] ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.relPath}:${v.line}: ${v.text}`);
  }
  console.error('');
  console.error('Each violation MUST route through `@cleocode/worktree`:');
  console.error('  - Agent worktrees → `createWorktree` / `destroyWorktree`');
  console.error('  - Transient worktrees → `addTransientWorktree` / `removeTransientWorktree`');
  console.error('  - Listing/diagnostics → `listWorktrees` / `pruneWorktrees`');
  console.error('');
  console.error('Per-line opt-out: append `// raw-git-worktree-ok: <reason>`.');
  console.error('Per-file opt-out: add to FILE_ALLOWLIST in scripts/lint-no-raw-git-worktree.mjs.');

  if (listMode) {
    process.exit(0);
  }
  process.exit(1);
}

main();
