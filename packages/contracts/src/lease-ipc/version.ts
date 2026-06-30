/**
 * PARALLEL protocol version for the `lease-ipc` v1.1 contract (T11627 ST-1).
 *
 * The Rust arbiter (`crates/cleo-supervisor/src/lease_ipc.rs`) and this
 * TypeScript contract MUST agree on this value. It runs **in parallel** to the
 * byte-frozen `supervisor-ipc` v1.0 contract: the two are distinguished on the
 * wire purely by this version string, so a single accept loop can route
 * `'1.0.0'` → the v1.0 union and `'1.2.0'` → the lease union. Bump only via a
 * coordinated dual (Rust + TS) edit, never edit this value in place.
 *
 * @see {@link LEASE_IPC_MESSAGE_KINDS} for the v1.1 message set.
 * @task T11627
 * @packageDocumentation
 */

/**
 * The `lease-ipc` v1.2 protocol version string.
 *
 * Mirrors `cleo_supervisor::lease_ipc::LEASE_IPC_PROTOCOL_VERSION` on the Rust
 * side. Both the Rust schema-drift guard (`lease_ipc::tests`) and the TS drift
 * test (`__tests__/freeze.test.ts`) pin this exact value.
 *
 * v1.2 (T12001 · Epic T11992) added the `resource_admit` / `resource_release`
 * heavy-op admission verbs; v1.1 added `queue_admit` / `worker_heartbeat`.
 */
export const LEASE_IPC_PROTOCOL_VERSION = '1.2.0' as const;

/**
 * Whether the given version string is the frozen `lease-ipc` v1.1 wire version.
 *
 * Used by an accept-loop version router to confirm a frame is a lease-protocol
 * frame before dispatching it through the {@link LEASE_IPC_PROTOCOL_VERSION}
 * union (rather than the v1.0 supervisor-ipc union).
 *
 * @param version - The `protocol_version` field read off an inbound envelope.
 * @returns `true` iff `version` equals {@link LEASE_IPC_PROTOCOL_VERSION}.
 *
 * @example
 * ```ts
 * if (isFrozenLeaseIpcVersion(env.protocol_version)) {
 *   // dispatch through LeaseIpcEnvelopeSchema
 * }
 * ```
 */
export function isFrozenLeaseIpcVersion(
  version: string,
): version is typeof LEASE_IPC_PROTOCOL_VERSION {
  return version === LEASE_IPC_PROTOCOL_VERSION;
}
