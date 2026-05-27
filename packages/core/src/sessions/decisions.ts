/**
 * Decision recording and retrieval for session audit trail.
 *
 * @task T4782
 * @epic T4654
 * @task T1450 — normalized (projectRoot, params) signature
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExitCode,
  type SessionDecisionLogParams,
  type SessionRecordDecisionParams,
} from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DecisionRecord } from './types.js';

/**
 * Record a decision to the audit trail AND the BRAIN decision-store.
 *
 * Dual-writes: BRAIN brain_decisions table (canonical, queryable, FTS5-backed)
 * AND the legacy .cleo/audit/decisions.jsonl ledger (compatibility). Prefer the
 * BRAIN record for all retrieval paths; the ledger blob is a fallback.
 *
 * Normalized Core signature: (projectRoot, params) → Result.
 * Throws if required params are missing.
 *
 * @task T1450, T11185
 */
export async function recordDecision(
  projectRoot: string,
  params: SessionRecordDecisionParams,
): Promise<DecisionRecord> {
  if (!params.sessionId || !params.taskId || !params.decision || !params.rationale) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'sessionId, taskId, decision, and rationale are required',
    );
  }

  // 1. Store in BRAIN decision-store (canonical, queryable).
  //    Fire-and-forget — audit log write proceeds regardless of BRAIN outcome.
  let brainDecisionId: string | undefined;
  try {
    const { storeDecision } = await import('../memory/decisions.js');
    // Derive a task-id scoped pseudo-session reference from the session id.
    // BRAIN decisions don't have a direct session_id column; we use contextTaskId
    // to associate the decision with its originating task+session context.
    const brainRow = await storeDecision(projectRoot, {
      type: 'technical',
      decision: params.decision,
      rationale: params.rationale,
      confidence: 'medium',
      outcome: 'pending',
      alternatives: params.alternatives,
      contextTaskId: params.taskId,
    });
    brainDecisionId = brainRow.id;
  } catch {
    // BRAIN store is best-effort — audit log write is mandatory below.
  }

  // 2. Write to legacy audit ledger for backward compatibility.
  const auditDir = join(projectRoot, '.cleo', 'audit');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  const decisionPath = join(auditDir, 'decisions.jsonl');

  const idPrefix = brainDecisionId ? `${brainDecisionId}:` : '';
  const record: DecisionRecord = {
    id: `${idPrefix}dec-${randomBytes(8).toString('hex')}`,
    sessionId: params.sessionId,
    taskId: params.taskId,
    decision: params.decision,
    rationale: params.rationale,
    alternatives: params.alternatives || [],
    timestamp: new Date().toISOString(),
  };

  appendFileSync(decisionPath, JSON.stringify(record) + '\n', 'utf-8');

  return record;
}

/**
 * Read decisions for a session/task from the BRAIN decision-store AND the
 * legacy audit ledger. BRAIN results are preferred and returned first;
 * ledger blobs supplement (deduplicated by content) when BRAIN is partial.
 *
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450, T11185
 */
export async function getDecisionLog(
  projectRoot: string,
  params: SessionDecisionLogParams,
): Promise<DecisionRecord[]> {
  const decisions: DecisionRecord[] = [];
  const seenTexts = new Set<string>();

  // 1. Primary: query BRAIN brain_decisions table.
  //    Decisions linked to the task via contextTaskId are the most relevant.
  try {
    const { getBrainAccessor } = await import('../store/memory-accessor.js');
    const brainAccessor = await getBrainAccessor(projectRoot);

    let brainDecisions = params.taskId
      ? await brainAccessor.findDecisions({ contextTaskId: params.taskId })
      : await brainAccessor.findDecisions({ limit: 50 });

    for (const d of brainDecisions) {
      const textKey = (d.decision + '|' + d.rationale).toLowerCase();
      if (seenTexts.has(textKey)) continue;
      seenTexts.add(textKey);

      decisions.push({
        id: d.id,
        sessionId: params.sessionId ?? '',
        taskId: d.contextTaskId ?? params.taskId ?? '',
        decision: d.decision,
        rationale: d.rationale,
        alternatives: (() => {
          try {
            return d.alternativesJson ? JSON.parse(d.alternativesJson) : [];
          } catch {
            return [];
          }
        })(),
        timestamp: d.createdAt ?? '',
      });
    }
  } catch {
    // BRAIN unavailable — fall through to ledger blob.
  }

  // 2. Fallback / supplement: legacy .cleo/audit/decisions.jsonl ledger.
  const decisionPath = join(projectRoot, '.cleo', 'audit', 'decisions.jsonl');

  if (existsSync(decisionPath)) {
    const content = readFileSync(decisionPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      let entry: DecisionRecord | null = null;
      try {
        entry = JSON.parse(line) as DecisionRecord;
      } catch {
        // Skip malformed lines
        continue;
      }
      if (!entry) continue;

      // Filter by sessionId / taskId.
      if (params.sessionId && entry.sessionId !== params.sessionId) continue;
      if (params.taskId && entry.taskId !== params.taskId) continue;

      // Deduplicate: skip if BRAIN already provided an equivalent decision.
      const textKey = (entry.decision + '|' + entry.rationale).toLowerCase();
      if (seenTexts.has(textKey)) continue;
      seenTexts.add(textKey);

      decisions.push(entry);
    }
  }

  return decisions;
}
