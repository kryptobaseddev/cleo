/**
 * CLEO Goal runtime (`@cleocode/goal`, bin `cleo-goal`, alias `ocg`): health
 * and per-project registration.
 *
 * CLEO Goal is a standalone package CLEO talks to only through its bin
 * (T13791 owner decisions). CLEO works fully without it: every function here
 * reports absence instead of throwing.
 *
 * Bin contracts used here: `cleo-goal --version`, `cleo-goal status --json`
 * and `cleo-goal install --project --json` (idempotent, project-local
 * `.opencode/opencode.json`, never user-global). JSON shapes live in
 * `@cleocode/contracts/goal-runtime.js`; an unknown `schemaVersion` is refused.
 *
 * @task T13819
 * @task T13820
 * @task T13821
 * @epic T13791
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EngineResult, HeavyHookDeliveryOutcome } from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  GOAL_RUNTIME_SCHEMA_VERSION,
  type GoalRuntimeError,
  type GoalRuntimeInstall,
  type GoalRuntimeStatus,
} from '@cleocode/contracts/goal-runtime.js';
import { findOnPath } from '@cleocode/paths';
import { joinCommandLine } from '../tasks/command-line.js';

// shortcut: @cleocode/cleo does not list this as an optionalDependency yet, since an unpublished one 404s on every install; add it as ">=0.8.0 <1.0.0" once the package is on npm (T13819 note).
/** The npm package that ships the CLEO Goal runtime. */
export const GOAL_PACKAGE = '@cleocode/goal';

/** Bin names CLEO Goal installs, primary first (`ocg` = "open cleo goal"). */
export const GOAL_BINS = ['cleo-goal', 'ocg'] as const;

/** Install command shown in remedies (the fix of every `E_GOAL_RUNTIME_MISSING`). */
export const GOAL_INSTALL_COMMAND = `npm i -g ${GOAL_PACKAGE}@latest`;

/** Harnesses `cleo goal install` accepts, in rollout order (owner decision). */
export const GOAL_HARNESSES = ['opencode', 'claude', 'codex', 'hermes', 'kimi'] as const;

/** One of {@link GOAL_HARNESSES}. */
export type GoalHarness = (typeof GOAL_HARNESSES)[number];

/** Environment the bin lookup and spawns use (tests pass a fake `PATH`). */
type Env = Readonly<Record<string, string | undefined>>;

/** What {@link inspectGoalRuntime} found. */
export interface GoalRuntimeHealth {
  /** Absolute path of the resolved bin, or `null` when neither bin is on PATH. */
  readonly bin: string | null;
  /** An `ocg` on PATH that is not CLEO Goal (another tool's bin), else `null`. */
  readonly foreign: string | null;
  /** Semver from `cleo-goal --version`, or `null` when absent or it failed. */
  readonly version: string | null;
  /** Latest version on npm; `null` unless `checkUpdates`, or when unpublished, not found or offline. */
  readonly latest: string | null;
  /** `true` when both versions are known and differ. */
  readonly updateAvailable: boolean;
}

/** Run a bin; its trimmed stdout, or `null` on any failure. */
function run(file: string, args: readonly string[], env: Env, timeout: number): string | null {
  try {
    // shortcut: no shell, so a Windows `.cmd` shim fails here; add shell resolution when Windows is supported.
    return execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: { ...env },
    }).trim();
  } catch {
    return null;
  }
}

/** The first semver in `text` (`cleo-goal 0.5.0` → `0.5.0`), or `null`. */
function semver(text: string | null): string | null {
  return text?.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? null;
}

/**
 * Whether `bin` belongs to the `@cleocode/goal` package: the nearest
 * `package.json` above its real path is named {@link GOAL_PACKAGE}. Reads
 * files only, never runs the bin.
 */
function isGoalPackageBin(bin: string): boolean {
  try {
    let dir = dirname(realpathSync(bin));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg: { readonly name?: string } = JSON.parse(
          readFileSync(join(dir, 'package.json'), 'utf-8'),
        );
        return pkg.name === GOAL_PACKAGE;
      } catch {
        // No readable package.json here; keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    // Dangling link or unreadable path.
  }
  return false;
}

