/**
 * `cleo auth remove <provider> <label>` — invoke the source-specific
 * {@link RemovalStep} for a credential, persist suppression so the next pool
 * seed does NOT re-import it, and drop the entry from
 * `llm-credentials.json`.
 *
 * Flow (per E-CONFIG-AUTH-UNIFY E2b §5.2 T-E2-8 + E2-MUST-012):
 *
 *   1. Resolve the entry from the unified pool's `list()` so we can dispatch
 *      on its `source`.
 *   2. Look up the `RemovalStep` for that source via `REMOVAL_REGISTRY.find`.
 *   3. Invoke `step.remove({ provider, label })`; surface `cleaned` + `hints`
 *      to stderr.
 *   4. If `result.suppress` is true, call `addSuppression(provider, sourceId)`
 *      so the next `seed()` pass skips that source for this provider.
 *   5. Drop the entry from the store via `removeCredential(provider, label)`.
 *
 * The store mutation in step 5 is what makes the change visible to the very
 * next `cleo auth list` invocation; suppression is what makes it durable
 * across `seed()` re-runs (env / claude-code / cleo-pkce / etc. would
 * otherwise re-discover the credential and re-seed it on the next call).
 *
 * The flow lives in core (`removeLlmCredential`, T12712) so `cleo logout
 * <provider> [label]` runs the identical removal.
 *
 * @task T9416
 * @task T12712
 * @epic E-CONFIG-AUTH-UNIFY (E2b)
 */

import type {
  LlmCredentialRemoval,
  LlmCredentialRemovalOutcome,
} from '@cleocode/core/llm/credential-remove-entry.js';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../../renderers/index.js';

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * Result envelope for `cleo auth remove`.
 *
 * Reported to stdout as `{ success: true, data: <this> }` when the LAFS
 * envelope is requested (`--json`); the human renderer prints the
 * `removed/cleaned/hints/suppressed` summary directly.
 *
 * @task T9416
 */
export type AuthRemoveResult = LlmCredentialRemoval;

/**
 * Emit a pool-credential removal outcome: the failure envelope and exit code,
 * or the per-source side effects on stderr and the result envelope on stdout.
 * Shared by `cleo auth remove` and `cleo logout <provider>`.
 *
 * @param outcome - Result of `removeLlmCredential`.
 * @param command - Renderer command id.
 * @param operation - LAFS operation id.
 * @task T12712
 */
export function emitLlmCredentialRemoval(
  outcome: LlmCredentialRemovalOutcome,
  command: string,
  operation: string,
): void {
  if (!outcome.ok) {
    cliError(outcome.message, outcome.exitCode, { name: outcome.code, fix: outcome.fix });
    process.exit(outcome.exitCode);
  }
  // Side effects go to stderr so --json consumers get only the envelope on
  // stdout while still seeing the human-facing guidance.
  for (const path of outcome.result.cleaned) process.stderr.write(`cleaned: ${path}\n`);
  for (const hint of outcome.result.hints) process.stderr.write(`hint: ${hint}\n`);
  cliOutput(outcome.result, { command, operation });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo auth remove <provider> <label>` — remove a single credential.
 *
 * @task T9416
 */
export const authRemoveCommand = defineCommand({
  meta: {
    name: 'remove',
    description:
      'Remove a credential by (provider, label) and suppress its source from ' +
      'future re-seeding. Dispatches to the per-source RemovalStep so claude-code ' +
      '(et al.) entries are handled correctly without deleting external files.',
  },
  args: {
    provider: {
      type: 'positional',
      description: 'Provider id (e.g. anthropic, openai, gemini)',
      required: true,
    },
    label: {
      type: 'positional',
      description: 'Label of the credential to remove (unique within provider)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON envelope',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    const provider = String(a['provider'] ?? '');
    const label = String(a['label'] ?? '');

    if (!provider) {
      cliError('provider is required', 6, { name: 'E_INVALID_INPUT' });
      process.exit(6);
    }
    if (!label) {
      cliError('label is required', 6, { name: 'E_INVALID_INPUT' });
      process.exit(6);
    }

    // Lazy import — keeps `--help` fast (same rationale as `cleo auth list`).
    const { removeLlmCredential } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credential-remove-entry.js'
    );
    emitLlmCredentialRemoval(
      await removeLlmCredential(provider, label),
      'auth-remove',
      'auth.remove',
    );
  },
});
