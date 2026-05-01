/**
 * Moonshot AI provider backend (Kimi K2 coding model).
 *
 * Moonshot AI exposes an OpenAI-compatible REST API at
 * https://api.moonshot.ai/v1. This backend DELEGATES all wire-format
 * logic to OpenAIBackend — the only Moonshot-specific concerns are:
 *   - Fixed baseURL for the Moonshot API endpoint
 *   - Model name validation (kimi-k2-0905-preview and kimi-* variants)
 *   - Rejection of thinking-budget tokens (not supported by Moonshot API)
 *
 * Default model: kimi-k2-0905-preview (Kimi K2 coding model).
 *
 * Wire protocol: OpenAI-compatible (Chat Completions v1).
 * Auth: MOONSHOT_API_KEY environment variable.
 *
 * @task T1678 (T-LW-W2)
 * @epic T1676
 */

import type { OpenAI } from 'openai';

import type {
  BackendCallParams,
  CompletionResult,
  ProviderBackend,
  StreamChunk,
} from '../backend.js';
import { OpenAIBackend } from './openai.js';

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

/**
 * MoonshotBackend — delegates to OpenAIBackend with a Moonshot-specific
 * OpenAI client (custom baseURL, Moonshot API key).
 *
 * Moonshot's wire format is OpenAI-compatible (Chat Completions v1), so
 * no additional conversion is needed beyond what OpenAIBackend already
 * provides. This class is intentionally thin — DRY over duplicating the
 * entire OpenAI request-building and response-normalization logic.
 */
export class MoonshotBackend implements ProviderBackend {
  private readonly _delegate: OpenAIBackend;

  /**
   * @param client - OpenAI SDK client configured for api.moonshot.ai/v1.
   *   Callers MUST set `baseURL` to {@link MOONSHOT_BASE_URL} and supply
   *   the Moonshot API key as `apiKey`.
   */
  constructor(client: OpenAI) {
    this._delegate = new OpenAIBackend(client);
  }

  /**
   * Non-streaming completion via Moonshot's OpenAI-compatible endpoint.
   *
   * Rejects `thinkingBudgetTokens` — Moonshot does not support extended
   * thinking in the same protocol as Anthropic.
   */
  async complete(params: BackendCallParams): Promise<CompletionResult> {
    MoonshotBackend._rejectThinkingBudget(params);
    return this._delegate.complete(params);
  }

  /**
   * Streaming completion via Moonshot's OpenAI-compatible endpoint.
   *
   * Rejects `thinkingBudgetTokens` — Moonshot does not support extended
   * thinking in the same protocol as Anthropic.
   */
  async *stream(params: BackendCallParams): AsyncGenerator<StreamChunk> {
    MoonshotBackend._rejectThinkingBudget(params);
    yield* this._delegate.stream(params);
  }

  /**
   * Guard against callers passing Anthropic-style thinking budget tokens.
   * Moonshot's API does not expose a thinking-budget parameter.
   */
  private static _rejectThinkingBudget(params: BackendCallParams): void {
    if (params.thinkingBudgetTokens !== null && params.thinkingBudgetTokens !== undefined) {
      throw new Error(
        'MoonshotBackend does not support thinkingBudgetTokens; ' +
          'remove thinkingBudgetTokens from the ModelConfig for this provider',
      );
    }
  }
}
