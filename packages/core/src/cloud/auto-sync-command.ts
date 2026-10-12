/**
 * Piggyback sync on normal CLI commands (T13553): a command in a linked
 * project starts a detached `autoCloudSync(projectRoot, 'command')` child at
 * most once per {@link autoSyncIntervalMs}, the way the presence refresh
 * piggybacks (T13289). No daemon, timer or server; the foreground command
 * never waits for the child.
 *
 * The check on the command's path is one `stat` of a per-project stamp under
 * the CLEO home, so one busy project cannot starve another's sync (T13556).
 * The stamp is written before the spawn, so a failing child is retried a
 * window later, not on every command. Everything else (the config opt-out
 * `cloud.autoSync`, flags, login, the network) runs in the child, where
 * `autoCloudSync` adds its own throttle and the cross-process lock that keeps
 * this, session end and the sentient tick from syncing twice.
 *
 * Never spawned for heavy or evidence runs (`CLEO_RUN_CLASS` is set in every
 * governed child), for `cleo run` / `cleo verify` / `cleo cloud`, or when
 * `CLEO_DISABLE_AUTO_SYNC=1` or `CLEO_AUTO_SYNC_INTERVAL_MIN=0`.
 *
 * @task T13553
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getCleoHome } from '../paths.js';
import {
  type AutoSyncOutcome,
  autoCloudSync,
  autoSyncIntervalMs,
  autoSyncReleased,
} from './auto-sync.js';

/** Environment switch that turns the command piggyback off (`1`). */
export const AUTO_SYNC_DISABLE_ENV = 'CLEO_DISABLE_AUTO_SYNC';

/** Root verbs that never piggyback: heavy/evidence runs and explicit cloud commands. */
const SKIP_VERBS: ReadonlySet<string> = new Set(['run', 'verify', 'cloud']);

const WORKER_SPECIFIER = '@cleocode/core/cloud/auto-sync-command-entry.js';

/** How {@link startCommandAutoSync} ended. */
export type CommandAutoSyncOutcome = 'disabled' | 'skipped' | 'throttled' | 'spawned' | 'failed';

/** Options for {@link startCommandAutoSync}. */
export interface CommandAutoSyncOptions {
  /** The linked project root. */
  projectRoot: string;
  /** The command's root verb (`show`, `add`, …), if any. */
  verb?: string;
  /** Environment. @defaultValue process.env */
  env?: NodeJS.ProcessEnv;
  /** CLEO home holding the stamp. @defaultValue getCleoHome() */
  cleoHome?: string;
  /** Clock. */
  now?: () => Date;
  /** Starts the detached child; defaults to spawning the worker entry. */
  spawnWorker?: (projectRoot: string) => void;
  /** The unreleased flags; test seam. @defaultValue UNRELEASED_FLAGS */
  unreleasedFlags?: ReadonlySet<string>;
}

/** The throttle stamp of a project root under the CLEO home (T13556). */
function stampPath(cleoHome: string, projectRoot: string): string {
  const key = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(cleoHome, 'auto-sync-command', `${key}.stamp`);
}

/** One `CLEO_DEBUG` line for a failure that would otherwise be silent (T13556). */
function debugFailure(env: NodeJS.ProcessEnv, error: unknown): void {
  if (env['CLEO_DEBUG'])
    process.stderr.write(
      `[cleo][debug] Piggyback sync not started: ${error instanceof Error ? error.message : String(error)}\n`,
    );
}

/**
 * The command's root verb: the first argv token naming a root command, so the
 * value of a leading global option (`cleo --cwd x run`) is never taken for it.
 *
 * @param argv - The command's argv after the executable and script.
 * @param commands - The root commands, keyed by name and alias.
 * @returns The root verb, or `undefined` when no token names a root command.
 */
export function commandRootVerb(
  argv: readonly string[],
  commands: Readonly<Record<string, unknown>>,
): string | undefined {
  return argv.find((token) => !token.startsWith('-') && Object.hasOwn(commands, token));
}

function spawnDetachedWorker(projectRoot: string): void {
  const entry = createRequire(import.meta.url).resolve(WORKER_SPECIFIER);
  const child = spawn(process.execPath, [entry, projectRoot], {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
    env: process.env,
  });
  // A spawn failure is emitted asynchronously; never let it escape the command.
  child.on('error', (error) => debugFailure(process.env, error));
  child.unref();
}

/**
 * Start a background sync for this linked project if the window has elapsed.
 * Never throws and never waits for the sync.
 *
 * @param opts - Project root, verb and test seams.
 * @returns What happened on the command's path.
 */
export function startCommandAutoSync(opts: CommandAutoSyncOptions): CommandAutoSyncOutcome {
  const env = opts.env ?? process.env;
  try {
    if (env[AUTO_SYNC_DISABLE_ENV] === '1') return 'disabled';
    // Inert until T13549 releases sync.push/sync.pull: no stamp, no spawn.
    if (!autoSyncReleased(opts.unreleasedFlags)) return 'disabled';
    if (env['CLEO_RUN_CLASS'] !== undefined) return 'skipped';
    if (opts.verb !== undefined && SKIP_VERBS.has(opts.verb)) return 'skipped';
    const gap = autoSyncIntervalMs();
    if (gap === null) return 'disabled';
    const now = (opts.now ?? (() => new Date()))();
    const stamp = stampPath(opts.cleoHome ?? getCleoHome(), opts.projectRoot);
    try {
      if (now.getTime() - statSync(stamp).mtimeMs < gap) return 'throttled';
    } catch {
      // No stamp yet: due.
    }
    mkdirSync(join(stamp, '..'), { recursive: true });
    writeFileSync(stamp, now.toISOString());
    utimesSync(stamp, now, now);
    (opts.spawnWorker ?? spawnDetachedWorker)(opts.projectRoot);
    return 'spawned';
  } catch (error) {
    debugFailure(env, error);
    return 'failed';
  }
}

/**
 * The detached child's body: honour the config opt-out `cloud.autoSync:
 * false` (project, then global), then {@link autoCloudSync} with reason
 * `command`. Never throws.
 *
 * @param projectRoot - The linked project root.
 * @param seams - Test seams.
 * @returns The sync outcome, or `disabled` when the config turns it off.
 */
export async function runCommandAutoSync(
  projectRoot: string,
  seams: {
    readConfig?: (projectRoot: string) => Promise<boolean | undefined>;
    sync?: (projectRoot: string) => Promise<AutoSyncOutcome>;
  } = {},
): Promise<AutoSyncOutcome> {
  try {
    const readConfig =
      seams.readConfig ??
      (async (root: string) => {
        const { getConfigValue } = await import('../config/registry.js');
        return getConfigValue<boolean>('cloud.autoSync', { projectRoot: root });
      });
    if ((await readConfig(projectRoot)) === false) return 'disabled';
    return await (seams.sync ?? ((root: string) => autoCloudSync(root, 'command')))(projectRoot);
  } catch {
    return 'failed';
  }
}
