/**
 * Redaction utilities for transcript ingestion (T1002).
 *
 * Scrubs PII, secrets, and sensitive path strings from content blocks
 * before they are persisted to brain_transcript_events. Designed to be
 * fast and conservative — it is always better to redact too much than
 * to store secrets in the brain.
 *
 * As of E5 (T11414 · Saga T11387) the credential-pattern set lives once in
 * the pure `@cleocode/utils` leaf — see {@link redactWithFlag} /
 * {@link containsSecret} there. This module is a thin domain-named adapter
 * that preserves the historical `redactContent` API (and its `RedactionResult`
 * shape) for the transcript-ingestion call sites while sourcing every pattern
 * from the single SSoT. The former second copy
 * (`llm/plugin-facade.ts:redactCredentials`) now also delegates to the same
 * leaf, so no credential pattern is duplicated across the codebase.
 *
 * Patterns covered (defined in `@cleocode/utils/redact`):
 *  - Anthropic API keys (sk-ant-...)
 *  - OpenAI / generic `sk-` API keys
 *  - Slack bot tokens (xoxb-...)
 *  - Environment variable assignments (FOO=<value>)
 *  - File paths that look like secrets (.env, .pem, .key, id_rsa, etc.)
 *  - JWT tokens (eyJ...base64)
 *  - Bearer tokens in HTTP headers
 *  - Hex strings that look like secrets (32+ hex chars after a key= prefix)
 *  - JSON password / token fields
 *
 * @task T1002
 * @task T11414
 * @epic T1000
 */

import { redactWithFlag, containsSecret as utilsContainsSecret } from '@cleocode/utils';

/**
 * Result from a redaction pass.
 */
export interface RedactionResult {
  /** Redacted content string. */
  content: string;
  /** True when at least one pattern matched and was replaced. */
  redacted: boolean;
}

/**
 * Apply all redaction patterns to a content string.
 *
 * Returns the scrubbed content and a flag indicating whether any
 * substitutions were made. The replacement token is `[REDACTED]`.
 *
 * Delegates to the `@cleocode/utils` SSoT (T11414); behaviour is unchanged for
 * the transcript-ingestion call sites.
 *
 * @param content - Raw content string to scrub.
 * @returns RedactionResult with scrubbed content and redacted flag.
 */
export function redactContent(content: string): RedactionResult {
  return redactWithFlag(content);
}

/**
 * Check whether a string contains any detectable secret pattern.
 *
 * Cheaper than redactContent — does not perform replacement. Delegates to the
 * `@cleocode/utils` SSoT (T11414).
 *
 * @param content - String to probe.
 * @returns True if at least one secret pattern is detected.
 */
export function containsSecret(content: string): boolean {
  return utilsContainsSecret(content);
}
