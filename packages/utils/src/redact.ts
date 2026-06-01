/**
 * redact — credential / secret string scrubbing (SSoT).
 *
 * Canonical, behaviour-preserving union of the two credential-redaction copies
 * previously maintained independently in `core` (E5 · T11414 · Saga T11387):
 *
 *   1. `packages/core/src/memory/redaction.ts` → `redactContent` — the rich
 *      transcript scrubber (PII/secrets before persistence to the brain).
 *   2. `packages/core/src/llm/plugin-facade.ts` → `redactCredentials` — the
 *      error-string scrubber applied to `err.message`/`err.stack`.
 *
 * The two copies overlapped on the Anthropic-key, generic `sk-` key and
 * `Bearer` token patterns but disagreed at the edges: the plugin-facade copy
 * uniquely matched Slack bot tokens (`xoxb-…`) while the transcript copy
 * uniquely matched OpenAI prefixed keys, JWTs, env assignments, secret file
 * paths, hex secrets and JSON password fields. This module is the **superset**
 * of both — no pattern from either prior copy is lost, and the Slack-token
 * coverage that previously existed only in the plugin path is now applied
 * everywhere. Both former call sites delegate here.
 *
 * Everything is pure, dependency-free and global-state-free per the
 * `@cleocode/utils` leaf contract: the patterns reset `lastIndex` on every use
 * so the module-level `RegExp` literals are safe to share across calls.
 *
 * @module @cleocode/utils/redact
 */

/** The token substituted for any matched secret. */
const REDACTED = '[REDACTED]';

/** The token substituted for a redacted secret-looking file path. */
const REDACTED_PATH = ' [REDACTED_PATH] ';

// ---------------------------------------------------------------------------
// Patterns — the union of both prior copies.
// ---------------------------------------------------------------------------

/** Anthropic API key: `sk-ant-api03-…`. */
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;

/**
 * OpenAI API key — legacy short-form and modern prefixed variants
 * (`sk-proj-*`, `sk-svcacct-*`, `sk-admin-*`).
 */
const OPENAI_KEY_RE = /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{32,}\b/g;

/**
 * Generic `sk-` token (≥20 body chars). Carried over from the plugin-facade
 * copy; catches provider keys not covered by the stricter OpenAI form above.
 */
const GENERIC_SK_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;

/** Slack bot token: `xoxb-…`. Previously only scrubbed on the plugin path. */
const SLACK_BOT_RE = /\bxoxb-[A-Za-z0-9_-]+\b/g;

/** JWT bearer token: `eyJ<base64>.<base64>.<base64>`. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** Bearer token in an HTTP `Authorization` header. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

/** Hex secrets: `key=<32+ hex chars>`. */
const HEX_SECRET_RE = /\b(?:key|token|secret|password|passwd|pwd)=([0-9a-f]{32,})\b/gi;

/** Password / token fields in JSON-like payloads: `"password":"abc123"`. */
const JSON_PASSWORD_RE =
  /"(?:password|passwd|secret|token|apiKey|api_key|authToken|auth_token)"\s*:\s*"[^"]{4,}"/gi;

/**
 * Environment variable assignment containing a secret value, e.g.
 * `ANTHROPIC_API_KEY=sk-ant-…` or `TOKEN="abc123"`. The variable name is
 * preserved; only the value is replaced.
 */
const ENV_ASSIGNMENT_RE =
  /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|NPM_TOKEN|AWS_(?:SECRET_)?ACCESS_KEY(?:_ID)?|GCP_(?:SERVICE_ACCOUNT_)?KEY|AZURE_(?:CLIENT_SECRET|ACCESS_KEY)|DATABASE_URL|REDIS_URL|SECRET(?:_KEY)?|API_(?:KEY|TOKEN|SECRET)|AUTH_(?:TOKEN|SECRET)|PRIVATE_KEY|ACCESS_(?:TOKEN|KEY)|BEARER_TOKEN|JWT_SECRET|ENCRYPTION_KEY|SIGNING_KEY|WEBHOOK_SECRET)(\s*=\s*)['"]?[^\s'"]{8,}['"]?/gi;

/**
 * Paths that look like secrets — `.env` files, PEM/key files, SSH private
 * keys. Replaced with {@link REDACTED_PATH}.
 */
