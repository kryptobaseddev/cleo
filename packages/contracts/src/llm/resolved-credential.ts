/**
 * Fully-resolved credential type for the unified LLM provider architecture.
 *
 * This type replaces the partial `CredentialResultWire` at the runtime level.
 * `CredentialResultWire` is retained solely as a wire diagnostic type for
 * `cleo llm whoami` CLI output.
 *
 * @module llm/resolved-credential
 * @task T9281
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §Type lock-in
 */

import type { ProviderId } from './provider-id.js';

/**
 * Fully-resolved credential ready for use in a transport constructor.
 *
 * The transport consumes this at construction time and MUST NOT store it
 * beyond initialization. {@link extraHeaders} is merged into SDK
 * defaultHeaders.
 *
 * Replaces the partial `CredentialResultWire` for runtime use.
 * `CredentialResultWire` is retained as a wire diagnostic type for
 * `cleo llm whoami` CLI output only.
 *
 * @see ADR-072 §Type lock-in
 */
export interface ResolvedCredential {
  /** Provider this credential targets. */
  readonly provider: ProviderId;
  /** Human-readable store label (e.g. 'personal', 'work'). */
  readonly label: string;
  /**
   * API key, OAuth bearer token, or empty string for aws_sdk auth.
   * NEVER log this field. NEVER include in NormalizedResponse.providerData.
   */
  readonly token: string;
  /** How the token is presented to the provider. */
  readonly authType: 'api_key' | 'oauth' | 'aws_sdk';
  /**
   * Unix epoch ms at which the token expires. null = never expires.
   * LlmSession checks this before each send() and triggers OAuth refresh
   * when less than 60 seconds remain.
   */
  readonly expiresAt: number | null;
  /**
   * OAuth refresh token. null for api_key and aws_sdk credentials.
   * LlmSession holds this; the transport never sees it.
   */
  readonly refreshToken: string | null;
  /**
   * Extra HTTP headers merged into every SDK request from this credential.
   * Typically carries 'Authorization: Bearer ...' for oauth authType,
   * and 'anthropic-beta: ...' when needed.
   */
  readonly extraHeaders: Readonly<Record<string, string>>;
  /** Base URL override (proxy, on-prem deployment). null = use provider default. */
  readonly baseUrl: string | null;
  /** AWS profile name for Bedrock. null for all other providers. */
  readonly awsProfile: string | null;
}
