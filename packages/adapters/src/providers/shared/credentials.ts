/**
 * Anthropic credential resolver for adapter packages (D-ph4-02 · T9357).
 *
 * This module is the canonical credential resolver for adapter packages that
 * cannot import `@cleocode/core` due to the `core → adapters` dependency.
 * It mirrors the first 3 tiers of `core/llm/credentials.ts resolveCredentials()`
 * using only Node.js builtins and `@cleocode/contracts` helpers.
 *
 * ## Resolution tiers (first non-empty match wins)
 * 1. `ANTHROPIC_API_KEY` environment variable
 * 2. `~/.local/share/cleo/anthropic-key` (XDG-aware legacy flat-key file)
 * 3. `~/.claude/.credentials.json` OAuth bearer token
 *
 * Call-sites use the same `resolveCredentials('anthropic').apiKey` pattern
 * as the full 6-tier resolver in `@cleocode/core`, making future migration
 * to the canonical resolver transparent.
 *
 * @module shared/credentials
 * @task T9357
 * @see D-ph4-02
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeCodeCredentials } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link resolveCredentials}.
 *
 * The shape intentionally matches the subset of `CredentialResult` from
 * `@cleocode/core` that adapter call-sites need, so that if this module is
 * ever replaced by a direct core import the call-sites require no changes.
 */
export interface ResolvedCredential {
  /** API key or OAuth bearer token, or `null` when no credential was found. */
  apiKey: string | null;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the Anthropic API key using a 3-tier priority chain.
 *
 * Drop-in compatible with `@cleocode/core` `resolveCredentials('anthropic')`
 * for the subset of fields adapters use (`.apiKey`).
 *
 * Resolution order (first non-empty match wins):
 * 1. `ANTHROPIC_API_KEY` environment variable
 * 2. `~/.local/share/cleo/anthropic-key` (XDG-aware stored key)
 * 3. `~/.claude/.credentials.json` Claude Code OAuth token
 *
 * Never throws — all filesystem errors are caught and treated as "not found".
 *
 * @param provider - Currently only `'anthropic'` is supported.
 * @returns `{ apiKey }` where `apiKey` is `null` when no credential was found.
 *
 * @example
 * ```ts
 * import { resolveCredentials } from '../../shared/credentials.js';
 *
 * const { apiKey } = resolveCredentials('anthropic');
 * if (!apiKey) throw new Error('No Anthropic credential available');
 * ```
 */
export function resolveCredentials(_provider: 'anthropic'): ResolvedCredential {
  // Tier 1 — explicit env var
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey?.trim()) return { apiKey: envKey.trim() };

  // Tier 2 — XDG-aware legacy flat-key file (~/.local/share/cleo/anthropic-key)
  try {
    const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
    const keyFile = join(xdg, 'cleo', 'anthropic-key');
    if (existsSync(keyFile)) {
      const stored = readFileSync(keyFile, 'utf-8').trim();
      if (stored) return { apiKey: stored };
    }
  } catch {
    // Not available — continue to next tier
  }

  // Tier 3 — Claude Code OAuth token (~/.claude/.credentials.json)
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return { apiKey: null };
    const raw = readFileSync(credPath, 'utf-8');
    const cred = parseClaudeCodeCredentials(raw);
    return { apiKey: cred?.accessToken ?? null };
  } catch {
    // Credentials file missing or unreadable — not an error
  }

  return { apiKey: null };
}
