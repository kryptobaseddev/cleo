/**
 * FROZEN protocol version for the `supervisor-ipc` v1.0 contract.
 *
 * The Rust supervisor (`crates/cleo-supervisor/src/ipc.rs`) and this TypeScript
 * contract MUST agree on this value. R2 (T11253) consumes the v1.0 message set
 * without churn, so the version is **frozen**: bump only via a new major
 * contract revision in a new directory, never edit this value in place.
 *
 * @see {@link SUPERVISOR_IPC_MESSAGE_KINDS} for the frozen v1.0 message set.
 * @task T11339
 * @packageDocumentation
 */

/**
 * The frozen `supervisor-ipc` protocol version string.
 *
 * Mirrors `cleo_supervisor::ipc::IPC_PROTOCOL_VERSION` on the Rust side. Both a
 * Rust schema-drift guard (`crates/cleo-supervisor` `ipc::tests`) and the TS
 * drift test (`__tests__/freeze.test.ts`) pin this exact value.
 */
export const SUPERVISOR_IPC_PROTOCOL_VERSION = '1.0.0' as const;

/**
 * Default base name for the IPC channel.
 *
 * Unix sockets are created under the CLEO home as `<basename>.sock`; Windows
 * named pipes use `\\.\pipe\<basename>.<pid>`. Mirrors
 * `cleo_supervisor::ipc::IPC_CHANNEL_BASENAME`.
 */
export const SUPERVISOR_IPC_CHANNEL_BASENAME = 'cleo-supervisor' as const;
