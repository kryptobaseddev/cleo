/**
 * Canonical EngineResult type used by dispatch engines and core modules.
 *
 * This type was originally defined in src/dispatch/engines/_error.ts.
 * Moved to core so that core modules can reference it without
 * importing from the dispatch layer.
 *
 * @task T5715
 * @epic T5701
 */

import type { LAFSPage } from '@cleocode/lafs';

/**
 * Canonical EngineResult type used by all engines and core engine-compat modules.
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  page?: LAFSPage;
  error?: {
    code: string;
    message: string;
    exitCode?: number;
    details?: unknown;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}
