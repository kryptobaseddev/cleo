/**
 * Failed-first reruns for `tool:test` (T12961).
 *
 * When a test run fails, the failing test FILES are parsed out of the runner's
 * output and remembered per execution root. The next test run in that root —
 * normally after an attempted fix, so on a different tree and a cache miss —
 * runs only those files first:
 *
 *   - still failing → that IS a failing suite; the failure is recorded and the
 *     full run is skipped entirely,
 *   - passing → the normal run (full or affected) proceeds as before.
 *
 * Everything here is best-effort and fails OPEN to today's behaviour: when the
 * failing files cannot be parsed, resolved to tracked files, or mapped to a
 * runnable vitest binary and config, no focused run is planned and the normal
 * command runs unchanged. A focused run can only ever *shorten* a red result;
 * it can never produce a pass, because a pass always falls through to the
 * normal command.
 *
 * ## Why the default reporter's text, not a JSON reporter
 *
 * The resolved test command is the project's own (`pnpm run test`, a pinned
 * `testing.command`, an affected-packages command). Injecting
 * `--reporter=json --outputFile=…` into it would change the command — and
 * therefore the cache key and the evidence identity — and does not compose
 * with scripts that fan out (`pnpm -r test`). The `FAIL <file>` lines of the
 * vitest and jest default reporters sit in the closing summary, which is
 * exactly the part the 64 KiB stream tail retains.
 *
 * ## Why the pointer is keyed on (tool, execution root), not on the command
 *
 * A failing test file is a failing test file whichever command found it: a
 * full run's failures are just as worth re-running first before an affected
 * run, whose command (and therefore cache key) differs. Scoping by execution
 * root keeps one agent's red files out of another worktree's runs. Even if
 * they did cross, a focused failure is a genuine failure of THIS tree's tests.
 *
 * @task T12961
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Canonical tools that record failing files and get failed-first reruns. */
export const FAILED_FIRST_TOOLS: ReadonlySet<string> = new Set(['test']);

/**
 * Most failing files remembered. A larger red set means the tree is broadly
 * broken; the full run is the right next step and the pointer is dropped.
 */
export const MAX_FAILED_TEST_FILES = 100;

/** How a failed-first stage ended. */
export type FailedFirstOutcome = 'failed' | 'passed' | 'inconclusive';

/**
 * Report of the failed-first stage of one run, attached to the result (and,
 * when the focused run decided the result, to the cache entry).
 *
 * @task T12961
 */
export interface FailedFirstReport {
  /** Repo-relative test files that were run first. */
  files: string[];
  /** `failed` stops the run; `passed`/`inconclusive` continue to the normal command. */
  outcome: FailedFirstOutcome;
}

/** The remembered failing files for one (tool, execution root). */
export interface FailedFirstPointer {
  schemaVersion: 1;
  canonical: string;
  executionRoot: string;
  /** Test files relative to `executionRoot`, forward slashes. */
  files: string[];
  /** Tree hash of the run that failed. */
  treeHash: string | null;
  capturedAt: string;
}

