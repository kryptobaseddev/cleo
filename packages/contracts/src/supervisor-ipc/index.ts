/**
 * `supervisor-ipc` v1.0 — FROZEN IPC contract barrel.
 *
 * Re-exports the version constants and Zod message schemas + inferred types for
 * the CLEO native process supervisor (`crates/cleo-supervisor`). R2 (T11253)
 * consumes this contract; it is frozen at v1.0 — see
 * {@link SUPERVISOR_IPC_PROTOCOL_VERSION}.
 *
 * @task T11339
 * @packageDocumentation
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
} from './messages.js';

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
  SUPERVISOR_IPC_MESSAGE_KINDS,
  SUPERVISOR_IPC_REQUEST_KINDS,
  SUPERVISOR_IPC_RESPONSE_KINDS,
  SupervisorIpcEnvelopeSchema,
  SupervisorIpcRequestEnvelopeSchema,
  SupervisorIpcRequestSchema,
  SupervisorIpcResponseEnvelopeSchema,
  SupervisorIpcResponseSchema,
} from './messages.js';
export {
  SUPERVISOR_IPC_CHANNEL_BASENAME,
  SUPERVISOR_IPC_PROTOCOL_VERSION,
} from './version.js';
