#!/usr/bin/env node
/**
 * Lint rule: npm publish-surface SSoT — the `publish_pkg` list in
 * `.github/workflows/release.yml` is the single source of truth for which
 * `@cleocode/*` packages are published to npm via OIDC. This gate locks that
 * surface against silent growth and re-introduction of dead artifacts.
 *
 * Why this matters
 * ----------------
 * SG-PACKAGE-ARCH (T11387) is driving the publish surface DOWN — first the E1
 * quick-wins (20 → 18: drop `studio` + `mcp-adapter`, neither of which is a
 * consumed library), and ultimately to the owner's END-STATE target of **1**
 * (a single `@cleocode/cleo` artifact bundling the whole `workspace:*` graph
 * via the R8/R10 internalization epics). Without a guard, a future PR can
 * silently re-add a publish (the studio regression already happened once via
 * Issue #102 / PR #103), re-introduce a per-platform worktree-napi-* stub
 * package (the binaries are now bundled into `@cleocode/worktree/native`), or
 * list a `private: true` package that npm would reject mid-release.
 *
 * Checks (all fail-closed):
 *   1. The `publish_pkg` entry count equals the committed EXPECTED_PUBLISH_COUNT.
 *      Lower this constant (never raise it) as R8/R10 internalize packages; the
 *      destination is 1. A higher count = regression; a lower count = update the
 *      constant in the same PR that removed the publish.
 *   2. Every listed dir resolves to `packages/<arg>/package.json` with
 *      `private !== true` and `name === '@cleocode/' + <npmName>` (npmName = the
 *      optional 2nd token, else the dir basename). A private/missing/misnamed
 *      package in the list is a release-time footgun.
 *   3. None of the 5 per-platform `worktree-napi-*` stub packages appear in the
 *      publish list OR on disk under `packages/` (they were deleted in T11398;
 *      binaries ship bundled, never as separate npm packages).
 *
 * REPO_ROOT is resolved from `process.cwd()` so unit tests can point the script
 * at a synthetic tree (mirrors scripts/lint-deployed-template-parity.mjs).
 *
 * Exit 0 = clean; exit 1 = violations (printed).
 *
 * @task T11400
 * @epic T11388
 * @saga T11387
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Committed expected publish-surface size. Post-E1 (T11399) this is 18.
 * FORWARD-ONLY: decrement this as R8/R10 internalize packages toward the
 * owner's single-artifact target of 1. Never increase it — a larger surface is
 * a regression this gate exists to catch.
 */
export const EXPECTED_PUBLISH_COUNT = 18;

/** The owner's END-STATE publish-surface target (owner decision 1, 2026-05-30). */
export const TARGET_PUBLISH_COUNT = 1;

/** Per-platform napi stub package basenames that must never be published or on disk. */
export const FORBIDDEN_NAPI_STUBS = [
  'worktree-napi-linux-x64-gnu',
  'worktree-napi-linux-arm64-gnu',
  'worktree-napi-darwin-arm64',
  'worktree-napi-darwin-x64',
  'worktree-napi-win32-x64-msvc',
];

/**
 * Parse `publish_pkg <dir> [npmName]` invocations from a release.yml body.
 * Ignores the `publish_pkg() {` function definition (no whitespace before `(`)
 * and any commented-out lines.
 *
 * @param {string} workflowText - the release.yml file contents
 * @returns {{ dir: string, npmName: string, raw: string }[]}
 */
export function parsePublishCalls(workflowText) {
  const calls = [];
  for (const line of workflowText.split('\n')) {
    // A real call is `  publish_pkg <token>[ <token>]`; the definition line is
    // `publish_pkg() {` (paren immediately after the name → no match here).
    const m = /^\s*publish_pkg\s+([A-Za-z0-9._/-]+)(?:\s+([A-Za-z0-9._/-]+))?\s*$/.exec(line);
    if (!m) continue;
    const dir = m[1];
    const npmName = m[2] ?? dir.split('/').pop();
    calls.push({ dir, npmName, raw: line.trim() });
  }
  return calls;
}

