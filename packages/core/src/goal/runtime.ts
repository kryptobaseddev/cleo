/**
 * CLEO Goal runtime (`@cleocode/goal`, bin `cleo-goal`, alias `ocg`): health
 * and per-project registration.
 *
 * CLEO Goal is a standalone package CLEO talks to only through its bin
 * (T13791 owner decisions). CLEO works fully without it: every function here
 * reports absence instead of throwing.
 *
 * Bin contracts used here: `cleo-goal --version` and
 * `cleo-goal install --project` (idempotent, project-local
 * `.opencode/opencode.json`, never user-global).
 *
 * @task T13819
 * @task T13820
 * @epic T13791
 */

import { execFileSync } from 'node:child_process';
import type { EngineResult } from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { findOnPath } from '@cleocode/paths';
import type { HeavyHookDeliveryReport } from '../resources/heavy-command-hook-delivery.js';

// shortcut: @cleocode/cleo does not list this as an optionalDependency yet, since an unpublished one 404s on every install; add it once the package is on npm (T13819 note).
/** The npm package that ships the CLEO Goal runtime. */
export const GOAL_PACKAGE = '@cleocode/goal';

/** Bin names CLEO Goal installs, primary first (`ocg` = "open cleo goal"). */
export const GOAL_BINS = ['cleo-goal', 'ocg'] as const;

/** Install command shown in remedies. */
export const GOAL_INSTALL_COMMAND = `npm i -g ${GOAL_PACKAGE}@latest`;

/** Harnesses `cleo goal install` accepts, in rollout order (owner decision). */
export const GOAL_HARNESSES = ['opencode', 'claude', 'codex', 'hermes', 'kimi'] as const;

/** One of {@link GOAL_HARNESSES}. */
export type GoalHarness = (typeof GOAL_HARNESSES)[number];

/** Environment the bin lookup and spawns use (tests pass a fake `PATH`). */
type Env = Readonly<Record<string, string | undefined>>;

/** What {@link inspectGoalRuntime} found. */
export interface GoalRuntimeStatus {
  /** Absolute path of the resolved bin, or `null` when neither bin is on PATH. */
  readonly bin: string | null;
  /** Semver from `cleo-goal --version`, or `null` when absent or it failed. */
  readonly version: string | null;
  /** Latest version on npm, or `null` when unpublished, not found or offline. */
  readonly latest: string | null;
  /** `true` when both versions are known and differ. */
  readonly updateAvailable: boolean;
}

/** Run a bin; its trimmed stdout, or `null` on any failure. */
function run(
  file: string,
  args: readonly string[],
  env: Env,
  timeout: number,
  cwd?: string,
): string | null {
  try {
    // shortcut: no shell, so a Windows `.cmd` shim fails here; add shell resolution when Windows is supported.
    return execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: { ...env },
      ...(cwd === undefined ? {} : { cwd }),
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
 * Resolve the CLEO Goal bin on PATH: `cleo-goal`, then `ocg`.
 *
 * @param env - environment whose `PATH` is searched (default `process.env`)
 * @returns the absolute bin path, or `null`
 */
export function resolveGoalBin(env: Env = process.env): string | null {
  for (const name of GOAL_BINS) {
    const found = findOnPath(name, { env });
    if (found !== null) return found;
  }
  return null;
}

/**
 * Inspect the installed CLEO Goal runtime and the latest version on npm.
 * Never throws; an unpublished package or no network leaves `latest` null.
 *
 * @param env - environment for the bin lookup and spawns (default `process.env`)
 * @returns installed path, version, npm latest and whether an update exists
 */
export function inspectGoalRuntime(env: Env = process.env): GoalRuntimeStatus {
  const bin = resolveGoalBin(env);
  const version = semver(bin === null ? null : run(bin, ['--version'], env, 5000));
  const npm = findOnPath('npm', { env });
  // A 404 (not published yet) or no network both leave `latest` null.
  const latest = semver(
    npm === null ? null : run(npm, ['view', GOAL_PACKAGE, 'version'], env, 8000),
  );
  return {
    bin,
    version,
    latest,
    updateAvailable: version !== null && latest !== null && version !== latest,
  };
}

/** `text` parsed as a JSON object, or `null` (plain-text output passes through as is). */
function parseObject(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: Readonly<Record<string, unknown>> | null = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Result of {@link installGoalForHarness}. */
export interface GoalInstallResult {
  /** The harness registered. */
  readonly harness: GoalHarness;
  /** The CLEO Goal bin used. */
  readonly bin: string;
  /** `opencode`: what `cleo-goal install --project` printed (parsed JSON, else text). */
  readonly goal?: Readonly<Record<string, unknown>> | string;
  /** `claude` / `codex`: the project hook delivery that wires the Stop dispatcher. */
  readonly delivery?: HeavyHookDeliveryReport;
}

/**
 * Register CLEO Goal with one harness for this project. Writes only
 * project-level config, never `~/.claude`, `~/.codex` or `~/.config`.
 *
 * - `opencode`: runs `cleo-goal install --project` in the project.
 * - `claude` / `codex`: installs the project Stop dispatcher (`cleo hook stop`,
 *   T13796), which runs the goal tick; no separate Stop hook.
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
    return engineError('E_VALIDATION', `Unknown harness '${harness}'`, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: `Use --harness ${GOAL_HARNESSES.join('|')}`,
    });
  }
  const h = harness as GoalHarness;
  if (h === 'hermes' || h === 'kimi') {
    return engineError(
      'E_NOT_IMPLEMENTED',
      `cleo goal install --harness ${h} is not implemented yet; harness pilots are tracked in T13822`,
      { exitCode: ExitCode.GENERAL_ERROR, fix: 'cleo show T13822' },
    );
  }
  const bin = resolveGoalBin(env);
  if (bin === null) {
    return engineError(
      'E_GOAL_RUNTIME_MISSING',
      `CLEO Goal is not installed: neither ${GOAL_BINS.join(' nor ')} is on PATH`,
      { exitCode: ExitCode.DEPENDENCY_ERROR, fix: GOAL_INSTALL_COMMAND },
    );
  }
  if (h === 'opencode') {
    let out: string;
    try {
      out = execFileSync(bin, ['install', '--project'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        env: { ...env },
      }).trim();
    } catch (err) {
      const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr ?? '').trim() : '';
      return engineError(
        'E_GOAL_INSTALL_FAILED',
        `${bin} install --project failed${stderr ? `: ${stderr}` : ''}`,
        { exitCode: ExitCode.GENERAL_ERROR, fix: `Run ${bin} install --project in ${projectRoot}` },
      );
    }
    return engineSuccess({ harness: h, bin, goal: parseObject(out) ?? out });
  }
  const { deliverHeavyCommandHooks } = await import('../resources/heavy-command-hook-delivery.js');
  const delivery = await deliverHeavyCommandHooks(projectRoot, {
    env,
    providers: [h === 'claude' ? 'claude-code' : 'codex'],
  });
  return engineSuccess({ harness: h, bin, delivery });
}
