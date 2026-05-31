/**
 * FROZEN protocol version for the `gateway/rpc` v1.0 wire contract.
 *
 * The CLI-RPC transport adapter (`@cleocode/runtime/gateway/rpc`) and any RPC
 * client MUST agree on this value. The wire format is newline-delimited JSON
 * (NDJSON): one {@link GatewayRpcFrame} per line over a unix-domain socket —
 * the same framing discipline as the FROZEN `supervisor-ipc` v1.0 contract
 * (`packages/contracts/src/supervisor-ipc/`), but a SEPARATE message set: this
 * carries `DispatchRequest`/`DispatchResponse` over the gateway, not supervisor
 * process-control messages.
 *
 * Bump only via a new major contract revision in a new directory, never edit
 * this value in place — see {@link GATEWAY_RPC_MESSAGE_KINDS} for the frozen
 * v1.0 message set.
 *
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7464 | NDJSON framing}
 * @task T11449
 * @epic T11254
 * @saga T11243
 * @packageDocumentation
 */

/**
 * The frozen `gateway/rpc` protocol version string.
 *
 * Both the TS drift test (`__tests__/freeze.test.ts`) and the adapter's
 * version-negotiation handshake pin this exact value. A frame whose
 * `protocol_version` differs from this is rejected with an `error` frame.
 */
export const GATEWAY_RPC_PROTOCOL_VERSION = '1.0.0' as const;

/**
 * Default base name for the RPC unix-socket channel.
 *
 * Callers resolve the concrete socket path under the CLEO home (e.g.
 * `<cleoHome>/<basename>.sock`); the adapter itself takes the resolved path so
 * the runtime stays free of any `@cleocode/paths` dependency. Mirrors
 * {@link SUPERVISOR_IPC_CHANNEL_BASENAME} from the supervisor-ipc contract.
 */
export const GATEWAY_RPC_CHANNEL_BASENAME = 'cleo-gateway-rpc' as const;
