/**
 * Daemon subsystem log-routing primitive.
 *
 * `createSubsystemLogger(name)` is the **single** logging surface the
 * `@cleocode/runtime/daemon` submodule exposes. It routes through the canonical
 * pino factory `getLogger` (`packages/core/src/logger.ts`) — NOT raw
 * `createWriteStream` and NOT `console.*` — so every daemon log line lands in
 * the rotating, retention-managed CLEO log files with a consistent structured
 * shape and a per-subsystem `subsystem` field.
 *
 * It supersedes the **5 ad-hoc logging conventions** the legacy daemons grew,
 * which R4-R7 will migrate onto this primitive:
 *
 * 1. `sentient/daemon.ts` — `createWriteStream(sentient.log)` /
 *    `createWriteStream(sentient.err)` + `process.stderr.write` lines.
 * 2. `gc/daemon.ts` — `createWriteStream(gc.log)` / `createWriteStream(gc.err)`.
 * 3. `web.ts` — `console.*`.
 * 4. `docs-viewer.ts` — ad-hoc stdout/stderr writes.
 * 5. the `runtime` services — bespoke per-service logging.
 *
 * ## Migration guidance for R4-R7 adapters
 *
 * Each adapter (Studio, GC, web, docs-viewer) replaces its bespoke sink with:
 *
 * ```ts
 * import { createSubsystemLogger } from '@cleocode/runtime/daemon';
 * const log = createSubsystemLogger('studio');
 * log.info({ pid }, 'Studio started');   // not process.stderr.write(...)
 * log.error({ err }, 'Studio crashed');  // not createWriteStream('sentient.err')
 * ```
 *
 * Do not import pino directly and do not open file streams — the canonical
 * factory owns rotation, retention, level, and the `projectHash` correlation
 * field. Routing through it is what makes the daemon's logs observable via the
 * same `cleo` log surface as the rest of the system.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11368 — log routing primitive (pino getLogger canonical sink)
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { getLogger } from '@cleocode/core';

/**
 * A structured log payload — a plain object of serializable fields merged into
 * the emitted log record (e.g. `{ pid, err }`).
 */
export type SubsystemLogFields = Record<string, unknown>;

/**
 * The narrow logging surface a daemon subsystem uses.
 *
 * Each method accepts an optional structured `fields` object followed by the
 * message, mirroring pino's `(obj, msg)` call shape. This is intentionally
 * smaller than the full pino `Logger` so the daemon submodule does not leak the
 * pino type across its public boundary while still routing through the
 * canonical pino sink.
 */
export interface SubsystemLogger {
  /** Log at `debug` level. */
  debug: (fields: SubsystemLogFields, msg: string) => void;
  /** Log at `info` level. */
  info: (fields: SubsystemLogFields, msg: string) => void;
  /** Log at `warn` level. */
  warn: (fields: SubsystemLogFields, msg: string) => void;
  /** Log at `error` level. */
  error: (fields: SubsystemLogFields, msg: string) => void;
}

/**
 * Create the single per-subsystem logger for the daemon submodule.
 *
 * Routes through the canonical pino factory `getLogger('daemon')` and namespaces
 * the result with a per-subsystem child binding (`{ subsystem: name }`), so all
 * daemon log lines share the `daemon` subsystem root while remaining
 * individually attributable. Never opens a file stream and never writes to
 * `console`.
 *
 * @param name - The logical subsystem name (e.g. `'studio'`, `'gc'`, `'web'`).
 * @returns A {@link SubsystemLogger} bound to `name`.
 *
 * @example
 * ```ts
 * const log = createSubsystemLogger('studio');
 * log.info({ pid: 4242, port: 3456 }, 'Studio started');
 * ```
 */
export function createSubsystemLogger(name: string): SubsystemLogger {
  // Bind under the canonical 'daemon' root, then a per-subsystem child so each
  // subsystem's lines carry `{ subsystem: 'daemon', daemonSubsystem: name }`.
  const log = getLogger('daemon').child({ daemonSubsystem: name });
  return {
    debug: (fields, msg) => log.debug(fields, msg),
    info: (fields, msg) => log.info(fields, msg),
    warn: (fields, msg) => log.warn(fields, msg),
    error: (fields, msg) => log.error(fields, msg),
  };
}
