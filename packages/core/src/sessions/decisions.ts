/**
 * Decision recording and retrieval for session audit trail.
 *
 * Decisions are recorded to the BRAIN decision-store (`brain_decisions`, the
 * canonical, queryable store) and to the legacy `.cleo/audit/decisions.jsonl`
 * ledger. Reads prefer BRAIN and fall back to — or are supplemented by — the
 * ledger.
 *
 * @task T4782
 * @epic T4654
 * @task T1450 — normalized (projectRoot, params) signature
 * @task T11185 — BRAIN-first decision routing
 * @task T12458 — salvaged onto current memory-authority semantics
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
import { isCurrentMemoryEntry } from '../memory/eligibility.js';
import type { BrainDataAccessor } from '../store/memory-accessor.js';
import type { DecisionRecord } from './types.js';

/** Maximum BRAIN rows read when no task scope is supplied. */
const UNSCOPED_BRAIN_DECISION_LIMIT = 50;

/**
 * Separator between a BRAIN decision id and the ledger-local id.
 *
 * A ledger record whose BRAIN write succeeded carries `<brainId>:dec-<hex>`
 * so readers can join the two stores without a schema change.
 */
const BRAIN_LINK_SEPARATOR = ':';

/** Content key used to deduplicate a decision across both stores. */
function contentKey(decision: string, rationale: string): string {
  return `${decision}|${rationale}`.toLowerCase();
}

/** Extract the linked BRAIN decision id from a ledger record id, if any. */
function linkedBrainId(ledgerId: string): string | undefined {
  const idx = ledgerId.indexOf(BRAIN_LINK_SEPARATOR);
  return idx > 0 ? ledgerId.slice(0, idx) : undefined;
}

/** Parse a BRAIN `alternatives_json` column, tolerating malformed values. */
function parseAlternatives(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Whether the BRAIN row a ledger record links to has been retired
 * (invalidated or superseded). The ledger must not resurrect a decision that
 * current authority has retired. A missing or unreadable row is not proof of
 * retirement, so the ledger record is kept.
 */
async function isRetiredInBrain(accessor: BrainDataAccessor, brainId: string): Promise<boolean> {
  try {
    const row = await accessor.getDecision(brainId);
    return row !== null && !isCurrentMemoryEntry(row);
  } catch {
    return false;
  }
}

/** Read every well-formed record from the legacy ledger. Malformed lines are skipped. */
function readLedger(projectRoot: string): DecisionRecord[] {
  const decisionPath = join(projectRoot, '.cleo', 'audit', 'decisions.jsonl');
  if (!existsSync(decisionPath)) {
    return [];
  }
  const entries: DecisionRecord[] = [];
  const lines = readFileSync(decisionPath, 'utf-8').split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Record a decision to the BRAIN decision-store AND the audit ledger.
 *
 * Dual-write: the BRAIN `brain_decisions` row is canonical (queryable,
 * eligibility-filtered on read); the `.cleo/audit/decisions.jsonl` line keeps
 * session attribution and backward compatibility. The BRAIN write is
 * best-effort; the ledger write is mandatory. When the BRAIN write succeeds the
 * ledger id is `<brainId>:dec-<hex>`, linking the two records.
 *
 * The BRAIN write never requests LLM validation (`validateWithLlm` stays
 * unset) — recording a caller-sourced decision does not invoke synthesis.
 *
 * Normalized Core signature: (projectRoot, params) → Result.
 * Throws if required params are missing.
 *
 * @task T1450
 * @task T11185
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

  // 1. Canonical BRAIN decision-store (best-effort).
  let brainDecisionId: string | undefined;
  try {
    const { storeDecision } = await import('../memory/decisions.js');
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
    // BRAIN is unavailable or rejected the write — the ledger below is mandatory.
  }

  // 2. Legacy audit ledger (mandatory).
  const auditDir = join(projectRoot, '.cleo', 'audit');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  const decisionPath = join(auditDir, 'decisions.jsonl');
  const localId = `dec-${randomBytes(8).toString('hex')}`;

  const record: DecisionRecord = {
    id: brainDecisionId ? `${brainDecisionId}${BRAIN_LINK_SEPARATOR}${localId}` : localId,
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
 * Read decisions, optionally filtered by sessionId and/or taskId.
 *
 * BRAIN `brain_decisions` rows are read first (current-authority eligibility
 * applies — invalidated and superseded rows are excluded by the accessor) and
 * returned first. The legacy ledger supplements them and is the sole source
 * when BRAIN is unavailable. Records are deduplicated by BRAIN link and by
 * content (decision + rationale).
 *
 * A ledger record linked to a BRAIN row that has since been invalidated or
 * superseded is omitted, so the ledger cannot resurrect retired decisions.
 *
 * BRAIN rows carry no session column: a row's session comes from the ledger
 * record linked to it. Under a `sessionId` filter, a BRAIN row is returned only
 * when a linked ledger record proves it belongs to that session.
 *
 * Normalized Core signature: (projectRoot, params) → Result.
 *
 * @task T1450
 * @task T11185
 */
export async function getDecisionLog(
  projectRoot: string,
  params: SessionDecisionLogParams,
): Promise<DecisionRecord[]> {
  const ledger = readLedger(projectRoot);
  const ledgerByBrainId = new Map<string, DecisionRecord>();
  for (const entry of ledger) {
    const brainId = typeof entry.id === 'string' ? linkedBrainId(entry.id) : undefined;
    if (brainId && !ledgerByBrainId.has(brainId)) {
      ledgerByBrainId.set(brainId, entry);
    }
  }

  const decisions: DecisionRecord[] = [];
  const seenContent = new Set<string>();
  const emittedBrainIds = new Set<string>();

  // 1. Primary: BRAIN decision-store.
  let accessor: BrainDataAccessor | undefined;
  try {
    const { getBrainAccessor } = await import('../store/memory-accessor.js');
    accessor = await getBrainAccessor(projectRoot);
    const rows = params.taskId
      ? await accessor.findDecisions({ contextTaskId: params.taskId })
      : await accessor.findDecisions({ limit: UNSCOPED_BRAIN_DECISION_LIMIT });

    for (const row of rows) {
      const linked = ledgerByBrainId.get(row.id);
      const sessionId = linked?.sessionId ?? '';
      if (params.sessionId && sessionId !== params.sessionId) continue;

      const key = contentKey(row.decision, row.rationale);
      if (seenContent.has(key)) continue;
      seenContent.add(key);
      emittedBrainIds.add(row.id);

      decisions.push({
        id: row.id,
        sessionId,
        taskId: row.contextTaskId ?? linked?.taskId ?? params.taskId ?? '',
        decision: row.decision,
        rationale: row.rationale,
        alternatives: parseAlternatives(row.alternativesJson),
        timestamp: linked?.timestamp ?? row.createdAt ?? '',
      });
    }
  } catch {
    // BRAIN unavailable — the ledger below is the fallback.
    accessor = undefined;
  }

  // 2. Fallback / supplement: legacy ledger.
  for (const entry of ledger) {
    if (params.sessionId && entry.sessionId !== params.sessionId) continue;
    if (params.taskId && entry.taskId !== params.taskId) continue;

    const brainId = typeof entry.id === 'string' ? linkedBrainId(entry.id) : undefined;
    if (brainId && emittedBrainIds.has(brainId)) continue;
    if (brainId && accessor && (await isRetiredInBrain(accessor, brainId))) continue;

    const key = contentKey(entry.decision, entry.rationale);
    if (seenContent.has(key)) continue;
    seenContent.add(key);

    decisions.push(entry);
  }

  return decisions;
}
