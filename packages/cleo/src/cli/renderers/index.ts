import { randomUUID } from 'node:crypto';

/**
 * Generate a request UUID for error envelopes.
 * Extracted to keep the hot path synchronous.
 *
 * @internal
 */
function generateRequestId(): string {
  return randomUUID();
}

/**
 * Central output dispatch for V2 CLI commands.
 *
 * Provides cliOutput() which replaces `console.log(formatSuccess(data))`.
 * Checks the resolved format (JSON/human/quiet) and dispatches to either
 * the LAFS JSON envelope (formatSuccess) or a human-readable renderer.
 *
 * Commands call:
 *   cliOutput(data, { command: 'show', message, operation, page })
 *
 * @task T4665
 * @task T4666
 * @task T4813
 * @epic T4663
 */

import { type FormatOptions, formatSuccess } from '@cleocode/core';
import type { CliEnvelope, CliMeta } from '@cleocode/lafs';
import { applyFieldFilter, extractFieldFromResult } from '@cleocode/lafs';
import { getFieldContext } from '../field-context.js';
import { getFormatContext } from '../format-context.js';
import { emitLafsViolation, LafsViolationError, validateLafsShape } from './lafs-validator.js';
import { normalizeForHuman } from './normalizer.js';
// System renderers
import {
  renderAuditReconstruct,
  renderBlockers,
  renderBrainBackfill,
  renderBrainExport,
  renderBrainMaintenance,
  renderBrainPlasticityStats,
  renderBrainPurge,
  renderBrainQuality,
  renderBriefing,
  renderCurrent,
  renderDoctor,
  renderGeneric,
  renderNext,
  renderPlan,
  renderSchemaCommand,
  renderSession,
  renderStart,
  renderStats,
  renderStop,
  renderTree,
  renderVersion,
  renderWaves,
} from './system.js';

export type { RenderWavesMode, RenderWavesOptions } from './system.js';
export { renderWaves };

// Nexus renderers (T1720)
import {
  renderNexusAnalyze,
  renderNexusBrainAnchors,
  renderNexusClusters,
  renderNexusColdSymbols,
  renderNexusConduitScan,
  renderNexusContext as renderNexusContextResult,
  renderNexusContractsLinkTasks,
  renderNexusContractsShow,
  renderNexusContractsSync,
  renderNexusDiff,
  renderNexusExport,
  renderNexusFlows,
  renderNexusFullContext,
  renderNexusHotNodes,
  renderNexusHotPaths,
  renderNexusImpact,
  renderNexusImpactFull,
  renderNexusProjectsClean,
  renderNexusProjectsCleanPreview,
  renderNexusProjectsList,
  renderNexusProjectsRegister,
  renderNexusProjectsRemove,
  renderNexusProjectsScan,
  renderNexusQuery,
  renderNexusRefreshBridge,
  renderNexusRouteMap,
  renderNexusSearchCode,
  renderNexusSetup,
  renderNexusShapeCheck,
  renderNexusStatus,
  renderNexusTaskFootprint,
  renderNexusTaskSymbols,
  renderNexusWhy,
  renderNexusWiki,
} from './nexus.js';
// Task renderers
import {
  renderAdd,
  renderArchive,
  renderComplete,
  renderDelete,
  renderFind,
  renderList,
  renderRestore,
  renderShow,
  renderUpdate,
} from './tasks.js';

// ---------------------------------------------------------------------------
// Renderer registry: maps command name to human renderer function
// ---------------------------------------------------------------------------

type HumanRenderer = (data: Record<string, unknown>, quiet: boolean) => string;

