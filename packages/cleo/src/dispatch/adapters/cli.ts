/**
 * CLI Adapter for the CQRS Dispatch Layer.
 *
 * Provides dispatchFromCli() — the single entry point for all CLI commands
 * that route through the dispatch pipeline. Also exports getCliDispatcher()
 * for commands needing custom output handling.
 *
 * @epic T4820
 * @task T4818
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, registerSkillLibraryFromPath } from '@cleocode/caamp';
import { autoRecordDispatchTokenUsage, getProjectRoot, hooks } from '@cleocode/core/internal';
import { type CliOutputOptions, cliError, cliOutput } from '../../cli/renderers/index.js';
import { Dispatcher } from '../dispatcher.js';
import { createDomainHandlers } from '../domains/index.js';
import { createAudit } from '../middleware/audit.js';
import { createFieldFilter } from '../middleware/field-filter.js';
import { createSanitizer } from '../middleware/sanitizer.js';
import { createSessionResolver } from '../middleware/session-resolver.js';
import type { DispatchResponse, Gateway } from '../types.js';

// Reverse mapping from string error codes to numeric exit codes.
// Used when dispatch handlers return string error codes without exitCode.
const ERROR_CODE_TO_EXIT: Record<string, number> = {
  E_NOT_FOUND: 4,
  E_INVALID_INPUT: 2,
  E_FILE_ERROR: 3,
  E_DEPENDENCY: 5,
  E_VALIDATION: 6,
  E_RETRYABLE: 7,
  E_CONFIG_ERROR: 8,
  E_PARENT_NOT_FOUND: 10,
  E_DEPTH_EXCEEDED: 11,
  E_SIBLING_LIMIT: 12,
  E_CIRCULAR_DEP: 14,
  E_INVALID_PARENT_TYPE: 13,
  E_ORPHAN_DETECTED: 15,
  E_HAS_CHILDREN: 16,
  E_TASK_COMPLETED: 17, // ExitCode.TASK_COMPLETED — canonical value from @cleocode/contracts
  E_HAS_DEPENDENTS: 19,
  E_CHECKSUM_MISMATCH: 20,
  E_SESSION_EXISTS: 30,
  E_SESSION_NOT_FOUND: 31,
  E_SCOPE_CONFLICT: 32,
  E_ACTIVE_TASK_REQUIRED: 38,
  E_INVALID_OPERATION: 2,
  E_MISSING_PARAMS: 2,
  E_NO_HANDLER: 1,
  E_INTERNAL: 1,
};

// ---------------------------------------------------------------------------
// CAAMP skill library auto-registration
// ---------------------------------------------------------------------------

/**
 * Best-effort registration of the CAAMP skill library.
 *
 * Resolves the `@cleocode/skills` package via Node module resolution,
 * falling back to workspace monorepo path. Non-fatal: if the library
 * cannot be found, catalog-dependent operations (skills validate/dispatch/deps)
 * will return a helpful error instead of crashing.
 */
function ensureCaampLibrary(): void {
  // Already registered (e.g. via `cleo init` or env var) — nothing to do
  if (catalog.isCatalogAvailable()) return;

  try {
    // Strategy 1: resolve @cleocode/skills via Node module resolution
    let skillsRoot: string | null = null;
    try {
      const req = createRequire(import.meta.url);
      const skillsPkgJson = req.resolve('@cleocode/skills/package.json');
      const candidate = dirname(skillsPkgJson);
      if (existsSync(join(candidate, 'skills.json'))) {
        skillsRoot = candidate;
      }
    } catch {
      // Not resolvable — try fallback
    }

    // Strategy 2: workspace monorepo path (packages/skills/)
    if (!skillsRoot) {
      const thisFile = fileURLToPath(import.meta.url);
      const packageRoot = join(dirname(thisFile), '..', '..', '..', '..', '..');
      const candidate = join(packageRoot, 'packages', 'skills');
      if (existsSync(join(candidate, 'skills.json'))) {
        skillsRoot = candidate;
      }
    }

    if (skillsRoot) {
      registerSkillLibraryFromPath(skillsRoot);
    }
  } catch {
    // Non-fatal — catalog operations will degrade gracefully
  }
}

