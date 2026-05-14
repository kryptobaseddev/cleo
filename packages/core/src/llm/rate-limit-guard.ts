/**
 * Cross-session rate-limit guard for the CLEO LLM credential layer.
 *
 * Writes rate-limit state to a shared file so ALL CLEO processes
 * (sentient daemon, CLI calls, auxiliary router) see the same cooldown —
 * preventing pile-on retries from independent sessions.
 *
 * Port of Hermes' `agent/nous_rate_guard.py` (generalized for any provider).
 * Each 429 from a provider can trigger multiple SDK retries multiplied by
 * multiple Hermes retries.  By recording state on the first 429 and checking
 * before subsequent attempts, we eliminate retry amplification across sessions.
 *
 * State is keyed on `(provider, label)` and stored at:
 *   `${cleoHomeDir()}/rate-limit-state/<provider>-<label>.json`
 *
 * @module llm/rate-limit-guard
 * @task T9273
 * @epic T-LLM-CRED-CENTRALIZATION Phase 3
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, withFileLock, writeJsonFileAtomic } from '../store/file-utils.js';
import { cleoHomeDir } from './credentials.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * On-disk schema for a rate-limit state file.
 * @internal
 */
interface RateLimitState {
  /** Epoch milliseconds at which the rate limit clears. */
  resetAt: number;
  /** Epoch milliseconds at which the state was recorded. */
  recordedAt: number;
  /** Whether the reset time came from a parsed header or the default. */
  source: 'header' | 'default';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a provider or label string for use in a filename.
 *
 * Replaces any character outside `[a-zA-Z0-9_-]` with `_` to prevent
 * path traversal (e.g. `../../evil` → `_____evil`).
 *
 * @param value - Raw provider or label string.
 * @returns Filesystem-safe string.
 *
 * @task T9273
 */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Absolute path to the rate-limit state file for a given `(provider, label)`.
 *
 * Exposed for unit tests.
 *
 * @param provider - LLM provider identifier (e.g. `'anthropic'`).
 * @param label    - Credential label (e.g. `'personal'`).
 * @returns Absolute path to the JSON state file.
 *
 * @task T9273
 */
export function rateLimitStatePath(provider: string, label: string): string {
  const dir = join(cleoHomeDir(), 'rate-limit-state');
  return join(dir, `${sanitize(provider)}-${sanitize(label)}.json`);
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Extract the best available reset-time estimate (epoch ms) from HTTP
 * response headers.
 *
 * Priority:
 *   1. `retry-after`              — delta seconds OR HTTP-date
 *   2. `x-ratelimit-reset-requests` — epoch seconds (OpenAI-style)
 *   3. `x-ratelimit-reset`          — epoch seconds OR ISO 8601 date
 *
 * Returns `null` when no usable header is found or all parsed values are
 * in the past (caller falls back to `defaultCooldownSeconds`).
 *
 * @param headers - HTTP response headers from the 429 error.
 * @returns Epoch milliseconds for the reset time, or `null`.
 *
 * @internal
 * @task T9273
 */
function parseResetFromHeaders(headers: Headers | Record<string, string>): number | null {
  const get = (k: string): string | null => {
    if (headers instanceof Headers) return headers.get(k);
    return (headers as Record<string, string>)[k] ?? null;
  };

  const retryAfter = get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > Date.now()) return date;
  }

  const xResetReq = get('x-ratelimit-reset-requests');
  if (xResetReq) {
    const epoch = Number(xResetReq);
    if (Number.isFinite(epoch) && epoch > Date.now() / 1000) return epoch * 1000;
  }