const renderers: Record<string, HumanRenderer> = {
  // Task CRUD
  show: renderShow,
  list: renderList,
  ls: renderList,
  find: renderFind,
  search: renderFind,
  add: renderAdd,
  update: renderUpdate,
  complete: renderComplete,
  done: renderComplete,
  delete: renderDelete,
  rm: renderDelete,
  archive: renderArchive,
  restore: renderRestore,

  // Task work
  start: renderStart,
  stop: renderStop,
  current: renderCurrent,

  // System
  doctor: renderDoctor,
  stats: renderStats,
  next: renderNext,
  plan: renderPlan,
  blockers: renderBlockers,
  tree: renderTree,
  depends: renderTree,
  deps: renderTree,
  // Orchestration — `cleo orchestrate waves` emits { waves, epicId, ... }
  // which renderTree handles via its data.waves branch (T1194/T1195).
  orchestrate: renderTree,
  session: renderSession,
  version: renderVersion,
  // T1593 — `cleo briefing` reads tasks.db + brain.db (NEVER markdown handoffs).
  briefing: renderBriefing,

  // Brain subcommands (T1722)
  'brain-maintenance': renderBrainMaintenance,
  'brain-backfill': renderBrainBackfill,
  'brain-purge': renderBrainPurge,
  'brain-plasticity-stats': renderBrainPlasticityStats,
  'brain-quality': renderBrainQuality,
  'brain-export': renderBrainExport,

  // Audit subcommand renderers (T1729)
  'audit-reconstruct': renderAuditReconstruct,

  // Schema command renderer (T1729)
  schema: renderSchemaCommand,

  // Nexus subcommand renderers (T1720)
  'nexus-status': renderNexusStatus,
  'nexus-setup': renderNexusSetup,
  'nexus-clusters': renderNexusClusters,
  'nexus-flows': renderNexusFlows,
  'nexus-context': renderNexusContextResult,
  'nexus-impact': renderNexusImpact,
  'nexus-analyze': renderNexusAnalyze,
  'nexus-projects-list': renderNexusProjectsList,
  'nexus-projects-register': renderNexusProjectsRegister,
  'nexus-projects-remove': renderNexusProjectsRemove,
  'nexus-projects-scan': renderNexusProjectsScan,
  'nexus-projects-clean': renderNexusProjectsClean,
  'nexus-projects-clean-preview': renderNexusProjectsCleanPreview,
  'nexus-refresh-bridge': renderNexusRefreshBridge,
  'nexus-diff': renderNexusDiff,
  'nexus-query': renderNexusQuery,
  'nexus-route-map': renderNexusRouteMap,
  'nexus-shape-check': renderNexusShapeCheck,
  'nexus-full-context': renderNexusFullContext,
  'nexus-task-footprint': renderNexusTaskFootprint,
  'nexus-brain-anchors': renderNexusBrainAnchors,
  'nexus-why': renderNexusWhy,
  'nexus-impact-full': renderNexusImpactFull,
  'nexus-conduit-scan': renderNexusConduitScan,
  'nexus-task-symbols': renderNexusTaskSymbols,
  'nexus-search-code': renderNexusSearchCode,
  'nexus-contracts-sync': renderNexusContractsSync,
  'nexus-contracts-show': renderNexusContractsShow,
  'nexus-contracts-link-tasks': renderNexusContractsLinkTasks,
  'nexus-export': renderNexusExport,
  'nexus-wiki': renderNexusWiki,
  'nexus-hot-paths': renderNexusHotPaths,
  'nexus-hot-nodes': renderNexusHotNodes,
  'nexus-cold-symbols': renderNexusColdSymbols,
};

// ---------------------------------------------------------------------------
// Options for cliOutput
// ---------------------------------------------------------------------------

