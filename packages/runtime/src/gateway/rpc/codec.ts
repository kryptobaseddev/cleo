/**
 * NDJSON codec for the CLI-RPC transport.
 *
 * Implements the SAME framing discipline as the FROZEN `supervisor-ipc` v1.0
 * contract — one zod-validated JSON envelope per newline-delimited line, with
 * an explicit `protocol_version` negotiation step — but for the gateway-RPC
 * frame set (`@cleocode/contracts/gateway/rpc`). The supervisor-ipc module is
 * frozen and is NOT edited; this codec re-applies its pattern.
 *
 * The codec is intentionally socket-agnostic: it owns line buffering, JSON
 * parse, zod decode, and version negotiation, returning typed results the
 * server maps onto `node:net` reads/writes. This keeps the parse/validate logic
 * unit-testable without binding a real socket.
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 */

import {
  GATEWAY_RPC_PROTOCOL_VERSION,
  type GatewayRpcErrorCode,
  type GatewayRpcErrorFrame,
  type GatewayRpcFrame,
  GatewayRpcFrameSchema,
  type GatewayRpcRequestFrame,
  type GatewayRpcResponseFrame,
  isFrozenGatewayRpcVersion,
} from '@cleocode/contracts/gateway/rpc';

/** Newline delimiter for the NDJSON wire (mirrors supervisor-ipc). */
const NEWLINE = '\n';

/**
 * Encode any RPC frame to a single NDJSON line (JSON + trailing `\n`).
 *
 * @param frame - The response or error frame to serialize.
 * @returns A newline-terminated JSON string ready to write to the socket.
 */
export function encodeFrame(frame: GatewayRpcResponseFrame | GatewayRpcErrorFrame): string {
  return `${JSON.stringify(frame)}${NEWLINE}`;
}

/**
 * Build a protocol-level error frame.
 *
 * @param id - Correlation id (`'0'` when the originating frame's id is unknown).
 * @param code - One of the frozen {@link GatewayRpcErrorCode} values.
 * @param message - Human-readable detail.
 * @returns A fully-formed {@link GatewayRpcErrorFrame}.
 */
export function buildErrorFrame(
  id: string,
  code: GatewayRpcErrorCode,
  message: string,
): GatewayRpcErrorFrame {
  return {
    protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
    id,
    direction: 'error',
    error: { code, message },
  };
}

/**
 * The discriminated outcome of decoding a single inbound NDJSON line.
 *
 * - `request` — a valid, version-matched request frame ready to route.
 * - `error`   — a protocol-level error frame the server should write straight
 *               back (parse failure, version mismatch, or malformed frame). The
 *               server never routes these to the gateway.
 */
export type DecodeResult =
  | { kind: 'request'; frame: GatewayRpcRequestFrame }
  | { kind: 'error'; frame: GatewayRpcErrorFrame };

/**
 * Decode + validate a single inbound NDJSON line into a routable request or a
 * protocol-level error frame.
 *
 * Steps (the supervisor-ipc pattern, applied to gateway frames):
 *  1. JSON parse — failure → `E_RPC_PARSE`.
 *  2. zod decode against {@link GatewayRpcFrameSchema} — failure → `E_RPC_BAD_FRAME`.
 *  3. version negotiation via {@link isFrozenGatewayRpcVersion} —
 *     mismatch → `E_RPC_BAD_VERSION`.
 *  4. direction must be `request` (a server never receives response/error
 *     frames) — otherwise → `E_RPC_BAD_FRAME`.
 *
 * The best-effort correlation `id` is recovered from the raw JSON when possible
 * so the client can match the error to its request even on a decode failure.
 *
 * @param line - One trimmed NDJSON line (no trailing newline).
 * @returns A {@link DecodeResult}.
 */
export function decodeLine(line: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'error', frame: buildErrorFrame('0', 'E_RPC_PARSE', 'invalid JSON line') };
  }

  // Best-effort id recovery for error correlation before full validation.
  const recoveredId = recoverId(raw);

  const parsed = GatewayRpcFrameSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'error',
      frame: buildErrorFrame(recoveredId, 'E_RPC_BAD_FRAME', 'frame failed schema validation'),
    };
  }

  const frame: GatewayRpcFrame = parsed.data;

  if (!isFrozenGatewayRpcVersion(frame.protocol_version)) {
    return {
      kind: 'error',
      frame: buildErrorFrame(
        frame.id,
        'E_RPC_BAD_VERSION',
        `unsupported protocol version ${frame.protocol_version}; server speaks ${GATEWAY_RPC_PROTOCOL_VERSION}`,
      ),
    };
  }

  if (frame.direction !== 'request') {
    return {
      kind: 'error',
      frame: buildErrorFrame(
        frame.id,
        'E_RPC_BAD_FRAME',
        `server cannot accept a ${frame.direction} frame`,
      ),
    };
  }

  return { kind: 'request', frame };
}

/**
 * Recover a best-effort correlation id from raw decoded JSON, used so a
 * validation failure can still be correlated to the client's request.
 *
 * @param raw - The result of `JSON.parse` on the inbound line.
 * @returns The string `id` if present and non-empty, else `'0'`.
 */
function recoverId(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return '0';
}

/**
 * A streaming line splitter for the NDJSON wire.
 *
 * `node:net` sockets deliver arbitrary chunk boundaries; a single `data` event
 * may carry a partial line or several lines. This buffer accumulates bytes and
 * yields only complete lines (split on `\n`), matching the supervisor-ipc
 * client's `readline`-style framing without depending on `readline` (so it can
 * be driven directly off socket chunks).
 */
export class LineBuffer {
  /** Pending bytes that have not yet completed a line. */
  private buffer = '';

  /**
   * Push a decoded UTF-8 chunk; return every complete line it completes.
   *
   * @param chunk - A UTF-8 string chunk from the socket.
   * @returns Zero or more complete lines (trailing newline stripped, blanks
   *   skipped).
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx = this.buffer.indexOf(NEWLINE);
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) lines.push(line);
      idx = this.buffer.indexOf(NEWLINE);
    }
    return lines;
  }
}
