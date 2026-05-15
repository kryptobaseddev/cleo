/**
 * Builtin provider profile for OpenRouter.
 *
 * OpenRouter is a unified API gateway for 100+ LLM providers, accessible at
 * `https://openrouter.ai/api/v1`. It speaks the OpenAI chat completions wire
 * format. The CLEO-specific quirk is the Pareto router plugin block, which
 * selects the price-optimal provider for high-capability model requests.
 *
 * @task T9286 (W1d)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ProviderProfile } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// ProviderProfile
// ---------------------------------------------------------------------------

/**
 * OpenRouter provider profile.
 *
 * Encodes the Pareto plugin routing block as a `buildExtraBody` hook.
 * The plugin is only injected for high-capability model tiers
 * (Sonnet, Opus, Grok, GPT-4) — cheaper models route without it.
 *
 * @task T9286 (W1d)
 */
export const openrouterProfile: ProviderProfile = {
  name: 'openrouter',
  displayName: 'OpenRouter',
  authTypes: ['api_key'],
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openrouter/anthropic/claude-sonnet-4-6',
  aliases: ['open-router'],
  envVars: ['OPENROUTER_API_KEY'],
  defaultHeaders: {
    'HTTP-Referer': 'https://cleocode.dev',
    'X-Title': 'CLEO',
  },

  /**
   * Inject the Pareto price-optimal router plugin for high-capability models.
   *
   * @invariant openrouter-pareto-plugin: OpenRouter routes `openrouter/`-prefixed
   * model requests through the Pareto plugin (`sort: 'price'`) for Sonnet, Opus,
   * Grok, and GPT-4 tiers. The plugin enforces a minimum coding score threshold
   * (0.85) so price-sorting never selects a degraded provider.
   *
   * @param model - The resolved model identifier.
   * @returns Extra body with `plugins` populated for matching models, or empty
   *   object for non-matching models.
   */
  buildExtraBody(model: string): Readonly<Record<string, unknown>> {
    if (model.startsWith('openrouter/') && /sonnet|opus|grok|gpt-4/i.test(model)) {
      return { plugins: [{ id: 'pareto', min_coding_score: 0.85 }] };
    }
    return {};
  },
};
