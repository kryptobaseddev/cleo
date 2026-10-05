/**
 * Long-lived brain host flag (T13126).
 *
 * A one-shot CLI command writes one observation and exits, so the per-process
 * costs of the brain write path are paid once per command. A second
 * `worker_threads` isolate and a second store open cost ~120 MB. Loading the
 * local embedding model costs ~280 MB. A long-lived host (daemon, gateway
 * server, Studio) amortises both across many writes. A host declares itself
 * once at startup:
 *
 * - its brain writes run on the single-writer worker thread
 *   (`brain-writer-thread.ts`), and
 * - `observeBrain` embeds each new observation as it is stored.
 *
 * Every other process writes inline under the brain writer lease and mutex,
 * and leaves new observations unembedded. The embedding backfill fills them
 * later: an opted-in host's periodic tick, the `cleo session end` background
 * batch, or `cleo backfill`.
 *
 * The flag lives in its own leaf module so the worker isolate can set it
 * without loading the main-thread queue manager.
 *
 * @module
 * @task T13126
 */

/** Environment variable a host process can be launched with instead of calling {@link markLongLivedBrainHost}. */
export const BRAIN_HOST_FLAG = 'CLEO_BRAIN_WRITER_THREAD';

let _longLivedHost = false;

/**
 * Declare this process (or worker isolate) a long-lived brain host.
 *
 * @example
 * ```ts
 * markLongLivedBrainHost();
 * isLongLivedBrainHost(); // true
 * ```
 */
export function markLongLivedBrainHost(): void {
  _longLivedHost = true;
}

/**
 * Whether this process is a long-lived brain host.
 *
 * @returns `true` after {@link markLongLivedBrainHost} or with
 *   `CLEO_BRAIN_WRITER_THREAD=1`; `false` for a one-shot process.
 */
export function isLongLivedBrainHost(): boolean {
  return _longLivedHost || process.env[BRAIN_HOST_FLAG] === '1';
}

/**
 * Clear the flag (tests only).
 *
 * @internal
 */
export function _resetLongLivedBrainHostForTests(): void {
  _longLivedHost = false;
  _writerIsolate = false;
}

let _writerIsolate = false;

/**
 * Declare this isolate the brain writer worker (`brain-writer-worker.ts`
 * calls it once). Only there is the open store handle the chokepoint's own,
 * so only there may `observeBrain` write an embedding directly (T13246). Any
 * other worker thread, `CLEO_BRAIN_WRITER_THREAD=1` in its environment or
 * not, goes through `enqueueBrainWrite`.
 *
 * @example
 * ```ts
 * markBrainWriterIsolate();
 * isBrainWriterIsolate(); // true
 * ```
 */
export function markBrainWriterIsolate(): void {
  _writerIsolate = true;
}

/**
 * Whether this isolate is the brain writer worker.
 *
 * @returns `true` only after {@link markBrainWriterIsolate}; never from the environment.
 */
export function isBrainWriterIsolate(): boolean {
  return _writerIsolate;
}