export interface CliOutputOptions {
  /** Command name (used to pick the correct human renderer). */
  command: string;
  /** Optional success message for JSON envelope (attached to `meta.message`). */
  message?: string;
  /** Operation name for canonical envelope `meta.operation` (e.g. `"tasks.show"`). */
  operation?: string;
  /** Pagination metadata for canonical envelope `page` field. */
  page?: FormatOptions['page'];
  /** Extra metadata extensions merged into `meta`. */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Main output function
// ---------------------------------------------------------------------------

/**
 * Output data to stdout in the resolved format (JSON or human-readable).
 *
 * Replaces `console.log(formatSuccess(data))` in all V2 commands.
 * When format is 'human', normalizes the data shape then dispatches to
 * the appropriate renderer.
 * When format is 'json', delegates to existing formatSuccess().
 *
 * @task T4665
 * @task T4666
 * @task T4813
 */
export function cliOutput(data: unknown, opts: CliOutputOptions): void {
  const ctx = getFormatContext();
  const fieldCtx = getFieldContext();

  if (ctx.format === 'human') {
    let dataToRender = data as Record<string, unknown>;

    // §5.4.1 filter-then-render: apply --field extraction BEFORE human rendering
    let fieldExtracted = false;
    if (fieldCtx.field) {
      const extracted = extractFieldFromResult(
        data as Parameters<typeof extractFieldFromResult>[0],
        fieldCtx.field,
      );
      if (extracted === undefined) {
        cliError(`Field "${fieldCtx.field}" not found`, 4, { name: 'E_NOT_FOUND' });
        process.exit(4);
      }
      // If extracted is a primitive, render directly
      if (typeof extracted !== 'object' || extracted === null) {
        process.stdout.write(String(extracted) + '\n');
        return;
      }
      // If extracted is an array, wrap it for renderGeneric
      if (Array.isArray(extracted)) {
        dataToRender = { [fieldCtx.field]: extracted };
      } else {
        dataToRender = extracted as Record<string, unknown>;
      }
      fieldExtracted = true;
    }

    const normalized = normalizeForHuman(opts.command, dataToRender);
    // After field extraction, use renderGeneric — command-specific renderers
    // expect the full data structure, not a filtered subset (§5.4.1)
    const renderer = fieldExtracted ? renderGeneric : (renderers[opts.command] ?? renderGeneric);
    const text = renderer(normalized, ctx.quiet);
    if (text) {
      process.stdout.write(text + '\n');
    }
    return;
  }

  // --field: single-field plain text extraction (scripting / agent use).
  // Centralised here so ALL commands (dispatchFromCli and dispatchRaw) honour the flag.
  if (fieldCtx.field) {
    // extractFieldFromResult operates on the data payload (not the envelope).
    // Cast to the proto-envelope result type for the SDK call.
    const value = extractFieldFromResult(
      data as Parameters<typeof extractFieldFromResult>[0],
      fieldCtx.field,
    );
    if (value === undefined) {
      cliError(`Field "${fieldCtx.field}" not found`, 4, { name: 'E_NOT_FOUND' });
      process.exit(4);
    }
    const out = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    process.stdout.write(out + '\n');
    return;
  }

  // JSON format (default): apply --fields filter, then emit canonical CLI envelope.
  // Centralised here so ALL commands honour the flag without per-command wiring.
  // applyFieldFilter can throw on unusual mixed-type arrays (e.g. changes: ['status']).
  // In that case we fall back to unfiltered output rather than crashing.
  let filteredData = data;
  if (fieldCtx.fields?.length && data !== undefined && data !== null) {
    try {
      // Build a proto-envelope stub to drive the SDK field filter (ADR-039 bridge).
      const stub = {
        $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
        _meta: {
          specVersion: '',
          schemaVersion: '',
          timestamp: '',
          operation: '',
          requestId: '',
          transport: 'cli',
          strict: false,
          mvi: 'standard',
          contextVersion: 0,
        },
        success: true,
        result: data as Parameters<typeof applyFieldFilter>[0]['result'],
      };
      const filtered = applyFieldFilter(
        stub as Parameters<typeof applyFieldFilter>[0],
        fieldCtx.fields,
      );
      filteredData = filtered.result;
    } catch {
      // applyFieldFilter limitation: mixed-type arrays (strings inside arrays) are not
      // supported. Fall through to emit the full unfiltered result.
    }
  }

  // Build FormatOptions for formatSuccess (now emits canonical CliEnvelope shape).
  const formatOpts: FormatOptions = {};
  if (opts.operation) formatOpts.operation = opts.operation;
  if (opts.page) formatOpts.page = opts.page;
  if (opts.extensions) formatOpts.extensions = opts.extensions;
  if (fieldCtx.mvi) formatOpts.mvi = fieldCtx.mvi;

  // Phase 6 — LAFS envelope validation middleware.
  // Every CLI output flows through `formatSuccess()` → string. We parse the
  // string, assert the shape invariants, and only emit if validation passes.
  // A shape violation is a CLEO developer bug, so we:
  //   1. Emit a valid LAFS error envelope to stderr describing the violation
  //   2. Set process.exitCode to ExitCode.LAFS_VIOLATION (104)
  //   3. Still emit the (invalid) original to stdout so operators can inspect
  // This is a safety net — it never SILENTLY swallows output.
  const envelopeString = formatSuccess(
    filteredData,
    opts.message,
    Object.keys(formatOpts).length > 0 ? formatOpts : opts.operation,
  );

  if (process.env['CLEO_LAFS_VALIDATE'] !== 'off') {
    try {
      const report = validateLafsShape(envelopeString);
      if (report.reasons.length > 0) {
        emitLafsViolation(
          new LafsViolationError(`cliOutput: envelope failed LAFS shape validation`, report),
        );
      }
    } catch (err) {
      if (err instanceof LafsViolationError) {
        emitLafsViolation(err);
      }
      // Non-validator errors — re-raise so tests can see them
    }
  }

  process.stdout.write(envelopeString + '\n');
}

/**
 * Error details for structured error output.
 *
 * Carries the full LAFS-compatible error context forwarded by the dispatch
 * adapter from {@link DispatchError}. All fields are optional — only present
 * fields are emitted in the output envelope.
 *
 * @see packages/cleo/src/dispatch/types.ts DispatchError
 */
export interface CliErrorDetails {
  /** Machine-readable error code name (e.g. `E_NOT_FOUND`). */
  name?: string;
  /** Additional structured details from the error. */
  details?: unknown;
  /** Copy-paste fix hint for the operator or agent. */
  fix?: unknown;
  /** Alternative actions the caller can try. */
  alternatives?: Array<{ action: string; command: string }>;
}

/**
 * Output an error in the resolved format.
 *
 * In JSON format (default / agent mode): emits a canonical `CliEnvelope` error
 * envelope to stdout. The envelope always includes `meta` (ADR-039).
 * All optional fields (`codeName`, `fix`, `alternatives`, `details`) are
 * included only when they are actually present — no `undefined` keys are emitted.
 *
 * In human format: prints a plain error line to stderr and, when
 * `details.fix` is a string, appends a `Fix: <hint>` line.
 *
 * @param message - Human-readable error message.
 * @param code    - Numeric exit code or string error code.
 * @param details - Optional structured details (codeName, fix, alternatives, …).
 * @param meta    - Optional partial meta to merge into the error envelope.
 *
 * @task T4666
 * @task T4813
 * @task T336
 * @task T338
 */
export function cliError(
  message: string,
  code?: number | string,
  details?: CliErrorDetails,
  meta?: Partial<CliMeta>,
): void {
  const ctx = getFormatContext();

  if (ctx.format === 'human') {
    process.stderr.write(`Error: ${message}${code ? ` (${code})` : ''}\n`);
    if (typeof details?.fix === 'string') {
      process.stderr.write(`Fix: ${details.fix}\n`);
    }
    return;
  }

  // JSON envelope always goes to stdout for consistent machine-readable output.
  // Build the error object incrementally so that absent optional fields are
  // never serialised as `undefined` (which JSON.stringify would strip anyway,
  // but being explicit keeps the intent clear and avoids lint warnings).
  const errorObj: Record<string, unknown> = {
    code: code ?? 1,
    message,
  };

  if (details?.name !== undefined) errorObj['codeName'] = details.name;
  if (details?.fix !== undefined) errorObj['fix'] = details.fix;
  if (details?.alternatives !== undefined) errorObj['alternatives'] = details.alternatives;
  if (details?.details !== undefined) errorObj['details'] = details.details;

  // Canonical error envelope: {success, error, meta} — meta is ALWAYS present.
  // Merge caller-supplied meta with defaults (ADR-039).
  const errorMeta: CliMeta = {
    operation: meta?.operation ?? 'cli.error',
    requestId: meta?.requestId ?? generateRequestId(),
    duration_ms: meta?.duration_ms ?? 0,
    timestamp: meta?.timestamp ?? new Date().toISOString(),
    ...meta,
  };

  const envelope: CliEnvelope<never> = {
    success: false,
    error: errorObj as import('@cleocode/lafs').CliEnvelopeError,
    meta: errorMeta,
  };

  process.stdout.write(JSON.stringify(envelope) + '\n');
}
