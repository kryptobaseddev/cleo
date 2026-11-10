#!/usr/bin/env node
/**
 * Select the tests a pull request's unit shards run (T13142, T14366).
 *
 * File-level first (T14366): the test files whose static import graph reaches
 * a changed module (`selectAffectedTestFiles` in core), passed to vitest as
 * file filters. When the graph cannot speak for the change (a non-module file
 * such as a migration, fixture or template, a module no test reaches, or too
 * many files), the package-level selection below runs instead.
 *
 * Each PR ran all four unit shards over the whole suite (~7,100 tests,
 * 10–17 min a shard), whatever it changed. A PR now runs the projects of the
 * packages it changes plus their workspace dependents, the set
 * `tool:test-affected` runs locally (D11150, T12635), plus every project that
 * covers no package (the root `scripts` project reads live package files).
 * Main pushes, the nightly run, merge groups and dispatches run the full
 * suite, so coverage is unchanged; only its timing moves.
 *
 * Fails closed to the full suite:
 * - a change outside every workspace package (a root config, the lockfile,
 *   this workflow) — `deriveAffectedPackages` says `full`;
 * - a directly changed package no vitest project covers;
 * - vitest's projects cannot be resolved, git fails, or core's build output
 *   is missing.
 *
 * Usage (unit-tests job, pull_request only):
 *
 *   node scripts/ci-affected-test-projects.mjs <base-ref> <head-ref>
 *
 * Writes to `$GITHUB_OUTPUT`: `mode=full|affected`, `args=<test files>` or
 * `args=<--project a --project b ...>` (empty for `full`) and prints the
 * reason. Always exits 0.
 *
 * @task T13142
 * @task T14366
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ scope: 'affected', direct: string[], packages: string[] } | { scope: 'full', reason: string }} AffectedScope
 * @typedef {{ ok: true, projects: string[], untested: string[] } | { ok: false, reason: string }} Targets
 * @typedef {{ mode: 'full', reason: string } | { mode: 'affected', projects: string[], reason: string }} Selection
 * @typedef {{ mode: 'affected', testFiles: string[], reason: string } | { mode: 'full', reason: string }} FileSelection
 */

/**
 * File-level selection when the import graph covers the change, else the
 * package-level selection with the file-level refusal in its reason.
 *
 * @param {readonly string[] | null} changed - Repo-relative changed paths, or `null` when git failed.
 * @param {(changed: readonly string[]) => FileSelection} files - `selectAffectedTestFiles` bound to the root.
 * @param {(changed: readonly string[] | null) => Promise<Selection>} projects - {@link selectTestProjects}, bound.
 * @returns {Promise<{ mode: 'affected', testFiles: string[], reason: string } | Selection>}
 */
export async function selectTests(changed, files, projects) {
  if (changed !== null && changed.length > 0) {
    const sel = files(changed);
    if (sel.mode === 'affected')
      return { mode: 'affected', testFiles: sel.testFiles, reason: sel.reason };
    const fallback = await projects(changed);
    return { ...fallback, reason: `file-level: ${sel.reason}; package-level: ${fallback.reason}` };
  }
  return projects(changed);
}

/**
 * Decide the projects from the changed paths.
 *
 * @param {readonly string[] | null} changed - Repo-relative changed paths, or `null` when git failed.
 * @param {(changed: readonly string[]) => AffectedScope} derive - `deriveAffectedPackages` bound to the root.
 * @param {(packages: readonly string[], direct: readonly string[]) => Promise<Targets>} targets -
 *   `affectedTestTargets` bound to the root and a resolver.
 * @returns {Promise<Selection>}
 */
export async function selectTestProjects(changed, derive, targets) {
  if (changed === null) return { mode: 'full', reason: 'git could not list the changed paths' };
  if (changed.length === 0) return { mode: 'full', reason: 'the diff is empty' };
  const scope = derive(changed);
  if (scope.scope === 'full') return { mode: 'full', reason: scope.reason };
  if (scope.packages.length === 0) {
    return { mode: 'full', reason: 'no workspace package is affected (documents only)' };
  }
  const resolved = await targets(scope.packages, scope.direct);
  if (!resolved.ok) return { mode: 'full', reason: resolved.reason };
  if (resolved.projects.length === 0) return { mode: 'full', reason: 'no vitest project selected' };
  const untested =
    resolved.untested.length > 0 ? `; no tests in ${resolved.untested.join(', ')}` : '';
  return {
    mode: 'affected',
    projects: resolved.projects,
    reason: `changed ${scope.direct.join(', ')}; affected ${scope.packages.join(', ')}${untested}`,
  };
}

/** `--project <name>` per project, as one shell-safe line (names are package names). */
export function projectArgs(/** @type {readonly string[]} */ projects) {
  for (const p of projects) {
    if (!/^[@\w./-]+$/.test(p)) throw new Error(`unexpected vitest project name: ${p}`);
  }
  return projects.map((p) => `--project ${p}`).join(' ');
}

/** Test files as one line the shell splits into words: no space, quote or glob character. */
export function testFileArgs(/** @type {readonly string[]} */ files) {
  for (const f of files) {
    if (!/^[\w@./+-]+$/.test(f)) throw new Error(`unexpected test file path: ${f}`);
  }
  return files.join(' ');
}

function output(/** @type {Record<string, string>} */ values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

async function main() {
  const [base, head] = process.argv.slice(2);
  const root = process.cwd();
  /** @type {Selection | { mode: 'affected', testFiles: string[], reason: string }} */
  let selection;
  try {
    let changed = null;
    try {
      changed = execFileSync('git', ['diff', '--name-only', '--no-renames', base, head], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter(Boolean);
    } catch {
      changed = null;
    }
    const dist = (/** @type {string} */ m) =>
      import(pathToFileURL(path.join(root, `packages/core/dist/tasks/${m}.js`)).href);
    const core = await dist('affected-packages');
    // Older core builds have no file-level selection: select by package.
    const fileLevel = await dist('affected-tests').catch(() => null);
    // CI owns the machine: no heavy-tool slot to queue for.
    const resolve = (/** @type {string} */ r) =>
      core.listVitestProjects(r, { acquireSlot: async () => async () => {} });
    selection = await selectTests(
      changed,
      (c) =>
        fileLevel?.selectAffectedTestFiles(root, c) ?? {
          mode: 'full',
          reason: 'core has no file-level selection built',
        },
      (c) =>
        selectTestProjects(
          c,
          (cc) => core.deriveAffectedPackages(root, cc),
          (packages, direct) => core.affectedTestTargets(root, packages, direct, resolve),
        ),
    );
  } catch (err) {
    selection = {
      mode: 'full',
      reason: `affected selection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let args = '';
  if (selection.mode === 'affected') {
    try {
      args =
        'testFiles' in selection
          ? testFileArgs(selection.testFiles)
          : projectArgs(selection.projects);
    } catch (err) {
      selection = { mode: 'full', reason: err instanceof Error ? err.message : String(err) };
    }
  }
  if (selection.mode === 'affected') {
    output({ mode: 'affected', args });
    console.log(`Affected tests only (T13142, T14366): ${selection.reason}`);
  } else {
    output({ mode: 'full', args: '' });
    console.log(`Full suite (T13142): ${selection.reason}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
