/**
 * Decision recording and retrieval for session audit trail.
 *
 * @task T4782
 * @epic T4654
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { DecisionRecord } from './types.js';

export interface RecordDecisionParams {
  sessionId: string;
  taskId: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
}

export interface DecisionLogParams {
  sessionId?: string;
  taskId?: string;
}

/**
 * Record a decision to the audit trail.
 * Appends a JSON line to `.cleo/audit/decisions.jsonl`.
 * Throws if required params are missing.
 */
export async function recordDecision(
  projectRoot: string,
  params: RecordDecisionParams,
): Promise<DecisionRecord> {
  if (
    !params.sessionId ||
    !params.taskId ||
    !params.decision ||
    !params.rationale
  ) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'sessionId, taskId, decision, and rationale are required',
    );
  }

  const auditDir = join(projectRoot, '.cleo', 'audit');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  const decisionPath = join(auditDir, 'decisions.jsonl');

  const record: DecisionRecord = {
    id: `dec-${randomBytes(8).toString('hex')}`,
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
 * Read the decision log, optionally filtered by sessionId and/or taskId.
 */
export async function getDecisionLog(
  projectRoot: string,
  params?: DecisionLogParams,
): Promise<DecisionRecord[]> {
  const decisionPath = join(projectRoot, '.cleo', 'audit', 'decisions.jsonl');

  if (!existsSync(decisionPath)) {
    return [];
  }

  const content = readFileSync(decisionPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  let entries: DecisionRecord[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // Skip malformed lines
    }
  }

  if (params?.sessionId) {
    entries = entries.filter((e) => e.sessionId === params.sessionId);
  }

  if (params?.taskId) {
    entries = entries.filter((e) => e.taskId === params.taskId);
  }

  return entries;
}
