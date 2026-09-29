/**
 * `cleo logout [nexus | <provider> [label]]` — sign out.
 *
 * - `nexus` (the default): revoke the Cleo Nexus session server-side, then
 *   delete the stored token (`<cleoHome>/nexus-credentials.json`). The local
 *   token is deleted even when the revocation call fails; the envelope says so.
 * - `<provider> [label]`: remove an LLM credential through the SAME logic as
 *   `cleo auth remove` (per-source removal step, suppression, store delete).
 *   The label may be omitted when the provider has a single credential.
 *
 * Thin handler: the flows live in `@cleocode/core/cloud/nexus-auth.js` and
 * `@cleocode/core/llm/credential-remove-entry.js`.
 *
 * @module cli/commands/logout
 * @task T12712
 */

import type { NexusLogoutResult } from '@cleocode/contracts';
import { NEXUS_LOGIN_TARGET } from '@cleocode/contracts';
import { defineCommand } from '../lib/define-cli-command.js';
import {
  emitNexusResult,
  failNexus,
  NEXUS_API_URL_ARG,
  nexusApiUrlArg,
} from '../lib/nexus-account-cli.js';
import { emitLlmCredentialRemoval } from './auth/remove.js';

/**
 * One human line for a Nexus logout.
 *
 * @param r - Logout result.
 * @returns Summary line.
 */
export function nexusLogoutSummary(r: NexusLogoutResult): string {
  if (!r.removedLocally) return `Not signed in to ${r.apiUrl}; nothing to do.`;
  const server =
    r.revocation === 'revoked'
      ? 'session revoked'
      : r.revocation === 'already-invalid'
        ? 'session was already invalid'
        : 'server-side revocation FAILED (the session ends when it expires)';
  return `Signed out of ${r.apiUrl}: ${server}; local token deleted.`;
}

/**
 * `cleo logout` — sign out of Cleo Nexus or remove an LLM credential.
 *
 * @task T12712
 */
export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description:
      'Sign out. cleo logout [nexus] revokes the Cleo Nexus session server-side and deletes the stored token; cleo logout <provider> [label] removes an LLM credential exactly like cleo auth remove (the label may be omitted when the provider has one credential).',
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
    const { logoutFromNexus } = await import(
      /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-auth.js'
    );
    let result: NexusLogoutResult;
    try {
      result = await logoutFromNexus({ apiUrl: nexusApiUrlArg(a) });
    } catch (err) {
      failNexus(err, 'logout.run');
    }
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    emitNexusResult(result, nexusLogoutSummary(result), 'logout', 'logout.run');
  },
});
