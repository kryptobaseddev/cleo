/**
 * `lease-ipc` v1.1 — PARALLEL DbWriterLease IPC contract barrel (T11627 ST-1).
 *
 * Re-exports the version constants and Zod message schemas + inferred types for
 * the CLEO DbWriterLease arbitration surface. Runs **in parallel** to the
 * byte-frozen `supervisor-ipc` v1.0 contract — see
 * {@link LEASE_IPC_PROTOCOL_VERSION}. ST-1 ships the protocol surface with no
 * consumer (zero behavior change); the local-mode arbiter (ST-2+) and the
 * supervisor fast path (ST-5) consume it later.
 *
 * @task T11627
 * @packageDocumentation
 */

export type {
  ChildKilledUnresponsiveResponse,
  LeaseAcquireRequest,
  LeaseDeniedResponse,
  LeaseErrorResponse,
  LeaseGrantedResponse,
  LeaseIpcEnvelope,
  LeaseIpcRequest,
  LeaseIpcRequestEnvelope,
  LeaseIpcResponse,
  LeaseIpcResponseEnvelope,
  LeaseLane,
  LeaseQueuedResponse,
  LeaseReleaseRequest,
  LeaseRenewRequest,
  LeaseRevokedResponse,
  LeaseScope,
  RateCheckRequest,
  RateResultResponse,
  ToolGrantedResponse,
  ToolGrantRequest,
} from './messages.js';

export {
  ChildKilledUnresponsiveResponseSchema,
  LEASE_IPC_MESSAGE_KINDS,
  LEASE_IPC_REQUEST_KINDS,
  LEASE_IPC_RESPONSE_KINDS,
  LeaseAcquireRequestSchema,
  LeaseDeniedResponseSchema,
  LeaseErrorResponseSchema,
  LeaseGrantedResponseSchema,
  LeaseIpcEnvelopeSchema,
  LeaseIpcRequestEnvelopeSchema,
  LeaseIpcRequestSchema,
  LeaseIpcResponseEnvelopeSchema,
  LeaseIpcResponseSchema,
  LeaseLaneSchema,
  LeaseQueuedResponseSchema,
  LeaseReleaseRequestSchema,
  LeaseRenewRequestSchema,
  LeaseRevokedResponseSchema,
  LeaseScopeSchema,
  RateCheckRequestSchema,
  RateResultResponseSchema,
  ToolGrantedResponseSchema,
  ToolGrantRequestSchema,
} from './messages.js';
export { isFrozenLeaseIpcVersion, LEASE_IPC_PROTOCOL_VERSION } from './version.js';
