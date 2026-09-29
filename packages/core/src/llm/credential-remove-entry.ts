/**
 * Remove one credential from the unified pool: the logic behind
 * `cleo auth remove <provider> <label>` and `cleo logout <provider> [label]`.
 *
 * 1. Resolve the entry from the pool (`list()` is a pure store read).
 * 2. Dispatch to the per-source {@link RemovalStep} (never deletes files CLEO
 *    does not own).
 * 3. Persist suppression when the step asks for it, so the next seed pass
 *    does not re-import the entry.
 * 4. Drop the entry from `llm-credentials.json`.
 *
 * Failures are returned, not thrown, with the exit code and remedy the CLI
 * has always emitted for them.
 *
 * @task T9416
 * @task T12712
 */

import { getCredentialPool } from './credential-pool.js';
import { addSuppression, REMOVAL_REGISTRY } from './credential-removal.js';
import type { SeederSourceId } from './credential-seeders/index.js';
import { removeCredential } from './credentials-store.js';

/** Every seeder source id, for narrowing the store's untyped `source` field. */
const SEEDER_SOURCE_IDS: ReadonlySet<string> = new Set<SeederSourceId>([
  'env',
  'claude-code', // llm-resolve-allowed: seeder source id, not a model
  'cleo-pkce',
  'codex-cli',
  'gemini-cli', // llm-resolve-allowed: seeder source id, not a model
  'gh-cli',
  'manual',
  'cli-input',
]);

/** `true` when `source` names a known seeder source. */
function isSeederSourceId(source: string): source is SeederSourceId {
  return SEEDER_SOURCE_IDS.has(source);
}

/** What a successful removal did. */
export interface LlmCredentialRemoval {
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

/** Outcome of {@link removeLlmCredential}. */
export type LlmCredentialRemovalOutcome =
  | { ok: true; result: LlmCredentialRemoval }
  | {
      ok: false;
      /** Stable error code. */
      code: 'E_NOT_FOUND' | 'E_AMBIGUOUS_LABEL' | 'E_REMOVAL_NOT_REGISTERED';
      /** Human message. */
      message: string;
      /** Remedy. */
      fix: string;
      /** Process exit code the CLI uses for this failure. */
      exitCode: number;
    };

/**
 * Remove a pool credential by provider and label. When `label` is omitted the
 * provider must have exactly one entry.
 *
 * @param provider - Provider id (e.g. `anthropic`).
 * @param label - Entry label; optional when the provider has a single entry.
 * @returns The removal, or a typed failure.
 */
export async function removeLlmCredential(
  provider: string,
  label?: string,
): Promise<LlmCredentialRemovalOutcome> {
  const entries = (await getCredentialPool().list()).filter((c) => c.provider === provider);
  const matches = label === undefined ? entries : entries.filter((c) => c.label === label);
  const entry = matches[0];
  if (!entry) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message:
        label === undefined
          ? `No credential found for provider='${provider}'`
          : `No credential found for provider='${provider}' label='${label}'`,
      fix: `Run 'cleo auth list' to see active credentials.`,
      exitCode: 4,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'E_AMBIGUOUS_LABEL',
      message: `provider='${provider}' has ${matches.length} credentials: ${matches.map((c) => c.label).join(', ')}`,
      fix: `Name one: 'cleo logout ${provider} <label>'.`,
      exitCode: 6,
    };
  }

  // Legacy entries written before the seeder migration lack a `source`
  // field; the MANUAL_REMOVAL_STEP handles those.
  const sourceId = entry.source ?? 'manual';
  const step = isSeederSourceId(sourceId) ? REMOVAL_REGISTRY.find(sourceId) : undefined;
  if (!step) {
    return {
      ok: false,
      code: 'E_REMOVAL_NOT_REGISTERED',
      message: `No RemovalStep registered for source='${sourceId}' — cannot safely remove '${provider}/${entry.label}'.`,
      fix: 'Open an issue: a credential was seeded from an unknown source.',
      exitCode: 2,
    };
  }

  const stepResult = await step.remove({ provider, label: entry.label });
  let suppressed = false;
  if (stepResult.suppress) {
    addSuppression(provider, step.sourceId);
    suppressed = true;
  }
  const removed = await removeCredential(entry.provider, entry.label);
  return {
    ok: true,
    result: {
      provider,
      label: entry.label,
      source: sourceId,
      removed,
      cleaned: stepResult.cleaned,
      hints: stepResult.hints,
      suppressed,
    },
  };
}
