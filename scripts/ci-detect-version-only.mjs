#!/usr/bin/env node
/**
 * Detect a "version-only" pull request — the release bump-PR shape — so CI can
 * skip the heavy jobs (unit tests, builds, install/packed artifacts) and run
 * only lint, typecheck and the lockfile check on it.
 *
 * A diff is version-only when EVERY changed path is one of:
 *   - a `package.json` (root or nested) whose ONLY changed lines are
 *     `"version": "..."` lines;
 *   - a `CHANGELOG.md` (any directory), with any content change;
 *   - a path under `.changeset/` (adds, deletes and moves between
 *     `.changeset/` locations), with any content change.
 *
 * Anything else — including an empty diff, a binary `package.json`, a rename
 * into or out of `.changeset/`, or a git error — is NOT version-only, and CI
 * runs in full. The detector fails open to the full run, never to a skip.
 *
 * Usage (in the `changes` job of `.github/workflows/ci.yml`):
 *
 *   node scripts/ci-detect-version-only.mjs <base-ref> <head-ref>
 *
 * Writes `version_only=true|false` to `$GITHUB_OUTPUT` when set, and prints the
 * reason. Always exits 0 — a detector crash must not fail CI, it must only
 * withhold the skip.
 *
 * @task ci-speed-shards
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A `"version": "x.y.z"` line as it appears in a unified diff, with its +/- marker. */
export const VERSION_LINE = /^[+-]\s*"version"\s*:\s*"[^"\n]*"\s*,?\s*$/;

/**
 * Classify one repository path.
 *
 * @param {string} path - Repo-relative path, forward slashes.
 * @returns {'package-json' | 'free' | null} `package-json` when only version
 *   lines may change, `free` when any change is allowed, `null` when the path
 *   is outside the version-only shape.
 */
export function classifyPath(path) {
  if (path === 'package.json' || path.endsWith('/package.json')) return 'package-json';
  if (path === 'CHANGELOG.md' || path.endsWith('/CHANGELOG.md')) return 'free';
  if (path.startsWith('.changeset/')) return 'free';
  return null;
}

/**
 * Return true when every changed line of a unified diff is a version line and
 * there is at least one such line.
 *
 * @param {string} patch - `git diff --unified=0` output for ONE file.
 * @returns {boolean}
 */
export function isVersionOnlyPatch(patch) {
  if (/^Binary files /m.test(patch)) return false;
  let changed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (!VERSION_LINE.test(line)) return false;
    changed += 1;
  }
  return changed > 0;
}

/**
 * Parse `git diff --name-status -z -M` output into change records.
 *
 * @param {string} raw - NUL-separated name-status output.
 * @returns {{ status: string, path: string, oldPath?: string }[]}
 */
export function parseNameStatus(raw) {
  const fields = raw.split('\0').filter((f) => f !== '');
  /** @type {{ status: string, path: string, oldPath?: string }[]} */
  const changes = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[i++];
      const path = fields[i++];
      changes.push({ status: status[0], path, oldPath });
    } else {
      changes.push({ status: status[0], path: fields[i++] });
    }
  }
  return changes;
}

/**
 * Decide whether a set of changes is version-only.
 *
 * @param {{ status: string, path: string, oldPath?: string }[]} changes
 * @param {(path: string) => string} patchFor - Returns the `--unified=0` patch for a path.
 * @returns {{ versionOnly: boolean, reason: string }}
 */
export function classifyChanges(changes, patchFor) {
  if (changes.length === 0) return { versionOnly: false, reason: 'empty diff' };
  for (const change of changes) {
    const kind = classifyPath(change.path);
    if (change.oldPath !== undefined) {
      // A move is allowed only when BOTH ends are free paths (e.g. a
      // `.changeset/x.md` → `.changeset/shipped/v/x.md` archive move).
      if (kind !== 'free' || classifyPath(change.oldPath) !== 'free') {
        return {
          versionOnly: false,
          reason: `rename outside the version-only shape: ${change.oldPath} -> ${change.path}`,
        };
      }
      continue;
    }
    if (kind === null) {
      return { versionOnly: false, reason: `path outside the version-only shape: ${change.path}` };
    }
    if (kind === 'package-json') {
      if (change.status !== 'M') {
        return { versionOnly: false, reason: `package.json added/deleted: ${change.path}` };
      }
      if (!isVersionOnlyPatch(patchFor(change.path))) {
        return { versionOnly: false, reason: `non-version change in ${change.path}` };
      }
    }
  }
  return { versionOnly: true, reason: `${changes.length} path(s), all version-only` };
}

/**
 * Run git with the given arguments and return stdout.
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
  const [base, head] = argv;
  let result;
  if (!base || !head) {
    result = { versionOnly: false, reason: 'usage: ci-detect-version-only.mjs <base> <head>' };
  } else {
    try {
      const changes = parseNameStatus(git(['diff', '--name-status', '-z', '-M', base, head]));
      result = classifyChanges(changes, (path) =>
        git(['diff', '--no-color', '--no-ext-diff', '--unified=0', base, head, '--', path]),
      );
    } catch (err) {
      result = { versionOnly: false, reason: `detector error, running full CI: ${String(err)}` };
    }
  }
  process.stdout.write(`version_only=${result.versionOnly} (${result.reason})\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version_only=${result.versionOnly}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