/**
 * Locate the CLEO Goal bin on PATH without running anything: `cleo-goal`,
 * else `ocg` only when it belongs to {@link GOAL_PACKAGE} (`ocg` is a short
 * name another tool may own).
 *
 * @param env - environment whose `PATH` is searched (default `process.env`)
 * @returns the bin, and a foreign `ocg` that was skipped
 */
export function locateGoalBin(env: Env = process.env): {
  readonly bin: string | null;
  readonly foreign: string | null;
} {
  const primary = findOnPath('cleo-goal', { env });
  if (primary !== null) return { bin: primary, foreign: null };
  const ocg = findOnPath('ocg', { env });
  if (ocg === null) return { bin: null, foreign: null };
  return isGoalPackageBin(ocg) ? { bin: ocg, foreign: null } : { bin: null, foreign: ocg };
}

/**
 * Resolve the CLEO Goal bin on PATH: `cleo-goal`, then an `ocg` that belongs
 * to {@link GOAL_PACKAGE}. Synchronous and spawn-free.
 *
 * @param env - environment whose `PATH` is searched (default `process.env`)
 * @returns the absolute bin path, or `null`
 */
export function resolveGoalBin(env: Env = process.env): string | null {
  return locateGoalBin(env).bin;
}

/**
 * The Stop dispatcher's tick command line for the resolved bin
 * (`<bin> tick`, shell-quoted), or `null` when CLEO Goal is not installed.
 *
 * @param env - environment whose `PATH` is searched (default `process.env`)
 * @returns the command line, or `null`
 */
export function goalTickCommand(env: Env = process.env): string | null {
  const bin = resolveGoalBin(env);
  return bin === null ? null : joinCommandLine([bin, 'tick']);
}

/**
 * Inspect the installed CLEO Goal runtime. Local only by default: the npm
 * lookup runs only with `checkUpdates` (no network otherwise). Never throws;
 * an unpublished package or no network leaves `latest` null.
 *
 * @param env - environment for the bin lookup and spawns (default `process.env`)
 * @param options - `checkUpdates` asks npm for the latest version
 * @returns installed path, version, npm latest and whether an update exists
 */
export function inspectGoalRuntime(
  env: Env = process.env,
  options: { readonly checkUpdates?: boolean } = {},
): GoalRuntimeHealth {
  const { bin, foreign } = locateGoalBin(env);
  const version = semver(bin === null ? null : run(bin, ['--version'], env, 2000));
  const npm = options.checkUpdates === true ? findOnPath('npm', { env }) : null;
  // A 404 (not published yet) or no network both leave `latest` null.
  const latest = semver(
    npm === null ? null : run(npm, ['view', GOAL_PACKAGE, 'version'], env, 8000),
  );
  return {
    bin,
    foreign,
    version,
    latest,
    updateAvailable: version !== null && latest !== null && version !== latest,
  };
}

