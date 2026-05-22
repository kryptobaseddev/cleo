/**
 * BRAIN Observe — unified write path for observations + embedding backfill.
 *
 * @task T5134
 * @epic T5149
 */

import { createHash } from 'node:crypto';
import type {
  BrainObservationType,
  BrainSourceConfidence,
  ObserveBrainParams,
  ObserveBrainResult,
} from '@cleocode/contracts';
import { sessionExistsInTasksDb } from '../../store/cross-db-cleanup.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import type { BrainMemoryTier } from '../../store/memory-schema.js';
import { getDb } from '../../store/sqlite.js';
import { embedText, isEmbeddingAvailable } from '../brain-embedding.js';
import { addGraphEdge, upsertGraphNode } from '../graph-auto-populate.js';
import { computeObservationQuality } from '../quality-scoring.js';

// ============================================================================
// Observation type classification
// ============================================================================

/** Keyword patterns for auto-classifying observation type from text. */
const TYPE_KEYWORDS: Array<{ keywords: string[]; type: BrainObservationType }> = [
  { keywords: ['bug', 'fix', 'error', 'crash'], type: 'bugfix' },
  { keywords: ['refactor', 'rename', 'extract', 'move'], type: 'refactor' },
  { keywords: ['add', 'create', 'implement', 'new'], type: 'feature' },
  { keywords: ['decide', 'chose', 'pick', 'instead'], type: 'decision' },
  { keywords: ['update', 'change', 'modify', 'upgrade'], type: 'change' },
];

/** Auto-classify observation type from text using keyword matching. */
function classifyObservationType(text: string): BrainObservationType {
  const lower = text.toLowerCase();
  for (const { keywords, type } of TYPE_KEYWORDS) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        return type;
      }
    }
  }
  return 'discovery';
}

/** Monotonic counter to prevent ID collisions within the same millisecond. */
let observeSeq = 0;

// ============================================================================
// Auto-link helper
// ============================================================================

/**
 * Auto-link a newly created observation to the currently focused task.
 *
 * Queries the active session via sessionStatus() and reads taskWork.taskId.
 * If a task is focused, inserts a brain_memory_links row linking the
 * observation to that task with linkType 'produced_by'.
 *
 * All failures are silently swallowed — this is a best-effort side effect.
 *
 * @param projectRoot - Project root directory
 * @param observationId - ID of the newly created observation
 * @param accessor - BrainDataAccessor to use for the link insert
 */
async function autoLinkObservationToTask(
  projectRoot: string,
  observationId: string,
  accessor: Awaited<ReturnType<typeof getBrainAccessor>>,
): Promise<void> {
  const { sessionStatus } = await import('../../sessions/index.js');
  const session = await sessionStatus(projectRoot, {});

  if (!session) return;

  const taskId = session.taskWork?.taskId;
  if (!taskId) return;

  await accessor.addLink({
    memoryType: 'observation',
    memoryId: observationId,
    taskId,
    linkType: 'produced_by',
  });
}

// ============================================================================
// observeBrain — unified save
// ============================================================================

/**
 * Save an observation to the BRAIN observations table.
 * Replaces the external claude-mem save_observation pattern.
 *
 * Auto-classifies type from text if not provided. Generates a
 * unique ID with O- prefix + base36 timestamp.
 *
 * @param projectRoot - Project root directory
 * @param params - Observation data
 * @returns Created observation ID, type, and timestamp
 *
 * @example
 * ```ts
 * // Save a decision observation to the BRAIN.
 * // The result contains the auto-generated ID, classified type, and timestamp.
 * const result = await observeBrain('/path/to/project', {
 *   text: 'Decided to use ESM-only imports for better tree-shaking.',
 *   title: 'ESM-only import decision',
 *   type: 'decision',
 *   sourceType: 'session-debrief',
 * });
 *
 * console.assert(result.id.startsWith('O-'), 'ID uses O- prefix');
 * console.assert(result.type === 'decision', 'type preserved from params');
 * console.assert(typeof result.createdAt === 'string', 'createdAt is ISO timestamp');
 * ```
 */
