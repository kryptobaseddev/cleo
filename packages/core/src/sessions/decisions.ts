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
 * Record a decision to the audit trail.
 * Normalized Core signature: (projectRoot, params) → Result.
 * Appends a JSON line to `.cleo/audit/decisions.jsonl`.
 * Throws if required params are missing.
 * @task T1450
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
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function getDecisionLog(
  projectRoot: string,
  params: SessionDecisionLogParams,
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

  if (params.sessionId) {
    entries = entries.filter((e) => e.sessionId === params.sessionId);
  }

  if (params.taskId) {
    entries = entries.filter((e) => e.taskId === params.taskId);
  }

  return entries;
}
