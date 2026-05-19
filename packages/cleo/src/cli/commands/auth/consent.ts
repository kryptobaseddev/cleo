/**
 * `cleo auth consent` — manage consent gates for external credential sources.
 *
 * Implements T9573 audit bug #5 + #6:
 *   - Bug #5: `auth.claudeCodeConsentGiven` had no CLI surface to flip it.
 *   - Bug #6: revoking consent did not purge already-persisted tokens from the pool.
 *
 * Subcommand flags:
 *   --enable-claude-code   Set `auth.claudeCodeConsentGiven=true` in global config
 *                          and remove any `claude-code` suppression entry so the
 *                          seeder runs on the next pool seed.
 *   --disable-claude-code  Set `auth.claudeCodeConsentGiven=false` in global config,
 *                          add `claude-code` suppression, and purge every
 *                          `source:claude-code` entry from the pool.
 *   --status               Print current consent flag values as a JSON envelope.
 *
 * ## Purge-on-revoke (bug #6 fix)
 *
 * When `--disable-claude-code` is issued the command enumerates every entry
 * in the pool whose `source === 'claude-code'` and calls `removeCredential`
 * for each. This prevents a stale token from being served until the
 * suppression's 60-second seed cache expires.
 *
 * @module cleo/commands/auth/consent
 * @task T9598
 * @epic T9587
 */

import type {
  getConfigValue as GetConfigValueFn,
  setConfigValue as SetConfigValueFn,
} from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../../renderers/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result envelope for `cleo auth consent --status`.
 *
 * One gate entry per supported consent flag; additional gates will be added
 * as new external-credential sources are introduced.
 *
 * @task T9598
 */
export interface ConsentStatusResult {
  /** All known consent gate states. */
  gates: ConsentGate[];
}

/**
 * State of a single consent gate.
 *
 * @task T9598
 */
export interface ConsentGate {
  /** Stable identifier for this gate (e.g. `'claudeCode'`). */
  gate: string;
  /** Config key consulted for this flag. */
  configKey: string;
  /** Whether consent is currently granted. */
  enabled: boolean;
  /** Whether the source seeder is suppressed (independent of the consent flag). */
  suppressed: boolean;
}

/**
 * Result envelope for `cleo auth consent --enable-claude-code` /
 * `--disable-claude-code`.
 *
 * @task T9598
 */
