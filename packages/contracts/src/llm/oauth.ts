/**
 * Shared OAuth type contracts for the CLEO LLM credential layer.
 *
 * Defines the SSoT types shared between `@cleocode/core` (PKCE implementation)
 * and `@cleocode/cleo` (CLI dispatcher). No runtime dependencies — types only.
 *
 * @module contracts/llm/oauth
 * @task T9302
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

// ---------------------------------------------------------------------------
// OAuth mode discriminant
// ---------------------------------------------------------------------------

/**
 * OAuth grant mode supported by a provider profile.
 *
 * - `pkce` — RFC 7636 Authorization Code + PKCE (browser-based or headless
 *   with manual code paste). Used by Anthropic.
 * - `device-code` — RFC 8628 Device Authorization Grant (polling). Used by
 *   Kimi Code.
 */
export type OAuthMode = 'pkce' | 'device-code';

// ---------------------------------------------------------------------------
// Token response
// ---------------------------------------------------------------------------

/**
 * Successful token response from an OAuth token endpoint.
 *
 * Returned by both {@link exchangePkceCode} and {@link refreshPkceToken} in
 * `@cleocode/core/llm/oauth/pkce.ts`.
 *
 * @task T9302
 */
export interface OAuthTokens {
  /** Bearer access token. */
  accessToken: string;
  /**
   * Refresh token for obtaining new access tokens without user interaction.
   *
   * Not all providers return a refresh token. When absent, the user must
   * re-authorize when the access token expires.
   */
  refreshToken?: string;
  /** Seconds until `accessToken` expires. `undefined` when not provided. */
  expiresIn?: number;
  /** Token type (virtually always `'bearer'`). */
  tokenType: string;
}

// ---------------------------------------------------------------------------
// PKCE flow config
// ---------------------------------------------------------------------------

/**
 * Configuration for a RFC 7636 PKCE OAuth flow.
 *
 * All URLs and client credentials are provider-specific. Callers obtain an
 * instance from the builtin registry (e.g., `anthropicProfile.oauth`) or
 * construct one directly for a custom provider.
 *
 * @task T9302
 */
export interface PkceFlowConfig {
  /** Provider name — used only for logging / error messages. */
  provider: string;
  /** OAuth 2.0 client ID registered with the provider. */
  clientId: string;
  /**
   * Authorization endpoint (RFC 6749 §3.1).
   *
   * The user (or headless code) navigates here to grant consent. When the
   * grant succeeds the provider redirects to `redirectUri` with an
   * authorization `code` and the original `state` parameter.
   */
  authorizationEndpoint: string;
  /**
   * Token endpoint (RFC 6749 §3.2).
   *
   * POSTed to when exchanging the authorization `code` for tokens, and again
   * when refreshing an existing access token.
   */
  tokenEndpoint: string;
  /**
   * Space-separated OAuth scopes to request.
   *
   * @example 'org:create_api_key user:profile user:inference'
   */
  scope?: string;
  /**
   * Redirect URI registered with the provider.
   *
   * For CLI / headless flows this is typically `http://localhost:<port>/callback`
   * or a custom URI scheme handled by the CLI binary.
   *
   * @default 'http://localhost'
   */
  redirectUri?: string;
  /**
   * Additional HTTP headers sent with every token-endpoint request.
   *
   * Used for provider-specific version headers (e.g. Anthropic's
   * `anthropic-beta`).
   */
  extraHeaders?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// ProviderProfile oauth config shape
// ---------------------------------------------------------------------------

/**
 * OAuth configuration embedded in a {@link ProviderProfile}.
 *
 * Added as an optional field `oauth?` on `ProviderProfile` so the CLI login
 * dispatcher can read the mode and endpoints without importing provider-
 * specific modules.
 *
 * @task T9302
 */
export interface ProviderOAuthConfig {
  /** OAuth grant mode this provider uses. */
  mode: OAuthMode;
  /** OAuth 2.0 client ID. */
  clientId: string;
  /**
   * Authorization endpoint URL (required for `pkce` mode; omit for
   * `device-code`).
   */
  authorizationEndpoint?: string;
  /** Token endpoint URL. */
  tokenEndpoint: string;
  /** Space-separated OAuth scopes. */
  scope?: string;
  /**
   * Redirect URI (required for `pkce` mode; omit for `device-code`).
   *
   * @default 'http://localhost'
   */
  redirectUri?: string;
}
