/**
 * The modules a command needs AFTER it has run, loaded BEFORE it runs (T13159).
 *
 * The CLI is code-split (T13126): every command module, the renderers and all
 * of CORE arrive through dynamic `import()`. An in-place upgrade (`npm i -g`,
 * `cleo self-update`) replaces the package directory, hashed chunk names and
 * all, while a long-running command (`cleo run --wait` for up to 30 minutes,
 * a `cleo verify` evidence run, the daemon) is still running. When that command
 * finished and only THEN imported its teardown (`@cleocode/core/shutdown`) or
 * the error renderer, the import failed with `ERR_MODULE_NOT_FOUND`, after the
 * child had already finished: its exit code or output was lost.
 *
 * {@link preloadExitPath} starts those imports when the command is dispatched,
 * while the files are certainly there; by the time the command ends they are in
 * the module cache. {@link isVanishedModule} and {@link vanishedModuleNotice}
 * turn any module that is still missing into one plain stderr line instead of a
 * stack trace.
 *
 * Only dynamic imports here: this module is in the CLI's static startup graph
 * (gate 25 forbids core barrels there).
 *
 * @module
 * @task T13159
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the success and error paths call once the command has returned. */
export interface ExitPath {
  /** The CLI error renderer (an error envelope on stdout or stderr). */
  readonly cliError: typeof import('../renderers/index.js').cliError;
  /** Coordinated teardown of process-lifetime resources (success path). */
  readonly shutdownCliRuntime: typeof import('@cleocode/core/shutdown').shutdownCliRuntime;
  /** The unref'd last-resort exit timer. */
  readonly armExitBackstop: typeof import('@cleocode/core/shutdown-deadline').armExitBackstop;
  /** Renders shutdown step outcomes worth reporting. */
  readonly formatShutdownOutcomes: typeof import('@cleocode/core/shutdown-deadline').formatShutdownOutcomes;
}

let preloaded: Promise<ExitPath> | null = null;

/**
 * Start loading the exit path now; later calls return the same promise. A
 * rejection is kept for the caller of {@link exitPath}, never thrown here.
 *
 * @returns the pending exit path.
 *
 * @example
 * ```ts
 * preloadExitPath();          // at dispatch, while the files exist
 * await runCommand(cmd, ...); // may outlive an upgrade
 * const { shutdownCliRuntime } = await exitPath();
 * ```
 */
export function preloadExitPath(): Promise<ExitPath> {
  preloaded ??= Promise.all([
    import('../renderers/index.js'),
    import('@cleocode/core/shutdown'),
    import('@cleocode/core/shutdown-deadline'),
  ]).then(([renderers, shutdown, deadline]) => ({
    cliError: renderers.cliError,
    shutdownCliRuntime: shutdown.shutdownCliRuntime,
    armExitBackstop: deadline.armExitBackstop,
    formatShutdownOutcomes: deadline.formatShutdownOutcomes,
  }));
  // Observed here so an early failure is never an unhandled rejection.
  preloaded.catch(() => {});
  return preloaded;
}

/**
 * The exit path: the preloaded modules, or a fresh load when nothing preloaded
 * them (a path that skipped dispatch).
 */
export function exitPath(): Promise<ExitPath> {
  return preloadExitPath();
}

/**
 * Whether an error is a module that is no longer on disk: Node's
 * `ERR_MODULE_NOT_FOUND`, or a CommonJS `MODULE_NOT_FOUND`.
 *
 * @param err - a caught error.
 */
export function isVanishedModule(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * The one stderr line for a vanished module: when the installed CLEO's version
 * no longer matches the one that started this process, says it was upgraded
 * mid-run and to run the command again; otherwise names the missing module.
 *
 * @param err - the vanished-module error.
 * @param runningVersion - the version this process started as.
 * @param packageJsonPath - the installed package's `package.json`.
 *   @defaultValue the one two levels above this module (`dist/cli/../../`)
 */
export function vanishedModuleNotice(
  err: unknown,
  runningVersion: string,
  packageJsonPath: string = defaultPackageJson(),
): string {
  const installed = installedVersion(packageJsonPath);
  const missing = err instanceof Error ? err.message.split('\n')[0] : String(err);
  if (installed !== null && installed !== runningVersion) {
    return (
      `[cleo] CLEO was upgraded from ${runningVersion} to ${installed} while this command ran, ` +
      `and the code it needed to finish is gone (${missing}). The command itself ran; ` +
      'check its result, and run it again if needed.\n'
    );
  }
  return `[cleo] a CLEO module is missing from the installation (${missing}). Reinstall CLEO.\n`;
}

function defaultPackageJson(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
}

function installedVersion(packageJsonPath: string): string | null {
  try {
    if (!existsSync(packageJsonPath)) return null;
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Forget the preload (tests). @internal */
export function _resetExitPathForTest(): void {
  preloaded = null;
}