export interface ConsentToggleResult {
  /** Which action was performed. */
  action: 'enabled' | 'disabled';
  /** Gate identifier (e.g. `'claudeCode'`). */
  gate: string;
  /** Config key that was written. */
  configKey: string;
  /** Value written to the config. */
  value: boolean;
  /** Whether the suppression entry was added or removed. */
  suppressionChanged: boolean;
  /** Number of pool entries purged (only non-zero on disable). */
  purgedCount: number;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo auth consent` — toggle and inspect Claude Code (and future) consent
 * gates.
 *
 * @task T9598
 */
export const authConsentCommand = defineCommand({
  meta: {
    name: 'consent',
    description:
      'Manage consent gates for external credential sources (e.g. Claude Code OAuth). ' +
      'Use --enable-claude-code / --disable-claude-code to toggle, --status to inspect.',
  },
  args: {
    'enable-claude-code': {
      type: 'boolean',
      description:
        'Grant consent for the claude-code seeder: sets auth.claudeCodeConsentGiven=true ' +
        'in the global config and removes any suppression entry.',
    },
    'disable-claude-code': {
      type: 'boolean',
      description:
        'Revoke consent for the claude-code seeder: sets auth.claudeCodeConsentGiven=false, ' +
        'adds a suppression entry, and purges all source:claude-code entries from the pool.',
    },
    status: {
      type: 'boolean',
      description: 'Print the current state of all consent gates.',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON envelope',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    const enableClaudeCode = a['enable-claude-code'] === true;
    const disableClaudeCode = a['disable-claude-code'] === true;
    const showStatus = a['status'] === true;

    // Must specify exactly one action.
    if (!enableClaudeCode && !disableClaudeCode && !showStatus) {
      cliError('Specify one of --enable-claude-code, --disable-claude-code, or --status.', 6, {
        name: 'E_INVALID_INPUT',
        fix: 'Run `cleo auth consent --status` to see current consent state.',
      });
      process.exit(6);
    }

    if (enableClaudeCode && disableClaudeCode) {
      cliError('--enable-claude-code and --disable-claude-code are mutually exclusive.', 6, {
        name: 'E_INVALID_INPUT',
      });
      process.exit(6);
    }

    // Lazy imports — keeps `--help` fast and avoids pulling the entire LLM
    // dependency graph for users who never call `cleo auth consent`.
    // Type-only aliases are imported at the top of this file so TypeScript
    // can check the call sites; the dynamic import provides the runtime value.
    const configMod = (await import(
      /* webpackIgnore: true */ '@cleocode/core/config.js' as string
    )) as { getConfigValue: typeof GetConfigValueFn; setConfigValue: typeof SetConfigValueFn };
    const getConfigValue = configMod.getConfigValue;
    const setConfigValue = configMod.setConfigValue;
    const { addSuppression, removeSuppression, isSuppressed } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credential-removal.js'
    );

    const CONSENT_KEY = 'auth.claudeCodeConsentGiven';
    const SOURCE_ID = 'claude-code' as const;
    const PROVIDER = 'anthropic';

    // -------------------------------------------------------------------------
    // --status
    // -------------------------------------------------------------------------
    if (showStatus) {
      const resolved = await getConfigValue<boolean | undefined>(CONSENT_KEY);
      const consentEnabled = resolved.value === true;
      const suppressed = isSuppressed(PROVIDER, SOURCE_ID);

      const result: ConsentStatusResult = {
        gates: [
          {
            gate: 'claudeCode',
            configKey: CONSENT_KEY,
            enabled: consentEnabled,
            suppressed,
          },
        ],
      };

      cliOutput(result, {
        command: 'auth-consent-status',
        operation: 'auth.consent.status',
      });
      return;
    }

    // -------------------------------------------------------------------------
    // --enable-claude-code
    // -------------------------------------------------------------------------
    if (enableClaudeCode) {
      await setConfigValue(CONSENT_KEY, true, undefined, { global: true });

      // Remove any existing suppression so the seeder runs on next seed pass.
      const suppressionChanged = removeSuppression(PROVIDER, SOURCE_ID);

      const result: ConsentToggleResult = {
        action: 'enabled',
        gate: 'claudeCode',
        configKey: CONSENT_KEY,
        value: true,
        suppressionChanged,
        purgedCount: 0,
      };

      cliOutput(result, {
        command: 'auth-consent-enable',
        operation: 'auth.consent.enable',
      });
      return;
    }

    // -------------------------------------------------------------------------
    // --disable-claude-code
    // -------------------------------------------------------------------------
    // Set the config flag first so any concurrent seed() call that happens to
    // start before the suppression write also fails the consent check.
    await setConfigValue(CONSENT_KEY, false, undefined, { global: true });

    // Add suppression so future seed() passes never re-import the token.
    const wasAlreadySuppressed = isSuppressed(PROVIDER, SOURCE_ID);
    addSuppression(PROVIDER, SOURCE_ID);
    const suppressionChanged = !wasAlreadySuppressed;

    // Purge all source:claude-code entries that are already in the pool
    // (bug #6 fix — revoke must take effect immediately, not just on next seed).
    const { listCredentials, removeCredential } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credentials-store.js'
    );

    const allEntries = await listCredentials();
    const claudeCodeEntries = allEntries.filter((c) => c.source === SOURCE_ID);

    let purgedCount = 0;
    for (const entry of claudeCodeEntries) {
      const removed = await removeCredential(entry.provider, entry.label);
      if (removed) purgedCount++;
    }

    const result: ConsentToggleResult = {
      action: 'disabled',
      gate: 'claudeCode',
      configKey: CONSENT_KEY,
      value: false,
      suppressionChanged,
      purgedCount,
    };

    cliOutput(result, {
      command: 'auth-consent-disable',
      operation: 'auth.consent.disable',
    });
  },
});
