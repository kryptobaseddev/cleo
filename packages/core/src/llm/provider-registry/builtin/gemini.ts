/**
 * Builtin provider profile for Google Gemini (OpenAI-compat shim).
 *
 * Gemini exposes an OpenAI-compatible shim at
 * `https://generativelanguage.googleapis.com/v1beta/openai` that accepts
 * the standard `chat.completions.create` wire shape. The Gemini-specific
 * quirk is the `extra_body.thinking_config` field which controls extended
 * reasoning budget selection.
 *
 * @task T9286 (W1d)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ProviderProfile } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Gemini thinking config builder (module-private)
// ---------------------------------------------------------------------------

/**
 * Build the Gemini thinking configuration object for `extra_body`.
 *
 * Budget selection:
 * - `'auto'` — Gemini 1.x and 2.x models, and any model with `flash` in the
 *   name (Flash-tier models use dynamic budget allocation).
 * - `'high'` — Gemini 3 Pro and newer high-capability variants that support
 *   explicit budget control without automatic fallback.
 *
 * @invariant gemini-thinking-config: Gemini requires `extra_body.thinking_config`
 * for extended reasoning. Budget is model-aware: 'auto' for ≤2.x/flash,
 * 'high' for ≥3.x non-flash. This quirk is DISTINCT from Moonshot's shallow
 * schema sanitizer and Gemini's own deep schema sanitizer.
 *
 * @param model - Lowercase model identifier string.
 * @returns Thinking config record for `extra_body.thinking_config`.
 */
function buildGeminiThinkingConfig(model: string): Record<string, unknown> {
  // Gemini 3+ Pro models that support explicit 'high' budget
  if (/gemini-3|gemini3/.test(model) && !model.includes('flash')) {
    return { thinking_budget: 'high' };
  }
  // All other Gemini models (1.x, 2.x, flash variants) use 'auto'
  return { thinking_budget: 'auto' };
}

// ---------------------------------------------------------------------------
// ProviderProfile
// ---------------------------------------------------------------------------

/**
 * Google Gemini provider profile (OpenAI-compatible shim).
 *
 * Encodes the Gemini thinking config quirk as a `buildExtraBody` hook.
 *
 * @task T9286 (W1d)
 */
export const geminiProfile: ProviderProfile = {
  name: 'gemini',
  displayName: 'Google Gemini',
  authTypes: ['api_key'],
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  defaultModel: 'gemini-2.0-flash',
  aliases: ['google', 'google-gemini'],
  // Hermes-parity routing/catalog fields (T11756); catalog-sourced under E8.
  tier: 'standard',
  defaultAuxModel: 'gemini-2.0-flash',
  defaultMaxTokens: 4096,
  envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],

  /**
   * Inject `thinking_config` for Gemini's extended reasoning support.
   *
   * @invariant gemini-thinking-config: All Gemini models require a
   * `thinking_config` in `extra_body`. Budget is model-aware — auto for
   * 1.x/2.x/flash, high for 3.x+ non-flash.
   *
   * @invariant gemini-deep-sanitizer-distinct: The Gemini deep schema
   * sanitizer (which recursively cleans JSON schemas for Gemini's strict
   * validator) is SEPARATE from this hook and from the Moonshot shallow
   * sanitizer. They MUST NOT be merged or confused.
   *
   * @param model - The resolved model identifier.
   * @returns Extra body with `thinking_config` populated.
   */
  buildExtraBody(model: string): Readonly<Record<string, unknown>> {
    return { thinking_config: buildGeminiThinkingConfig(model.toLowerCase()) };
  },
};
