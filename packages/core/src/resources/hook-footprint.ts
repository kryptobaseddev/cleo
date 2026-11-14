/**
 * What a governed run actually used, so the next run of the same command is
 * charged by its measured peak, not its class plan (T13921 for git hooks,
 * T14050 for scripts, T14281 for every command: a one-package `tsc -b` was
 * planned at 12 GiB and measured 0.8 GB). One store, one rule.
 *
 * Keys:
 *
 * - A hook: the repository root, the hook name, the file git calls AND the
 *   hook manager's real script or config (husky's `.husky/<hook>`, lefthook's
 *   config, pre-commit's config). A manager whose real script cannot be found
 *   is never measured, so a shared shim never pools the peaks of different
 *   repositories.
 * - A script: its path and content ({@link scriptFootprint}).
 * - Any other command: the project root and its normalized argv
 *   ({@link commandChargeKey}).
 *
 * The rule (conservative, T14281):
 *
 * - A run counts only when its tree was sampled at least
 *   {@link MEASURED_MIN_SAMPLES} times (it ran long enough to have done work:
 *   an "Everything up-to-date" push or a skipped hook is not a measurement).
 * - The charge is the largest of the last {@link MEASURED_WINDOW} counted
 *   peaks times {@link MEASURED_PEAK_MARGIN}, never above the plan, once
 *   {@link MEASURED_MIN_RUNS} runs are counted.
 * - A run whose peak exceeds that charge resets the count, so the plan applies
 *   again until enough runs are counted (T13972).
 * - Writes take a lock, re-read inside it and replace the file tmp-then-rename,
 *   so concurrent runs never lose a peak.
 *
 * The store is `<cleoHome>/run/charges.json` ({@link chargesDir}). An existing
 * `<cleoHome>/admission/hook-footprints.json` is read once, until the first
 * write of the new file (T14281; that reader goes in Phase 3).
 *
 * Every failure reads as "not measured", which keeps the class plan.
 *
 * @task T13921
 * @task T14281
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { PreparedGitPushHook } from '@cleocode/contracts/resource-governor.js';
import lockfile from 'proper-lockfile';
import { getCleoHome } from '../paths.js';
import { gitHookFor, parseGitInvocation, runFootprint } from './run-class.js';

/** The measured peak is charged with this margin. */
export const MEASURED_PEAK_MARGIN = 1.25;

/** Tree samples a run needs before it counts as a measurement of its hook. */
export const MEASURED_MIN_SAMPLES = 2;

/** Counted runs before the charge may fall below the class plan. */
export const MEASURED_MIN_RUNS = 3;

/** The charge is the largest of this many most recent counted peaks (T14281). */
export const MEASURED_WINDOW = 10;

/** The key prefix of a plain command's charge ({@link commandChargeKey}). */
export const COMMAND_KEY_PREFIX = 'cmd';

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

/** Keys kept in the file; the least recently measured are dropped. */
const MAX_KEYS = 500;

/** One key's measurements. */
interface Measurement {
  /** The last {@link MEASURED_WINDOW} counted peaks, oldest first. */
  readonly peaks: readonly number[];
  /** Counted runs since the count was last reset. */
  readonly runs: number;
  readonly measuredAtMs: number;
  /**
   * The largest peak of an uncounted run that exceeded its charge (a failed
   * run, T14162): it raises the next charge ({@link readMeasuredPeak}) but
   * never counts toward lowering one ({@link readCountedPeak}).
   */
  readonly exceededPeakBytes?: number;
}

/**
 * The directory of the measured-charge store (T14281).
 *
 * @param cleoHome - The CLEO home. @defaultValue {@link getCleoHome}
 */
export function chargesDir(cleoHome: string = getCleoHome()): string {
  return join(cleoHome, 'run');
}

function file(dir: string): string {
  return join(dir, 'charges.json');
}

/** The store before T14281, beside the admission ledger: read once. */
function legacyFile(dir: string): string {
  return join(dirname(dir), 'admission', 'hook-footprints.json');
}

function isPeakList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((p) => typeof p === 'number' && Number.isFinite(p));
}

