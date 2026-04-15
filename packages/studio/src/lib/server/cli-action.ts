/**
 * Shared error-handling helper for CLI-invoking endpoints.
 *
 * Wraps spawn-cli calls and returns structured LAFS-compliant error envelopes
 * per ADR-039. All CLI subprocess errors return 4xx (client/input error), not 5xx.
 *
 * @task T722
 */

import { json } from '@sveltejs/kit';
import { runCleoCli } from './spawn-cli.js';

/**
 * HTTP response returned by a CLI action handler.
 *
 * @template _T - Type of successful response data (unused, reserved for type annotation).
 */
export type CliActionResponse<_T = Record<string, unknown>> = Response;

/**
 * Options for wrapping a CLI command.
 */
export interface CliActionOptions {
  /** Specific error code (e.g., 'E_INDEX_FAILED'). Defaults to 'CLI_FAILURE'. */
  errorCode?: string;
  /** Optional metadata to include in the response. */
  meta?: Record<string, unknown>;
}

/**
 * Wraps a `cleo` CLI command and returns a structured LAFS error envelope on failure.
 *
 * On CLI failure (non-zero exit), returns **4xx** with `{ success: false, error, meta }`.
 * On CLI success, returns **2xx** with the CLI's JSON envelope (or `{ success: true }`).
 *
 * @param args - Arguments for `cleo` CLI (e.g., `['nexus', 'analyze', '/path', '--json']`).
 * @param options - Error code and metadata options.
 * @returns A SvelteKit JSON response (2xx on success, 4xx on failure).
 *
 * @example
 * ```ts
 * const result = await executeCliAction(['nexus', 'analyze', projectPath, '--json'], {
 *   errorCode: 'E_INDEX_FAILED',
 *   meta: { projectId: 'proj-123' },
 * });
 * return result;
 * ```
 */
export async function executeCliAction(
  args: string[],
  options: CliActionOptions = {},
): Promise<CliActionResponse> {
  const { errorCode = 'CLI_FAILURE', meta } = options;

  const result = await runCleoCli(args);

  if (!result.ok) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'CLI command failed';
    return json(
      {
        success: false,
        error: {
          code: errorCode,
          message: reason,
        },
        meta: {
          exitCode: result.exitCode,
          ...meta,
        },
      },
      { status: 400 }, // 4xx for CLI input/state errors, not 5xx
    );
  }

  // Return the CLI's own envelope on success, or a minimal success envelope
  return json(result.envelope ?? { success: true, data: {}, meta });
}