/** One focused vitest invocation. */
export interface FocusedRun {
  /** Directory holding the vitest config the files belong to. */
  cwd: string;
  /** Absolute path of the vitest binary. */
  cmd: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A test-file path: `*.test.*` / `*.spec.*` with a JS/TS extension. */
const TEST_FILE = String.raw`(\S+?\.(?:test|spec)\.[cm]?[jt]sx?)`;
/** Optional vitest project label: `|core| `. */
const PROJECT_LABEL = String.raw`(?:\|[^|]+\|\s+)?`;
/** ` FAIL  src/a.test.ts > suite > case` (vitest) or `FAIL src/a.test.ts` (jest). */
const FAIL_LINE = new RegExp(String.raw`^\s*FAIL\s+${PROJECT_LABEL}${TEST_FILE}(?:\s|$)`);
/** ` ❯ src/a.test.ts (3 tests | 1 failed) 12ms` — vitest's per-file summary. */
const FILE_SUMMARY_LINE = new RegExp(
  String.raw`^\s*❯\s+${PROJECT_LABEL}${TEST_FILE}\s+\(.*\bfailed\b`,
);
/** `packages/core test: <line>` — the prefix `pnpm -r` puts on child output. */
const PNPM_RECURSIVE_PREFIX = /^([^\s:]+) [\w:.-]+: (.*)$/;

/**
 * Raw `{base, file}` references to failing test files in runner output.
 *
 * @internal exported for tests
 */
export function extractFailingTestRefs(
  output: string,
): Array<{ base: string | null; file: string }> {
  const refs: Array<{ base: string | null; file: string }> = [];
  for (const rawLine of output.replace(ANSI, '').split(/\r?\n/)) {
    let line = rawLine;
    let base: string | null = null;
    const prefixed = PNPM_RECURSIVE_PREFIX.exec(line);
    if (prefixed?.[1] && prefixed[2] !== undefined) {
      base = prefixed[1];
      line = prefixed[2];
    }
    const m = FAIL_LINE.exec(line) ?? FILE_SUMMARY_LINE.exec(line);
    if (m?.[1]) refs.push({ base, file: m[1] });
  }
  return refs;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** `p` relative to `root` when it is an existing file inside it, else `null`. */
function insideRoot(root: string, p: string): string | null {
  const rel = relative(root, p);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return existsSync(p) ? toPosix(rel) : null;
}

/**
 * Parse the failing test files out of a run's output and resolve each to a
 * path relative to `executionRoot`.
 *
 * A reported path is tried against the `pnpm -r` package prefix, the
 * execution root itself, and `searchBase` (the cwd of a focused run). A path
 * none of those resolve is looked up among tracked files by suffix and kept
 * only when exactly one matches. Unresolvable references are dropped; an empty
 * result means "unknown" and disables failed-first for the next run.
 *
 * @param output - stdout and stderr of the run (ANSI allowed).
 * @param executionRoot - Tree the run executed in.
 * @param trackedFiles - Lazily supplied tracked-file list for suffix lookup.
 * @param searchBase - Extra directory paths may be relative to.
 * @returns Sorted, de-duplicated repo-relative paths; `[]` when unknown or
 *   when more than {@link MAX_FAILED_TEST_FILES} failed.
 *
 * @task T12961
 */
export function parseFailingTestFiles(
  output: string,
  executionRoot: string,
  trackedFiles: () => readonly string[] = () => [],
  searchBase?: string,
): string[] {
  const found = new Set<string>();
  for (const { base, file } of extractFailingTestRefs(output)) {
    const candidates: string[] = [];
    if (isAbsolute(file)) candidates.push(file);
    else {
      if (base !== null) candidates.push(resolve(executionRoot, base, file));
      if (searchBase !== undefined) candidates.push(resolve(searchBase, file));
      candidates.push(resolve(executionRoot, file));
    }
    let hit: string | null = null;
    for (const c of candidates) {
      hit = insideRoot(executionRoot, c);
      if (hit !== null) break;
    }
    if (hit === null && !isAbsolute(file)) {
      const suffix = `/${toPosix(file).replace(/^\.\//, '')}`;
      const matches = trackedFiles().filter((t) => `/${t}`.endsWith(suffix));
      if (matches.length === 1 && matches[0]) hit = matches[0];
    }
    if (hit !== null) found.add(hit);
  }
  if (found.size > MAX_FAILED_TEST_FILES) return [];
  return [...found].sort();
}

/** `true` when vitest reported that the filters matched no test file. */
export function reportsNoTestFiles(output: string): boolean {
  return /No test files found/i.test(output.replace(ANSI, ''));
}

// ---------------------------------------------------------------------------
// Planning the focused run
// ---------------------------------------------------------------------------

const VITEST_CONFIG_NAMES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
  (ext) => `vitest.config.${ext}`,
);

/** Nearest directory from `start` up to `root` (inclusive) satisfying `test`. */
function findUp(start: string, root: string, test: (dir: string) => boolean): string | null {
  let dir = start;
  for (;;) {
    if (test(dir)) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith('..')) return null;
    dir = parent;
  }
}

