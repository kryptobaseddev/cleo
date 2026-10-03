/**
 * Keep the CLI's own libuv thread-pool size out of every process it spawns
 * (T13122).
 *
 * `bin/cleo.js` sets `UV_THREADPOOL_SIZE=64` for the CLI unless the operator set
 * one (T12348: `cleo nexus status` stats every indexed file, and on a FUSE
 * mount 64 threads read the tree 6x faster than Node's default 4). It sets it in
 * the environment because libuv reads it from there — so every child inherited
 * it: the evidence test runner, each of its workers, every `cleo run` command.
 * The live `cleo verify` test child on 2026-10-03 carried it, so each Node
 * process in that tree would start 64 pool threads, not 4, on its first
 * filesystem or crypto call.
 *
 * libuv reads the variable once, when the first piece of work is queued, and
 * never resizes the pool. So once the CLI's pool exists the variable has done
 * its job here and can leave the environment: the CLI keeps its 64 threads, its
 * children get Node's default. Measured on Node 24.21 (macOS): a process with
 * the variable set went from 7 to 71 threads on its first `randomFill`; its
 * child, spawned after the variable was removed, had 11 (4 pool threads).
 *
 * Only CLEO's own default is removed. The shim names the value it set in
 * {@link CLI_THREADPOOL_MARKER}; a value the operator exported carries no
 * marker and is inherited as before.
 *
 * @module
 * @task T13122
 */

import { randomFill } from 'node:crypto';

/**
 * Set by `bin/cleo.js` to the `UV_THREADPOOL_SIZE` it supplied itself, so the
 * CLI can tell its own default from an operator's value.
 */
export const CLI_THREADPOOL_MARKER = 'CLEO_CLI_UV_THREADPOOL_SIZE';

/**
 * Queue one piece of thread-pool work, which makes libuv create the pool — and
 * read `UV_THREADPOOL_SIZE` — synchronously, before returning. `randomFill`
 * always runs on the pool (unlike `fs`, which io_uring can serve on Linux).
 */
function startThreadPool(): void {
  randomFill(new Uint8Array(1), () => {});
}

/**
 * Remove CLEO's own `UV_THREADPOOL_SIZE` default from the environment once this
 * process's thread pool exists, so no child inherits it.
 *
 * Does nothing unless the shim's marker is present and still matches the value
 * (anything else is the operator's choice). The marker itself is always removed.
 *
 * @param env - the environment to edit; the live `process.env` by default.
 * @param startPool - creates this process's thread pool; injectable for tests.
 * @returns `true` when the default was removed.
 *
 * @example
 * ```ts
 * // bin/cleo.js set UV_THREADPOOL_SIZE=64 and CLEO_CLI_UV_THREADPOOL_SIZE=64:
 * releaseCliThreadpoolEnv(); // → true; children now inherit neither
 * ```
 */
export function releaseCliThreadpoolEnv(
  env: NodeJS.ProcessEnv = process.env,
  startPool: () => void = startThreadPool,
): boolean {
  const supplied = env[CLI_THREADPOOL_MARKER];
  if (supplied === undefined) return false;
  delete env[CLI_THREADPOOL_MARKER];
  if (env.UV_THREADPOOL_SIZE !== supplied) return false;
  // The pool must exist BEFORE the variable goes, or this process would read
  // nothing and fall back to 4 threads.
  startPool();
  delete env.UV_THREADPOOL_SIZE;
  return true;
}