/** A stored measurement, or a pre-T14281 one (`peakBytes`) read as a one-peak window. */
function asMeasurement(v: unknown): Measurement | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.runs !== 'number' || typeof m.measuredAtMs !== 'number') return null;
  const peaks = isPeakList(m.peaks)
    ? m.peaks.slice(-MEASURED_WINDOW)
    : typeof m.peakBytes === 'number'
      ? m.peakBytes > 0
        ? [m.peakBytes]
        : []
      : null;
  if (peaks === null) return null;
  return {
    peaks,
    runs: m.runs,
    measuredAtMs: m.measuredAtMs,
    ...(typeof m.exceededPeakBytes === 'number' ? { exceededPeakBytes: m.exceededPeakBytes } : {}),
  };
}

function parse(path: string): Record<string, Measurement> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return {};
  const out: Record<string, Measurement> = {};
  for (const [key, v] of Object.entries(doc)) {
    const m = asMeasurement(v);
    if (m !== null) out[key] = m;
  }
  return out;
}

function readAll(dir: string): Record<string, Measurement> {
  if (existsSync(file(dir))) return parse(file(dir)) ?? {};
  // T14281: the hook store's measurements carry over until the first write.
  return parse(legacyFile(dir)) ?? {};
}

function largest(peaks: readonly number[]): number {
  return peaks.reduce((a, b) => Math.max(a, b), 0);
}

function git(
  cwd: string,
  globals: readonly string[],
  args: readonly string[],
  timeout = 5_000,
): string {
  return execFileSync('git', [...globals, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
  }).trim();
}

/** How long the alias probe may take before it fails heavy (T14405). */
const ALIAS_PROBE_TIMEOUT_MS = 2_000;

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

/**
 * Give a push's pre-push hook its own governed run, so a network wait holds no
 * heavy reservation. The delegated `git hook run` restores the original hooks
 * directory and preserves Git's hook arguments, stdin and exit status.
 *
 * @param argv - Original command, including Git's global options.
 * @param cwd - Directory where the command runs.
 * @param runner - This CLI's `run` invocation, including its wait and priority flags.
 * @returns Temporary argv and cleanup, or null when the push cannot be separated safely.
 * @remarks The caller releases the temporary hooks after Git settles, including on spawn failure.
 * @example
 * ```ts
 * const push = prepareGitPushHook(['git', 'push'], process.cwd(), ['cleo', 'run', '--wait']);
 * if (push !== null) push.release();
 * ```
 */
