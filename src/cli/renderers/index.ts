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
import { formatSuccess, type FormatOptions } from '../../core/output.js';
import { normalizeForHuman } from './normalizer.js';

// Task renderers
import {
  renderShow, renderList, renderFind, renderAdd,
  renderUpdate, renderComplete, renderDelete, renderArchive, renderRestore,
} from './tasks.js';

// System renderers
import {
  renderDoctor, renderStats, renderNext, renderBlockers,
  renderTree, renderStart, renderStop, renderCurrent,
  renderSession, renderVersion, renderGeneric,
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

  if (ctx.format === 'human') {
    const normalized = normalizeForHuman(opts.command, data as Record<string, unknown>);
    const renderer = renderers[opts.command] ?? renderGeneric;
    const text = renderer(normalized, ctx.quiet);
    if (text) {
      console.log(text);
    }
    return;
  }

  // JSON format (default)
  const formatOpts: FormatOptions = {};
  if (opts.operation) formatOpts.operation = opts.operation;
  if (opts.page) formatOpts.page = opts.page;
  if (opts.extensions) formatOpts.extensions = opts.extensions;

  console.log(formatSuccess(data, opts.message, Object.keys(formatOpts).length > 0 ? formatOpts : opts.operation));
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
