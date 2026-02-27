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

import { getFormatContext } from '../format-context.js';
import { getFieldContext } from '../field-context.js';
import { formatSuccess, type FormatOptions } from '../../core/output.js';
import { normalizeForHuman } from './normalizer.js';
import { extractFieldFromResult, applyFieldFilter } from '@cleocode/lafs-protocol';
import type { LAFSEnvelope } from '@cleocode/lafs-protocol';

// Task renderers
import {
  renderShow, renderList, renderFind, renderAdd,
  renderUpdate, renderComplete, renderDelete, renderArchive, renderRestore,
} from './tasks.js';

// System renderers
import {
  renderDoctor, renderStats, renderNext, renderBlockers,
  renderTree, renderStart, renderStop, renderCurrent,
  renderSession, renderVersion, renderPlan, renderGeneric,
} from './system.js';

// ---------------------------------------------------------------------------
// Renderer registry: maps command name to human renderer function
// ---------------------------------------------------------------------------

type HumanRenderer = (data: Record<string, unknown>, quiet: boolean) => string;

const renderers: Record<string, HumanRenderer> = {
  // Task CRUD
  'show': renderShow,
  'list': renderList,
  'ls': renderList,
  'find': renderFind,
  'search': renderFind,
  'add': renderAdd,
  'update': renderUpdate,
  'complete': renderComplete,
  'done': renderComplete,
  'delete': renderDelete,
  'rm': renderDelete,
  'archive': renderArchive,
  'restore': renderRestore,

  // Task work
  'start': renderStart,
  'stop': renderStop,
  'current': renderCurrent,

  // System
  'doctor': renderDoctor,
  'stats': renderStats,
  'next': renderNext,
  'plan': renderPlan,
  'blockers': renderBlockers,
  'tree': renderTree,
  'depends': renderTree,
  'deps': renderTree,
  'session': renderSession,
  'version': renderVersion,
};

// ---------------------------------------------------------------------------
// Options for cliOutput
// ---------------------------------------------------------------------------

export interface CliOutputOptions {
  /** Command name (used to pick the correct human renderer). */
  command: string;
  /** Optional success message for JSON envelope. */
  message?: string;
  /** Operation name for LAFS _meta. */
  operation?: string;
  /** Pagination for LAFS envelope. */
  page?: FormatOptions['page'];
  /** Extra LAFS extensions. */
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

  // --human wins over all field flags.
  // --field, --fields, and --mvi are JSON-envelope / scripting concepts.
  // When a human is reading the output, render the full data without manipulation.
  if (ctx.format === 'human') {
    const normalized = normalizeForHuman(opts.command, data as Record<string, unknown>);
    const renderer = renderers[opts.command] ?? renderGeneric;
    const text = renderer(normalized, ctx.quiet);
    if (text) {
      console.log(text);
    }
    return;
  }

  // --field: single-field plain text extraction (scripting / agent use).
  // Centralised here so ALL commands (dispatchFromCli and dispatchRaw) honour the flag.
  if (fieldCtx.field) {
    const value = extractFieldFromResult(data as LAFSEnvelope['result'], fieldCtx.field);
    if (value === undefined) {
      cliError(`Field "${fieldCtx.field}" not found`, 4, { name: 'E_NOT_FOUND' });
      process.exit(4);
    }
    const out = (value !== null && typeof value === 'object') ? JSON.stringify(value) : String(value);
    process.stdout.write(out + '\n');
    return;
  }

  // JSON format (default): apply --fields filter, then emit LAFS envelope.
  // Centralised here so ALL commands honour the flag without per-command wiring.
  // applyFieldFilter can throw on unusual mixed-type arrays (e.g. changes: ['status']).
  // In that case we fall back to unfiltered output rather than crashing.
  let filteredData = data;
  if (fieldCtx.fields?.length && data !== undefined && data !== null) {
    try {
      const stub: LAFSEnvelope = {
        $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
        _meta: {} as unknown as LAFSEnvelope['_meta'],
        success: true,
        result: data as LAFSEnvelope['result'],
      };
      const filtered = applyFieldFilter(stub, fieldCtx.fields);
      filteredData = filtered.result;
    } catch {
      // applyFieldFilter limitation: mixed-type arrays (strings inside arrays) are not
      // supported. Fall through to emit the full unfiltered result.
    }
  }

  // Per LAFS §9.1 (v1.5.0 clarification): _meta MUST always be present.
  // --mvi minimal governs result contents only; mvi level is reflected in _meta.mvi.
  const formatOpts: FormatOptions = {};
  if (opts.operation) formatOpts.operation = opts.operation;
  if (opts.page) formatOpts.page = opts.page;
  if (opts.extensions) formatOpts.extensions = opts.extensions;
  if (fieldCtx.mvi) formatOpts.mvi = fieldCtx.mvi;

  console.log(formatSuccess(filteredData, opts.message, Object.keys(formatOpts).length > 0 ? formatOpts : opts.operation));
}

/**
 * Error details for structured error output.
 */
export interface CliErrorDetails {
  name?: string;
  details?: unknown;
  fix?: unknown;
}

/**
 * Output an error in the resolved format.
 * For JSON: delegates to formatError (already handled in command catch blocks).
 * For human: prints a plain error message to stderr.
 *
 * @task T4666
 * @task T4813
 */
export function cliError(message: string, code?: number | string, _details?: CliErrorDetails): void {
  const ctx = getFormatContext();

  if (ctx.format === 'human') {
    console.error(`Error: ${message}${code ? ` (${code})` : ''}`);
    return;
  }

  // JSON: caller already uses formatError, so this is a fallback
  console.error(JSON.stringify({
    success: false,
    error: { code: code ?? 1, message },
  }));
}
