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
import {
  autoRecordDispatchTokenUsage,
  describeOperation,
  getProjectRoot,
  hooks,
} from '@cleocode/core/internal';
import { createDispatchSpinner } from '../../cli/animation-bridge.js';
import { isDescribeMode } from '../../cli/describe-context.js';
import { getIdempotencyKeyContext } from '../../cli/idempotency-context.js';
import { type CliOutputOptions, cliError, cliOutput } from '../../cli/renderers/index.js';
import { Dispatcher } from '../dispatcher.js';
import { createDomainHandlers } from '../domains/index.js';
import { createAudit } from '../middleware/audit.js';
import { createBudgetEnforcement } from '../middleware/budget-enforcement.js';
import { createFieldFilter } from '../middleware/field-filter.js';
import { createIdempotency } from '../middleware/idempotency.js';
import { createMutateMinimalEnvelope } from '../middleware/mutate-minimal-envelope.js';
import { createMviRecordProjection } from '../middleware/mvi-record-projection.js';
import { createSanitizer } from '../middleware/sanitizer.js';
import { createSessionResolver } from '../middleware/session-resolver.js';
import { createTelemetry } from '../middleware/telemetry.js';
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
  // T9796 — docs canon CI gate: violation = fail-build, invalid = tool-error.
  E_CANON_VIOLATION: 1,
  E_CANON_INVALID: 2,
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
 * Best-effort lookup of the current session ID for CLI commands.
 *
 * T11344 (Epic T11284) — env-first resolution. The canonical
 * `resolveSessionIdFromEnv()` is consulted BEFORE `getActiveSession()` so a
 * short-lived `cleo` call inside a spawned agent's worktree resolves THAT
 * agent's `CLEO_SESSION_ID` (injected by spawn isolation, T11343) rather than
 * collapsing onto the orchestrator's most-recent active row. The DB lookup is
 * the fallback only when no session env var is set. This single env-first
 * precedence is shared with the session-resolver + audit middleware — no
 * duplicated precedence logic.
 *
 * Returns null on any failure (many CLI commands don't need a session).
 *
 * @epic T4959
 * @task T11344
 */
async function lookupCliSession(): Promise<string | null> {
  try {
    const { resolveSessionIdFromEnv, getActiveSession } = await import('@cleocode/core/internal');
    // Env-first: the spawned agent's own session id wins over the DB's
    // most-recent active row (the session-bleed root cause).
    const fromEnv = resolveSessionIdFromEnv();
    if (fromEnv) return fromEnv;
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
      // T9922 (Saga T9855 / E8.3): MVI record projection default for read ops.
      // Runs AFTER the domain handler returns so it can trim the data payload
      // before audit + telemetry record byte sizes. Sits before audit so the
      // audit trail captures the projected (final) bytes.
      createMviRecordProjection(),
      // T9931 (Saga T9855 / E9.4): minimal envelopes for mutate ops. Mirror
      // policy to the read-side projection — sits in the same pre-audit slot
      // so audit/telemetry record the trimmed bytes.
      createMutateMinimalEnvelope(),
      // T11350 (Epic T11285 EP-MVI-PRIMITIVE): LIVE MVI token-budget chokepoint.
      // Runs AFTER projection/minimal-envelope (measures the trimmed payload)
      // and BEFORE audit/telemetry (so they record the final budget-enforced
      // bytes). Enforces per-op ceilings from BUDGET_POLICIES (e.g. focus ≤1500).
      createBudgetEnforcement(),
      createAudit(), // T4959: CLI now gets audit trail
      createIdempotency(), // T10600: duplicate retry protection after audit wraps the response
      createTelemetry(), // T624: opt-in self-improvement telemetry
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
// --describe short-circuit (T11692 / DHQ-057)
// ---------------------------------------------------------------------------

/**
 * When the global `--describe` flag is active, emit the operation's INPUT +
 * OUTPUT contract as a LAFS envelope (per ADR-086: one envelope to stdout) and
 * return `true` to signal the caller to SKIP dispatch entirely.
 *
 * This is the introspection affordance behind `cleo <op> --describe`: instead
 * of running the operation, an agent receives the declared result shape and the
 * exact valid `--field` JSON pointers (e.g. `/data/task/title`), eliminating the
 * trial-and-error that previously produced `E_FIELD_NOT_FOUND`.
 *
 * @param gateway - CQRS gateway of the operation about to be dispatched.
 * @param domain - Canonical domain of the operation.
 * @param operation - Operation name.
 * @param outputOpts - The caller's CLI output options (command label, etc.).
 * @returns `true` when a describe envelope was emitted (caller must return),
 *          `false` when normal dispatch should proceed.
 *
 * @task T11692
 */
export function maybeEmitDescribe(
  gateway: Gateway,
  domain: string,
  operation: string,
  outputOpts?: CliOutputOptions,
): boolean {
  if (!isDescribeMode()) return false;

  const key = `${domain}.${operation}`;
  const descriptor = describeOperation(key);
  const command = outputOpts?.command ?? operation;

  if (descriptor === null) {
    cliOutput(
      { operation: key, gateway, inputContract: null, outputContract: null },
      {
        command,
        operation: `describe.${key}`,
        message: `No registered operation found for "${key}".`,
      },
    );
    return true;
  }

  cliOutput(descriptor, {
    command,
    operation: `describe.${key}`,
    message: `Schema for ${key} (input + output). Use the outputContract.fieldPointers for --field.`,
  });
  return true;
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
  // T11692 (DHQ-057) — `--describe` short-circuit: print the op's I/O schema
  // envelope and skip execution. Runs BEFORE the dispatcher/session is touched
  // so introspection works with no DB or active session.
  if (maybeEmitDescribe(gateway, domain, operation, outputOpts)) return;

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

  // Spinner is silent on --json/--quiet/non-TTY/NO_COLOR — no branching needed.
  const spinner = createDispatchSpinner(domain, operation);
  spinner.start();

  let response: DispatchResponse;
  const mergedParams = mergeIdempotencyParam(gateway, params);
  try {
    response = await dispatcher.dispatch({
      gateway,
      domain,
      operation,
      params: mergedParams,
      source: 'cli',
      requestId: randomUUID(),
    });
  } finally {
    spinner.stop();
  }

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
      requestPayload: mergedParams,
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
    // T9393: auto-forward decorator-stamped meta fields (e.g. `_nexus`,
    // `deprecated`) so JSON consumers see what the dispatcher decorators
    // attached. Callers can still pass `responseMeta` explicitly to override.
    if (opts.responseMeta === undefined) {
      opts.responseMeta = response.meta;
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
        ...(response.meta.originSessionId
          ? { originSessionId: response.meta.originSessionId }
          : {}),
        ...(response.meta.executionSessionId
          ? { executionSessionId: response.meta.executionSessionId }
          : {}),
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
      ...(response.meta.originSessionId ? { originSessionId: response.meta.originSessionId } : {}),
      ...(response.meta.executionSessionId
        ? { executionSessionId: response.meta.executionSessionId }
        : {}),
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

  const spinner = createDispatchSpinner(domain, operation);
  spinner.start();

  let response: DispatchResponse;
  const mergedParams = mergeIdempotencyParam(gateway, params);
  try {
    response = await dispatcher.dispatch({
      gateway,
      domain,
      operation,
      params: mergedParams,
      source: 'cli',
      requestId: randomUUID(),
    });
  } finally {
    spinner.stop();
  }

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

function mergeIdempotencyParam(
  gateway: Gateway,
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (gateway !== 'mutate') return params;
  const idempotencyKey = getIdempotencyKeyContext();
  if (!idempotencyKey || params?.['idempotencyKey'] !== undefined) return params;
  return { ...(params ?? {}), idempotencyKey };
}
