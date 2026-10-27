/**
 * What a git hook actually used (T13921), so a hooked `git push` or `git
 * commit` is charged by its measured peak, not assumed to be a scoped build
 * (a pre-push typecheck was charged 12 GiB and four routine pushes held a
 * one-file fix for 35 minutes).
 *
 * Safety rules (review of #2386):
 *
 * - The key covers the repository root, the hook name, the file git calls AND
 *   the hook manager's real script or config (husky's `.husky/<hook>`,
 *   lefthook's config, pre-commit's config). A manager whose real script
 *   cannot be found is never measured, so a shared shim never pools the
 *   peaks of different repositories.
 * - A run counts only when its tree was sampled at least
 *   {@link HOOK_MIN_SAMPLES} times (it ran long enough for the hook to have
 *   done work: an "Everything up-to-date" push or a skipped hook is not a
 *   measurement), and the charge is lowered only after
 *   {@link HOOK_MIN_RUNS} counted runs. The recorded peak is the maximum of
 *   every counted run, so one light run never lowers it.
 * - Writes take a lock and keep the maximum, so concurrent runs never lose
 *   a peak.
 *
 * Every failure reads as "not measured", which keeps the class plan.
 *
 * @task T13921
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

/** The measured peak is charged with this margin. */
export const HOOK_PEAK_MARGIN = 1.25;

/** Tree samples a run needs before it counts as a measurement of its hook. */
export const HOOK_MIN_SAMPLES = 2;

/** Counted runs before the charge may fall below the class plan. */
export const HOOK_MIN_RUNS = 3;

/**
 * Environment variables that switch a hook manager off or narrow what it runs
 * (T13972): their values are part of the key, so `HUSKY=0 git push` is never
 * measured as the same hook as a full one.
 */
export const HOOK_ENV_KEYS = [
  'HUSKY',
  'HUSKY_SKIP_HOOKS',
  'LEFTHOOK',
  'LEFTHOOK_EXCLUDE',
  'LEFTHOOK_ONLY',
  'SKIP',
  'PRE_COMMIT_ALLOW_NO_CONFIG',
] as const;

/** Hooks kept in the file; the least recently measured are dropped. */
const MAX_HOOKS = 200;

/** One hook's measurement. */
interface HookMeasurement {
  /** The largest peak of every counted run. */
  readonly peakBytes: number;
  /** Counted runs. */
  readonly runs: number;
  readonly measuredAtMs: number;
}

function file(dir: string): string {
  return join(dir, 'hook-footprints.json');
}

function isMeasurement(v: unknown): v is HookMeasurement {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.peakBytes === 'number' &&
    typeof m.runs === 'number' &&
    typeof m.measuredAtMs === 'number'
  );
}

function readAll(dir: string): Record<string, HookMeasurement> {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file(dir), 'utf8'));
  } catch {
    return {};
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return {};
  const out: Record<string, HookMeasurement> = {};
  for (const [key, m] of Object.entries(doc)) if (isMeasurement(m)) out[key] = m;
  return out;
}

function git(cwd: string, globals: readonly string[], args: readonly string[]): string {
  return execFileSync('git', [...globals, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  }).trim();
}

/**
 * Where git looks for a hook in the repository at `cwd`: `git rev-parse
 * --git-path hooks/<name>` honours `core.hooksPath`, and the command's own
 * global options (`-C <dir>`, `-c core.hooksPath=…`) pick the repository and
 * hooks directory it will use (T13458). Throws when git cannot say.
 *
 * @param cwd - Where the git command runs.
 * @param hook - Hook name (`pre-push`).
 * @param globals - The command's git global options.
 * @returns The absolute hook path (the file may not exist).
 */
export function gitHookPath(cwd: string, hook: string, globals: readonly string[] = []): string {
  const path = git(cwd, globals, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    `hooks/${hook}`,
  ]);
  return isAbsolute(path) ? path : join(cwd, path);
}

/** Lefthook's config files, any of which it reads. */
const LEFTHOOK_CONFIGS = [
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yaml',
  'lefthook-local.yml',
  '.lefthook-local.yml',
  'lefthook-local.yaml',
  '.lefthook-local.yaml',
] as const;

/**
 * The hook manager's real script or config for a shim, as `[path, content]`
 * pairs; the root package.json for a plain hook that runs package scripts;
 * `[]` for a hook that is its own script; `null` when the shim names a
 * manager whose real script cannot be found (then nothing is measured).
 */
function managedSources(
  shim: string,
  top: string,
  hook: string,
): ReadonlyArray<readonly [string, string]> | null {
  const read = (rel: string): readonly [string, string] | null => {
    const path = join(top, rel);
    return existsSync(path) ? [rel, readFileSync(path, 'utf8')] : null;
  };
  const found = (rels: readonly string[]): ReadonlyArray<readonly [string, string]> =>
    rels.map(read).filter((x): x is readonly [string, string] => x !== null);
  if (/\bhusky\b/.test(shim)) {
    // husky v9 runs `.husky/<hook>`; husky v4 reads its config from package.json.
    const sources = found([`.husky/${hook}`, 'package.json']);
    return sources.length > 0 ? sources : null;
  }
  if (/\blefthook\b/.test(shim)) {
    const sources = found(LEFTHOOK_CONFIGS);
    return sources.length > 0 ? sources : null;
  }
  const preCommit = /INSTALL_PYTHON|pre_commit|pre-commit\s+hook-impl/;
  if (/\bpre[-_]commit\b/.test(shim) && preCommit.test(shim)) {
    const sources = found(['.pre-commit-config.yaml']);
    return sources.length > 0 ? sources : null;
  }
  // T13974: a plain hook that runs package scripts (`pnpm typecheck`) is keyed
  // by the package.json that defines them, so editing a script re-measures.
  return /\b(npm|pnpm|yarn|bun)\b/.test(shim) ? found(['package.json']) : [];
}

