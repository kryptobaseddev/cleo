/**
 * `cleo auth list` — unified view of every credential the unified credential
 * pool has discovered, across every seeder source (env, claude-code, cleo-pkce,
 * codex-cli, gemini-cli, gh-cli, manual).
 *
 * Sister command to `cleo llm list` — the LLM-scoped command continues to read
 * the redacted `llm-credentials.json` store directly, while `cleo auth list`
 * triggers a `seed()` pass first so the user sees the same set the resolver
 * would see on the next pick.
 *
 * Tokens are NEVER surfaced — every row reports only the last-4-char preview
 * baked into `StoredCredential` (via the `accessToken` suffix display logic in
 * the renderer below).
 *
 * @task T9416
 * @epic E-CONFIG-AUTH-UNIFY (E2b)
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { cliOutput } from '../../renderers/index.js';

// ---------------------------------------------------------------------------
// Public types — kept local because they are shaped by the auth CLI surface,
// not part of the cross-package credential contract.
// ---------------------------------------------------------------------------

/**
 * One row in `cleo auth list` output.
 *
 * Mirrors the columns documented in T9416 / §5.2 T-E2-8: provider, label,
 * source, authType, expiry status, current-default flag.
 *
 * @task T9416
 */
export interface AuthListEntry {
  /** Canonical provider name (e.g. `anthropic`). */
  provider: string;
  /** Human-readable label, unique within `provider`. */
  label: string;
  /** Seeder source id (e.g. `claude-code`, `cleo-pkce`, `env`, `manual`). */
  source: string;
  /** Storage-level auth scheme — `api_key`, `oauth`, or `aws_sdk`. */
  authType: string;
  /**
   * Human-readable expiry status:
   *   - `'never'`            — no `expiresAt` field on the entry.
   *   - `'expired'`          — `expiresAt` is in the past.
   *   - `'expires in <Xm>'`  — minutes until `expiresAt` (rounded down).
   *   - `'expires in <Xh>'`  — hours when `> 90` minutes remain.
   *   - `'expires in <Xd>'`  — days when `> 36` hours remain.
   */
  expiryStatus: string;
  /** `true` if this entry is the current default for its provider+label. */
  current: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an `expiresAt` epoch-ms timestamp into a short human-readable string.
 *
 * @param expiresAt - Optional epoch-ms timestamp from a {@link StoredCredential}.
 * @returns Display string per {@link AuthListEntry.expiryStatus}.
 *
 * @internal
 */
function formatExpiry(expiresAt: number | null | undefined): string {
  if (expiresAt == null) return 'never';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'expired';
  const minutes = Math.floor(remaining / 60_000);
  if (minutes <= 90) return `expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours <= 36) return `expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `expires in ${days}d`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo auth list` — print the unified credential view.
 *
 * Behaviour:
 *   1. Resolves `getCredentialPool()` lazily so importing this module never
 *      triggers seeder registration on `cleo --help`.
 *   2. Calls `pool.seed()` (subject to the 60s cache) so the listing reflects
 *      what the resolver would see — without the explicit seed step,
 *      first-run users would see an empty list.
 *   3. Calls `pool.list()` for the actual rows; this is a pure store read.
 *   4. Applies `--provider` filter when supplied.
 *   5. Sorts ascending by `(provider, label)` for deterministic output.
 *
 * @task T9416
 */
export const authListCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List ALL pool entries from ALL sources (env, claude-code, cleo-pkce, ' +
      'codex-cli, gemini-cli, gh-cli, manual). Tokens are never surfaced — ' +
      'use `cleo llm list` for the LLM-scoped view that mirrors the manual store only.',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Filter to a single provider id (e.g. anthropic)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON envelope',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    const providerFilter =
      typeof a['provider'] === 'string' && a['provider'] !== '' ? (a['provider'] as string) : null;

    // Lazy import — keeps `--help` fast and avoids pulling the entire LLM
    // dependency graph for users who never call `cleo auth list`.
    const { getCredentialPool } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credential-pool.js'
    );

    const pool = getCredentialPool();
    // Force a seed pass so the listing matches what `pick()` would return.
    // The pool's internal 60s cache makes repeat calls cheap.
    await pool.seed();

    // T9594 one-shot migration: purge any stale source=gh-cli entries that
    // were persisted before the gh-cli seeder was removed from BUILTIN_SEEDERS.
    // `gh auth token` returns a GitHub PAT (ghp_*/gho_*) which cannot
    // authenticate against api.openai.com — these entries are unusable.
    // Uses pool.list() (pure store read; already called below) so no extra import.
    const allStored = await pool.list();
    const ghCliEntries = allStored.filter((c) => c.source === 'gh-cli');
    if (ghCliEntries.length > 0) {
      const { removeCredential } = await import(
        /* webpackIgnore: true */ '@cleocode/core/llm/credentials-store.js'
      );
      const { addSuppression } = await import(
        /* webpackIgnore: true */ '@cleocode/core/llm/credential-removal.js'
      );
      for (const entry of ghCliEntries) {
        // removeCredential is typed to require a ModelTransport for provider;
        // cast is safe because we are removing an entry that already exists.
        await removeCredential(
          entry.provider as Parameters<typeof removeCredential>[0],
          entry.label,
        );
      }
      // Suppress re-seeding; provider was 'openai' when these entries were created.
      addSuppression('openai', 'gh-cli');
    }

    const stored = allStored.filter((c) => c.source !== 'gh-cli');

    const entries: AuthListEntry[] = stored
      .filter((c) => (providerFilter ? c.provider === providerFilter : true))
      .map((c) => ({
        provider: c.provider,
        label: c.label,
        source: c.source ?? 'manual',
        authType: c.authType,
        expiryStatus: formatExpiry(c.expiresAt),
        // `current` is "is this entry not in active cooldown AND not disabled"
        // — i.e. could it be served right now. A richer notion of "default
        // credential per provider" would require resolver introspection,
        // which lands in a follow-up task.
        current: !c.disabled && (c.lastErrorResetAt == null || c.lastErrorResetAt <= Date.now()),
      }))
      .sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        return p !== 0 ? p : a.label.localeCompare(b.label);
      });

    // T9598: emit a hint when ~/.claude/.credentials.json exists but the
    // claudeCodeConsentGiven flag is false — so operators know they can opt in.
    const claudeCredsPath = join(homedir(), '.claude', '.credentials.json');
    const hint =
      existsSync(claudeCredsPath) && entries.every((e) => e.source !== 'claude-code')
        ? 'Hint: Claude Code OAuth detected at ~/.claude/.credentials.json but consent is off. ' +
          'Run `cleo auth consent --enable-claude-code` to seed it into the pool.'
        : null;

    cliOutput(
      { entries, ...(hint !== null ? { hint } : {}) },
      {
        command: 'auth-list',
        operation: 'auth.list',
      },
    );
  },
});
