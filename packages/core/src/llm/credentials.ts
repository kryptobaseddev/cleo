/**
 * Credential resolution for the CLEO LLM layer.
 *
 * Ported from Honcho src/llm/credentials.py. Resolves API keys for each
 * provider transport from environment variables. Imports the existing
 * anthropic-key-resolver for compatibility with the existing extraction pipeline.
 *
 * @task T1394 (T1386-W8)
 * @epic T1386
 */

import type { ModelConfig, ModelTransport } from './types-config.js';

/**
 * Resolve credentials for the effective model transport.
 * Returns {apiKey, apiBase} pair where null means "use SDK default".
 */
export function resolveCredentials(config: ModelConfig): {
  apiKey: string | null;
  apiBase: string | null;
} {
  const defaultApiKey = defaultTransportApiKey(config.transport);
  return {
    apiKey: config.apiKey ?? defaultApiKey,
    apiBase: config.baseUrl ?? null,
  };
}

/**
 * Fall back to the global LLM API key for the matching transport.
 * Reads from environment variables.
 */
export function defaultTransportApiKey(transport: ModelTransport): string | null {
  switch (transport) {
    case 'anthropic':
      return process.env['ANTHROPIC_API_KEY'] ?? null;
    case 'openai':
      return process.env['OPENAI_API_KEY'] ?? null;
    case 'gemini':
      return process.env['GEMINI_API_KEY'] ?? null;
    default:
      throw new Error(`Unknown transport: ${transport as string}`);
  }
}
