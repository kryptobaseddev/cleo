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
 * @task T9416
 * @epic E-CONFIG-AUTH-UNIFY (E2b)
 */

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
export interface AuthRemoveResult {
  /** Provider whose entry was removed. */
  provider: string;
  /** Label of the removed entry. */
  label: string;
  /** Source id the entry came from (e.g. `claude-code`). */
  source: string;
  /** `true` if the entry was actually present in the store. */
  removed: boolean;
  /** Absolute filesystem paths the removal step mutated / deleted. */
  cleaned: string[];
  /** Operator-facing follow-up hints surfaced by the removal step. */
  hints: string[];
  /** `true` if `(provider, source)` was added to the suppression list. */
  suppressed: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo auth remove <provider> <label>` — see file-level docstring.
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

    // Lazy import — same rationale as `cleo auth list`.
    const { getCredentialPool } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credential-pool.js'
    );
    const { REMOVAL_REGISTRY, addSuppression } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credential-removal.js'
    );
    const { removeCredential } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/credentials-store.js'
    );

    const pool = getCredentialPool();
    const entries = await pool.list();
    const entry = entries.find((c) => c.provider === provider && c.label === label);

    if (!entry) {
      cliError(`No credential found for provider='${provider}' label='${label}'`, 4, {
        name: 'E_NOT_FOUND',
        fix: `Run 'cleo auth list' to see active credentials.`,
      });
      process.exit(4);
    }

    // Step 1 — dispatch to the per-source RemovalStep. `source` falls back to
    // `'manual'` because legacy entries written before the seeder migration
    // lack a `source` field; the MANUAL_REMOVAL_STEP handles those.
    const sourceId = (entry.source ?? 'manual') as
      | 'env'
      | 'claude-code'
      | 'cleo-pkce'
      | 'codex-cli'
      | 'gemini-cli'
      | 'gh-cli'
      | 'manual';
    const step = REMOVAL_REGISTRY.find(sourceId);

    if (!step) {
      cliError(
        `No RemovalStep registered for source='${sourceId}' — cannot safely remove '${provider}/${label}'.`,
        2,
        {
          name: 'E_REMOVAL_NOT_REGISTERED',
          fix: `Open an issue: a credential was seeded from an unknown source.`,
        },
      );
      process.exit(2);
    }

    const stepResult = await step.remove({ provider, label });

    // Step 2 — surface the per-source side-effects (`cleaned` + `hints`) on
    // stderr. We deliberately route these through stderr so JSON consumers
    // (--json) get the structured envelope on stdout while still seeing the
    // human-facing guidance interleaved with their tool's output.
    for (const path of stepResult.cleaned) {
      process.stderr.write(`cleaned: ${path}\n`);
    }
    for (const hint of stepResult.hints) {
      process.stderr.write(`hint: ${hint}\n`);
    }

    // Step 3 — persist suppression if the removal step asked for it.
    let suppressed = false;
    if (stepResult.suppress) {
      addSuppression(provider, sourceId);
      suppressed = true;
    }

    // Step 4 — drop the entry from `llm-credentials.json`. This is what makes
    // the very next `cleo auth list` reflect the change without waiting for
    // the 60s seed cache to expire.
    const removed = await removeCredential(
      entry.provider, // ModelTransport
      label,
    );

    const result: AuthRemoveResult = {
      provider,
      label,
      source: sourceId,
      removed,
      cleaned: stepResult.cleaned,
      hints: stepResult.hints,
      suppressed,
    };

    cliOutput(result, {
      command: 'auth-remove',
      operation: 'auth.remove',
    });
  },
});
