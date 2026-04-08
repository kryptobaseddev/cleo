/**
 * LAFS Field Filter Middleware
 *
 * Implements LAFS _fields parameter (field selection) and _mvi envelope verbosity.
 * Extracts _fields and _mvi from params (for callers that pass them as params),
 * stores them on the request, and post-processes the response via the canonical
 * SDK utilities from @cleocode/lafs v1.5.0.
 *
 * @epic T4820
 * @task T4979
 * @task T338 — updated for canonical CLI envelope (meta, data)
 */

import { isMVILevel, applyFieldFilter as sdkApplyFieldFilter } from '@cleocode/lafs';
import type { DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Bridge stub type for the LAFS SDK's `applyFieldFilter`.
 *
 * The SDK's internal `LAFSEnvelope` still uses `{_meta, result}` (proto-shape).
 * We construct a minimal stub of that shape to drive field filtering, then map
 * the filtered `result` back to the canonical `data` field of DispatchResponse.
 *
 * @internal
 */
interface _ProtoEnvelopeStub {
  $schema: string;
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
  success: boolean;
  result: Record<string, unknown> | Record<string, unknown>[] | null;
  [key: string]: unknown;
}

/**
 * Create the LAFS field-filter middleware.
 *
 * Handles:
 * - _fields: filter response data to specified fields (delegates to SDK applyFieldFilter)
 * - _mvi: envelope verbosity — stored on request for downstream use
 *
 * _fields and _mvi are extracted from req.params (for callers that pass
 * them as params) and stored on the DispatchRequest before the domain handler runs.
 */
export function createFieldFilter(): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    // Extract control params from req.params (callers may pass them here)
    const _fields = req._fields ?? (req.params?._fields as string[] | undefined);
    const rawMvi = req._mvi ?? (req.params?._mvi as string | undefined);
    const _mvi = isMVILevel(rawMvi) ? rawMvi : undefined;

    // Remove from params so domain handlers don't see them
    if (req.params) {
      delete req.params['_fields'];
      delete req.params['_mvi'];
    }

    // Store on request for potential downstream use
    if (_fields) req._fields = _fields;
    if (_mvi) req._mvi = _mvi;

    const response = await next();

    // Apply _fields filter via SDK — handles all four result shapes,
    // preserves envelope structure. Bridges DispatchResponse (canonical CLI shape)
    // to the lafs SDK proto-envelope shape for filtering, then maps back.
    if (_fields?.length && response.success && response.data !== undefined) {
      const stub: _ProtoEnvelopeStub = {
        $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
        _meta: {
          specVersion: '',
          schemaVersion: '',
          timestamp: response.meta.timestamp,
          operation: response.meta.operation,
          requestId: response.meta.requestId,
          transport: 'sdk',
          strict: true,
          mvi: 'minimal',
          contextVersion: 0,
        },
        success: true,
        result: response.data as _ProtoEnvelopeStub['result'],
      };
      // Type assertion: applyFieldFilter expects LAFSEnvelope (proto shape) but
      // our stub satisfies the structural contract at runtime.
      const filtered = sdkApplyFieldFilter(
        stub as Parameters<typeof sdkApplyFieldFilter>[0],
        _fields,
      );
      // Map filtered.result back to the canonical DispatchResponse.data field
      response.data = filtered.result ?? undefined;
    }

    return response;
  };
}
