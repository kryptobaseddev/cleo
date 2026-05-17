/**
 * DELETE /api/credentials/:provider/:label — remove a credential.
 *
 * Mirrors `cleo auth remove` (T9416):
 *
 *   1. Resolve the pool entry by `(provider, label)` so we can dispatch
 *      on its `source`.
 *   2. Look up the per-source `RemovalStep` via `REMOVAL_REGISTRY.find`.
 *   3. Invoke `step.remove({ provider, label })` to clean up any
 *      filesystem state owned by that source.
 *   4. If `result.suppress` is true, call `addSuppression(provider,
 *      sourceId)` so the next `seed()` pass skips that source.
 *   5. Drop the entry from `llm-credentials.json` via `removeCredential`.
 *
 * The response carries `cleaned[]` (absolute paths the removal step
 * touched) and `hints[]` (operator-facing follow-ups) so the Studio UI
 * can surface them in a toast. NO secret material is included.
 *
 * @task T9426
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-7)
 */

import { getCredentialPool } from '@cleocode/core/llm/credential-pool.js';
import {
  addSuppression,
  REMOVAL_REGISTRY,
  type SuppressionEntry,
} from '@cleocode/core/llm/credential-removal.js';
import { removeCredential } from '@cleocode/core/llm/credentials-store.js';
import { json } from '@sveltejs/kit';
import { err, ok } from '../../../memory/_lafs.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * DELETE response envelope.
 *
 * Mirrors `AuthRemoveResult` from `packages/cleo/src/cli/commands/auth/remove.ts`
 * minus the CLI-specific output flags.
 *
 * @task T9426
 */
export interface RemoveCredentialData {
  provider: string;
  label: string;
  source: string;
  removed: boolean;
  cleaned: string[];
  hints: string[];
  suppressed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Source ids accepted as `RemovalRegistry` keys.
 *
 * Mirrors `SeederSourceId` from `@cleocode/core/llm/credential-seeders` —
 * kept as a closed runtime set so an unknown source id from a legacy
 * entry fails fast with `E_REMOVAL_NOT_REGISTERED` rather than coercing
 * into a wrong handler.
 *
 * @task T9426
 */
const ALLOWED_SOURCE_IDS: ReadonlySet<string> = new Set([
  'env',
  'claude-code',
  'cleo-pkce',
  'codex-cli',
  'gemini-cli',
  'gh-cli',
  'manual',
]);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * DELETE /api/credentials/:provider/:label — see file-level docstring.
 *
 * @task T9426
 */
export const DELETE: RequestHandler = async ({ params }) => {
  const provider = params['provider'];
  const label = params['label'];

  if (!provider || provider.trim().length === 0) {
    return json(err('E_VALIDATION', 'provider path segment is required'), { status: 400 });
  }
  if (!label || label.trim().length === 0) {
    return json(err('E_VALIDATION', 'label path segment is required'), { status: 400 });
  }

  // Step 1 — resolve the entry from the unified pool's `list()`.
  const pool = getCredentialPool();
  const entries = await pool.list();
  const entry = entries.find((c) => c.provider === provider && c.label === label);

  if (!entry) {
    return json(
      err('E_NOT_FOUND', `No credential found for provider='${provider}' label='${label}'`),
      { status: 404 },
    );
  }

  // Step 2 — dispatch to the per-source RemovalStep. Legacy entries
  // without a `source` field fall back to `'manual'` (matches the CLI
  // behaviour in `cleo auth remove`).
  const sourceId = entry.source ?? 'manual';
  if (!ALLOWED_SOURCE_IDS.has(sourceId)) {
    return json(
      err(
        'E_REMOVAL_NOT_REGISTERED',
        `Credential has unknown sourceId='${sourceId}' — cannot dispatch removal.`,
      ),
      { status: 500 },
    );
  }
  // `sourceId` is narrowed by ALLOWED_SOURCE_IDS to one of the closed
  // SeederSourceId literals; the cast satisfies the typed registry API.
  const step = REMOVAL_REGISTRY.find(sourceId as SuppressionEntry['sourceId']);
  if (!step) {
    return json(
      err(
        'E_REMOVAL_NOT_REGISTERED',
        `No RemovalStep registered for source='${sourceId}' — cannot safely remove '${provider}/${label}'.`,
      ),
      { status: 500 },
    );
  }

  const stepResult = await step.remove({ provider, label });

  // Step 3 — persist suppression if the removal step asked for it.
  let suppressed = false;
  if (stepResult.suppress) {
    addSuppression(provider, sourceId as SuppressionEntry['sourceId']);
    suppressed = true;
  }

  // Step 4 — drop the entry from llm-credentials.json. The store's
  // chmod-0600 + atomic-rename invariants apply.
  const removed = await removeCredential(entry.provider, label);

  return json(
    ok<RemoveCredentialData>({
      provider,
      label,
      source: sourceId,
      removed,
      cleaned: stepResult.cleaned,
      hints: stepResult.hints,
      suppressed,
    }),
  );
};
