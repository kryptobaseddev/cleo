/**
 * Commands that read this machine's sync state against the cloud (T13852).
 *
 * `startCli()` normally records the project encounter (`nexus_project_locations`
 * `last_seen`, `last_opened_at`) and the device heartbeat (`nexus_devices`
 * `last_heartbeat_at`) before the command runs. Both are synced rows, so a
 * `cleo cloud verify` more than a minute after a push changed the store it was
 * about to compare and reported this device "ahead" of its own push. These
 * commands therefore skip that bookkeeping: they observe the store, they are not
 * use of it.
 *
 * @task T13852
 */

/** Command paths (leading positional tokens) that only compare the store with the cloud. */
export const SYNC_PROBE_COMMAND_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['cloud', 'verify'],
  ['cloud', 'status'],
];

/**
 * Returns `true` when the invocation is a sync-state probe, which must not write
 * the startup encounter or heartbeat rows. Flag/value interleavings that hide the
 * path degrade to `false`: the bookkeeping runs, as it always did.
 *
 * @param argv - argv with the `cleo` binary already stripped (e.g. `process.argv.slice(2)`)
 * @returns Whether startup bookkeeping is skipped.
 * @example
 * ```ts
 * isSyncProbeInvocation(['cloud', 'verify', '--deep']); // true
 * ```
 */
export function isSyncProbeInvocation(argv: readonly string[]): boolean {
  const positionals = argv.filter((token) => !token.startsWith('-'));
  return SYNC_PROBE_COMMAND_PATHS.some(
    (path) => path.length <= positionals.length && path.every((seg, i) => seg === positionals[i]),
  );
}
