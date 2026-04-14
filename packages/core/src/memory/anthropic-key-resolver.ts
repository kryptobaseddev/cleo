/**
 * Resolve Anthropic API key from multiple sources.
 *
 * Resolution priority (first match wins):
 * 1. `ANTHROPIC_API_KEY` environment variable (explicit per-process config)
 * 2. CLEO global config at `~/.local/share/cleo/anthropic-key` (user-stored key)
 * 3. Claude Code OAuth token at `~/.claude/.credentials.json` (auto-discover
 *    from the user's existing Claude Code login — no manual config needed)
 *
 * To store a key explicitly: `cleo config set brain.anthropicApiKey <key>`
 * or write directly to `~/.local/share/cleo/anthropic-key`.
 *
 * Returns null when no key is available.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cached key to avoid repeated filesystem reads within the same process. */
let cachedKey: string | null | undefined;

/** Global CLEO data directory (XDG_DATA_HOME/cleo). */
function globalCleoDir(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'cleo');
}

/**
 * Resolve the Anthropic API key. Result is cached for the process lifetime.
 *
 * @returns The API key/token string, or null if unavailable.
 */
export function resolveAnthropicApiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;

  // 1. Explicit env var (highest priority — per-process override)
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey?.trim()) {
    cachedKey = envKey;
    return cachedKey;
  }

  // 2. CLEO global stored key (user explicitly set via CLI)
  try {
    const keyFile = join(globalCleoDir(), 'anthropic-key');
    if (existsSync(keyFile)) {
      const stored = readFileSync(keyFile, 'utf-8').trim();
      if (stored) {
        cachedKey = stored;
        return cachedKey;
      }
    }
  } catch {
    // Not available — continue
  }

  // 3. Auto-discover from Claude Code credentials (zero config)
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) {
      cachedKey = null;
      return cachedKey;
    }
    const raw = readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const token = creds.claudeAiOauth?.accessToken;
    if (token?.trim()) {
      // Skip expired tokens
      const expiresAt = creds.claudeAiOauth?.expiresAt;
      if (expiresAt && Date.now() > expiresAt) {
        cachedKey = null;
        return cachedKey;
      }
      cachedKey = token;
      return cachedKey;
    }
  } catch {
    // Credentials file missing or unreadable — not an error
  }

  cachedKey = null;
  return cachedKey;
}

/**
 * Store an Anthropic API key in the CLEO global config directory.
 *
 * Writes to `~/.local/share/cleo/anthropic-key` with 0600 permissions.
 * This is the backup path for users who want to set a key explicitly
 * without using environment variables.
 *
 * @param apiKey - The API key to store.
 */
export function storeAnthropicApiKey(apiKey: string): void {
  const dir = globalCleoDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const keyFile = join(dir, 'anthropic-key');
  writeFileSync(keyFile, apiKey.trim(), { mode: 0o600 });
  // Invalidate cache so next resolveAnthropicApiKey picks up the new key
  cachedKey = undefined;
}

/**
 * Clear the cached key (useful for testing or token refresh scenarios).
 */
export function clearAnthropicKeyCache(): void {
  cachedKey = undefined;
}
