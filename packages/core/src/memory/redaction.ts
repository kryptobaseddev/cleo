/**
 * Redaction utilities for transcript ingestion (T1002).
 *
 * Scrubs PII, secrets, and sensitive path strings from content blocks
 * before they are persisted to brain_transcript_events. Designed to be
 * fast and conservative — it is always better to redact too much than
 * to store secrets in the brain.
 *
 * Patterns covered:
 *  - Anthropic API keys (sk-ant-...)
 *  - Generic API keys / tokens matching common naming conventions (*_KEY, *_TOKEN, etc.)
 *  - Environment variable assignments (FOO=<value>)
 *  - File paths that look like secrets (.env, .pem, .key, id_rsa, etc.)
 *  - JWT tokens (eyJ...base64)
 *  - Bearer tokens in HTTP headers
 *  - Hex strings that look like secrets (32+ hex chars after a key= prefix)
 *
 * @task T1002
 * @epic T1000
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Anthropic API key: sk-ant-api03-... */
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;

/** OpenAI / Anthropic short-form API key: sk-[A-Za-z0-9]{32,} */
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{32,}\b/g;

/**
 * Environment variable assignment containing a secret value.
 * Matches lines like: ANTHROPIC_API_KEY=sk-ant-... or TOKEN="abc123"
 */
const ENV_ASSIGNMENT_RE =
  /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|NPM_TOKEN|AWS_(?:SECRET_)?ACCESS_KEY(?:_ID)?|GCP_(?:SERVICE_ACCOUNT_)?KEY|AZURE_(?:CLIENT_SECRET|ACCESS_KEY)|DATABASE_URL|REDIS_URL|SECRET(?:_KEY)?|API_(?:KEY|TOKEN|SECRET)|AUTH_(?:TOKEN|SECRET)|PRIVATE_KEY|ACCESS_(?:TOKEN|KEY)|BEARER_TOKEN|JWT_SECRET|ENCRYPTION_KEY|SIGNING_KEY|WEBHOOK_SECRET)(\s*=\s*)['"]?[^\s'"]{8,}['"]?/gi;

/** JWT bearer token: eyJ<base64>.<base64>.<base64> */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** Bearer token in HTTP Authorization header */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/]+=*\b/gi;

/**
 * Paths that look like secrets: .env files, PEM/key files, SSH private keys.
 * Matches:
 *  - Any path containing id_rsa (including ~/.ssh/id_rsa)
 *  - Standalone .env files (with optional suffix)
 *  - Files ending in .pem, .key, .p8, .p12, .pfx, .jks, .keystore
 */
const SECRET_PATH_RE =
  /(?:(?:~|\/)[^\s'"]*\/)?(?:\.env(?:\.[A-Za-z0-9._-]+)?|id_rsa(?:_[A-Za-z0-9_-]*)?|[A-Za-z0-9_-]+\.(?:pem|key|p8|p12|pfx|jks|keystore))(?=[\s'"$]|$)/gi;

/** Hex secrets: key=<32+ hex chars> */
const HEX_SECRET_RE = /\b(?:key|token|secret|password|passwd|pwd)=([0-9a-f]{32,})\b/gi;

/** Password fields in JSON-like payloads: "password":"abc123" */
const JSON_PASSWORD_RE =
  /"(?:password|passwd|secret|token|apiKey|api_key|authToken|auth_token)"\s*:\s*"[^"]{4,}"/gi;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 * @param content - Raw content string to scrub.
 * @returns RedactionResult with scrubbed content and redacted flag.
 */
export function redactContent(content: string): RedactionResult {
  let result = content;
  let redacted = false;

  const patterns: RegExp[] = [
    ANTHROPIC_KEY_RE,
    OPENAI_KEY_RE,
    JWT_RE,
    BEARER_RE,
    HEX_SECRET_RE,
    JSON_PASSWORD_RE,
  ];

  for (const pattern of patterns) {
    // Reset lastIndex for global patterns between calls
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
      redacted = true;
    }
  }

  // ENV assignments need special handling to preserve the key name
  ENV_ASSIGNMENT_RE.lastIndex = 0;
  const envReplaced = result.replace(ENV_ASSIGNMENT_RE, (_match, varName: string, eq: string) => {
    redacted = true;
    return `${varName}${eq}[REDACTED]`;
  });
  result = envReplaced;

  // Secret paths — replace the filename portion only
  SECRET_PATH_RE.lastIndex = 0;
  if (SECRET_PATH_RE.test(result)) {
    SECRET_PATH_RE.lastIndex = 0;
    result = result.replace(SECRET_PATH_RE, ' [REDACTED_PATH] ');
    redacted = true;
  }

  return { content: result, redacted };
}

/**
 * Check whether a string contains any detectable secret pattern.
 *
 * Cheaper than redactContent — does not perform replacement.
 *
 * @param content - String to probe.
 * @returns True if at least one secret pattern is detected.
 */
export function containsSecret(content: string): boolean {
  const allPatterns = [
    ANTHROPIC_KEY_RE,
    OPENAI_KEY_RE,
    JWT_RE,
    BEARER_RE,
    HEX_SECRET_RE,
    JSON_PASSWORD_RE,
    ENV_ASSIGNMENT_RE,
    SECRET_PATH_RE,
  ];
  for (const p of allPatterns) {
    p.lastIndex = 0;
    if (p.test(content)) return true;
  }
  return false;
}
