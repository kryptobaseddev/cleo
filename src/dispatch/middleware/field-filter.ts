/**
 * LAFS Field Filter Middleware
 *
 * Implements LAFS _fields parameter (field selection) and _mvi envelope verbosity.
 * Extracts _fields and _mvi from params (for MCP agents that pass them as params),
 * stores them on the request, and post-processes the response via the canonical
 * SDK utilities from @cleocode/lafs-protocol v1.5.0.
 *
 * @epic T4820
 * @task T4979
 */

import { applyFieldFilter as sdkApplyFieldFilter, isMVILevel } from '@cleocode/lafs-protocol';
import type { LAFSEnvelope } from '@cleocode/lafs-protocol';
import type { Middleware, DispatchRequest, DispatchResponse } from '../types.js';

/**
 * Create the LAFS field-filter middleware.
 *
 * Handles:
 * - _fields: filter response data to specified fields (delegates to SDK applyFieldFilter)
 * - _mvi: envelope verbosity — stored on request for downstream use
 *
 * _fields and _mvi are extracted from req.params (for MCP callers that pass
 * them as params) and stored on the DispatchRequest before the domain handler runs.
 */
export function createFieldFilter(): Middleware {
  return async (req: DispatchRequest, next: () => Promise<DispatchResponse>): Promise<DispatchResponse> => {
    // Extract control params from req.params (MCP agents pass them here)
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
    // preserves envelope structure, sets _meta.mvi = 'custom' per §9.1
    if (_fields?.length && response.success && response.data !== undefined) {
      const stub: LAFSEnvelope = {
        $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
        _meta: (response._meta as unknown as LAFSEnvelope['_meta']),
        success: true,
        result: response.data as LAFSEnvelope['result'],
      };
      const filtered = sdkApplyFieldFilter(stub, _fields);
      response.data = filtered.result;
    }

    return response;
  };
}