export async function observeBrain(
  projectRoot: string,
  params: ObserveBrainParams,
): Promise<ObserveBrainResult> {
  const {
    text,
    title: titleParam,
    type: typeParam,
    project,
    sourceSessionId,
    sourceType,
    agent,
    sourceConfidence: sourceConfidenceParam,
    crossRef,
    attachmentRefs,
    origin,
    provenanceChain,
    _skipGate,
  } = params;

  if (!text?.trim()) {
    throw new Error('Observation text is required');
  }

  // T992: Route through verifyCandidate gate unless called internally from
  // storeVerifiedCandidate (which already ran the gate before calling here).
  // Uses verifyCandidate (not verifyAndStore) so dedup check runs without
  // double-writing — this function handles its own storage below.
  if (!_skipGate) {
    const { verifyCandidate } = await import('../extraction-gate.js');
    const title = titleParam ?? text.slice(0, 120);
    const resolvedSourceConf: import('../../store/memory-schema.js').BrainSourceConfidence =
      sourceConfidenceParam ??
      (sourceType === 'manual'
        ? 'owner'
        : sourceType === 'session-debrief'
          ? 'task-outcome'
          : 'agent');
    const gateResult = await verifyCandidate(projectRoot, {
      text,
      title,
      memoryType: 'episodic',
      tier: 'short',
      confidence: 0.6,
      source: sourceType === 'manual' ? 'manual' : 'transcript',
      sourceSessionId,
      sourceConfidence: resolvedSourceConf,
      trusted: resolvedSourceConf === 'owner' || resolvedSourceConf === 'task-outcome',
    });
    if (gateResult.action !== 'stored') {
      // Gate merged, rejected, or queued — return the existing/null id
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      return {
        id: gateResult.id ?? `O-gate-${Date.now().toString(36)}`,
        type: typeParam ?? 'observation',
        createdAt: now,
      };
    }
    // Gate approved — fall through to native storage below (no recursion needed).
  }

  const type = typeParam ?? classifyObservationType(text);
  const title = titleParam ?? text.slice(0, 120);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // T549 Wave 1-A: Tier routing for observations.
  // sourceConfidence routing (spec §4.1 Decision Tree):
  //   - sourceType 'manual' → 'owner' (owner-stated facts skip short-term in consolidator)
  //   - sourceType 'session-debrief' → 'task-outcome' (synthesized summaries)
  //   - otherwise → 'agent' (default for all hook/agent writes)
  const resolvedSourceConfidence: BrainSourceConfidence =
    sourceConfidenceParam ??
    (sourceType === 'manual'
      ? 'owner'
      : sourceType === 'session-debrief'
        ? 'task-outcome'
        : 'agent');

  // T794 BRAIN-05: retention floor — auto-promote to 'medium' when the observation
  // references multiple tasks or has explicit cross-references.
  const taskIdMatches = text.match(/T\d+/g) ?? [];
  const distinctTaskIds = new Set(taskIdMatches);
  const hasMultipleTaskRefs = distinctTaskIds.size >= 2;
  const hasCrossRef = Array.isArray(crossRef) && crossRef.length >= 1;
  const memoryTier: BrainMemoryTier = hasMultipleTaskRefs || hasCrossRef ? 'medium' : 'short';
  const memoryType = 'episodic' as const;
  const verified =
    resolvedSourceConfidence === 'owner' || resolvedSourceConfidence === 'task-outcome';

  // Content hash for storage (used by addObservation to populate content_hash column).
  // T992: Hash matches contentHashPrefix() in extraction-gate.ts (text-only, normalized)
  // so verifyCandidate's hash-dedup lookup finds the stored row correctly.
  const contentHash = createHash('sha256')
    .update(text.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);

  // Load native DB handle for later embedding write (fire-and-forget).
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();

  // Write-guard: validate cross-db session reference before inserting
  let validSessionId = sourceSessionId ?? null;
  if (validSessionId) {
    try {
      const tasksDb = await getDb(projectRoot);
      if (!(await sessionExistsInTasksDb(validSessionId, tasksDb))) {
        validSessionId = null;
      }
    } catch {
      // Best-effort: if tasks.db unavailable, null out the reference
      validSessionId = null;
    }
  }

  // Compute quality score from text richness, title length, and T549 source multiplier.
  const qualityScore = computeObservationQuality({
    text,
    title,
    sourceConfidence: resolvedSourceConfidence,
    memoryTier,
  });

  const id = `O-${Date.now().toString(36)}-${(observeSeq++ % 1000).toString(36)}`;
  const accessor = await getBrainAccessor(projectRoot);

  const row = await accessor.addObservation({
    id,
    type,
    title,
    narrative: text,
    contentHash,
    project: project ?? null,
    sourceSessionId: validSessionId,
    sourceType: sourceType ?? 'agent',
    agent: agent ?? null,
    qualityScore,
    createdAt: now,
    // T549 Wave 1-A: tier/type/confidence assigned at write time
    memoryTier,
    memoryType,
    sourceConfidence: resolvedSourceConfidence,
    verified,
    // T799: optional attachment refs stored as JSON array
    ...(attachmentRefs && attachmentRefs.length > 0
      ? { attachmentsJson: JSON.stringify(attachmentRefs) }
      : {}),
    // T1897: provenance trust columns
    ...(origin != null ? { origin } : {}),
    ...(provenanceChain && provenanceChain.length > 0
      ? { provenanceChain: JSON.stringify(provenanceChain) }
      : {}),
  });

  // Populate embedding if provider is available (T5387).
  // Fire-and-forget: embedding runs in the background so it never blocks the CLI.
  if (isEmbeddingAvailable()) {
    setImmediate(() => {
      embedText(text)
        .then((vector) => {
          if (vector && nativeDb) {
            nativeDb
              .prepare('INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)')
              .run(id, Buffer.from(vector.buffer));
          }
        })
        .catch(() => {
          // Silently skip embedding failures — observation is already persisted
        });
    });
  }

  // Regenerate memory bridge for high-value observation types (T5240).
  // Only learning and decision types trigger bridge refresh to avoid excessive writes.
  if (type === 'decision') {
    import('../memory-bridge.js')
      .then(({ refreshMemoryBridge }) => refreshMemoryBridge(projectRoot))
      .catch(() => {
        /* Memory bridge refresh is best-effort */
      });
  }

  // Auto-link observation to the currently focused task when a session is active. (T141)
  // This is a fire-and-forget side effect — linking failure MUST NOT block the return.
  if (validSessionId) {
    autoLinkObservationToTask(projectRoot, row.id, accessor).catch(() => {
      /* Auto-linking is best-effort */
    });
  }

  // Auto-populate graph node + edges for this observation (best-effort, T537).
  try {
    await upsertGraphNode(
      projectRoot,
      `observation:${row.id}`,
      'observation',
      row.title.substring(0, 200),
      row.qualityScore ?? 0.5,
      row.narrative ?? row.title,
      { sourceType: row.sourceType, agent: row.agent ?? undefined },
    );

    // Link observation → session when the observation has a session context.
    if (validSessionId) {
      await upsertGraphNode(
        projectRoot,
        `session:${validSessionId}`,
        'session',
        validSessionId,
        0.8,
        '',
      );
      await addGraphEdge(
        projectRoot,
        `observation:${row.id}`,
        `session:${validSessionId}`,
        'produced_by',
        1.0,
        'auto:observe',
      );
    }
  } catch {
    /* Graph population is best-effort — never block the primary return */
  }

  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt,
  };
}

