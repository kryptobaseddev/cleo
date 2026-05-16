/**
 * Thin Anthropic SDK client factory — D-ph4-01 grep-guard compliance.
 *
 * Provides `buildAnthropicClient` as a lightweight factory that keeps all
 * `new Anthropic(...)` construction inside the `transports/` directory
 * (D-ph4-01 invariant from T9356). This module is intentionally free of
 * transitive imports that would bring in `structured-output.ts` or other
 * heavy dependencies, so that `role-resolver.ts` can import it without
 * pulling in the full transport stack.
 *
 * @module llm/transports/anthropic-client-factory
 * @task T9356 (D-ph4-01 factory retirement — relocate new Anthropic() to transports/)
 */

import { Anthropic } from '@anthropic-ai/sdk';

/**
 * Build a raw Anthropic SDK client from a resolved credential.
 *
 * Centralises all `new Anthropic(...)` construction outside `AnthropicTransport`
 * so that D-ph4-01 grep guards stay clean: no `new Anthropic` outside transports/.
 * This is the canonical path for callers that need a raw `Anthropic` instance
 * (e.g. `resolveLLMForRole` for the memory/deriver/sentient direct-API path).
 *
 * @param credential - Resolved credential with apiKey and authType.
 * @param credential.apiKey - API key or OAuth bearer token.
 * @param credential.authType - `'oauth'` or `'api_key'` (or any other string).
 * @returns Constructed Anthropic SDK client. Returns `null` when apiKey is falsy.
 *
 * @task T9356 (D-ph4-01 factory retirement)
 */
export function buildAnthropicClient(credential: {
  apiKey: string | null | undefined;
  authType?: string | null;
}): Anthropic | null {
  if (!credential.apiKey) return null;
  if (credential.authType === 'oauth') {
    return new Anthropic({
      authToken: credential.apiKey,
      timeout: 600_000,
      defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    });
  }
  return new Anthropic({ apiKey: credential.apiKey, timeout: 600_000 });
}
