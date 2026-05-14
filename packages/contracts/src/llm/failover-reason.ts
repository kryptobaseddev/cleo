/**
 * Structured taxonomy of LLM failure modes — mirrors Hermes' FailoverReason enum.
 *
 * Consumers (CredentialPool, auxiliary-router, CLI error envelopes) use this
 * to drive deterministic recovery actions instead of ad-hoc status-code
 * inspection.
 *
 * Adding new values is BC-safe. Removing or renaming values is BREAKING.
 *
 * @task T9270 (Phase 3 T-LLM-CRED)
 */
export type FailoverReason =
  // --- Authentication / authorization ---
  /** 401/403 — transient; refresh or rotate credential */
  | 'auth'
  /** Auth failed AFTER refresh — abort, do not retry */
  | 'auth_permanent'
  // --- Billing / quota ---
  /** 402 or credit exhaustion — rotate immediately to next credential */
  | 'billing'
  /** 429 — backoff then rotate */
  | 'rate_limit'
  // --- Server-side ---
  /** 503/529 — provider overloaded; retry with backoff */
  | 'overloaded'
  /** 500/502 — internal error; retry */
  | 'server_error'
  // --- Transport ---
  /** Connection or read timeout — rebuild client + retry */
  | 'timeout'
  // --- Context / payload ---
  /** Context too large — invoke compression engine */
  | 'context_overflow'
  /** 413 — compress payload */
  | 'payload_too_large'
  /** Per-image limit hit — shrink and retry */
  | 'image_too_large'
  // --- Model / provider ---
  /** 404 — fall back to a different model */
  | 'model_not_found'
  /** Aggregator policy block (OpenRouter, etc.) */
  | 'provider_policy_blocked'
  // --- Request format ---
  /** 400 — abort or strip + retry */
  | 'format_error'
  // --- Provider-specific (hooks for future deep classification) ---
  /** Anthropic thinking-block signature invalid */
  | 'thinking_signature'
  /** Anthropic extra-usage tier gate */
  | 'long_context_tier'
  /** OAuth long-context beta forbidden */
  | 'oauth_long_context_beta_forbidden'
  /** llama.cpp grammar pattern regex rejection */
  | 'llama_cpp_grammar_pattern'
  // --- Catch-all ---
  | 'unknown';

/**
 * Structured classification of an LLM API error with deterministic recovery hints.
 *
 * Produced by `classifyError` in `@cleocode/core`. Consumers check the flags
 * (`retryable`, `shouldCompress`, `shouldRotateCredential`, `shouldFallback`)
 * instead of re-inspecting the raw error.
 *
 * @task T9270 (Phase 3 T-LLM-CRED)
 */
export interface ClassifiedError {
  /** Structured failure reason driving recovery strategy. */
  reason: FailoverReason;
  /** HTTP status code extracted from the error, if available. */
  statusCode: number | null;
  /** Provider identifier from the call context, if supplied. */
  provider: string | null;
  /** Model identifier from the call context, if supplied. */
  model: string | null;
  /** Human-readable error message. */
  message: string;
  /** Whether the operation can be retried (possibly after backoff). */
  retryable: boolean;
  /** Whether the caller should attempt context compression before retrying. */
  shouldCompress: boolean;
  /** Whether the caller should rotate to a different credential. */
  shouldRotateCredential: boolean;
  /** Whether the caller should fall back to a different model/provider. */
  shouldFallback: boolean;
}
