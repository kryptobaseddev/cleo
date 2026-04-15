/**
 * Diagnostics Engine
 *
 * Business logic for `cleo diagnostics` — opt-in telemetry analysis and
 * autonomous BRAIN observation generation.
 *
 * Operations:
 *   - enable   → enable telemetry, generate anonymous ID
 *   - disable  → disable telemetry collection
 *   - status   → show current config and DB path
 *   - analyze  → build diagnostics report and emit BRAIN observations
 *   - export   → JSON dump for external analysis
 *
 * @task T624
 */

import {
  buildDiagnosticsReport,
  disableTelemetry,
  enableTelemetry,
  exportTelemetryEvents,
  getTelemetryConfigPath,
  getTelemetryDbPath,
  isTelemetryEnabled,
  loadTelemetryConfig,
} from '@cleocode/core/internal';
import { type EngineResult, engineError } from './_error.js';

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

/**
 * Enable telemetry collection.
 * Generates a stable anonymous UUID on first call; preserves it on subsequent calls.
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
    return {
      success: true,
      data: {
        enabled: true,
        anonymousId: config.anonymousId,
        dbPath: getTelemetryDbPath(),
        configPath: getTelemetryConfigPath(),
        message:
          'Telemetry enabled. CLEO will now record anonymous command telemetry to improve itself.',
      },
    };
  } catch (err: unknown) {
    return engineError('E_WRITE_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

/**
 * Disable telemetry collection.
 * Existing data in telemetry.db is preserved for historical analysis.
 */
export async function diagnosticsDisable(): Promise<
  EngineResult<{ enabled: false; message: string }>
> {
  try {
    disableTelemetry();
    return {
      success: true,
      data: {
        enabled: false,
        message:
          'Telemetry disabled. Existing data in telemetry.db is preserved but no new events will be recorded.',
      },
    };
  } catch (err: unknown) {
    return engineError('E_WRITE_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Return current telemetry config and paths.
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
  return {
    success: true,
    data: {
      enabled: config.enabled,
      anonymousId: config.anonymousId || '(not set)',
      dbPath: getTelemetryDbPath(),
      configPath: getTelemetryConfigPath(),
    },
  };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

/**
 * Build a diagnostics report and push high-signal patterns to BRAIN.
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
      return {
        success: true,
        data: {
          report,
          brainObservationsAdded: 0,
          message: `No telemetry events found in the last ${days} days.`,
        },
      };
    }

    let brainObservationsAdded = 0;

    if (pushToBrain && report.observations.length > 0) {
      try {
        const { memoryObserve } = await import('@cleocode/core/internal');
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

    return {
      success: true,
      data: {
        report,
        brainObservationsAdded,
      },
    };
  } catch (err: unknown) {
    return engineError('E_READ_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * Export all telemetry events as a JSON array for external analysis.
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
    return {
      success: true,
      data: {
        events,
        count: events.length,
        exportedAt: new Date().toISOString(),
      },
    };
  } catch (err: unknown) {
    return engineError('E_READ_FAILED', (err as Error).message);
  }
}