/**
 * Run all publish-surface checks against a repo tree.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute path to the repo root
 * @param {number} [opts.expectedCount] - expected publish count (defaults to EXPECTED_PUBLISH_COUNT)
 * @returns {{ violations: string[], count: number }}
 */
export function checkPublishSurface({ repoRoot, expectedCount = EXPECTED_PUBLISH_COUNT }) {
  const violations = [];
  const workflowPath = join(repoRoot, '.github', 'workflows', 'release.yml');
  if (!existsSync(workflowPath)) {
    return { violations: [`release.yml not found at ${workflowPath}`], count: 0 };
  }
  const workflowText = readFileSync(workflowPath, 'utf8');
  const calls = parsePublishCalls(workflowText);
  const count = calls.length;

  // ── Check 1: exact count ────────────────────────────────────────────────
  if (count !== expectedCount) {
    const verb = count > expectedCount ? 'grew (REGRESSION)' : 'shrank';
    violations.push(
      `publish_pkg count ${verb}: found ${count}, expected ${expectedCount}. ` +
        (count > expectedCount
          ? 'Adding a publish is a regression — the surface must trend DOWN to 1.'
          : `Surface shrank — update EXPECTED_PUBLISH_COUNT to ${count} in this PR (toward target ${TARGET_PUBLISH_COUNT}).`),
    );
  }

  // ── Check 2: each entry is publishable + correctly named ─────────────────
  for (const { dir, npmName, raw } of calls) {
    const resolvedDir = dir.includes('/') ? join(repoRoot, dir) : join(repoRoot, 'packages', dir);
    const pkgJsonPath = join(resolvedDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      violations.push(`\`${raw}\`: ${pkgJsonPath} does not exist`);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      violations.push(`\`${raw}\`: ${pkgJsonPath} is not valid JSON (${err.message})`);
      continue;
    }
    if (pkg.private === true) {
      violations.push(
        `\`${raw}\`: ${pkgJsonPath} has "private": true — a private package cannot be published`,
      );
    }
    const expectedName = `@cleocode/${npmName}`;
    if (pkg.name !== expectedName) {
      violations.push(
        `\`${raw}\`: package name "${pkg.name}" !== expected "${expectedName}" ` +
          `(pass an explicit npm-name 2nd token if the dir and name legitimately differ)`,
      );
    }
  }

  // ── Check 3: no per-platform napi stubs in list or on disk ───────────────
  for (const { dir, npmName, raw } of calls) {
    if (FORBIDDEN_NAPI_STUBS.includes(dir) || FORBIDDEN_NAPI_STUBS.includes(npmName)) {
      violations.push(
        `\`${raw}\`: per-platform napi stub is forbidden in the publish list (binaries ship bundled into @cleocode/worktree/native — T11398)`,
      );
    }
  }
  const pkgsDir = join(repoRoot, 'packages');
  if (existsSync(pkgsDir)) {
    for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && FORBIDDEN_NAPI_STUBS.includes(entry.name)) {
        violations.push(
          `packages/${entry.name}/ exists on disk — per-platform napi stub dirs were deleted in T11398 and must not return`,
        );
      }
    }
  }

  return { violations, count };
}

/** CLI entry. */
function main() {
  const repoRoot = process.cwd();
  const { violations, count } = checkPublishSurface({ repoRoot });
  if (violations.length > 0) {
    console.error(`\n✗ publish-surface drift (expected ${EXPECTED_PUBLISH_COUNT} entries):\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\nThe npm publish surface is the publish_pkg list in .github/workflows/release.yml. ` +
        `It must trend DOWN to ${TARGET_PUBLISH_COUNT} (owner decision 1). To remove a publish, ` +
        `delete its publish_pkg line and decrement EXPECTED_PUBLISH_COUNT in scripts/lint-publish-surface.mjs.\n`,
    );
    return 1;
  }
  console.log(
    `✓ publish-surface: ${count} @cleocode/* publishes (expected ${EXPECTED_PUBLISH_COUNT}; target ${TARGET_PUBLISH_COUNT}), all public + correctly named, no napi stubs.`,
  );
  return 0;
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1]?.endsWith('lint-publish-surface.mjs')) {
  process.exit(main());
}
