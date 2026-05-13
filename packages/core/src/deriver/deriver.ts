/**
 * Deriver — Main Derivation Logic
 *
 * Processes a single claimed deriver queue item and writes derived outputs
 * to the appropriate BRAIN tables. Each item type has a dedicated derivation
 * function.
 *
 * Derived observations always carry:
 *   - level='inductive'
 *   - provenanceClass='deriver-synthesized' (M6 gate, T1260 E3)
 *   - source_ids=[sourceItemId] (lineage tracking)
 *   - sourceType='deriver'
 *
 * LLM calls: routed through `resolveLLMForRole('derivation')` (T9255) so
 * the provider + model + credential come from
 * `config.llm.roles.derivation` → `config.llm.default` → `config.llm.daemon`
 * → implicit fallback. If no credential is reachable, derivation falls back
 * to a deterministic title-concatenation summary. No LLM = silent degrade
 * (no throw).
 *
 * @task T1145
 * @epic T1145
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import type { ClaimedItem } from './queue-manager.js';

// ============================================================================
// Constants
// ============================================================================

/** Source type tag written to brain_observations for deriver results. */
const DERIVER_SOURCE = 'deriver';

/** Default quality score for deriver-synthesized observations. */
const DERIVER_QUALITY_SCORE = 0.72;

/** Max source observations to synthesize per batch. */
const MAX_SOURCE_OBS = 20;

// ============================================================================
// Types
// ============================================================================

/** Result of a single derivation pass. */
export interface DerivationResult {
  /** Item ID from the deriver_queue. */
  queueItemId: string;
  /** Whether the derivation produced new output. */
  produced: boolean;
  /** ID of the synthesized brain_observations row (if produced). */
  outputObservationId?: string;
  /** Human-readable reason if no output was produced. */
  skipReason?: string;
}

/** Options for {@link deriveItem}. */
export interface DeriveOptions {
  /** Inject a DatabaseSync for testing without touching the real brain.db. */
  db?: DatabaseSync | null;
  /**
   * Absolute path to the project root. Forwarded to
   * `resolveLLMForRole('derivation')` so the derivation LLM picks up
   * project-config (`llm.roles.derivation`) and project-scoped credential
   * tiers. Defaults to `process.cwd()` when omitted.
   *
   * @task T9255
   */
  projectRoot?: string;
}

// ============================================================================
// Internal row types
// ============================================================================

