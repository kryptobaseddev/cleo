/**
 * `llm` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Mirrors Hermes Agent's `setup.py` LLM block:
 *   1. Display the current credential pool snapshot (provider/label/source).
 *   2. Prompt for a provider id (or accept `--provider` non-interactively).
 *   3. Accept an API key via `--api-key` *or* via interactive prompt.
 *   4. Write the result to the credential pool — never to config.
 *
 * V2 additions (T9610):
 *   - `isConfigured()` — returns `true` when pool has at least one entry (LLM-7).
 *   - Bracketed paste sanitization on API key input (LLM-4).
 *   - Pool-seeding consent prompt after key entry (LLM-5).
 *   - Section description printed before prompts (GEN-6).
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.provider` + `options.apiKey`
 *     → write key to pool; no prompts.
 *   - Missing `--provider` or `--api-key` under `--non-interactive` →
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9420
 * @task T9610
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.3
 */

import { setConfigValue } from '../../config.js';
import { getCredentialPool } from '../../llm/credential-pool.js';
import { addCredential } from '../../llm/credentials-store.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/**
 * Provider ids the interactive wizard offers from the menu.
 *
 * Plugin providers are added later in T-E2-3; this list is the safe
 * starter set drawn from `BuiltinProviderId`.
 */
const INTERACTIVE_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'moonshot',
  'deepseek',
  'xai',
  'groq',
  'ollama',
] as const;

/**
 * Providers that support pool seeding consent prompt (LLM-5).
 */
const POOL_SEEDING_PROVIDERS = new Set<string>(['anthropic', 'openrouter']);

/**
 * Resolved authentication mechanism for a freshly entered API key.
 *
 * `'api_key'` covers every provider we wire today; `'oauth_login'` is a
 * sentinel the CLI command (T9421) interprets as "launch `cleo llm
 * login <provider>` instead of writing a raw key".
 */
type LlmAuthMode = 'api_key' | 'oauth_login';

/**
 * Strip bracketed paste mode escape sequences from user input (LLM-4).
 *
 * Terminal emulators wrap pasted content with `\x1b[200~` (start) and
 * `\x1b[201~` (end) when bracketed paste mode is enabled. These must be
 * removed before persisting an API key, otherwise the key will include
 * the raw escape bytes and authentication will fail.
 *
 * @param input - Raw string as received from the readline prompt.
 * @returns Cleaned string with bracketed paste sequences stripped.
 * @internal
 */
function stripBracketedPaste(input: string): string {
  return input.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
}

/**
 * Build the `llm` section runner.
 *
 * Constructed via a factory so unit tests can swap `getCredentialPool`
 * / `addCredential` references via module mocking without touching the
 * production singleton.
 *
 * @returns A {@link WizardSectionRunner} for the LLM section.
 * @task T9420
 * @task T9610
 */
export function createLlmSection(): WizardSectionRunner {
  return {
    section: 'llm',
    title: 'LLM provider + API key',
    optional: false,

    /**
     * Returns `true` when the credential pool has at least one entry (LLM-7).
     *
     * @returns `true` when already configured.
     */
    async isConfigured(_options: WizardOptions): Promise<boolean> {
      try {
        const pool = getCredentialPool();
        const entries = await pool.list();
        return entries.length > 0;
      } catch {
        return false;
      }
    },

    async run(io: WizardIO, options: WizardOptions) {
      // GEN-6: Section description.
      io.info(
        'Configures LLM provider credentials stored in the credential pool (brain.db).\n' +
          'Credentials are never written to config files — they live in the encrypted pool.\n' +
          'Supports: anthropic, openai, gemini, openrouter, moonshot, deepseek, xai, groq, ollama.',
      );

      // 1. Show what's already configured (GEN-7 / LLM-1).
      try {
        const pool = getCredentialPool();
        const entries = await pool.list();
        if (entries.length === 0) {
          io.info('No credentials configured yet.');
        } else {
          io.info(`Current credentials (${entries.length}):`);
          for (const entry of entries) {
            const expiry =
              entry.expiresAt && entry.expiresAt > 0
                ? ` exp=${new Date(entry.expiresAt).toISOString()}`
                : '';
            io.info(
              `  - ${entry.provider}:${entry.label} (${entry.authType}, source=${entry.source ?? 'unknown'})${expiry}`,
            );
          }
        }
      } catch (err) {
        io.warn(
          `Could not list current credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2. Non-interactive path.
      if (options.nonInteractive === true) {
        if (!options.provider || !options.apiKey) {
          return {
            changed: false,
            summary: 'skipped (non-interactive: --provider and --api-key required)',
          };
        }
        const cleanKey = stripBracketedPaste(options.apiKey);
        await persistApiKey(options.provider, cleanKey, options.label ?? 'cli-input');
        // LLM-6: optionally write pool seeding consent.
        if (options.poolSeedingConsent !== undefined) {
          await setConfigValue('auth.poolSeedingConsent', options.poolSeedingConsent, undefined, {
            global: true,
          });
        }
        return {
          changed: true,
          summary: `added ${options.provider}:${options.label ?? 'cli-input'} to pool`,
        };
      }

      // 3. Interactive provider + auth-mode selection.
      const provider = await io.select<(typeof INTERACTIVE_PROVIDERS)[number]>(
        'Which LLM provider do you want to configure?',
        INTERACTIVE_PROVIDERS,
      );

      const authMode = await io.select<LlmAuthMode>(
        'How will CLEO authenticate to this provider?',
        ['api_key', 'oauth_login'] as const,
      );

      if (authMode === 'oauth_login') {
        io.info(
          `OAuth login deferred to 'cleo llm login ${provider}' — run that command after setup.`,
        );
        return {
          changed: false,
          summary: `oauth login deferred for ${provider}`,
        };
      }

      // 4. Interactive API-key entry.
      const label =
        (await io.prompt('Label for this credential [default: cli-input]:')) || 'cli-input';
      const rawApiKey = (await io.prompt('API key (input not echoed in production):')).trim();
      // LLM-4: strip bracketed paste sequences.
      const apiKey = stripBracketedPaste(rawApiKey);
      if (apiKey === '') {
        io.warn('No API key supplied — leaving section unchanged.');
        return { changed: false, summary: 'skipped (empty api key)' };
      }

      await persistApiKey(provider, apiKey, label);

      // LLM-5: Pool-seeding consent for supported providers.
      if (POOL_SEEDING_PROVIDERS.has(provider)) {
        const consent = await io.confirm(
          "Consent to including this key in CLEO's credential pool for multi-agent distribution?",
          false,
        );
        await setConfigValue('auth.poolSeedingConsent', consent, undefined, { global: true });
        io.info(
          `Pool-seeding consent: ${consent ? 'granted' : 'denied'} (saved to auth.poolSeedingConsent)`,
        );
      }

      return { changed: true, summary: `added ${provider}:${label} to pool` };
    },
  };
}

/**
 * Upsert an API-key entry into the credential pool.
 *
 * Keeps the policy "secrets live in the pool, never in config" enforced
 * by routing every write through {@link addCredential}.
 *
 * @internal
 */
async function persistApiKey(provider: string, apiKey: string, label: string): Promise<void> {
  await addCredential({
    // Cast at the boundary: the pool's `provider` is `ModelTransport`,
    // a literal-tagged union — `INTERACTIVE_PROVIDERS` entries already
    // satisfy it. Non-interactive `options.provider` is unconstrained
    // string, so trust the caller to validate before reaching us.
    provider: provider as Parameters<typeof addCredential>[0]['provider'],
    label,
    authType: 'api_key',
    accessToken: apiKey,
    source: 'cli-input',
  });
}
