/**
 * Store write guard middleware (T12535).
 *
 * While a project store's twin collapse is failed or pending, reads keep
 * working (they are served from the merged TEMP shadows) and `cleo doctor`
 * stays available, but mutating operations of the failed pair's domain are
 * refused with `E_TWIN_COLLAPSE_FAILED`: a write would land in a shadow or in
 * a twin that is not in step with its bare table. Other domains keep writing
 * (a failed docs merge does not stop `cleo add`). `admin.backup` stays allowed, because
 * taking or restoring a backup is part of the recovery path.
 *
 * @task T12535
 */

import type { DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/** Mutating operations allowed while the store is read-only (`domain.operation`). */
const ALLOWED_WHILE_READ_ONLY: ReadonlySet<string> = new Set(['admin.backup']);

/**
 * Create the store write guard.
 *
 * @param getProjectRoot - Resolves the project the request acts on.
 * @returns A middleware that refuses mutating operations on a store whose twin
 *   collapse failed.
 * @task T12535
 */
export function createStoreWriteGuard(getProjectRoot: () => string): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    if (req.gateway !== 'mutate' || ALLOWED_WHILE_READ_ONLY.has(`${req.domain}.${req.operation}`)) {
      return next();
    }
    let projectRoot: string;
    try {
      projectRoot = getProjectRoot();
    } catch {
      return next();
    }
    const { storeWriteBlock } = await import('@cleocode/core/store/store-write-guard.js');
    const blocked = await storeWriteBlock(projectRoot, {
      domain: req.domain,
      operation: req.operation,
    });
    if (blocked === null) return next();
    return {
      success: false,
      meta: {
        gateway: req.gateway,
        domain: req.domain,
        operation: req.operation,
        source: req.source,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        duration_ms: 0,
      },
      data: null,
      error: {
        code: 'E_TWIN_COLLAPSE_FAILED',
        exitCode: blocked.code,
        message: blocked.message,
        ...(blocked.details ? { details: blocked.details } : {}),
        ...(blocked.fix ? { fix: blocked.fix } : {}),
      },
    };
  };
}
