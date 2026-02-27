/**
 * Assumption recording for session audit trail.
 *
 * @task T4782
 * @epic T4654
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { AssumptionRecord, TaskFileExt } from './types.js';

export interface RecordAssumptionParams {
  sessionId?: string;
  taskId?: string;
  assumption: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Record an assumption made during a session.
 * Appends to .cleo/audit/assumptions.jsonl (creates dir if needed).
 * Throws if required params are missing or invalid.
 */
export async function recordAssumption(
  projectRoot: string,
  params: RecordAssumptionParams,
): Promise<Omit<AssumptionRecord, 'validatedAt'> & { timestamp: string }> {
  if (!params?.assumption) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'assumption is required',
    );
  }

  if (
    !params?.confidence ||
    !['high', 'medium', 'low'].includes(params.confidence)
  ) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'confidence must be one of: high, medium, low',
    );
  }

  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  const sessionId =
    params.sessionId || current._meta?.activeSession || 'default';
  const id = `asm-${randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  const record: AssumptionRecord = {
    id,
    sessionId,
    taskId: params.taskId || null,
    assumption: params.assumption,
    confidence: params.confidence,
    validatedAt: null,
    timestamp: now,
  };

  const auditDir = join(projectRoot, '.cleo', 'audit');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  const assumptionsPath = join(auditDir, 'assumptions.jsonl');
  appendFileSync(assumptionsPath, JSON.stringify(record) + '\n', 'utf-8');

  return {
    id,
    sessionId,
    taskId: params.taskId || null,
    assumption: params.assumption,
    confidence: params.confidence,
    timestamp: now,
  };
}