  const xReset = get('x-ratelimit-reset');
  if (xReset) {
    const epoch = Number(xReset);
    if (Number.isFinite(epoch) && epoch > Date.now() / 1000) return epoch * 1000;
    const isoDate = Date.parse(xReset);
    if (Number.isFinite(isoDate) && isoDate > Date.now()) return isoDate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record that a provider+label combination is currently rate-limited.
 *
 * Parses the reset time from HTTP response headers when available, then
 * falls back to `defaultCooldownSeconds` (default 300 s).  Writes state to
 * `${cleoHomeDir()}/rate-limit-state/<provider>-<label>.json` so that ALL
 * CLEO processes (sentient daemon, CLI calls, auxiliary router) see the same
 * cooldown — preventing pile-on retries from independent sessions.
 *
 * Port of Hermes' `agent/nous_rate_guard.py:record_nous_rate_limit`
 * (generalized for any provider).
 *
 * @param provider - LLM provider identifier (e.g. `'anthropic'`).
 * @param label    - Credential label (e.g. `'personal'`).
 * @param opts     - Optional header map and fallback cooldown seconds.
 *
 * @task T9273
 */
export async function recordRateLimit(
  provider: string,
  label: string,
  opts?: {
    /** HTTP response headers (parses x-ratelimit-reset, retry-after). */
    headers?: Headers | Record<string, string>;
    /** Default cooldown seconds if no header present (default 300). */
    defaultCooldownSeconds?: number;
  },
): Promise<void> {
  const now = Date.now();
  const defaultMs = (opts?.defaultCooldownSeconds ?? 300) * 1000;

  let resetAt: number;
  let source: 'header' | 'default';

  if (opts?.headers) {
    const headerReset = parseResetFromHeaders(opts.headers);
    if (headerReset !== null && headerReset > now) {
      resetAt = headerReset;
      source = 'header';
    } else {
      resetAt = now + defaultMs;
      source = 'default';
    }
  } else {
    resetAt = now + defaultMs;
    source = 'default';
  }

  const filePath = rateLimitStatePath(provider, label);
  const dir = join(cleoHomeDir(), 'rate-limit-state');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const state: RateLimitState = { resetAt, recordedAt: now, source };

  // Use withFileLock for cross-process safety, then writeJsonFileAtomic for
  // the actual write. We do NOT use `withLock` here because that helper
  // reads the file before writing and will fail on the empty sentinel it
  // creates — our write-only pattern needs a simpler lock + atomic-write.
  await withFileLock(filePath, () => {
    writeJsonFileAtomic(filePath, state);
  });
}

/**
 * Return remaining seconds until the rate-limit clears, or `null` if not active.
 *
 * Stale state files (reset_at in the past) are treated as cleared —
 * the file is NOT deleted here to avoid a lock-delete race; `pick()` callers
 * may clean up with `clearRateLimit` after a successful request.
 *
 * Port of Hermes' `agent/nous_rate_guard.py:nous_rate_limit_remaining`.
 *
 * @param provider - LLM provider identifier (e.g. `'anthropic'`).
 * @param label    - Credential label (e.g. `'personal'`).
 * @returns Seconds remaining (positive float) or `null` if guard is inactive.
 *
 * @task T9273
 */
export async function rateLimitRemaining(provider: string, label: string): Promise<number | null> {
  const filePath = rateLimitStatePath(provider, label);
  const state = readJsonFile<RateLimitState>(filePath);
  if (!state) return null;

  const remaining = (state.resetAt - Date.now()) / 1000;
  if (remaining > 0) return remaining;

  // Expired — state is stale; treat as inactive (don't block on clean-up).
  return null;
}

/**
 * Clear the rate-limit state for a provider+label.
 *
 * Idempotent — succeeds even if no state file exists.
 *
 * Port of Hermes' `agent/nous_rate_guard.py:clear_nous_rate_limit`.
 *
 * @param provider - LLM provider identifier (e.g. `'anthropic'`).
 * @param label    - Credential label (e.g. `'personal'`).
 *
 * @task T9273
 */
export async function clearRateLimit(provider: string, label: string): Promise<void> {
  const filePath = rateLimitStatePath(provider, label);
  try {
    unlinkSync(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Surface unexpected errors (permissions, etc.) but swallow ENOENT.
      throw err;
    }
  }
}

/**
 * Ensure the rate-limit-state directory exists.
 *
 * Called lazily by consumers that need the directory without writing a file.
 * Re-exported for test setup.
 *
 * @internal
 * @task T9273
 */
export function ensureRateLimitStateDir(): string {
  const dir = join(cleoHomeDir(), 'rate-limit-state');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
