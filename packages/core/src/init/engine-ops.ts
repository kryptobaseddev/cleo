/**
 * Init Engine Operations — EngineResult wrappers for init domain.
 *
 * Migrated from `packages/cleo/src/dispatch/engines/init-engine.ts`
 * (ENG-MIG-14 / T1581). All business logic remains in `../init.ts`;
 * this module only adds the `EngineResult` envelope so the CLI dispatch
 * layer can call core directly per ADR-057 D1.
 *
 * Importable from `@cleocode/core/internal` — no intermediate engine file
 * required in the CLI layer.
 *
 * @module init/engine-ops
 * @task T1581 — ENG-MIG-14
 * @epic T1566
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import {
  ensureInitialized as coreEnsureInitialized,
  getVersion as coreGetVersion,
  initProject as coreInitProject,
  isAutoInitEnabled as coreIsAutoInitEnabled,
} from '../init.js';

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------

/**
 * Initialize a CLEO project directory.
 *
 * Creates the `.cleo/` directory structure with empty data files.
 * Returns an error envelope if already initialized (unless `force` is true).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param options - Optional init overrides (projectName, force, mapCodebase).
 * @returns EngineResult with initialization details and next-step guidance.
 * @task T1581 — ENG-MIG-14
 */
export async function initProject(
  projectRoot: string,
  options?: {
    projectName?: string;
    force?: boolean;
    mapCodebase?: boolean;
  },
): Promise<
  EngineResult<{
    initialized: boolean;
    projectRoot: string;
    filesCreated: string[];
    skipped: string[];
    warnings: string[];
    classification?: {
      kind: 'greenfield' | 'brownfield';
      signalCount: number;
      topLevelFileCount: number;
      hasGit: boolean;
    };
    nextSteps?: Array<{ action: string; command: string }>;
  }>
> {
  try {
    const result = await coreInitProject({
      name: options?.projectName,
      force: options?.force,
      mapCodebase: options?.mapCodebase,
    });

    return engineSuccess({
      initialized: result.initialized,
      projectRoot,
      filesCreated: result.created,
      skipped: result.skipped,
      warnings: result.warnings,
      classification: result.classification,
      nextSteps: result.nextSteps,
    });
  } catch (err: unknown) {
    const message = (err as Error).message;
    if (message.includes('already initialized')) {
      return engineError(
        'E_ALREADY_INITIALIZED',
        'CLEO project already initialized. Use force=true to reinitialize.',
      );
    }
    return engineError('E_INIT_FAILED', message);
  }
}

// ---------------------------------------------------------------------------
// isAutoInitEnabled
// ---------------------------------------------------------------------------

/**
 * Check whether auto-init is enabled via the `CLEO_AUTO_INIT` environment
 * variable.
 *
 * @returns `true` if `CLEO_AUTO_INIT=true` is set in the environment.
 * @task T1581 — ENG-MIG-14
 */
export function isAutoInitEnabled(): boolean {
  return coreIsAutoInitEnabled();
}

// ---------------------------------------------------------------------------
// ensureInitialized
// ---------------------------------------------------------------------------

/**
 * Check initialization status and auto-init if configured.
 *
 * Returns `{ initialized: true }` if the project is ready. Throws (wrapped
 * as `E_NOT_INITIALIZED`) if the project is not initialized and auto-init is
 * disabled.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns EngineResult with initialized flag.
 * @task T1581 — ENG-MIG-14
 */
export async function ensureInitialized(
  projectRoot: string,
): Promise<EngineResult<{ initialized: boolean }>> {
  try {
    const result = await coreEnsureInitialized(projectRoot);
    return engineSuccess(result);
  } catch (err: unknown) {
    return engineError('E_NOT_INITIALIZED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// getVersion
// ---------------------------------------------------------------------------

/**
 * Get the current CLEO / project version string.
 *
 * Checks the `VERSION` file first, then falls back to `package.json`.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns EngineResult with the resolved version string.
 * @task T1581 — ENG-MIG-14
 */
export async function getVersion(projectRoot: string): Promise<EngineResult<{ version: string }>> {
  try {
    const result = await coreGetVersion(projectRoot);
    return engineSuccess(result);
  } catch (err: unknown) {
    return engineError('E_VERSION_FAILED', (err as Error).message);
  }
}
