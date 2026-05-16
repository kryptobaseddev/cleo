/**
 * Builtin provider profile for AWS Bedrock (Converse API).
 *
 * AWS Bedrock exposes many foundation models through a uniform Converse API.
 * This profile covers the common model ID prefixes:
 * - `anthropic.claude-*` — Anthropic Claude models on Bedrock
 * - `amazon.nova-*`      — Amazon Nova series
 * - `mistral.mistral-*`  — Mistral AI models on Bedrock
 * - `meta.llama*`        — Meta Llama models on Bedrock
 * - `cohere.command-*`   — Cohere Command models on Bedrock
 *
 * Credential auth for Bedrock uses the standard AWS credential chain
 * (`fromNodeProviderChain`), not an API key. The `authTypes: ['aws_sdk']`
 * declaration is informational — the actual resolution happens inside
 * `BedrockTransport` via the AWS SDK credential chain.
 *
 * @task T9317
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import type { ProviderProfile } from '@cleocode/contracts';

/**
 * AWS Bedrock provider profile.
 *
 * - `authTypes` is `['aws_sdk']` — informational for the credential store
 *   UI. Actual resolution uses `fromNodeProviderChain()` inside the transport.
 * - `fetchModels` is omitted — the Bedrock model catalog is large and
 *   region-specific. Use `cleo llm refresh-catalog` (T9314) for discovery.
 * - `defaultModel` targets Claude Sonnet 3.7, widely available across regions.
 */
export const bedrockProfile: ProviderProfile = {
  name: 'bedrock',
  displayName: 'AWS Bedrock',
  authTypes: ['aws_sdk'],
  baseUrl: 'https://bedrock-runtime.{region}.amazonaws.com',
  defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  aliases: ['aws-bedrock', 'bedrock-converse'],
};
