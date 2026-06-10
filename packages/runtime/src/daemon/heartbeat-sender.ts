/**
 * Worker-side heartbeat sender for the watchdog (T11628).
 *
 * A thin wrapper over {@link createLeaseIpcClient} that encodes a
 * `worker_heartbeat` frame and writes it to the supervisor over whatever
 * transport the caller owns. It is **degrade-by-default**: when no transport is
 * wired (no supervisor up / the daemon-off posture) {@link sendHeartbeat} is a
 * no-op, exactly mirroring how the LLM-queue admit path degrades when the
 * supervisor arbiter is absent. A managed worker calls {@link sendHeartbeat}
 * periodically (well inside the watchdog's NORMAL deadline) so the supervisor
 * knows it is alive; on a miss the watchdog SIGTERM→SIGKILLs it.
 *
 * The sender owns no socket: the caller supplies a `writeLine` sink (the
 * connected Unix-socket write half, a test double, …) — keeping this module free
 * of platform IO and trivially testable, consistent with the v1.0/v1.1 codecs.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11625
 * @task T11628 — supervisor watchdog: worker heartbeat sender
 * @saga T11243 SG-RUNTIME-UNIFICATION
 * @see ./lease-ipc-client.ts — the codec this wraps
 */

import { createLeaseIpcClient, type LeaseIpcClient } from './lease-ipc-client.js';

/**
 * A transport sink that writes one already-framed NDJSON line (including the
 * trailing `\n`) to the supervisor. Returning a promise lets the caller await a
 * flush; the sender does not require it.
 */
export type WriteLine = (line: string) => void | Promise<void>;

/**
 * A degrade-by-default worker heartbeat sender.
 *
 * Construct via {@link createHeartbeatSender}. When no transport is wired,
 * {@link HeartbeatSender.sendHeartbeat} is a no-op and {@link HeartbeatSender.isActive}
 * is `false`.
 */
export interface HeartbeatSender {
  /**
   * Send one `worker_heartbeat` for `childId`. A no-op (resolves immediately)
   * when no transport is wired — the worker degrades gracefully when no
   * supervisor is up.
   *
   * @param childId      - The heartbeating child's logical id (registry key).
   * @param inFlightLlm  - The worker's own view of whether it is currently
   *                       inside an LLM call. `true` lets the watchdog grant the
   *                       EXTENDED deadline so a slow-but-healthy long call is
   *                       never false-killed (AC2 · RISK-7).
   * @returns The correlation `id` of the sent frame, or `null` when no transport
   *          is wired (the no-op path).
   */
  sendHeartbeat: (childId: string, inFlightLlm: boolean) => Promise<string | null>;

  /**
   * Whether a transport is wired. `false` means {@link sendHeartbeat} is a
   * no-op (no supervisor up).
   */
  isActive: () => boolean;
}

/**
 * Create a worker heartbeat sender.
 *
 * @param writeLine - The transport sink that writes one NDJSON line to the
 *                    supervisor, or `undefined`/`null` when no supervisor is up
 *                    (the no-op / degrade path).
 * @param client    - An optional pre-built {@link LeaseIpcClient} codec (defaults
 *                    to a fresh one); injectable for tests.
 * @returns A {@link HeartbeatSender}.
 *
 * @example
 * ```ts
 * // With a connected supervisor socket:
 * const sender = createHeartbeatSender((line) => socket.write(line));
 * setInterval(() => sender.sendHeartbeat('worker-7', isInLlmCall()), 10_000);
 *
 * // No supervisor up — every sendHeartbeat is a silent no-op:
 * const offline = createHeartbeatSender(undefined);
 * await offline.sendHeartbeat('worker-7', false); // resolves to null
 * ```
 */
export function createHeartbeatSender(
  writeLine: WriteLine | undefined | null,
  client: LeaseIpcClient = createLeaseIpcClient(),
): HeartbeatSender {
  const active = typeof writeLine === 'function';

  return {
    isActive(): boolean {
      return active;
    },

    async sendHeartbeat(childId: string, inFlightLlm: boolean): Promise<string | null> {
      // Degrade: no transport wired → no-op (mirrors the queue's degrade).
      if (!active || writeLine == null) {
        return null;
      }
      const { id, line } = client.encodeRequest({
        kind: 'worker_heartbeat',
        child_id: childId,
        in_flight_llm: inFlightLlm,
      });
      await writeLine(line);
      return id;
    },
  };
}
