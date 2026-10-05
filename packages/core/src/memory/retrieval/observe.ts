/**
 * BRAIN Observe — unified write path for observations + embedding backfill.
 *
 * @task T5134
 * @epic T5149
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import type {
  BrainSourceConfidence,
  ObserveBrainParams,
  ObserveBrainResult,
} from '@cleocode/contracts';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import { generateProjectHash } from '../../nexus/hash.js';
import { pushWarning } from '../../output.js';
import { worktreeScope } from '../../paths.js';
import {
  sessionExistsInTasksDb,
  sessionExistsInTasksDbFresh,
} from '../../store/cross-db-cleanup.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import type { BrainMemoryTier } from '../../store/schema/memory-schema.js';
import { getDb } from '../../store/sqlite.js';
import { embedText, ensureEmbeddingProvider, isEmbeddingAvailable } from '../brain-embedding.js';
import { isLongLivedBrainHost } from '../brain-host.js';
import { addGraphEdge, upsertGraphNode } from '../graph-auto-populate.js';
import {
  classifyObservationTypeByKeywords,
  type ObservationTypeChoice,
} from '../observation-type-decision.js';
import { computeObservationQuality } from '../quality-scoring.js';

/** Monotonic counter to prevent ID collisions within the same millisecond. */
let observeSeq = 0;

// ============================================================================
// Auto-link helper
// ============================================================================

