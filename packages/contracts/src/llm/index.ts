/**
 * `@cleocode/contracts/llm` — LLM contract subpath barrel.
 *
 * Re-exports the declarative provider contracts so consumers can import from the
 * `./llm` subpath (`@cleocode/contracts/llm`) in addition to the package root.
 * Currently fronts the M3 Provider SSoT {@link ProviderDef} contract (T11702);
 * other `llm/*` modules continue to export from the package root barrel.
 *
 * @module llm
 * @task T11702
 * @epic T11667
 */

export type {
  AiSdkEndpoint,
  AnthropicMessagesEndpoint,
  OAuthFlowDef,
  OpenAICompletionsEndpoint,
  OpenAIResponsesEndpoint,
  ProviderDef,
  ProviderEndpoint,
  ProviderTransport,
  RequestQuirk,
  RequestQuirkKind,
} from './provider-def.js';
export {
  PROVIDER_TRANSPORTS,
  REQUEST_QUIRK_KINDS,
} from './provider-def.js';
