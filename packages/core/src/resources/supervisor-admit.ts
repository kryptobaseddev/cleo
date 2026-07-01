/**
 * Supervisor-mode resource admission client (T12001 · Epic T11992).
 *
 * The `supervisor`-mode counterpart of the {@link ResourceGovernor}'s local slot
 * engine. Where local mode arbitrates heavy-op concurrency through cross-process
 * lockfiles, supervisor mode routes the `resource_admit` / `resource_release`
 * lease-ipc verbs to the Rust `cleo-supervisor` so a single in-memory counter is
 * the machine-wide source of truth.
 *
 * A dead/absent supervisor must NEVER deadlock work: every send degrades to
 * `{ unavailable }` on any transport error, and the governor falls back to the
 * local slot engine. Mirrors the `llm-queue-admit.ts` transport (core cannot
 * import `@cleocode/runtime` — a cycle — so it speaks the NDJSON codec directly
 * through the shared `@cleocode/contracts` lease-ipc Zod schemas).
 *
 * @task T12001
 * @epic T11992
 */

import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  LEASE_IPC_PROTOCOL_VERSION,
  type LeaseIpcRequest,
  LeaseIpcRequestEnvelopeSchema,
  LeaseIpcResponseEnvelopeSchema,
  type ResourceAdmitResultResponse,
  type ResourceReleaseResultResponse,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';

/** The supervisor IPC socket filename — MUST equal `SOCKET_NAME` in `crates/cleo-supervisor/src/paths.rs`. */
const SUPERVISOR_SOCKET_NAME = 'cleo-supervisor.sock';

/** Connect timeout (ms). A slow/absent socket degrades fast — never a deadlock. */
const CONNECT_TIMEOUT_MS = 250;

/** Per-request read timeout for a result frame (ms). */
const REQUEST_TIMEOUT_MS = 2_000;

/** A transport-unavailable sentinel — the caller degrades to the local engine. */
export interface SupervisorUnavailable {
  readonly unavailable: true;
  readonly reason: string;
}

/**
 * Resolve the supervisor socket path: `$CLEO_SUPERVISOR_SOCKET` overrides,
 * otherwise `<cleoHome>/cleo-supervisor.sock`.
 */
export function resolveSupervisorSocketPath(): string {
  return process.env.CLEO_SUPERVISOR_SOCKET ?? join(getCleoHome(), SUPERVISOR_SOCKET_NAME);
}

/**
 * Admit (or defer) a heavy op of `cls` for `holderId` against `budget` through
 * the supervisor's central arbiter. Resolves the `resource_admit_result` reply,
 * or `{ unavailable }` when the supervisor cannot arbitrate (degrade to local).
 */
export async function sendResourceAdmit(
  socketPath: string,
  cls: string,
  holderId: string,
  budget: number,
): Promise<ResourceAdmitResultResponse | SupervisorUnavailable> {
  const result = await sendLeaseRequest(
    socketPath,
    { kind: 'resource_admit', class: cls, holder_id: holderId, budget },
    'resource_admit_result',
  );
  if ('unavailable' in result) return result;
  if (result.kind === 'resource_admit_result') return result;
  return { unavailable: true, reason: `unexpected response kind: ${result.kind}` };
}

/**
 * Release a previously-admitted slot of `cls` for `holderId`. Resolves the
 * `resource_release_result` reply, or `{ unavailable }` on transport failure
 * (the slot self-heals via the arbiter's process-death reclaim / stale recovery).
 */
export async function sendResourceRelease(
  socketPath: string,
  cls: string,
  holderId: string,
): Promise<ResourceReleaseResultResponse | SupervisorUnavailable> {
  const result = await sendLeaseRequest(
    socketPath,
    { kind: 'resource_release', class: cls, holder_id: holderId },
    'resource_release_result',
  );
  if ('unavailable' in result) return result;
  if (result.kind === 'resource_release_result') return result;
  return { unavailable: true, reason: `unexpected response kind: ${result.kind}` };
}

/**
 * One-shot NDJSON lease-ipc round-trip over a fresh Unix socket. Connection per
 * request (the verbs are stateless); the socket is closed before resolution.
 * Any transport error resolves to `{ unavailable }` — never throws, never
 * deadlocks. `expectedKind` is the result `kind` the caller correlates.
 */
function sendLeaseRequest(
  socketPath: string,
  request: LeaseIpcRequest,
  expectedKind: 'resource_admit_result' | 'resource_release_result',
): Promise<ResourceAdmitResultResponse | ResourceReleaseResultResponse | SupervisorUnavailable> {
  return new Promise((resolve) => {
    const id = `ra-${process.pid}-${request.kind}`;
    const envelope = LeaseIpcRequestEnvelopeSchema.parse({
      protocol_version: LEASE_IPC_PROTOCOL_VERSION,
      id,
      direction: 'request' as const,
      request,
    });
    const line = `${JSON.stringify(envelope)}\n`;

    let settled = false;
    let buffer = '';
    const socket: Socket = connect(socketPath);

    const done = (
      value: ResourceAdmitResultResponse | ResourceReleaseResultResponse | SupervisorUnavailable,
    ): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const degrade = (reason: string): void => done({ unavailable: true, reason });

    socket.setTimeout(REQUEST_TIMEOUT_MS);
    const connectTimer = setTimeout(
      () => degrade('supervisor connect timeout'),
      CONNECT_TIMEOUT_MS,
    );

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.write(line);
    });
    socket.on('timeout', () => degrade('supervisor request timeout'));
    socket.on('error', (err) => {
      clearTimeout(connectTimer);
      degrade(err.message);
    });
    socket.on('close', () => {
      if (!settled) degrade('supervisor closed the connection before responding');
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return; // wait for a full NDJSON line
      let json: unknown;
      try {
        json = JSON.parse(buffer.slice(0, nl));
      } catch (cause) {
        degrade(`malformed lease-ipc frame: ${cause instanceof Error ? cause.message : cause}`);
        return;
      }
      const parsed = LeaseIpcResponseEnvelopeSchema.safeParse(json);
      if (!parsed.success) {
        degrade(`off-contract lease-ipc response: ${parsed.error.message}`);
        return;
      }
      const { response } = parsed.data;
      if (response.kind === expectedKind) {
        done(response as ResourceAdmitResultResponse | ResourceReleaseResultResponse);
        return;
      }
      if (response.kind === 'error') {
        degrade(`${response.code}: ${response.message}`);
        return;
      }
      degrade(`unexpected lease-ipc response kind for ${request.kind}: ${response.kind}`);
    });
  });
}
