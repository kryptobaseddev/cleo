/**
 * Route the AI SDK's warning output through CLEO's logger instead of the
 * console (T12142 · GH #1223).
 *
 * Why this exists
 * ---------------
 * `ai@6`'s `logWarnings` writes its one-time banner with `console.info`, which
 * in Node goes to **stdout**:
 *
 * ```js
 * // node_modules/ai/dist/index.mjs
 * console.info(FIRST_WARNING_INFO_MESSAGE);   // stdout  <- breaks ADR-086
 * for (const warning of options.warnings) {
 *   console.warn(formatWarning({ … }));       // stderr  <- fine
 * }
 * ```
 *
 * ADR-086 states stdout is ONE LAFS envelope per call and all logs go to
 * stderr. That banner lands AFTER the envelope, so parsing the whole of stdout
 * as JSON fails outright. Measured on `cleo update`:
 *
 * ```
 * stdout line 0: {"success":true,"data":{"count":1,"updated":["T12142"],…
 * stdout line 1: AI SDK Warning System: To turn off warning logging, set the
 *                AI_SDK_LOG_WARNINGS global to false.
 *   -> json.loads(stdout): Extra data: line 2 column 1
 * ```
 *
 * Any consumer parsing stdout — which the `--field` contract actively
 * encourages — has to skip lines first, which is the exact
 * "pipe through tail/jq" anti-pattern ADR-086 forbids.
 *
 * Why a handler rather than `AI_SDK_LOG_WARNINGS = false`
 * ------------------------------------------------------
 * Disabling would satisfy the contract by destroying the information. These
 * warnings are real — the one that surfaced this said
 * `responseFormat is not supported` for `ollama.chat/qwen2.5-coder:3b`, which
 * is worth knowing when a local model silently ignores a JSON-schema request.
 * The SDK's global accepts a FUNCTION, so the warnings are kept and merely
 * moved to where they belong.
 *
 * @task T12142
 */

import { getLogger } from '../logger.js';

/** Shape `ai@6` passes to a custom `AI_SDK_LOG_WARNINGS` function. */
interface AiSdkWarningPayload {
  warnings: readonly unknown[];
  provider?: string;
  model?: string;
}

let installed = false;

/**
 * Install the CLEO warning handler on `globalThis.AI_SDK_LOG_WARNINGS`.
 *
 * Idempotent, and never overwrites a handler an embedder has already set —
 * a host application that configured its own routing keeps it.
 *
 * @returns `true` when this call installed the handler.
 */
export function installAiSdkWarningHandler(): boolean {
  if (installed) return false;
  const g = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: unknown };
  // Respect an explicit prior choice (a handler, or `false` to silence).
  if (g.AI_SDK_LOG_WARNINGS !== undefined) {
    installed = true;
    return false;
  }
  g.AI_SDK_LOG_WARNINGS = (payload: AiSdkWarningPayload): void => {
    const log = getLogger('llm:ai-sdk');
    for (const warning of payload.warnings) {
      log.warn(
        {
          provider: payload.provider,
          model: payload.model,
          warning:
            typeof warning === 'object' && warning !== null && 'message' in warning
              ? (warning as { message: unknown }).message
              : warning,
        },
        'AI SDK warning',
      );
    }
  };
  installed = true;
  return true;
}

/** Test seam — forget that the handler was installed. @internal */
export function resetAiSdkWarningHandlerForTests(): void {
  installed = false;
  delete (globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS;
}