/**
 * Auto-link a newly created observation to the currently focused task.
 *
 * Reads taskWork.taskId from the CALLER's BOUND session (T12500) — never the
 * newest active row, which from an unbound terminal is another agent's
 * session and would link this observation to that agent's focused task.
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
  const { resolveBoundSession } = await import('../../store/session-store.js');
  const session = (await resolveBoundSession(projectRoot))?.session ?? null;

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
 * @param execution - Optional captured lifetime for an explicitly guarded direct write.
 * @throws Error when scoped routing, cancellation, or the supported direct-write contract fails.
 * @remarks Scoped direct writes require already-validated input (`_skipGate`) and an
 * explicit writer dispatch (`_skipQueue`). They retain the original payload and commit
 * result without starting optional embeddings, graph, bridge, or task-link work.
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
  execution?: OperationExecutionContext,
): Promise<ObserveBrainResult> {
  if (execution) {
    execution.assertActive();
    if (projectRoot !== execution.identity.projectRoot) {
      throw new Error('Observation root does not match its captured execution');
    }
    if (!params._skipGate || !params._skipQueue) {
      throw new Error(
        'Scoped observation requires validated input and guarded direct writer dispatch',
      );
    }
    const inherited = worktreeScope.getStore()?.execution;
    if (inherited && inherited !== execution) {
      throw new Error('Observation cannot replace its captured execution context');
    }
    if (!inherited) {
      const captured = structuredClone(params);
      return worktreeScope.run(
        {
          worktreeRoot: execution.identity.projectRoot,
          projectHash: generateProjectHash(execution.identity.projectRoot),
          execution,
        },
        () => observeBrain(projectRoot, captured, execution),
      );
    }
  }
  const {
    text,
    title: titleParam,
    type: typeParam,
    askTypeDecision,
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
    _skipQueue,
  } = params;

  if (!text?.trim()) {
    throw new Error('Observation text is required');
  }

  // T10351: route hot-path writes through the single-writer chokepoint.
  // `_skipQueue` is set ONLY when this function is re-entered from inside
  // the writer-thread handler — that recursion must execute the row insert
  // directly (otherwise the worker would post-message itself in a loop).
  if (!_skipQueue) {
    let validatedSourceSessionId = sourceSessionId;
    if (sourceSessionId) {
      let sessionExists: boolean | undefined;
      let tasksDb: Awaited<ReturnType<typeof getDb>> | null = null;
      try {
        tasksDb = await getDb(projectRoot);
        if (await sessionExistsInTasksDb(sourceSessionId, tasksDb)) {
          sessionExists = true;
        }
      } catch {
        // The independent probe below handles a closed shared handle.
      }
      if (sessionExists !== true) {
        try {
          // Validate before crossing the worker boundary, while the caller's
          // project/worktree path context is still authoritative (T12034).
          sessionExists = await sessionExistsInTasksDbFresh(sourceSessionId, tasksDb, projectRoot);
        } catch {
          // Validation unavailable is not proof of absence. Preserve provenance.
        }
      }
      if (sessionExists === false) validatedSourceSessionId = undefined;
    }
    // T12494: no caller type → keywords, or System One in `on` mode — but
    // only for a caller that opted in (`cleo memory observe`); background
    // writers never send content to a provider. Asked here, before the writer
    // queue, so a decision never holds the single writer. Only a System One
    // answer changes the params: `off` and `shadow` leave the type to the
    // writer's keyword pass, exactly as before.
    let choice: ObservationTypeChoice | null = null;
    if (typeParam === undefined && askTypeDecision === true) {
      const { chooseObservationType } = await import('../observation-type-decision.js');
      choice = await chooseObservationType(text, titleParam, { projectRoot });
    }
    const { enqueueBrainWrite } = await import('../brain-writer-thread.js');
    const result = await enqueueBrainWrite({
      kind: 'observe',
      projectRoot,
      params: {
        ...params,
        ...(choice?.source === 'system-one' ? { type: choice.type } : {}),
        askTypeDecision: undefined,
        sourceSessionId: validatedSourceSessionId,
      },
    });
    if (result.kind !== 'observe') {
      throw new Error(`Unexpected writer result kind: ${result.kind}`);
    }
    if (typeParam !== undefined) return { ...result.result, typeSource: 'caller' };
    if (choice && result.result.type === choice.type) {
      return { ...result.result, typeSource: choice.source, typeConfidence: choice.confidence };
    }
    return result.result;
  }

  // T992: Route through verifyCandidate gate unless called internally from
  // storeVerifiedCandidate (which already ran the gate before calling here).
  // Uses verifyCandidate (not verifyAndStore) so dedup check runs without
  // double-writing — this function handles its own storage below.
  if (!_skipGate) {
    const { verifyCandidate } = await import('../extraction-gate.js');
    const title = titleParam ?? text.slice(0, 120);
    const resolvedSourceConf: import('../../store/schema/memory-schema.js').BrainSourceConfidence =
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

  const type = typeParam ?? classifyObservationTypeByKeywords(text);
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
  execution?.assertActive();
  const nativeDb = getBrainNativeDb(projectRoot);

  // Queued observations were validated before crossing the worker boundary.
  // Worker-internal dialectic observations carry their authoritative session ID.
  const validSessionId = sourceSessionId ?? null;

  // Compute quality score from text richness, title length, and T549 source multiplier.
  const qualityScore = computeObservationQuality({
    text,
    title,
    sourceConfidence: resolvedSourceConfidence,
    memoryTier,
  });

  // A durable document proposal has one observation identity across lost replies,
  // process restarts and lease epochs. No mutable attempt or clock enters the key.
  const id = execution?.writeFence
    ? `O-doc-${createHash('sha256')
        .update(
          JSON.stringify([
            execution.identity.projectId,
            execution.identity.operation,
            execution.identity.idempotencyKey,
            execution.writeFence.proposalHash,
          ]),
        )
        .digest('hex')}`
    : `O-${Date.now().toString(36)}-${(observeSeq++ % 1000).toString(36)}`;
  const accessor = await getBrainAccessor(projectRoot);
  execution?.assertActive();

  const row = await accessor.addObservation(
    {
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
      ...(execution?.writeFence
        ? {
            attachmentsJson: attachmentRefs?.length ? JSON.stringify(attachmentRefs) : null,
            origin: origin ?? null,
            provenanceChain: provenanceChain?.length ? JSON.stringify(provenanceChain) : null,
          }
        : {}),
    },
    execution,
  );

  if (execution) {
    // The primary row has committed. Optional enrichment belongs to an explicitly
    // prepared operation; do not launch detached work or convert late cancellation
    // into a false failure for the already-durable observation.
    return { id: row.id, type: row.type, createdAt: row.createdAt };
  }

  // Populate embedding for this observation (T5387) — in a long-lived host only.
  // T13126: loading the local embedding model costs ~280 MB, and a one-shot
  // process paid it on every observe for a single vector. A one-shot process
  // now leaves the row unembedded; `populateEmbeddings` fills it later (an
  // opted-in host's tick, the `cleo session end` background batch, or
  // `cleo backfill`). Until then the observation is found by BM25/FTS5 only.
  // T12314: the availability check happens inside the deferred work, after
  // ensuring a provider exists — registration is free.
  if (isLongLivedBrainHost()) {
    setImmediate(() => {
      void (async () => {
        try {
          if (!(await ensureEmbeddingProvider())) return;
          const vector = await embedText(text);
          if (!vector) return;
          // T13230: inside the writer isolate this IS the chokepoint's handle,
          // so write directly (enqueueBrainWrite there would start a nested
          // manager). On a main thread (a host whose worker is unavailable ran
          // observeBrain inline) the op has already released the lease and the
          // mutex, so the write goes back through the chokepoint.
          if (!isMainThread) {
            if (nativeDb) upsertEmbeddingRowsNative(nativeDb, [{ id, vector }]);
            return;
          }
          const { enqueueBrainWrite } = await import('../brain-writer-thread.js');
          await enqueueBrainWrite({ kind: 'embed', projectRoot, rows: [{ id, vector }] });
        } catch {
          // Silently skip embedding failures — observation is already persisted
        }
      })();
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

/**
 * Upsert computed embeddings into `brain_embeddings` on the given handle.
 *
 * Callers must be the brain single-writer chokepoint: the `embed` write op's
 * handler (`brain-writer-handlers.ts`, worker or inline under the lease and
 * mutex) and the host's observe-time embed, which runs inside the writer.
 *
 * @param nativeDb - The writer's brain handle.
 * @param rows - Observation ids and their vectors.
 * @returns Rows written.
 * @task T13218
 */