const SECRET_PATH_RE =
  /(?:(?:~|\/)[^\s'"]*\/)?(?:\.env(?:\.[A-Za-z0-9._-]+)?|id_rsa(?:_[A-Za-z0-9_-]*)?|[A-Za-z0-9_-]+\.(?:pem|key|p8|p12|pfx|jks|keystore))(?=[\s'"$]|$)/gi;

/**
 * Whole-string patterns replaced with the {@link REDACTED} token. Ordered so
 * the more specific Anthropic/OpenAI forms run before the generic `sk-` form.
 */
const SIMPLE_PATTERNS: readonly RegExp[] = [
  ANTHROPIC_KEY_RE,
  OPENAI_KEY_RE,
  GENERIC_SK_RE,
  SLACK_BOT_RE,
  JWT_RE,
  BEARER_RE,
  HEX_SECRET_RE,
  JSON_PASSWORD_RE,
];

/** Every pattern, used by {@link containsSecret} for cheap detection. */
const ALL_PATTERNS: readonly RegExp[] = [...SIMPLE_PATTERNS, ENV_ASSIGNMENT_RE, SECRET_PATH_RE];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Result of a {@link redactWithFlag} pass. */
export interface RedactionResult {
  /** The scrubbed content string. */
  readonly content: string;
  /** True when at least one pattern matched and was replaced. */
  readonly redacted: boolean;
}

/**
 * Scrub every known credential / secret pattern from a string, reporting
 * whether anything was replaced.
 *
 * Secret values become `[REDACTED]`; secret-looking file paths become
 * `[REDACTED_PATH]`; environment-variable assignments keep their key name and
 * redact only the value (`FOO=[REDACTED]`).
 *
 * @param content - Raw string to scrub.
 * @returns The scrubbed content plus a `redacted` flag.
 *
 * @example
 * ```ts
 * redactWithFlag('key: sk-ant-aaaaaaaaaaaaaaaaaaaa1');
 * // → { content: 'key: [REDACTED]', redacted: true }
 * redactWithFlag('nothing secret here');
 * // → { content: 'nothing secret here', redacted: false }
 * ```
 */
export function redactWithFlag(content: string): RedactionResult {
  let result = content;
  let redacted = false;

  for (const pattern of SIMPLE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
      redacted = true;
    }
  }

  // ENV assignments — preserve the variable name, redact only the value.
  ENV_ASSIGNMENT_RE.lastIndex = 0;
  result = result.replace(ENV_ASSIGNMENT_RE, (_match, varName: string, eq: string) => {
    redacted = true;
    return `${varName}${eq}${REDACTED}`;
  });

  // Secret-looking file paths.
  SECRET_PATH_RE.lastIndex = 0;
  if (SECRET_PATH_RE.test(result)) {
    SECRET_PATH_RE.lastIndex = 0;
    result = result.replace(SECRET_PATH_RE, REDACTED_PATH);
    redacted = true;
  }

  return { content: result, redacted };
}

/**
 * Scrub every known credential / secret pattern from a string.
 *
 * Convenience wrapper over {@link redactWithFlag} that returns only the
 * scrubbed string — the shape expected by error-message scrubbing call sites.
 * `undefined` passes through unchanged so callers can scrub optional fields
 * such as `err.stack` without a guard.
 *
 * @param value - String to scrub, or `undefined`.
 * @returns The scrubbed string, or `undefined` when the input was `undefined`.
 *
 * @example
 * ```ts
 * redact('Bearer abc.def-ghi');   // → '[REDACTED]'
 * redact(undefined);              // → undefined
 * ```
 */
export function redact(value: string): string;
export function redact(value: string | undefined): string | undefined;
export function redact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return redactWithFlag(value).content;
}

/**
 * Cheaply test whether a string contains any detectable secret pattern,
 * without performing replacement.
 *
 * @param content - String to probe.
 * @returns True when at least one secret pattern matches.
 *
 * @example
 * ```ts
 * containsSecret('Bearer abc.def');                 // → true
 * containsSecret('just some ordinary log line');    // → false
 * ```
 */
export function containsSecret(content: string): boolean {
  for (const pattern of ALL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }
  return false;
}
