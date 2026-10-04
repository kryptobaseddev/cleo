/**
 * `cleo logout [nexus | <provider> [label]]` — sign out.
 *
 * - `nexus` (the default): sign out every stored device credential (E9), or
 *   with `--revoke` revoke it (E10), and sign out a leftover 9.24 session
 *   (`nexus-credentials.json`). Nothing is reported done until the server
 *   confirms it (device contract §3.5, T12870). Runs whatever
 *   `CLEO_NEXUS_DEVICE` says, so the switch never hides a live credential.
 * - `<provider> [label]`: remove an LLM credential through the SAME logic as
 *   `cleo auth remove` (per-source removal step, suppression, store delete).
 *   The label may be omitted when the provider has a single credential.
 *
 * Thin handler: the flows live in `@cleocode/core/cloud/nexus-logout.js` and
 * `@cleocode/core/llm/credential-remove-entry.js`.
 *
 * @module cli/commands/logout
 * @task T12712
 */

import { NEXUS_LOGIN_TARGET } from '@cleocode/contracts/nexus-account.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { NEXUS_API_URL_ARG, runNexusDeviceLogout } from '../lib/nexus-account-cli.js';
import { emitLlmCredentialRemoval } from './auth/remove.js';

/**
 * `cleo logout` — sign out of Cleo Nexus or remove an LLM credential.
 *
 * @task T12712
 */
export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description:
      'Sign out. cleo logout [nexus] signs this machine out of Cleo Nexus (the device keeps its id for the next login; --revoke burns it), confirmed by the server; cleo logout <provider> [label] removes an LLM credential exactly like cleo auth remove (the label may be omitted when the provider has one credential).',
  },
  args: {
    target: {
      type: 'positional',
      description: "'nexus' (default) or an LLM provider id (e.g. anthropic).",
      required: false,
    },
    label: {
      type: 'positional',
      description: 'LLM credential label (optional when the provider has one credential).',
      required: false,
    },
    'api-url': NEXUS_API_URL_ARG,
    revoke: {
      type: 'boolean',
      description:
        'Hard-revoke this device: destroys its key grant and burns the device id; the next login enrols a new device. Without it, logout signs the device out and keeps it for the next login.',
    },
    json: { type: 'boolean', description: 'Output as JSON envelope' },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    const target =
      typeof a['target'] === 'string' && a['target'] ? a['target'] : NEXUS_LOGIN_TARGET;
    if (target !== NEXUS_LOGIN_TARGET) {
      const label = typeof a['label'] === 'string' && a['label'] ? a['label'] : undefined;
      const { removeLlmCredential } = await import(
        /* webpackIgnore: true */ '@cleocode/core/llm/credential-remove-entry.js'
      );
      emitLlmCredentialRemoval(await removeLlmCredential(target, label), 'logout', 'logout.run');
      return;
    }
    // Always the device logout: it ends every stored device credential and
    // signs out a leftover 9.24 session too, whatever CLEO_NEXUS_DEVICE says,
    // so the switch can never hide a live credential (T12904 review M2).
    await runNexusDeviceLogout(a);
  },
});
