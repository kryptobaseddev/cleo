/**
 * Typed NDJSON client for the FROZEN `supervisor-ipc` v1.0 contract.
 *
 * The Rust `cleo-supervisor` is the server; a CLEO daemon process is a client
 * that sends {@link SupervisorIpcRequestEnvelope}s and receives
 * {@link SupervisorIpcResponseEnvelope}s, one newline-delimited JSON
 * (NDJSON) envelope per line. This module is a transport-agnostic codec: it
 * encodes outbound envelopes to NDJSON lines and decodes inbound lines through
 * the frozen Zod schemas. **Every inbound line is parsed** — a malformed or
 * schema-violating frame is rejected with a typed {@link MalformedIpcFrameError}
 * and never silently dropped (T11367 AC2).
 *
 * The codec does not own a socket — callers feed it raw lines from whatever
 * transport (Unix socket, named pipe, test pair) they own, keeping the daemon
 * submodule free of platform IO and trivially testable.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11367 — defineSubsystem + lifecycle/health registry + IPC client
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import {
  SUPERVISOR_IPC_PROTOCOL_VERSION,
  type SupervisorIpcRequest,
  type SupervisorIpcRequestEnvelope,
  SupervisorIpcRequestEnvelopeSchema,
  type SupervisorIpcResponseEnvelope,
  SupervisorIpcResponseEnvelopeSchema,
} from '@cleocode/contracts';

/**
 * A typed error raised when an inbound NDJSON line cannot be decoded into a
 * valid {@link SupervisorIpcResponseEnvelope}.
 *
 * Carries the offending raw `line` and the underlying `cause` (a JSON
 * `SyntaxError` or a Zod validation error) so callers can log + correlate.
 * Invalid frames are surfaced as this error — never silently dropped.
 */
export class MalformedIpcFrameError extends Error {
  /** The raw NDJSON line that failed to decode. */
  readonly line: string;

  /**
   * @param line  - The offending raw NDJSON line.
   * @param cause - The underlying JSON or Zod error.
   */
  constructor(line: string, cause: unknown) {
    super(`Malformed supervisor-ipc frame: ${cause instanceof Error ? cause.message : cause}`);
    this.name = 'MalformedIpcFrameError';
    this.line = line;
    this.cause = cause;
  }
}

/**
 * A transport-agnostic codec for the FROZEN `supervisor-ipc` v1.0 wire format.
 *
 * Construct via {@link createSupervisorIpcClient}. The client is stateful only
 * in its monotonic correlation-id counter; it owns no socket.
 */
export interface SupervisorIpcClient {
  /**
   * Encode a request body into a complete, newline-terminated NDJSON envelope
   * line ready to write to the transport.
   *
   * Stamps the frozen protocol version and a fresh correlation `id`, validates
   * the result against {@link SupervisorIpcRequestEnvelopeSchema}, and returns
   * the serialized line (including the trailing `\n`).
   *
   * @param request - The request body (validated by the envelope schema).
   * @returns `{ id, line }` — the correlation id and the NDJSON line to send.
   */
  encodeRequest: (request: SupervisorIpcRequest) => { id: string; line: string };

  /**
   * Decode a single inbound NDJSON line into a typed response envelope.
   *
   * Parses the line as JSON, then validates it against
   * {@link SupervisorIpcResponseEnvelopeSchema}. A malformed or
   * schema-violating line throws {@link MalformedIpcFrameError} — it is never
   * silently dropped.
   *
   * @param line - A single NDJSON line (without the trailing newline).
   * @returns The decoded {@link SupervisorIpcResponseEnvelope}.
   * @throws {MalformedIpcFrameError} When the line is not a valid response frame.
   */
  decodeResponseLine: (line: string) => SupervisorIpcResponseEnvelope;
}

/**
 * Generate a process-unique correlation id for an IPC request envelope.
 *
 * @param seq - The client's monotonic sequence number.
 * @returns A correlation id of the form `c<seq>-<random>`.
 */
function nextCorrelationId(seq: number): string {
  return `c${seq}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a typed NDJSON codec for the FROZEN `supervisor-ipc` v1.0 contract.
 *
 * @returns A {@link SupervisorIpcClient}.
 *
 * @example
 * ```ts
 * const client = createSupervisorIpcClient();
 * const { id, line } = client.encodeRequest({ kind: 'health' });
 * socket.write(line);
 * socket.on('line', (raw) => {
 *   const env = client.decodeResponseLine(raw); // throws MalformedIpcFrameError on bad frame
 *   if (env.response.kind === 'health') { /* ... *\/ }
 * });
 * ```
 */
export function createSupervisorIpcClient(): SupervisorIpcClient {
  let seq = 0;

  return {
    encodeRequest(request: SupervisorIpcRequest): { id: string; line: string } {
      seq += 1;
      const id = nextCorrelationId(seq);
      const envelope: SupervisorIpcRequestEnvelope = {
        protocol_version: SUPERVISOR_IPC_PROTOCOL_VERSION,
        id,
        direction: 'request',
        request,
      };
      // Validate before serialization so we never emit an off-contract frame.
      const parsed = SupervisorIpcRequestEnvelopeSchema.parse(envelope);
      return { id, line: `${JSON.stringify(parsed)}\n` };
    },

    decodeResponseLine(line: string): SupervisorIpcResponseEnvelope {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (cause) {
        throw new MalformedIpcFrameError(line, cause);
      }
      const result = SupervisorIpcResponseEnvelopeSchema.safeParse(json);
      if (!result.success) {
        throw new MalformedIpcFrameError(line, result.error);
      }
      return result.data;
    },
  };
}
