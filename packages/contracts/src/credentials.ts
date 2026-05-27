/**
 * Pure credential-parsing helpers for the CLEO LLM layer.
 *
 * This module is a LEAF — it has NO imports from @cleocode/core or any
 * other runtime package. It exists so adapter packages can parse Claude Code
 * OAuth credentials without creating a circular dependency on @cleocode/core.
 *
 * ## What lives here
 * - `ClaudeCodeCredential` — shape of `~/.claude/.credentials.json`
 * - `parseClaudeCodeCredentials()` — pure JSON parser + expiry check
 *
 * ## What does NOT live here
 * - Filesystem reads (those belong in core/llm/credentials.ts)
 * - Caching (belongs in core)
 * - Multi-tier resolution (belongs in core)
 *
 * @module credentials
 * @task T9307
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The `claudeAiOauth` block found inside `~/.claude/.credentials.json`.
 */
export interface ClaudeCodeOAuthBlock {
  /** Short-lived bearer token for Anthropic API calls. */
  accessToken: string;
  /** Unix-millisecond timestamp after which the token is invalid. Optional. */
  expiresAt?: number;
  /** Refresh token for obtaining new access tokens. Optional. */
  refreshToken?: string;
  /**
   * OAuth scopes granted to the token, e.g. `['user:inference']`.
   *
   * Claude Code >= 2.1.81 requires the `user:inference` scope on its OAuth
   * tokens; cooperative write-back (T9411) preserves whatever scopes are
   * already on disk so we never strip the field on refresh.
   *
   * @task T9411
   */
  scopes?: string[];
}

/**
 * Parsed result returned by `parseClaudeCodeCredentials()`.
 *
 * All fields mirror `ClaudeCodeOAuthBlock` but `accessToken` is always
 * present (a null return indicates the file was absent, malformed, or expired).
 */
export interface ParsedClaudeCodeCredential {
  /** Bearer access token for the Anthropic API. */
  accessToken: string;
  /** Expiry as a Unix millisecond timestamp, if provided. */
  expiresAt?: number;
  /** Refresh token, if present in the credentials file. */
  refreshToken?: string;
  /**
   * OAuth scopes granted to the token, if present in the credentials file.
   *
   * Preserved verbatim by the parser — `parseClaudeCodeCredentials` does not
   * filter or normalize the array. Cooperative write-back (T9411) relies on
   * this to keep Claude Code's `user:inference` scope intact across refreshes.
   *
   * @task T9411
   */
  scopes?: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the contents of `~/.claude/.credentials.json` and extract the OAuth
 * credential block.
 *
 * This is a **pure** helper: it accepts a `Buffer | string` (the raw file
 * content) and returns the parsed credential or `null`. It never reads the
 * filesystem or accesses environment variables.
 *
 * Expiry is checked using `Date.now()` — tokens whose `expiresAt` is in the
 * past are treated as absent and `null` is returned.
 *
 * @param buf - Raw UTF-8 contents of the credentials file.
 * @returns Parsed credential object, or `null` when the file is malformed,
 *          the OAuth block is absent, or the token is expired.
 *
 * @example
 * ```ts
 * import { readFileSync } from 'node:fs';
 * import { join } from 'node:path';
 * import { homedir } from 'node:os';
 * import { parseClaudeCodeCredentials } from '@cleocode/contracts';
 *
 * const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'));
 * const cred = parseClaudeCodeCredentials(raw);
 * if (cred) {
 *   console.log('token:', cred.accessToken);
 * }
 * ```
 */
export function parseClaudeCodeCredentials(
  buf: Buffer | string,
): ParsedClaudeCodeCredential | null {
  try {
    const text = typeof buf === 'string' ? buf : buf.toString('utf-8');
    const raw = JSON.parse(text) as Record<string, unknown>;
    const oauth = raw['claudeAiOauth'];
    if (!oauth || typeof oauth !== 'object') return null;

    const block = oauth as Record<string, unknown>;
    const accessToken = block['accessToken'];
    if (typeof accessToken !== 'string' || !accessToken.trim()) return null;

    const expiresAt = typeof block['expiresAt'] === 'number' ? block['expiresAt'] : undefined;
    if (expiresAt !== undefined && Date.now() > expiresAt) return null;

    const refreshToken =
      typeof block['refreshToken'] === 'string' && block['refreshToken'].trim()
        ? block['refreshToken']
        : undefined;

    // T9411 — preserve `scopes` verbatim so cooperative write-back keeps
    // Claude Code's `user:inference` grant intact across refreshes.
    const rawScopes = block['scopes'];
    const scopes =
      Array.isArray(rawScopes) && rawScopes.every((s) => typeof s === 'string')
        ? (rawScopes as string[])
        : undefined;

    return {
      accessToken: accessToken.trim(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(scopes !== undefined ? { scopes } : {}),
    };
  } catch {
    return null;
  }
}
