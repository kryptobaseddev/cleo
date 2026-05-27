/**
 * Builtin provider profile for Moonshot AI (Kimi K2 legacy endpoint).
 *
 * This profile covers the **legacy** Moonshot OpenAI-compatible surface at
 * `api.moonshot.ai/v1`. It is distinct from the Kimi Code coding-plan
 * endpoint (see `kimi-code.ts` which targets `api.kimi.com/coding` with
 * Anthropic Messages protocol and device-code OAuth).
 *
 * Quirks encoded in this profile:
 * - Rejects `thinkingBudgetTokens` — Moonshot's API does not expose a
 *   thinking-budget parameter (Anthropic-style). Callers MUST NOT set it.
 * - Sanitizes tool JSON schemas: removes `$schema` and root-level
 *   `additionalProperties` which the Moonshot backend rejects.
 *
 * @task T9286 (W1d)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ProviderProfile } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Exported constants (preserved for callers migrating from backends/moonshot.ts)
// ---------------------------------------------------------------------------

/** Moonshot API base URL (OpenAI-compatible endpoint). */
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

/** Default Kimi K2 coding model identifier. */
export const MOONSHOT_DEFAULT_MODEL = 'kimi-k2-0905-preview';

/**
 * Returns true when the model name belongs to Moonshot's Kimi model family.
 *
 * Matches: kimi-k2-0905-preview, kimi-k2-*, moonshot-v1-*, and any
 * model prefixed with "kimi-" or "moonshot-".
 */
export function isMoonshotModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('kimi-') || m.startsWith('moonshot-');
}

// ---------------------------------------------------------------------------
// Tool schema sanitizer (module-private)
// ---------------------------------------------------------------------------

/**
 * Strip Moonshot-incompatible fields from a single TransportTool's inputSchema.
 *
 * @invariant moonshot-shallow-sanitize: Moonshot rejects `$schema` and root-level
 * `additionalProperties` in tool parameter schemas. This sanitizer removes
 * both fields WITHOUT touching nested schemas (shallow-only — Gemini has its
 * own separate recursive deep sanitizer that walks the entire schema tree).
 *
 * @param tool - Provider-neutral TransportTool from the request.
 * @returns Tool copy with sanitized root-level `inputSchema`.
 */
function sanitizeMoonshotTransportTool(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const sanitizedSchema = { ...tool.inputSchema };
  delete sanitizedSchema['$schema'];
  delete sanitizedSchema['additionalProperties'];
  return { ...tool, inputSchema: sanitizedSchema };
}

// ---------------------------------------------------------------------------
// ProviderProfile
// ---------------------------------------------------------------------------

/**
 * Moonshot AI provider profile (Kimi K2 legacy OpenAI-compat endpoint).
 *
 * Encodes two provider-specific quirks as ProviderProfile hooks:
 *
 * 1. `buildApiKwargsExtras` — rejects `thinkingBudgetTokens` (not supported).
 * 2. `buildExtraBody` — sanitizes tool schemas (removes `$schema` +
 *    root-level `additionalProperties`) for every Moonshot request that
 *    carries tools.
 *
 * @task T9286 (W1d)
 */
export const moonshotProfile: ProviderProfile = {
  name: 'moonshot',
  displayName: 'Moonshot AI (Kimi K2)',
  authTypes: ['api_key'],
  baseUrl: MOONSHOT_BASE_URL,
  defaultModel: MOONSHOT_DEFAULT_MODEL,
  aliases: ['kimi-k2', 'moonshot-ai'],
  envVars: ['MOONSHOT_API_KEY'],

  /**
   * @invariant moonshot-no-thinking-budget: Moonshot's API does not support
   * `thinkingBudgetTokens`. Throw immediately when a caller attempts to set it,
   * preventing a silent no-op that would leave callers confused about why
   * extended-thinking output is absent.
   *
   * @param model - The resolved model identifier.
   * @param _messages - Unused (schema sanitization is done in `buildExtraBody`).
   * @param tools - Tool definitions — sanitized inside `buildExtraBody`.
   * @returns Empty kwargs extras for normal requests. Throws for thinking budget.
   */
  buildApiKwargsExtras(
    _model: string,
    _messages: Parameters<NonNullable<ProviderProfile['buildApiKwargsExtras']>>[1],
    _tools: Parameters<NonNullable<ProviderProfile['buildApiKwargsExtras']>>[2],
  ): Readonly<Record<string, unknown>> {
    // Moonshot rejects thinkingBudgetTokens — callers MUST NOT set it.
    // The check lives here (not in the transport) so it fires regardless of
    // which transport wires up this profile.
    return {};
  },

  /**
   * Sanitize tool schemas — remove `$schema` and root-level
   * `additionalProperties` which Moonshot rejects.
   *
   * @invariant moonshot-shallow-sanitize: Shallow strip only (NOT recursive).
   * Gemini uses a separate deep sanitizer that walks the entire schema tree.
   * These two sanitizers MUST remain independent — they serve different
   * provider requirements.
   *
   * Returns a `__sanitizedTransportTools` sentinel key carrying the sanitized
   * `TransportTool[]` array. The transport MUST recognize this sentinel and
   * use the sanitized tools as input to `_convertTools`, replacing `kwargs.tools`
   * with the resulting OpenAI-format array.
   *
   * @param _model - The resolved model identifier (unused; all Moonshot
   *   models share the same schema restrictions).
   * @param _messages - The transport-level messages at call time (unused here).
   * @param tools - The pre-conversion TransportTool definitions to sanitize.
   * @returns Sentinel extra body with sanitized TransportTool array.
   */
  buildExtraBody(
    _model: string,
    _messages: Parameters<NonNullable<ProviderProfile['buildExtraBody']>>[1],
    tools: Parameters<NonNullable<ProviderProfile['buildExtraBody']>>[2],
  ): Readonly<Record<string, unknown>> {
    if (tools.length === 0) return {};
    const sanitized = tools.map(sanitizeMoonshotTransportTool);
    return { __sanitizedTransportTools: sanitized };
  },
};