export function upsertEmbeddingRowsNative(
  nativeDb: DatabaseSync,
  rows: ReadonlyArray<{ id: string; vector: Float32Array }>,
): number {
  const stmt = nativeDb
    // replace-allowed: brain_embeddings is a vec0 virtual table — never an FK parent, and virtual tables reject UPSERT (T12787)
    .prepare('INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)');
  let written = 0;
  for (const row of rows) {
    stmt.run(row.id, Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength));
    written++;
  }
  return written;
}

/** Result from populateEmbeddings backfill. */
export interface PopulateEmbeddingsResult {
  processed: number;
  skipped: number;
  errors: number;
  /**
   * Why nothing was processed, when nothing was.
   *
   * A bare `{processed: 0, skipped: 0, errors: 0}` is indistinguishable
   * between "everything is already embedded" and "embeddings are switched off
   * or broken" — and for the whole of gh#1217 it silently meant the latter
   * while `brain.embedding.enabled` was true. Reporting the reason is the
   * difference between a no-op and an outage.
   *
   * Absent when work was actually attempted.
   *
   * @task T12129 (gh#1217)
   */
  inactiveReason?: 'no-provider' | 'provider-load-failed' | 'no-brain-db';
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
   * Maximum observations embedded by this call, newest first (T13126). Bounds a
   * background batch so it cannot run for the whole backlog at once.
   * @defaultValue undefined — every unembedded observation.
   */
  limit?: number;
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
  // gh#1217: this check used to be unsatisfiable. `isEmbeddingAvailable()`
  // reported whether the lazy model had ALREADY loaded, and the only thing
  // that loads it is an embed call — which this function is. So the backfill
  // returned 0/0/0 on every run, forever, and said nothing about why.
  // `isAvailable()` is now capability, so this gate means what it reads as:
  // "is there a provider that could do this at all?"
  // T12314: registration is scheduled by a setImmediate in the DB open path,
  // so asking availability first races a registration this process cannot see.
  // Registering costs nothing — the model download happens on first embed.
  const registered = await ensureEmbeddingProvider();
  if (!registered || !isEmbeddingAvailable()) {
    pushWarning({
      code: 'W_EMBEDDINGS_UNAVAILABLE',
      severity: 'warn',
      message: registered
        ? 'Embedding backfill did nothing: the embedding provider is registered but ' +
          'reported itself unavailable, which means a previous load failed in this ' +
          'process (commonly: no cached model and no network for the ~22 MB first-run ' +
          'download). Hybrid search will fall back to FTS5.'
        : 'Embedding backfill did nothing: no embedding provider could be constructed. ' +
          'Check that brain.embedding.enabled is true and that the transformers runtime ' +
          'is installed. Hybrid search will fall back to FTS5.',
    });
    return {
      processed: 0,
      skipped: 0,
      errors: 0,
      inactiveReason: registered ? 'provider-load-failed' : 'no-provider',
    };
  }

  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb(projectRoot);

  if (!nativeDb) {
    return { processed: 0, skipped: 0, errors: 0, inactiveReason: 'no-brain-db' };
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
    ORDER BY o.created_at DESC${options?.limit !== undefined ? ' LIMIT ?' : ''}
  `),
    ...(options?.limit !== undefined ? [Math.max(0, Math.floor(options.limit))] : []),
  );

  const total = rows.length;
  let attempted = 0;

  // T13218: inference runs here, outside the chokepoint; the writes go through
  // it, one `embed` op per batch, so this never writes on a second handle
  // beside the brain writer (worker in a host, lease + mutex elsewhere).
  const { enqueueBrainWrite } = await import('../brain-writer-thread.js');
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const computed: Array<{ id: string; vector: Float32Array }> = [];
    for (const row of batch) {
      try {
        const vector = await embedText(row.narrative || row.title);
        if (vector) computed.push({ id: row.id, vector });
        else skipped++;
      } catch {
        errors++;
      }
      attempted++;
      onProgress?.(attempted, total);
    }
    if (computed.length === 0) continue;
    try {
      const result = await enqueueBrainWrite({ kind: 'embed', projectRoot, rows: computed });
      processed += result.kind === 'embed' ? result.written : 0;
    } catch {
      errors += computed.length;
    }
  }

  return { processed, skipped, errors };
}