/**
 * The key for a hook as installed in the repository at `cwd`: `<hook>:<sha256>`
 * over the repository root, the hook name, the file git calls
 * ({@link gitHookPath}), the hook manager's real script or config, and the
 * {@link HOOK_ENV_KEYS} the run sees. `null` when any of them cannot be read,
 * or the file names a manager whose real script is missing: such a hook is
 * never measured.
 *
 * @param cwd - Where the git command runs.
 * @param hook - Hook name (`pre-push`).
 * @param globals - The command's git global options.
 * @param env - The environment the run inherits. @defaultValue process.env
 */
export function hookFootprintKey(
  cwd: string,
  hook: string,
  globals: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const top = git(cwd, globals, ['rev-parse', '--show-toplevel']);
    const shim = readFileSync(gitHookPath(cwd, hook, globals), 'utf8');
    const managed = managedSources(shim, top, hook);
    if (managed === null) return null;
    const hash = createHash('sha256');
    const switches = HOOK_ENV_KEYS.map((k) => `${k}=${env[k] ?? ''}`);
    for (const part of [top, hook, shim, ...managed.flat(), ...switches]) {
      hash.update(part).update('\0');
    }
    return `${hook}:${hash.digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * A module a script loads that runs a compiler or test runner in-process
 * (T14050): `require('typescript')`, `import … from 'vitest'`,
 * `import('esbuild')`, `ts.createProgram(`.
 */
const HEAVY_TOOL_LOAD =
  /(?:require\(|import\(|from)\s*['"](typescript|vitest(?:\/node)?|jest|esbuild|webpack|rollup|@swc\/core|@babel\/core)['"]|\bcreateProgram\s*\(/;

/** A `node` script's measurement key and what it loads (T14050). */
export interface ScriptFootprint {
  /** `<script basename>:<sha256>` over its absolute path and content. */
  readonly key: string;
  /** The heavy tool it loads in-process (`typescript`), or `null`. */
  readonly heavyTool: string | null;
}

/**
 * Key a `node` script's measurements by its absolute path and content (T14050),
 * as a hook is keyed by its files: an edited script is measured afresh. The
 * key's first part is the script's basename, which is what a measured run's
 * process tree is matched on. `null` when the script cannot be read: such a
 * run is never measured.
 *
 * @param cwd - Where the command runs.
 * @param script - The script path, as the command names it.
 *
 * @example
 * ```ts
 * scriptFootprint(repo, 'scripts/typecheck/full-program.cjs');
 * // { key: 'full-program.cjs:3f…', heavyTool: 'typescript' }
 * ```
 */
export function scriptFootprint(cwd: string, script: string): ScriptFootprint | null {
  try {
    const path = resolve(cwd, script);
    const content = readFileSync(path, 'utf8');
    const hash = createHash('sha256').update(path).update('\0').update(content).digest('hex');
    const m = HEAVY_TOOL_LOAD.exec(content);
    return {
      key: `${basename(path)}:${hash}`,
      heavyTool: m === null ? null : (m[1] ?? 'typescript'),
    };
  } catch {
    return null;
  }
}

/**
 * The measured peak for a hook key, or `null` until it has
 * {@link HOOK_MIN_RUNS} counted runs.
 *
 * @param key - From {@link hookFootprintKey}.
 * @param dir - The admission directory.
 */
export function readHookPeak(key: string, dir: string): number | null {
  const m = readAll(dir)[key];
  return m !== undefined && m.runs >= HOOK_MIN_RUNS && m.peakBytes > 0 ? m.peakBytes : null;
}

/**
 * Record one run of a hook: counted only with at least
 * {@link HOOK_MIN_SAMPLES} samples that saw the hook running; the stored peak
 * is the maximum of every counted run. A lowered charge is provisional: a run
 * whose peak exceeds what the hook was charged ({@link HOOK_PEAK_MARGIN} over
 * the stored peak) resets the count to that one run, so the class plan
 * applies again until it has {@link HOOK_MIN_RUNS} counted runs (T13972).
 * Taken under a lock, re-read
 * inside it; a failure is ignored (the next run keeps the class plan).
 *
 * @param key - From {@link hookFootprintKey}.
 * @param peakBytes - The run's largest sampled tree RSS.
 * @param samples - How many times the tree was sampled.
 * @param dir - The admission directory.
 * @param nowMs - The clock.
 */
export async function recordHookPeak(
  key: string,
  peakBytes: number,
  samples: number,
  dir: string,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!(peakBytes > 0) || samples < HOOK_MIN_SAMPLES) return;
  let unlock: (() => Promise<void>) | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const path = file(dir);
    unlock = await lockfile.lock(path, {
      lockfilePath: `${path}.lock`,
      realpath: false,
      stale: 10_000,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      // A compromised lock must never throw from proper-lockfile's timer (T13973).
      onCompromised: () => {},
    });
    const all = readAll(dir);
    const last = all[key];
    const exceeded = last !== undefined && peakBytes > last.peakBytes * HOOK_PEAK_MARGIN;
    const next: HookMeasurement = {
      peakBytes: Math.max(peakBytes, last?.peakBytes ?? 0),
      runs: exceeded ? 1 : (last?.runs ?? 0) + 1,
      measuredAtMs: nowMs,
    };
    const kept = Object.entries({ ...all, [key]: next })
      .sort(([, a], [, b]) => b.measuredAtMs - a.measuredAtMs)
      .slice(0, MAX_HOOKS);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), 'utf8');
    renameSync(tmp, path);
  } catch {
    // Not recorded: the next run keeps the class plan.
  } finally {
    await unlock?.().catch(() => undefined);
  }
}
