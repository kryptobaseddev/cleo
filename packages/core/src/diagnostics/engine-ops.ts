/**
 * Diagnostics Engine Operations — business logic layer.
 *
 * Contains all diagnostics domain EngineResult wrappers migrated from
 * `packages/cleo/src/dispatch/engines/diagnostics-engine.ts` (ENG-MIG-13 / T1580).
 *
 * Wraps the telemetry primitives in `@cleocode/core/telemetry` with typed
 * EngineResult returns so the CLI dispatch layer can call them directly.
 *
 * Importable from `@cleocode/core/internal` so the CLI dispatch layer can
 * call them without any intermediate engine file.
 *
 * @module diagnostics/engine-ops
 * @task T1580 — ENG-MIG-13
 * @epic T1566
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { memoryObserve } from '../memory/engine-compat.js';
import {
  buildDiagnosticsReport,
  disableTelemetry,
  enableTelemetry,
  exportTelemetryEvents,
  getTelemetryConfigPath,
  getTelemetryDbPath,
  isTelemetryEnabled,
  loadTelemetryConfig,
} from '../telemetry/index.js';

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

/**
 * Enable telemetry collection.
 *
 * Generates a stable anonymous UUID on first call; preserves it on
 * subsequent calls (idempotent).
 *
 * @returns EngineResult with enabled status, anonymousId, and paths
 * @task T1580 — ENG-MIG-13
 */
export async function diagnosticsEnable(): Promise<
  EngineResult<{
    enabled: true;
    anonymousId: string;
    dbPath: string;
    configPath: string;
    message: string;
  }>
> {
  try {
    const config = enableTelemetry();
    return engineSuccess({
      enabled: true,
      anonymousId: config.anonymousId,
      dbPath: getTelemetryDbPath(),
      configPath: getTelemetryConfigPath(),
      message:
        'Telemetry enabled. CLEO will now record anonymous command telemetry to improve itself.',
    });
  } catch (err: unknown) {
    return engineError('E_WRITE_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

/**
 * Disable telemetry collection.
 *
 * Existing data in telemetry.db is preserved for historical analysis.
 *
 * @returns EngineResult with disabled status and confirmation message
 * @task T1580 — ENG-MIG-13
 */
export async function diagnosticsDisable(): Promise<
  EngineResult<{ enabled: false; message: string }>
> {
  try {
    disableTelemetry();
    return engineSuccess({
      enabled: false,
      message:
        'Telemetry disabled. Existing data in telemetry.db is preserved but no new events will be recorded.',
    });
  } catch (err: unknown) {
    return engineError('E_WRITE_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Return current telemetry config and paths.
 *
 * @returns EngineResult with enabled flag, anonymousId, and file paths
 * @task T1580 — ENG-MIG-13
 */
export async function diagnosticsStatus(): Promise<
  EngineResult<{
    enabled: boolean;
    anonymousId: string;
    dbPath: string;
    configPath: string;
  }>
> {
  const config = loadTelemetryConfig();
  return engineSuccess({
    enabled: config.enabled,
    anonymousId: config.anonymousId || '(not set)',
    dbPath: getTelemetryDbPath(),
    configPath: getTelemetryConfigPath(),
  });
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

/**
 * Build a diagnostics report and push high-signal patterns to BRAIN.
 *
 * Requires telemetry to be enabled. Optionally suppresses BRAIN write with
 * `pushToBrain = false`.
 *
 * @param days - Number of days to analyze (default: 30)
 * @param pushToBrain - Whether to write observations to BRAIN memory (default: true)
 * @returns EngineResult with the diagnostics report and BRAIN observation count
 * @task T1580 — ENG-MIG-13
 */
export async function diagnosticsAnalyze(
  days = 30,
  pushToBrain = true,
): Promise<EngineResult<Record<string, unknown>>> {
  if (!isTelemetryEnabled()) {
    return engineError(
      'E_NOT_INITIALIZED',
      'Telemetry is disabled. Run `cleo diagnostics enable` first.',
      { fix: 'cleo diagnostics enable' },
    );
  }

  try {
    const report = await buildDiagnosticsReport(days);
    if (!report) {
      return engineError('E_NO_DATA', 'No telemetry data found in the analysis window.');
    }

    if (report.totalEvents === 0) {
      return engineSuccess({
        report,
        brainObservationsAdded: 0,
        message: `No telemetry events found in the last ${days} days.`,
      });
    }

    let brainObservationsAdded = 0;

    if (pushToBrain && report.observations.length > 0) {
      try {
        for (const obs of report.observations) {
          await memoryObserve({
            text: obs,
            title: 'Diagnostics: command telemetry observation',
            type: 'insight',
            sourceType: 'agent',
          });
          brainObservationsAdded++;
        }
      } catch {
        // Non-fatal: BRAIN may not be initialized in all contexts
      }
    }

    return engineSuccess({ report, brainObservationsAdded });
  } catch (err: unknown) {
    return engineError('E_READ_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * Export all telemetry events as a JSON array for external analysis.
 *
 * Requires telemetry to be enabled. Optionally limit to the last N days.
 *
 * @param days - Number of days to include (optional; defaults to all time)
 * @returns EngineResult with events array, count, and export timestamp
 * @task T1580 — ENG-MIG-13
 */
export async function diagnosticsExport(
  days?: number,
): Promise<EngineResult<{ events: unknown[]; count: number; exportedAt: string }>> {
  if (!isTelemetryEnabled()) {
    return engineError(
      'E_NOT_INITIALIZED',
      'Telemetry is disabled. Run `cleo diagnostics enable` first.',
      { fix: 'cleo diagnostics enable' },
    );
  }

  try {
    const events = await exportTelemetryEvents(days);
    return engineSuccess({
      events,
      count: events.length,
      exportedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return engineError('E_READ_FAILED', (err as Error).message);
  }
}
