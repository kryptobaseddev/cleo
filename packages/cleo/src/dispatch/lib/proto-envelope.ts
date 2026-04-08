/**
 * Shared bridge stub type for LAFS SDK protocol-shape envelopes.
 *
 * The LAFS SDK's internal `LAFSEnvelope` uses the proto-shape `{_meta, result}`.
 * The canonical CLEO CLI envelope uses `{meta, data}`. Several dispatch-layer
 * modules (budget enforcement, field filtering) need to map between the two.
 *
 * This stub captures the SDK's expected shape so both `budget.ts` and
 * `field-filter.ts` share a single, consistent definition rather than
 * duplicating it inline.
 *
 * @task T338
 * @epic T335
 * @internal
 */

/**
 * Minimal stub of the LAFS SDK's `LAFSEnvelope` proto-shape.
 *
 * Used to bridge `DispatchResponse` (canonical CLI envelope with `meta` + `data`)
 * into the SDK's expected `{_meta, result}` shape for budget checking and
 * field filtering. After the SDK call, results are mapped back to the canonical
 * shape.
 *
 * @internal
 */
export interface _ProtoEnvelopeStub {
  /** LAFS JSON Schema URL. */
  $schema: string;
  /**
   * Protocol-level metadata block (SDK proto-shape).
   *
   * This mirrors the required fields of `LAFSMeta` so the SDK's validators
   * accept the stub without a full `LAFSMeta` import.
   */
  _meta: {
    specVersion: string;
    schemaVersion: string;
    timestamp: string;
    operation: string;
    requestId: string;
    transport: string;
    strict: boolean;
    mvi: string;
    contextVersion: number;
    [key: string]: unknown;
  };
  /** Whether the operation succeeded. */
  success: boolean;
  /** Operation result payload (SDK proto-shape uses `result`, not `data`). */
  result: Record<string, unknown> | Record<string, unknown>[] | null;
  /** Optional error payload. */
  error?: Record<string, unknown>;
  /** Extensible: additional SDK fields pass through the index signature. */
  [key: string]: unknown;
}
