/**
 * Typed NDJSON client for the PARALLEL `lease-ipc` v1.1 contract (T11627 ST-5).
 *
 * Mirrors {@link ./supervisor-client.ts | supervisor-client.ts} conventions
 * exactly — a transport-agnostic codec that **owns no socket**. It encodes
 * outbound {@link LeaseIpcRequestEnvelope}s to newline-delimited JSON (NDJSON)
 * lines and decodes inbound lines through the v1.1 Zod schemas. **Every inbound
 * line is parsed** — a malformed or schema-violating frame is rejected with a
 * typed {@link MalformedLeaseIpcFrameError} and never silently dropped.
 *
 * The wire format is byte-identical framing to the frozen `supervisor-ipc` v1.0
 * envelope; only the version string ({@link LEASE_IPC_PROTOCOL_VERSION} =
 * `1.1.0`) and the inner union differ. A single supervisor accept loop routes
 * `1.0.0` frames to the v1.0 union and `1.1.0` frames to this lease union.
 *
 * The Rust `cleo-supervisor` is the arbiter (server); a CLEO process running in
 * `CLEO_WRITER_LEASE_MODE=supervisor` is a client that sends lease requests and
 * receives lease responses + unsolicited events (`lease_revoked`,
 * `child_killed_unresponsive`), one NDJSON envelope per line.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11625
 * @task T11894 — supervisor fast path: TS lease-ipc-client (ST-5)
 * @saga T11243 SG-RUNTIME-UNIFICATION
 * @see ./supervisor-client.ts — the v1.0 codec this mirrors
 */

import {
  LEASE_IPC_PROTOCOL_VERSION,
  type LeaseIpcRequest,
  type LeaseIpcRequestEnvelope,
  LeaseIpcRequestEnvelopeSchema,
  type LeaseIpcResponseEnvelope,
  LeaseIpcResponseEnvelopeSchema,
} from '@cleocode/contracts';

/**
 * A typed error raised when an inbound NDJSON line cannot be decoded into a
 * valid {@link LeaseIpcResponseEnvelope}.
 *
 * Carries the offending raw `line` and the underlying `cause` (a JSON
 * `SyntaxError` or a Zod validation error) so callers can log + correlate.
 * Invalid frames are surfaced as this error — never silently dropped. This is
 * the v1.1 sibling of {@link MalformedIpcFrameError}.
 *
 * @public
 */
export class MalformedLeaseIpcFrameError extends Error {
  /** The raw NDJSON line that failed to decode. */
  readonly line: string;

  /**
   * @param line  - The offending raw NDJSON line.
   * @param cause - The underlying JSON or Zod error.
   */
  constructor(line: string, cause: unknown) {
    super(`Malformed lease-ipc frame: ${cause instanceof Error ? cause.message : cause}`);
    this.name = 'MalformedLeaseIpcFrameError';
    this.line = line;
    this.cause = cause;
  }
}

/**
 * A transport-agnostic codec for the PARALLEL `lease-ipc` v1.1 wire format.
 *
 * Construct via {@link createLeaseIpcClient}. The client is stateful only in its
 * monotonic correlation-id counter; it owns no socket. Callers feed it raw lines
 * from whatever transport (Unix socket, named pipe, test pair) they own.
 */
export interface LeaseIpcClient {
  /**
   * Encode a request body into a complete, newline-terminated NDJSON envelope
   * line ready to write to the transport.
   *
   * Stamps the parallel protocol version ({@link LEASE_IPC_PROTOCOL_VERSION}) and
   * a fresh correlation `id`, validates the result against
   * {@link LeaseIpcRequestEnvelopeSchema}, and returns the serialized line
   * (including the trailing `\n`).
   *
   * @param request - The request body (validated by the envelope schema).
   * @returns `{ id, line }` — the correlation id and the NDJSON line to send.
   */
  encodeRequest: (request: LeaseIpcRequest) => { id: string; line: string };

  /**
   * Decode a single inbound NDJSON line into a typed response envelope.
   *
   * Parses the line as JSON, then validates it against
   * {@link LeaseIpcResponseEnvelopeSchema}. A malformed or schema-violating line
   * throws {@link MalformedLeaseIpcFrameError} — it is never silently dropped.
   *
   * @param line - A single NDJSON line (without the trailing newline).
   * @returns The decoded {@link LeaseIpcResponseEnvelope}.
   * @throws {MalformedLeaseIpcFrameError} When the line is not a valid response frame.
   */
  decodeResponseLine: (line: string) => LeaseIpcResponseEnvelope;
}

/**
 * Generate a process-unique correlation id for a lease IPC request envelope.
 *
 * @param seq - The client's monotonic sequence number.
 * @returns A correlation id of the form `l<seq>-<random>`.
 */
function nextCorrelationId(seq: number): string {
  return `l${seq}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a typed NDJSON codec for the PARALLEL `lease-ipc` v1.1 contract.
 *
 * @returns A {@link LeaseIpcClient}.
 *
 * @example
 * ```ts
 * const client = createLeaseIpcClient();
 * const { id, line } = client.encodeRequest({
 *   kind: 'lease_acquire', scope: 'project', lane: 'tasks',
 *   holder_id: 'pid-42:tasks', priority: 0, ttl_ms: 30_000, reentrant: true,
 * });
 * socket.write(line);
 * socket.on('line', (raw) => {
 *   const env = client.decodeResponseLine(raw); // throws on a bad frame
 *   if (env.response.kind === 'lease_granted') { /* ... *\/ }
 * });
 * ```
 */
export function createLeaseIpcClient(): LeaseIpcClient {
  let seq = 0;

  return {
    encodeRequest(request: LeaseIpcRequest): { id: string; line: string } {
      seq += 1;
      const id = nextCorrelationId(seq);
      const envelope: LeaseIpcRequestEnvelope = {
        protocol_version: LEASE_IPC_PROTOCOL_VERSION,
        id,
        direction: 'request',
        request,
      };
      // Validate before serialization so we never emit an off-contract frame.
      const parsed = LeaseIpcRequestEnvelopeSchema.parse(envelope);
      return { id, line: `${JSON.stringify(parsed)}\n` };
    },

    decodeResponseLine(line: string): LeaseIpcResponseEnvelope {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (cause) {
        throw new MalformedLeaseIpcFrameError(line, cause);
      }
      const result = LeaseIpcResponseEnvelopeSchema.safeParse(json);
      if (!result.success) {
        throw new MalformedLeaseIpcFrameError(line, result.error);
      }
      return result.data;
    },
  };
}