// ============================================================================
// Embedding Backfill Pipeline (T5387)
// ============================================================================

/** Result from populateEmbeddings backfill. */
export interface PopulateEmbeddingsResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * Options for the embedding backfill pipeline.
 *
 * @example
 * ```ts
 * await populateEmbeddings(root, {
 *   batchSize: 25,
 *   onProgress: (current, total) => console.log(`${current}/${total}`),
 * });
 * ```
 */
export interface PopulateEmbeddingsOptions {
  /** Maximum items processed per batch cycle. Defaults to 50. */
  batchSize?: number;
  /**
   * Progress callback invoked after each observation is attempted.
   * `current` is the 1-based count of observations attempted so far;
   * `total` is the full count of observations that need embeddings.
   */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Backfill embeddings for existing observations that lack them.
 *
 * Iterates through observations not yet in brain_embeddings and
 * generates vectors using the registered embedding provider.
 * Processes in batches to avoid memory pressure.
 *
 * An optional {@link PopulateEmbeddingsOptions.onProgress} callback is called
 * after each observation is attempted, enabling callers to report progress.
 *
 * @param projectRoot - Project root directory
 * @param options - Optional batch size and progress callback
 * @returns Count of processed, skipped, and errored observations
 *
 * @epic T134
 * @task T142
 */
export async function populateEmbeddings(
  projectRoot: string,
  options?: PopulateEmbeddingsOptions,
): Promise<PopulateEmbeddingsResult> {
  if (!isEmbeddingAvailable()) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const batchSize = options?.batchSize ?? 50;
  const { onProgress } = options ?? {};
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Find observations without embeddings
  const { typedAll } = await import('../../store/typed-query.js');
  const rows = typedAll<import('../brain-row-types.js').BrainNarrativeRow>(
    nativeDb.prepare(`
    SELECT o.id, o.narrative, o.title
    FROM brain_observations o
    LEFT JOIN brain_embeddings e ON o.id = e.id
    WHERE e.id IS NULL AND o.narrative IS NOT NULL
    ORDER BY o.created_at DESC
  `),
  );

  const total = rows.length;
  let attempted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      try {
        const vector = await embedText(row.narrative || row.title);
        if (vector) {
          nativeDb
            .prepare('INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)')
            .run(row.id, Buffer.from(vector.buffer));
          processed++;
        } else {
          skipped++;
        }
      } catch {
        errors++;
      }
      attempted++;
      onProgress?.(attempted, total);
    }
  }

  return { processed, skipped, errors };
}