interface RawObsRow {
  id: string;
  title: string | null;
  narrative: string | null;
  type: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a new observation ID following O-<hex> pattern. */
function generateObsId(): string {
  return `O-${randomBytes(4).toString('hex')}`;
}

/**
 * Resolve the derivation LLM client + model via
 * `resolveAnthropicForRole('derivation')` (T9255 + T-LLM-CRED Phase 2 DRY
 * review P2-1). Lazy-imports the helper so test environments that never
 * reach the LLM path don't load the SDK.
 *
 * Returns null when no Anthropic credential is reachable.
 *
 * The return type is the helper's native `Pick<Anthropic, 'messages'>` —
 * downstream call-sites use the SDK's own `messages.create(...)` signature
 * (concrete request shape, properly typed response) rather than the
 * previous `(req: unknown) => Promise<unknown>` opaque-cast surface.
 */
async function resolveDeriverLlm(projectRoot: string | undefined): Promise<{
  client: Pick<import('@anthropic-ai/sdk').default, 'messages'>;
  model: string;
} | null> {
  try {
    const { resolveAnthropicForRole } = await import('../llm/role-resolver.js');
    const llm = await resolveAnthropicForRole('derivation', { projectRoot });
    if (!llm) return null;
    return { client: llm.client, model: llm.model };
  } catch {
    return null;
  }
}

/**
 * Deterministic fallback synthesis: concatenate titles of source observations.
 * Used when no LLM backend is available.
 */
function deterministicSynthesis(sourceRows: RawObsRow[]): string {
  const titles = sourceRows.map((r) => r.title ?? '(untitled)').filter(Boolean);
  return `Synthesized from ${titles.length} observations: ${titles.slice(0, 5).join('; ')}${titles.length > 5 ? ` …and ${titles.length - 5} more` : ''}.`;
}

// ============================================================================
// Derivation handlers
// ============================================================================

/**
 * Derive an inductive synthesis from a source observation and its cluster.
 *
 * Fetches the source observation plus up to MAX_SOURCE_OBS recent observations
 * of the same type. Produces one new `brain_observations` row with `level='inductive'`.
 *
 * @task T1145
 */
async function deriveFromObservation(
  queueItemId: string,
  sourceId: string,
  nativeDb: DatabaseSync,
  projectRoot: string | undefined,
): Promise<DerivationResult> {
  // Fetch the source observation
  const sourceRow = nativeDb
    .prepare(`SELECT id, title, narrative, type FROM brain_observations WHERE id = ?`)
    .get(sourceId) as RawObsRow | undefined;

  if (!sourceRow) {
    return { queueItemId, produced: false, skipReason: `source observation ${sourceId} not found` };
  }

  // Fetch sibling observations of the same type (cluster context)
  const siblings = nativeDb
    .prepare(
      `SELECT id, title, narrative, type FROM brain_observations
       WHERE type = ? AND id != ?
         AND (level IS NULL OR level = 'explicit')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(sourceRow.type, sourceId, MAX_SOURCE_OBS - 1) as unknown as RawObsRow[];

  const allSources = [sourceRow, ...siblings];

  // Attempt LLM synthesis; fall back to deterministic on failure.
  // Provider + model + credential routed through `resolveLLMForRole('derivation')`
  // (T9255). Test environments that never inject a project root rely on the
  // default `process.cwd()` to pick up the project config.
  let synthesisText: string;
  const resolved = await resolveDeriverLlm(projectRoot);

  if (resolved) {
    try {
      const prompt = `You are a memory synthesizer. Given these ${allSources.length} observations, produce ONE concise inductive insight (2-3 sentences) that captures the key pattern or learning:\n\n${allSources
        .slice(0, 10)
        .map((r, i) => `${i + 1}. ${r.title ?? ''}: ${(r.narrative ?? '').slice(0, 200)}`)
        .join('\n')}\n\nProvide only the synthesis text, no preamble.`;

      const msg = await resolved.client.messages.create({
        model: resolved.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = msg.content.find((b) => b.type === 'text');
      synthesisText =
        textBlock?.type === 'text' && typeof textBlock.text === 'string'
          ? textBlock.text.trim()
          : deterministicSynthesis(allSources);
    } catch {
      synthesisText = deterministicSynthesis(allSources);
    }
  } else {
    synthesisText = deterministicSynthesis(allSources);
  }

  const outputId = generateObsId();
  const now = new Date().toISOString();
  const sourceIdsJson = JSON.stringify(allSources.map((r) => r.id));

  nativeDb
    .prepare(
      `INSERT INTO brain_observations
         (id, type, title, narrative, source_type, quality_score, memory_tier,
          created_at, level, source_ids, times_derived, provenance_class)
       VALUES (?, ?, ?, ?, ?, ?, 'short', ?, 'inductive', ?, 1, 'deriver-synthesized')`,
    )
    .run(
      outputId,
      sourceRow.type,
      `[Deriver] Inductive synthesis from ${allSources.length} ${sourceRow.type} observations`,
      synthesisText,
      DERIVER_SOURCE,
      DERIVER_QUALITY_SCORE,
      now,
      sourceIdsJson,
    );

  return { queueItemId, produced: true, outputObservationId: outputId };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Process a single claimed deriver queue item.
 *
 * Dispatches to the appropriate derivation handler based on `item.itemType`.
 * Never throws — all errors are caught and returned as `produced: false`.
 *
 * @param item    - The claimed queue item.
 * @param options - Optional db injection for tests.
 * @returns DerivationResult with the output observation ID if successful.
 *
 * @task T1145
 */
export async function deriveItem(
  item: ClaimedItem,
  options: DeriveOptions = {},
): Promise<DerivationResult> {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();

  if (!nativeDb) {
    return { queueItemId: item.id, produced: false, skipReason: 'no database' };
  }

  try {
    switch (item.itemType) {
      case 'observation': {
        return await deriveFromObservation(item.id, item.itemId, nativeDb, options.projectRoot);
      }
      case 'session':
      case 'narrative':
      case 'embedding':
        // Future: session narrative + embedding derivation
        return {
          queueItemId: item.id,
          produced: false,
          skipReason: `item type '${item.itemType}' not yet implemented`,
        };
      default:
        return {
          queueItemId: item.id,
          produced: false,
          skipReason: `unknown item type: ${item.itemType}`,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { queueItemId: item.id, produced: false, skipReason: `error: ${msg}` };
  }
}