export function prepareGitPushHook(
  argv: readonly string[],
  cwd: string,
  runner: readonly string[],
): PreparedGitPushHook | null {
  const invocation = parseGitInvocation(argv);
  const probe = gitHookFor(argv);
  if (
    invocation?.sub !== 'push' ||
    !probe?.hooks.includes('pre-push') ||
    runFootprint(argv, (name, globals) => gitAlias(cwd, name, globals)).size !== 'light'
  )
    return null;
  const hook = gitHookPath(cwd, 'pre-push', invocation.globals);
  try {
    accessSync(hook, constants.X_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((err as NodeJS.ErrnoException).code === 'EACCES') return null;
    throw err;
  }
  const original = dirname(hook);
  const dir = mkdtempSync(join(tmpdir(), 'cleo-push-hook-'));
  const release = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    for (const name of readdirSync(original)) {
      if (name !== 'pre-push') symlinkSync(join(original, name), join(dir, name));
    }
    const command = [
      ...runner,
      '--passthrough',
      '--class',
      'build',
      '--',
      'git',
      '-c',
      `core.hooksPath=${original}`,
      'hook',
      'run',
    ]
      .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
      .join(' ');
    const input = join(dir, 'refs.XXXXXX').replaceAll("'", "'\\''");
    writeFileSync(
      join(dir, 'pre-push'),
      `#!/bin/sh\nrefs=$(mktemp '${input}') || exit 1\ntrap 'rm -f "$refs"' 0\ncat > "$refs" || exit 1\n${command} --to-stdin="$refs" pre-push -- "$@"\n`,
      { mode: 0o700 },
    );
    const at = argv.length - invocation.args.length - 1;
    return {
      argv: [...argv.slice(0, at), '-c', `core.hooksPath=${dir}`, ...argv.slice(at)],
      release,
    };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * What git says the alias `name` expands to in the repository at `cwd`
 * (T14405): `alias.<name>` or `alias.<name>.command`, read in ONE `git config
 * --get-regexp` call. Git runs the last definition in config order; a shell
 * (`!`) definition anywhere is returned, so a configured `alias.x=status`
 * never masks a later `alias.x.command=!make`. The command's own global
 * options are passed through, so `-C <dir>`, `--exec-path` and an inline
 * `-c alias.x=…` count. Git runs a built-in before an alias of the same name,
 * so the alias is skipped only when `git --list-cmds=builtins` names `name`.
 * An external (`git-mergetool`) is not enough: git falls back to the alias
 * whenever it cannot exec the external (missing from the exec path, or a
 * broken shebang), so its alias is read.
 *
 * @param cwd - Where the command runs.
 * @param name - The git subcommand that may be an alias.
 * @param globals - The command's git global options.
 * @returns The expansion, or `null` when `name` is a git built-in or git
 *   reports no such key.
 * @throws When git cannot answer (unreadable config, missing `-C` directory,
 *   timeout): the caller must not read that as "no alias".
 */
export function gitAlias(
  cwd: string,
  name: string,
  globals: readonly string[] = [],
): string | null {
  const commands = git(cwd, globals, ['--list-cmds=builtins'], ALIAS_PROBE_TIMEOUT_MS);
  if (commands.split('\n').includes(name)) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The variable name is case-insensitive; a subsection is not.
  const pattern = `^alias\\.(${escaped.toLowerCase()}|${escaped}\\.command)$`;
  let out: string;
  try {
    out = git(cwd, globals, ['config', '--null', '--get-regexp', pattern], ALIAS_PROBE_TIMEOUT_MS);
  } catch (err) {
    // Exit 1 is git's "no key matched"; anything else is no answer at all.
    if (err instanceof Error && 'status' in err && err.status === 1) return null;
    throw err;
  }
  // `--null` entries are `<key>\n<value>\0`.
  const values = out
    .split('\0')
    .filter((e) => e !== '')
    .map((e) => e.slice(e.indexOf('\n') + 1));
  return values.find((v) => v.trimStart().startsWith('!')) ?? values.at(-1) ?? null;
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

/**
 * A compiler, test runner or build a Python or shell script runs (T14079):
 * `pytest`, `import pytest`, `tsc`, `cargo build`, `pnpm test`, `make`. Any
 * mention counts, so a script that names one keeps the class plan.
 */
const HEAVY_TOOL_RUN =
  /\b(pytest|unittest|tsc|vitest|jest|esbuild|webpack|rollup|cargo|gradle|mvn|make|go\s+(?:build|test)|(?:pnpm|npm|yarn|npx)\s+(?:run\s+)?(?:test|build|typecheck|vitest|tsc))\b/;

/** A `node` script's measurement key and what it loads (T14050). */
export interface ScriptFootprint {
  /** `<script basename>:<sha256>` over its absolute path and content. */
  readonly key: string;
  /** The heavy tool it loads in-process (`typescript`), or `null`. */
  readonly heavyTool: string | null;
}

/**
 * Key a script's measurements by its absolute path and content (T14050; a
 * Python or shell script too, T14079),
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
    // T14079: a Python or shell script runs its tools as processes.
    const ran = /\.[cm]?js$/.test(path) ? null : HEAVY_TOOL_RUN.exec(content);
    return {
      key: `${basename(path)}:${hash}`,
      heavyTool: m !== null ? (m[1] ?? 'typescript') : (ran?.[1]?.replace(/\s+/g, ' ') ?? null),
    };
  } catch {
    return null;
  }
}

/**
 * The measured peak a charge is lowered to (before the margin): the largest of
 * the last {@link MEASURED_WINDOW} counted peaks, or `null` until
 * {@link MEASURED_MIN_RUNS} runs are counted since the last reset.
 *
 * @param key - From {@link hookFootprintKey}, {@link scriptFootprint} or
 *   {@link commandChargeKey}.
 * @param dir - The store directory. @defaultValue {@link chargesDir}
 */
export function readCountedPeak(key: string, dir: string = chargesDir()): number | null {
  const m = readAll(dir)[key];
  if (m === undefined || m.runs < MEASURED_MIN_RUNS) return null;
  const peak = largest(m.peaks);
  return peak > 0 ? peak : null;
}

/**
 * The largest peak recorded for a key after any number of counted runs, or
 * `null` when none was (T14162). Raising a charge needs one measurement;
 * only lowering one waits for {@link MEASURED_MIN_RUNS} ({@link readCountedPeak}).
 *
 * @param key - From {@link hookFootprintKey}, {@link scriptFootprint} or
 *   {@link commandChargeKey}.
 * @param dir - The store directory. @defaultValue {@link chargesDir}
 */
export function readMeasuredPeak(key: string, dir: string = chargesDir()): number | null {
  const m = readAll(dir)[key];
  const peak = Math.max(largest(m?.peaks ?? []), m?.exceededPeakBytes ?? 0);
  return peak > 0 ? peak : null;
}

/**
 * Record one run: counted only with at least {@link MEASURED_MIN_SAMPLES}
 * samples of its tree; the store keeps the last {@link MEASURED_WINDOW}
 * counted peaks. A lowered charge is provisional: a run whose peak exceeds
 * what the command was charged ({@link MEASURED_PEAK_MARGIN} over the largest
 * stored peak) resets the count, so the class plan applies again until
 * {@link MEASURED_MIN_RUNS} runs are counted (T13972, T14281). Taken under a
 * lock, re-read inside it, written tmp-then-rename; a failure is ignored (the
 * next run keeps the class plan).
 *
 * @param key - From {@link hookFootprintKey}, {@link scriptFootprint} or
 *   {@link commandChargeKey}.
 * @param peakBytes - The run's largest sampled tree RSS.
 * @param samples - How many times the tree was sampled.
 * @param dir - The store directory. @defaultValue {@link chargesDir}
 * @param nowMs - The clock.
 * @param counted - `false` for a run that exceeded its charge but is no
 *   measurement (it exited non-zero, T14162): its excess is kept apart (it
 *   raises the next charge), and an excess over the charge still resets the
 *   count. @defaultValue true
 */
export async function recordRunPeak(
  key: string,
  peakBytes: number,
  samples: number,
  dir: string = chargesDir(),
  nowMs: number = Date.now(),
  counted = true,
): Promise<void> {
  if (!(peakBytes > 0) || samples < MEASURED_MIN_SAMPLES) return;
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
    const stored = largest(last?.peaks ?? []);
    // A key holding only a failed run's excess has no counted peak to exceed.
    const exceeded = stored > 0 && peakBytes > stored * MEASURED_PEAK_MARGIN;
    const excess = Math.max(counted ? 0 : peakBytes, last?.exceededPeakBytes ?? 0);
    const kept = exceeded ? [] : (last?.peaks ?? []);
    const next: Measurement = {
      peaks: counted ? [...kept, peakBytes].slice(-MEASURED_WINDOW) : kept,
      runs: counted ? (exceeded ? 1 : (last?.runs ?? 0) + 1) : exceeded ? 0 : (last?.runs ?? 0),
      measuredAtMs: nowMs,
      ...(excess > 0 ? { exceededPeakBytes: excess } : {}),
    };
    const entries = Object.entries({ ...all, [key]: next })
      .sort(([, a], [, b]) => b.measuredAtMs - a.measuredAtMs)
      .slice(0, MAX_KEYS);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), 'utf8');
    renameSync(tmp, path);
  } catch {
    // Not recorded: the next run keeps the class plan.
  } finally {
    await unlock?.().catch(() => undefined);
  }
}

/**
 * The charge key of a plain command (T14281): `cmd:<sha256>` over the project
 * root and the argv with leading `NAME=value` assignments dropped and each
 * argument trimmed. A hook or script run keeps its own key.
 *
 * @param projectRoot - The project the command runs for.
 * @param argv - The command.
 *
 * @example
 * ```ts
 * commandChargeKey('/repo', ['pnpm', 'exec', 'tsc', '-b']); // 'cmd:9c1…'
 * ```
 */
export function commandChargeKey(projectRoot: string, argv: readonly string[]): string {
  let start = 0;
  while (start < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start] ?? '')) start++;
  const hash = createHash('sha256').update(resolve(projectRoot));
  for (const arg of argv.slice(start)) hash.update('\0').update(arg.trim());
  return `${COMMAND_KEY_PREFIX}:${hash.digest('hex')}`;
}
