/**
 * BRAIN writer-thread op handlers.
 *
 * Shared between the worker thread (`brain-writer-worker.ts`) and the
 * inline fallback executor inside `brain-writer-thread.ts`. Each op kind
 * lands here as its terminal SQL/orchestration call; **this is the only
 * module that opens a write handle to brain.db** during normal operation.
 *
 * Read-only callers continue to use `getBrainDb` / `getBrainNativeDb` on
 * the main thread — SQLite WAL allows concurrent readers.
 *
 * @task T10351
 * @epic T10286
 * @saga T10281
 */

import type { ObserveBrainResult } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import type {
  BrainDecisionOp,
  BrainDialecticOp,
  BrainLearningOp,
  BrainObserveOp,
  BrainPlasticityEventOp,
  BrainWeightUpdateOp,
  BrainWriteOp,
  BrainWriteResult,
} from './brain-writer-thread.js';

/**
 * Dispatch a write op to its terminal handler. Throws on failure — the worker
 * envelope code converts the throw into an `ok:false` response.
 *
 * @param op - The discriminated write op.
 * @returns A typed `BrainWriteResult` mirroring the op's `kind`.
 */
export async function handleWriteOp(op: BrainWriteOp): Promise<BrainWriteResult> {
  switch (op.kind) {
    case 'observe':
      return handleObserve(op);
    case 'decision':
      return handleDecision(op);
    case 'learning':
      return handleLearning(op);
    case 'plasticity_event':
      return handlePlasticityEvent(op);
    case 'weight_update':
      return handleWeightUpdate(op);
    case 'dialectic':
      return handleDialectic(op);
    default: {
      // Exhaustiveness check — TS enforces this at compile time.
      const _exhaustive: never = op;
      void _exhaustive;
      throw new Error(`Unknown BrainWriteOp kind: ${JSON.stringify(op)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// observe — full observeBrain pipeline on the writer side.
// ---------------------------------------------------------------------------

async function handleObserve(op: BrainObserveOp): Promise<BrainWriteResult> {
  // T10351: route to the direct-write path inside observeBrain so the
  // chokepoint actually performs the row insert. Passing `_skipQueue: true`
  // signals observeBrain to skip the queue and write directly (preventing
  // an infinite enqueue loop when the worker thread itself calls observeBrain).
  const { observeBrain } = await import('./retrieval/observe.js');
  const result: ObserveBrainResult = await observeBrain(op.projectRoot, {
    ...op.params,
    _skipQueue: true,
  });
  return { kind: 'observe', result };
}

// ---------------------------------------------------------------------------
// decision — insert into brain_decisions via accessor.
// ---------------------------------------------------------------------------

async function handleDecision(op: BrainDecisionOp): Promise<BrainWriteResult> {
  const { getBrainAccessor } = await import('../store/memory-accessor.js');
  const accessor = await getBrainAccessor(op.projectRoot);
  const row = await accessor.addDecision(op.row);
  return { kind: 'decision', id: row.id };
}

// ---------------------------------------------------------------------------
// learning — insert into brain_learnings via accessor.
// ---------------------------------------------------------------------------

async function handleLearning(op: BrainLearningOp): Promise<BrainWriteResult> {
  const { getBrainAccessor } = await import('../store/memory-accessor.js');
  const accessor = await getBrainAccessor(op.projectRoot);
  const row = await accessor.addLearning(op.row);
  return { kind: 'learning', id: row.id };
}

// ---------------------------------------------------------------------------
// plasticity_event — direct INSERT INTO brain_plasticity_events (T679 spec).
// ---------------------------------------------------------------------------

async function handlePlasticityEvent(op: BrainPlasticityEventOp): Promise<BrainWriteResult> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(op.projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) {
    throw new Error('brain native DB unavailable for plasticity_event op');
  }
  const stmt = nativeDb.prepare(
    `INSERT INTO brain_plasticity_events
       (source_node, target_node, delta_w, kind, timestamp,
        session_id, retrieval_log_id, weight_before, weight_after, delta_t_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    op.sourceNode,
    op.targetNode,
    op.deltaW,
    op.eventKind,
    op.timestamp,
    op.sessionId,
    op.retrievalLogId,
    op.weightBefore,
    op.weightAfter,
    op.deltaTms,
  );
  const lastInsertRowid =
    typeof result.lastInsertRowid === 'bigint'
      ? Number(result.lastInsertRowid)
      : typeof result.lastInsertRowid === 'number'
        ? result.lastInsertRowid
        : null;
  return { kind: 'plasticity_event', lastInsertRowid };
}

// ---------------------------------------------------------------------------
// weight_update — INSERT INTO brain_weight_history (T679 spec §2.1.4).
// ---------------------------------------------------------------------------

async function handleWeightUpdate(op: BrainWeightUpdateOp): Promise<BrainWriteResult> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(op.projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) {
    throw new Error('brain native DB unavailable for weight_update op');
  }
  // Guard: table may not exist on older schemas — match brain-stdp.ts behaviour.
  try {
    nativeDb.prepare('SELECT 1 FROM brain_weight_history LIMIT 1').get();
  } catch {
    return { kind: 'weight_update', ok: true };
  }
  const stmt = nativeDb.prepare(
    `INSERT INTO brain_weight_history
       (edge_from_id, edge_to_id, edge_type, weight_before, weight_after,
        delta_weight, event_kind, source_plasticity_event_id, retrieval_log_id,
        reward_signal, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    op.edgeFromId,
    op.edgeToId,
    op.edgeType,
    op.weightBefore,
    op.weightAfter,
    op.deltaWeight,
    op.eventKind,
    op.sourcePlasticityEventId,
    op.retrievalLogId,
    op.rewardSignal,
    op.changedAt,
  );
  return { kind: 'weight_update', ok: true };
}

// ---------------------------------------------------------------------------
// dialectic — compose multiple writes (peer insights + narrative delta).
// ---------------------------------------------------------------------------

async function handleDialectic(op: BrainDialecticOp): Promise<BrainWriteResult> {
  const log = getLogger('brain-writer');
  const sourceTag = `dialectic:${op.sessionId}`;

  // 1) Peer insights → observations (each routed through observeBrain).
  for (const insight of op.insights.peerInsights) {
    try {
      const { observeBrain } = await import('./retrieval/observe.js');
      await observeBrain(op.projectRoot, {
        text: `[${insight.key}] ${insight.value}`,
        title: insight.key,
        sourceSessionId: op.sessionId,
        sourceType: 'agent',
        agent: op.activePeerId,
        sourceConfidence: insight.confidence >= 0.8 ? 'task-outcome' : 'agent',
        _skipQueue: true,
      });
    } catch (err) {
      log.warn({ err, sourceTag, key: insight.key }, 'dialectic peer insight write failed');
    }
  }

  // 2) Session narrative delta → session_narrative table.
  if (op.insights.sessionNarrativeDelta) {
    try {
      const { appendNarrativeDelta } = await import('./session-narrative.js');
      await appendNarrativeDelta(op.sessionId, op.insights.sessionNarrativeDelta, op.projectRoot);
    } catch (err) {
      log.warn({ err, sourceTag }, 'dialectic narrative delta write failed');
    }
  }

  // NOTE: global traits → nexus.db. Nexus writes are NOT in the brain
  // chokepoint scope. Callers should still apply globalTraits on the main
  // thread (handled by the original applyInsights() flow); we only route
  // brain-bound writes through here.

  return { kind: 'dialectic', ok: true };
}