// ---------------------------------------------------------------------------
// Lazy singleton dispatcher
// ---------------------------------------------------------------------------

let _dispatcher: Dispatcher | null = null;

/**
 * Get or create the singleton CLI dispatcher.
 *
 * Creates a Dispatcher with all 9 domain handlers and sanitizer middleware.
 * No rate limiter — CLI is a single-user tool.
 */
export function getCliDispatcher(): Dispatcher {
  if (!_dispatcher) {
    _dispatcher = createCliDispatcher();
  }
  return _dispatcher;
}

/**
 * Best-effort lookup of the active session ID from SQLite.
 * Used by session-resolver middleware for CLI commands.
 * Returns null on any failure (many CLI commands don't need a session).
 *
 * @epic T4959
 */
async function lookupCliSession(): Promise<string | null> {
  try {
    const { getActiveSession } = await import('@cleocode/core/internal');
    const session = await getActiveSession();
    return session?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Factory: creates a Dispatcher with all domain handlers + session-resolver,
 * sanitizer, field-filter, and audit middleware.
 *
 * @epic T4959 — added session-resolver + audit to CLI pipeline
 */
export function createCliDispatcher(): Dispatcher {
  // Ensure the CAAMP skill catalog is available for tools domain operations
  ensureCaampLibrary();

  const handlers = createDomainHandlers();
  return new Dispatcher({
    handlers,
    middlewares: [
      createSessionResolver(lookupCliSession), // T4959: session identity first
      createSanitizer(() => getProjectRoot()),
      createFieldFilter(),
      createAudit(), // T4959: CLI now gets audit trail
    ],
  });
}

/**
 * Reset the singleton dispatcher (for testing).
 */
export function resetCliDispatcher(): void {
  _dispatcher = null;
}

// ---------------------------------------------------------------------------
// Main adapter function
// ---------------------------------------------------------------------------

/**
 * Build a DispatchRequest, dispatch it, and handle output/errors.
 *
 * This is the primary entry point for migrated CLI commands:
 *   await dispatchFromCli('query', 'tasks', 'show', { taskId }, { command: 'show' });
 *
 * Automatically honors global --field/--fields/--mvi flags from the FieldContext:
 * - --field <name>   → plain-text extraction, no JSON envelope
 * - --fields <list>  → field-filter middleware filters the JSON response
 * - --mvi <level>    → envelope verbosity passed to field-filter middleware
 *
 * On success: calls cliOutput(response.data, outputOpts)
 * On error: calls cliError(message, exitCode) + process.exit(exitCode)
 *
 * @epic T4953
 * @task T4955
 */
export async function dispatchFromCli(
  gateway: Gateway,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
  outputOpts?: CliOutputOptions,
): Promise<void> {
  const dispatcher = getCliDispatcher();
  const projectRoot = getProjectRoot();
  const dispatchStart = Date.now();

  // Dispatch PromptSubmit hook (best-effort, fire-and-forget)
  hooks
    .dispatch('PromptSubmit', projectRoot, {
      timestamp: new Date().toISOString(),
      gateway,
      domain,
      operation,
      source: 'cli',
    })
    .catch(() => {
      /* hook errors are non-fatal */
    });

  const response = await dispatcher.dispatch({
    gateway,
    domain,
    operation,
    params,
    source: 'cli',
    requestId: randomUUID(),
  });

  // Dispatch ResponseComplete hook (best-effort, fire-and-forget)
  hooks
    .dispatch('ResponseComplete', projectRoot, {
      timestamp: new Date().toISOString(),
      gateway,
      domain,
      operation,
      success: response.success,
      durationMs: Date.now() - dispatchStart,
      errorCode: response.error?.code,
    })
    .catch(() => {
      /* hook errors are non-fatal */
    });

  if (response.success) {
    await autoRecordDispatchTokenUsage({
      requestPayload: params,
      responsePayload: { data: response.data, page: response.page },
      transport: 'cli',
      gateway,
      domain,
      operation,
      sessionId: response.meta.sessionId,
      requestId: response.meta.requestId,
      cwd: getProjectRoot(),
    });

    const opts: CliOutputOptions = {
      command: outputOpts?.command ?? operation,
      operation: outputOpts?.operation ?? `${domain}.${operation}`,
      ...outputOpts,
    };
    if (opts.page === undefined && response.page !== undefined) {
      opts.page = response.page;
    }
    cliOutput(response.data, opts);
  } else {
    // Derive exit code from the string error code when exitCode is not set
    const errorCode = response.error?.code ?? 'E_GENERAL';
    const exitCode = response.error?.exitCode ?? ERROR_CODE_TO_EXIT[errorCode] ?? 1;
    cliError(
      response.error?.message ?? 'Unknown error',
      exitCode,
      {
        name: errorCode,
        details: response.error?.details,
        fix: response.error?.fix,
        alternatives: response.error?.alternatives,
      },
      {
        operation: `${domain}.${operation}`,
        requestId: response.meta.requestId,
        duration_ms: response.meta.duration_ms,
        timestamp: response.meta.timestamp,
        ...(response.meta.sessionId ? { sessionId: response.meta.sessionId } : {}),
      },
    );
    process.exit(exitCode);
  }
}

/**
 * Handle an error response from dispatchRaw().
 *
 * Calls cliError() and process.exit() when the response indicates failure.
 * No-op when response.success is true.
 */
export function handleRawError(
  response: DispatchResponse,
  _opts: { command: string; operation: string },
): void {
  if (response.success) return;
  const errorCode = response.error?.code ?? 'E_GENERAL';
  const exitCode = response.error?.exitCode ?? ERROR_CODE_TO_EXIT[errorCode] ?? 1;
  cliError(
    response.error?.message ?? 'Unknown error',
    exitCode,
    {
      name: errorCode,
      details: response.error?.details,
      fix: response.error?.fix,
      alternatives: response.error?.alternatives,
    },
    {
      operation: _opts.operation,
      requestId: response.meta.requestId,
      duration_ms: response.meta.duration_ms,
      timestamp: response.meta.timestamp,
      ...(response.meta.sessionId ? { sessionId: response.meta.sessionId } : {}),
    },
  );
  process.exit(exitCode);
}

/**
 * Dispatch and return the raw response without handling output.
 *
 * For commands that need custom output logic (pagination, conditional
 * messages, etc.), call this instead of dispatchFromCli().
 */
export async function dispatchRaw(
  gateway: Gateway,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
): Promise<DispatchResponse> {
  const dispatcher = getCliDispatcher();
  const projectRoot = getProjectRoot();
  const dispatchStart = Date.now();

  // Dispatch PromptSubmit hook (best-effort, fire-and-forget)
  hooks
    .dispatch('PromptSubmit', projectRoot, {
      timestamp: new Date().toISOString(),
      gateway,
      domain,
      operation,
      source: 'cli',
    })
    .catch(() => {
      /* hook errors are non-fatal */
    });

  const response = await dispatcher.dispatch({
    gateway,
    domain,
    operation,
    params,
    source: 'cli',
    requestId: randomUUID(),
  });

  // Dispatch ResponseComplete hook (best-effort, fire-and-forget)
  hooks
    .dispatch('ResponseComplete', projectRoot, {
      timestamp: new Date().toISOString(),
      gateway,
      domain,
      operation,
      success: response.success,
      durationMs: Date.now() - dispatchStart,
      errorCode: response.error?.code,
    })
    .catch(() => {
      /* hook errors are non-fatal */
    });

  return response;
}