/**
 * Plan the focused invocations that re-run `files` in `executionRoot`.
 *
 * Each file runs under the vitest config nearest to it — the same config a
 * `cd <package> && vitest run <file>` would use — with the nearest
 * `node_modules/.bin/vitest`. Files are grouped per config directory.
 *
 * @returns The runs, or `null` when any file is gone or has no vitest config
 *   or binary (failed-first is then skipped; the normal command runs).
 *
 * @task T12961
 */
export function planFocusedRuns(
  files: readonly string[],
  executionRoot: string,
): FocusedRun[] | null {
  if (files.length === 0) return null;
  const bin = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
  const groups = new Map<string, FocusedRun>();
  for (const file of files) {
    const abs = resolve(executionRoot, file);
    if (!existsSync(abs)) return null;
    const configDir = findUp(dirname(abs), executionRoot, (d) =>
      VITEST_CONFIG_NAMES.some((n) => existsSync(join(d, n))),
    );
    if (configDir === null) return null;
    let group = groups.get(configDir);
    if (!group) {
      const binDir = findUp(configDir, executionRoot, (d) =>
        existsSync(join(d, 'node_modules', '.bin', bin)),
      );
      if (binDir === null) return null;
      group = { cwd: configDir, cmd: join(binDir, 'node_modules', '.bin', bin), args: ['run'] };
      groups.set(configDir, group);
    }
    group.args.push(toPosix(relative(configDir, abs)));
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Pointer IO
// ---------------------------------------------------------------------------

/**
 * Path of the failed-first pointer for one (tool, execution root). Lives in
 * the evidence cache directory, so `clearToolCache` removes it too.
 *
 * @param storeRoot - CLEO store root holding `.cleo/cache/evidence/`.
 * @param canonical - Canonical tool name.
 * @param executionRoot - Normalised execution root.
 *
 * @task T12961
 */
export function failedFirstPointerPath(
  storeRoot: string,
  canonical: string,
  executionRoot: string,
): string {
  const id = createHash('sha256')
    .update(JSON.stringify([canonical, executionRoot]))
    .digest('hex')
    .slice(0, 32);
  return join(storeRoot, '.cleo', 'cache', 'evidence', `failed-first-${id}.json`);
}

/**
 * Read the failed-first pointer, or `null` when absent or malformed.
 *
 * @task T12961
 */
export function readFailedFirstPointer(
  storeRoot: string,
  canonical: string,
  executionRoot: string,
): FailedFirstPointer | null {
  const path = failedFirstPointerPath(storeRoot, canonical, executionRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<FailedFirstPointer>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.canonical !== canonical ||
      parsed.executionRoot !== executionRoot ||
      !Array.isArray(parsed.files) ||
      parsed.files.length === 0 ||
      !parsed.files.every((f) => typeof f === 'string')
    ) {
      return null;
    }
    return parsed as FailedFirstPointer;
  } catch {
    return null;
  }
}

/**
 * Remember `files` as the failing set, or forget it when `files` is empty.
 * The cache directory must already exist.
 *
 * @task T12961
 */
export function writeFailedFirstPointer(
  storeRoot: string,
  canonical: string,
  executionRoot: string,
  files: readonly string[],
  treeHash: string | null,
): void {
  const path = failedFirstPointerPath(storeRoot, canonical, executionRoot);
  try {
    if (files.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const pointer: FailedFirstPointer = {
      schemaVersion: 1,
      canonical,
      executionRoot,
      files: [...files],
      treeHash,
      capturedAt: new Date().toISOString(),
    };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // Best-effort: losing the pointer only costs the optimisation.
  }
}
