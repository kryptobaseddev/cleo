/**
 * Wire + lifecycle types for the `@cleocode/runtime/gateway/rpc` adapter.
 *
 * The RPC wire frames themselves are defined (zod) in
 * `@cleocode/contracts/gateway/rpc`; this module holds only the
 * runtime-adapter-local option/handle shapes (no external dependency, mirroring
 * the MCP adapter's `types.ts`).
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 */

import type { Server } from 'node:net';

/**
 * Options for {@link startRpcServer}.
 *
 * Mirrors the MCP adapter's `McpServerOptions` shape (a transport-local options
 * bag), adapted for a connection-oriented unix-socket server rather than a
 * single stdio stream.
 */
export interface RpcServerOptions {
  /**
   * Absolute path to the unix-domain socket to bind. The caller resolves this
   * (e.g. under the CLEO home using
   * {@link GATEWAY_RPC_CHANNEL_BASENAME}) so the runtime stays free of any
   * `@cleocode/paths` dependency.
   */
  socketPath: string;
  /**
   * Whether to `unlink` a stale socket file at {@link socketPath} before
   * binding. Defaults to `true` (a crashed prior server leaves a stale node).
   */
  removeStaleSocket?: boolean;
}

/**
 * A live RPC server handle returned by {@link startRpcServer}.
 *
 * Exposes the bound {@link Server} and an idempotent {@link close} so callers
 * (daemon, tests) can tear down deterministically. The adapter never calls
 * `process.exit` — lifecycle stays with the caller (R3 contract).
 */
export interface RpcServerHandle {
  /** The bound `node:net` server. */
  server: Server;
  /** Absolute path of the bound unix socket. */
  socketPath: string;
  /** Close the server + all live connections; resolves once fully closed. */
  close(): Promise<void>;
}