/** `text` parsed as a JSON object carrying a `schemaVersion`, or `null`. */
function parseVersioned(text: string): { readonly schemaVersion?: number } | null {
  try {
    const parsed: { readonly schemaVersion?: number } | null = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Run `bin args` in `cwd` and read its JSON reply per the CLEO Goal exit
 * contract: 0 = the `T` shape, 1 = {@link GoalRuntimeError}, 2 = usage error
 * on stderr. Any `schemaVersion` other than {@link GOAL_RUNTIME_SCHEMA_VERSION}
 * is refused.
 */
function runGoalJson<T>(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: Env,
  timeout: number,
): EngineResult<T> {
  // shortcut: no shell, so a Windows `.cmd` shim fails here; add shell resolution when Windows is supported.
  const r = spawnSync(bin, args, { cwd, encoding: 'utf-8', timeout, env: { ...env } });
  const command = `${bin} ${args.join(' ')}`;
  if (r.error !== undefined && 'code' in r.error && r.error.code === 'ETIMEDOUT') {
    // @sync-invariant none:local-only the goal bin did not answer in time; nothing is written
    return engineError('E_GOAL_RUNTIME_TIMEOUT', `${command} did not answer within ${timeout} ms`, {
      exitCode: ExitCode.GENERAL_ERROR,
      fix: `Run ${command} in ${cwd} to see why it is slow`,
    });
  }
  const body = parseVersioned(r.stdout ?? '');
  if ((r.status === 0 || r.status === 1) && body === null) {
    const out = (r.stdout ?? '').trim().slice(0, 200);
    // @sync-invariant none:local-only the goal bin replied with non-JSON; nothing is written
    return engineError(
      'E_GOAL_RUNTIME_FAILED',
      `${command} replied with non-JSON output: ${out || '(empty)'}`,
      {
        exitCode: ExitCode.GENERAL_ERROR,
        fix: `${GOAL_INSTALL_COMMAND} (this CLEO reads ${command} as JSON, schemaVersion ${GOAL_RUNTIME_SCHEMA_VERSION})`,
      },
    );
  }
  if (r.status === 2) {
    // @sync-invariant none:input-shape the goal bin rejected CLEO's arguments; nothing is written
    return engineError(
      'E_GOAL_RUNTIME_USAGE',
      `${command}: ${(r.stderr ?? '').trim() || 'usage error'}`,
      {
        exitCode: ExitCode.GENERAL_ERROR,
        fix: `${GOAL_INSTALL_COMMAND} (this CLEO needs a cleo-goal that accepts: ${args.join(' ')})`,
      },
    );
  }
  if ((r.status === 0 || r.status === 1) && body?.schemaVersion !== GOAL_RUNTIME_SCHEMA_VERSION) {
    // @sync-invariant none:local-only the goal bin speaks an unknown schema; nothing is written
    return engineError(
      'E_GOAL_RUNTIME_SCHEMA',
      `${command} replied with schemaVersion ${String(body?.schemaVersion)}; this CLEO understands ${GOAL_RUNTIME_SCHEMA_VERSION}`,
      {
        exitCode: ExitCode.DEPENDENCY_ERROR,
        fix: 'Upgrade both: npm i -g @cleocode/cleo@latest @cleocode/goal@latest',
      },
    );
  }
  if (r.status === 0) return engineSuccess(body as T);
  const reason =
    r.status === 1
      ? (body as GoalRuntimeError).error
      : (r.error?.message ?? `exit ${String(r.status ?? r.signal)}`);
  // @sync-invariant none:local-only the goal bin failed on this machine; no cleo.db write
  return engineError('E_GOAL_RUNTIME_FAILED', `${command} failed: ${reason}`, {
    exitCode: ExitCode.GENERAL_ERROR,
    fix: `Run ${command} in ${cwd} to see the full error`,
  });
}

/** The missing-bin failure, with the install command as the fix. */
function goalRuntimeMissing<T>(): EngineResult<T> {
  // @sync-invariant none:local-only the goal bin is absent on this machine; nothing is written
  return engineError(
    'E_GOAL_RUNTIME_MISSING',
    `CLEO Goal is not installed: neither ${GOAL_BINS.join(' nor ')} is on PATH`,
    { exitCode: ExitCode.DEPENDENCY_ERROR, fix: GOAL_INSTALL_COMMAND },
  );
}

/**
 * Read the live goal through `cleo-goal status --json` in the project. A
 * project with no goal is a success with `status: 'none'`.
 *
 * @param projectRoot - absolute project root (the bin's cwd)
 * @param env - environment for the bin lookup and spawn (default `process.env`)
 * @param timeoutMs - deadline for the bin (default 15 s; `cleo doctor` passes 2 s)
 * @returns the status shape, or a failure (`E_GOAL_RUNTIME_MISSING`,
 *   `E_GOAL_RUNTIME_SCHEMA`, `E_GOAL_RUNTIME_USAGE`, `E_GOAL_RUNTIME_TIMEOUT`,
 *   `E_GOAL_RUNTIME_FAILED`)
 */
export function readGoalStatus(
  projectRoot: string,
  env: Env = process.env,
  timeoutMs = 15_000,
): EngineResult<GoalRuntimeStatus> {
  const bin = resolveGoalBin(env);
  if (bin === null) return goalRuntimeMissing();
  return runGoalJson<GoalRuntimeStatus>(bin, ['status', '--json'], projectRoot, env, timeoutMs);
}

/** Result of {@link installGoalForHarness}. */
export interface GoalInstallResult {
  /** The harness registered. */
  readonly harness: GoalHarness;
  /** The CLEO Goal bin used. */
  readonly bin: string;
  /** `opencode`: the `cleo-goal install --project --json` reply. */
  readonly goal?: GoalRuntimeInstall;
  /** `claude` / `codex`: the project Stop dispatcher outcome. */
  readonly delivery?: HeavyHookDeliveryOutcome;
}

/**
 * Register CLEO Goal with one harness for this project. Writes only
 * project-level config, never `~/.claude`, `~/.codex` or `~/.config`.
 *
 * - `opencode`: runs `cleo-goal install --project --json` in the project.
 * - `claude` / `codex`: installs only the project Stop dispatcher (`cleo hook
 *   stop`, T13796), which runs the goal tick, whatever the heavy-command mode;
 *   no separate Stop hook and no `PreToolUse` hook.
 * - `hermes` / `kimi`: `E_NOT_IMPLEMENTED` until the pilot (T13822).
 *
 * @param projectRoot - absolute project root
 * @param harness - harness to register with
 * @param env - environment for the bin lookup and spawn (default `process.env`)
 * @returns the registration result, or a failure with a remedy
 */
export async function installGoalForHarness(
  projectRoot: string,
  harness: string,
  env: Env = process.env,
): Promise<EngineResult<GoalInstallResult>> {
  if (!(GOAL_HARNESSES as readonly string[]).includes(harness)) {
    // @sync-invariant none:input-shape unknown --harness value; nothing is written
    return engineError('E_VALIDATION', `Unknown harness '${harness}'`, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: `Use --harness ${GOAL_HARNESSES.join('|')}`,
    });
  }
  const h = harness as GoalHarness;
  if (h === 'hermes' || h === 'kimi') {
    // @sync-invariant none:input-shape harness not supported yet; nothing is written
    return engineError(
      'E_NOT_IMPLEMENTED',
      `cleo goal install --harness ${h} is not implemented yet; harness pilots are tracked in T13822`,
      { exitCode: ExitCode.GENERAL_ERROR, fix: 'cleo show T13822' },
    );
  }
  const bin = resolveGoalBin(env);
  if (bin === null) return goalRuntimeMissing();
  if (h === 'opencode') {
    const installed = runGoalJson<GoalRuntimeInstall>(
      bin,
      ['install', '--project', '--json'],
      projectRoot,
      env,
      60_000,
    );
    if (installed.success) return engineSuccess({ harness: h, bin, goal: installed.data });
    // @sync-invariant none:local-only the goal bin failed writing project config; no cleo.db write
    return engineError('E_GOAL_INSTALL_FAILED', installed.error.message, {
      exitCode: installed.error.exitCode ?? ExitCode.GENERAL_ERROR,
      ...(installed.error.fix === undefined ? {} : { fix: installed.error.fix }),
    });
  }
  const { loadHeavyHookDelivery } = await import('../resources/heavy-command-hook-delivery.js');
  const sync = (await loadHeavyHookDelivery()).syncProjectStopDispatch;
  if (sync === undefined) {
    // @sync-invariant none:local-only the installed adapters package predates Stop-only delivery; nothing is written
    return engineError(
      'E_GOAL_INSTALL_FAILED',
      '@cleocode/adapters is too old to install the Stop dispatcher alone',
      {
        exitCode: ExitCode.DEPENDENCY_ERROR,
        fix: 'npm i -g @cleocode/cleo@latest',
      },
    );
  }
  const delivery = await sync(projectRoot, h === 'claude' ? 'claude-code' : 'codex');
  if (
    delivery.status === 'failed' ||
    delivery.status === 'needs-consent' ||
    delivery.status === 'skipped'
  ) {
    // @sync-invariant none:local-only the project hook file could not be written; no cleo.db write
    return engineError(
      'E_GOAL_INSTALL_FAILED',
      `Stop dispatcher not installed in ${delivery.target}: ${delivery.reason ?? delivery.status}`,
      {
        exitCode: ExitCode.GENERAL_ERROR,
        details: delivery,
        ...(delivery.remedy === undefined ? {} : { fix: delivery.remedy }),
      },
    );
  }
  return engineSuccess({ harness: h, bin, delivery });
}
