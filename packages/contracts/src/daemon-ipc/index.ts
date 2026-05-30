/**
 * `@cleocode/contracts/daemon-ipc` — the FROZEN v1.0 daemon-IPC surface
 * R4-R7 adapt against (T11253 AC8).
 *
 * ## AC8 reconciliation (T11369)
 *
 * Epic T11253 AC8 specifies the frozen surface is published under the name
 * `@cleocode/contracts/daemon-ipc/`. R1 (T11339) had already shipped the
 * byte-for-byte Rust mirror under `@cleocode/contracts/supervisor-ipc/`. Rather
 * than DUPLICATE the contract (which would create two drift surfaces), this
 * module is a **thin re-export barrel**: `supervisor-ipc` IS the frozen v1.0
 * contract, and `daemon-ipc` is the AC8-named alias the R2 epic promised.
 *
 * Both import sites resolve to the same FROZEN schemas + version constant:
 *
 * ```ts
 * import { SupervisorIpcEnvelopeSchema } from '@cleocode/contracts/daemon-ipc';
 * import { SupervisorIpcEnvelopeSchema } from '@cleocode/contracts/supervisor-ipc';
 * // identical binding — one frozen contract, two names.
 * ```
 *
 * R4-R7 are **pure adapters** against this frozen surface (see the
 * contract-evolution policy doc, slug `daemon-ipc-contract-evolution-policy`).
 * Breaking changes require a NEW versioned directory + a version-negotiation
 * shim + an R2 amendment task — never an in-place edit to the v1.0 schemas.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/daemon-ipc
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11369 — freeze + publish v1.0 daemon-IPC contract surface (AC8 + AC9)
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

export type {
  ChildState,
  ChildStatus,
  EnvPair,
  ErrorResponse,
  HealthRequest,
  HealthResponse,
  LifecycleEventKind,
  LifecycleEventResponse,
  MonitorRequest,
  MonitorResponse,
  RestartedResponse,
  RestartRequest,
  SpawnedResponse,
  SpawnRequest,
  SupervisorIpcEnvelope,
  SupervisorIpcRequest,
  SupervisorIpcRequestEnvelope,
  SupervisorIpcResponse,
  SupervisorIpcResponseEnvelope,
} from '../supervisor-ipc/index.js';
export {
  ChildStateSchema,
  ChildStatusSchema,
  EnvPairSchema,
  ErrorResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  LifecycleEventKindSchema,
  LifecycleEventResponseSchema,
  MonitorRequestSchema,
  MonitorResponseSchema,
  RestartedResponseSchema,
  RestartRequestSchema,
  SpawnedResponseSchema,
  SpawnRequestSchema,
  SUPERVISOR_IPC_CHANNEL_BASENAME,
  SUPERVISOR_IPC_MESSAGE_KINDS,
  SUPERVISOR_IPC_PROTOCOL_VERSION,
  SUPERVISOR_IPC_REQUEST_KINDS,
  SUPERVISOR_IPC_RESPONSE_KINDS,
  SupervisorIpcEnvelopeSchema,
  SupervisorIpcRequestEnvelopeSchema,
  SupervisorIpcRequestSchema,
  SupervisorIpcResponseEnvelopeSchema,
  SupervisorIpcResponseSchema,
} from '../supervisor-ipc/index.js';

/**
 * The AC8-canonical name for the frozen daemon-IPC protocol version.
 *
 * Alias of `SUPERVISOR_IPC_PROTOCOL_VERSION` — re-exported so the freeze/drift
 * test (T11369) can pin the value through the `daemon-ipc` surface name AC8
 * specifies. Both constants are the SAME frozen `'1.0.0'`.
 */
export { SUPERVISOR_IPC_PROTOCOL_VERSION as DAEMON_IPC_PROTOCOL_VERSION } from '../supervisor-ipc/version.js';
