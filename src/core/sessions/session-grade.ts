/**
 * Session grading - rubric-based behavioral analysis of agent sessions.
 *
 * Reads audit log entries for a session and applies a 5-dimension rubric
 * to score agent behavior:
 *   - Session discipline (20pts)
 *   - Discovery efficiency (20pts)
 *   - Task hygiene (20pts)
 *   - Error protocol (20pts)
 *   - Progressive disclosure use (20pts)
 *
 * @task T4916
 */

import { queryAudit } from '../../dispatch/middleware/audit.js';
import type { AuditEntry } from '../../dispatch/middleware/audit.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { getCleoDirAbsolute } from '../paths.js';

export interface DimensionScore {
  score: number;
  max: number;
  evidence: string[];
}

export interface GradeResult {
  sessionId: string;
  taskId?: string;
  totalScore: number;
  maxScore: number;
  dimensions: {
    sessionDiscipline: DimensionScore;
    discoveryEfficiency: DimensionScore;
    taskHygiene: DimensionScore;
    errorProtocol: DimensionScore;
    disclosureUse: DimensionScore;
  };
  flags: string[];
  timestamp: string;
  entryCount: number;
}

/**
 * Grade a session by sessionId using the 5-dimension behavioral rubric.
 */
export async function gradeSession(sessionId: string, cwd?: string): Promise<GradeResult> {
  const sessionEntries = await queryAudit({ sessionId });

  const result: GradeResult = {
    sessionId,
    totalScore: 0,
    maxScore: 100,
    dimensions: {
      sessionDiscipline: { score: 0, max: 20, evidence: [] },
      discoveryEfficiency: { score: 0, max: 20, evidence: [] },
      taskHygiene: { score: 0, max: 20, evidence: [] },
      errorProtocol: { score: 0, max: 20, evidence: [] },
      disclosureUse: { score: 0, max: 20, evidence: [] },
    },
    flags: [],
    timestamp: new Date().toISOString(),
    entryCount: sessionEntries.length,
  };

  if (sessionEntries.length === 0) {
    result.flags.push('No audit entries found for session (use --grade flag when starting session)');
    await appendGradeResult(result, cwd);
    return result;
  }

  // -- Dimension 1: Session Discipline (20pts) --
  const sessionListCalls = sessionEntries.filter(
    e => e.domain === 'session' && e.operation === 'list',
  );
  const sessionEndCalls = sessionEntries.filter(
    e => e.domain === 'session' && e.operation === 'end',
  );
  const taskOps = sessionEntries.filter(e => e.domain === 'tasks');

  let disciplineScore = 0;

  if (sessionListCalls.length > 0) {
    const firstListTime = new Date(sessionListCalls[0].timestamp).getTime();
    const firstTaskTime =
      taskOps.length > 0 ? new Date(taskOps[0].timestamp).getTime() : Infinity;
    if (firstListTime <= firstTaskTime) {
      disciplineScore += 10;
      result.dimensions.sessionDiscipline.evidence.push('session.list called before first task op');
    } else {
      result.flags.push('session.list called after task ops (should check sessions first)');
    }
  } else {
    result.flags.push('session.list never called (check existing sessions before starting)');
  }

  if (sessionEndCalls.length > 0) {
    disciplineScore += 10;
    result.dimensions.sessionDiscipline.evidence.push('session.end called');
  } else {
    result.flags.push('session.end never called (always end sessions when done)');
  }

  result.dimensions.sessionDiscipline.score = disciplineScore;

  // -- Dimension 2: Discovery Efficiency (20pts) --
  const findCalls = sessionEntries.filter(
    e => e.domain === 'tasks' && e.operation === 'find',
  );
  const listCalls = sessionEntries.filter(
    e => e.domain === 'tasks' && e.operation === 'list',
  );
  const showCalls = sessionEntries.filter(
    e => e.domain === 'tasks' && e.operation === 'show',
  );

  let discoveryScore = 0;
  const totalDiscoveryCalls = findCalls.length + listCalls.length;

  if (totalDiscoveryCalls > 0) {
    const findRatio = findCalls.length / totalDiscoveryCalls;
    if (findRatio >= 0.8) {
      discoveryScore += 15;
      result.dimensions.discoveryEfficiency.evidence.push(
        `find:list ratio ${(findRatio * 100).toFixed(0)}% >= 80%`,
      );
    } else {
      result.flags.push(`tasks.list used ${listCalls.length}x (prefer tasks.find for discovery)`);
      discoveryScore += Math.round(15 * findRatio);
    }
  } else {
    discoveryScore += 10;
    result.dimensions.discoveryEfficiency.evidence.push('No discovery calls needed');
  }

  if (showCalls.length > 0) {
    discoveryScore = Math.min(20, discoveryScore + 5);
    result.dimensions.discoveryEfficiency.evidence.push(
      `tasks.show used ${showCalls.length}x for detail`,
    );
  }

  result.dimensions.discoveryEfficiency.score = Math.min(20, discoveryScore);

  // -- Dimension 3: Task Hygiene (20pts) --
  const addCalls = sessionEntries.filter(
    e => e.domain === 'tasks' && e.operation === 'add' && e.result.success,
  );
  const existsCalls = sessionEntries.filter(
    e => e.domain === 'tasks' && e.operation === 'exists',
  );

  let hygieneScore = 20;

  for (const addCall of addCalls) {
    const desc = addCall.params?.description as string | undefined;
    if (!desc || desc.trim().length === 0) {
      hygieneScore -= 5;
      result.flags.push(
        `tasks.add without description (taskId: ${addCall.metadata?.taskId ?? 'unknown'})`,
      );
    }
  }

  const subtaskAdds = addCalls.filter(e => e.params?.parent);
  if (subtaskAdds.length > 0 && existsCalls.length > 0) {
    result.dimensions.taskHygiene.evidence.push('Parent existence verified before subtask creation');
  } else if (subtaskAdds.length > 0) {
    result.flags.push('Subtasks created without tasks.exists parent check');
    hygieneScore -= 3;
  }

  if (addCalls.length > 0 && hygieneScore >= 20) {
    result.dimensions.taskHygiene.evidence.push(
      `All ${addCalls.length} tasks.add calls had descriptions`,
    );
  }

  result.dimensions.taskHygiene.score = Math.max(0, hygieneScore);

  // -- Dimension 4: Error Protocol (20pts) --
  const notFoundErrors = sessionEntries.filter(
    e => !e.result.success && e.result.exitCode === 4,
  );

  let errorScore = 20;

  for (const errEntry of notFoundErrors) {
    const errIdx = sessionEntries.indexOf(errEntry);
    const nextEntries = sessionEntries.slice(errIdx + 1, errIdx + 5);
    const hasRecovery = nextEntries.some(
      e => e.domain === 'tasks' && (e.operation === 'find' || e.operation === 'exists'),
    );
    if (!hasRecovery) {
      errorScore -= 5;
      result.flags.push(
        `E_NOT_FOUND (${errEntry.domain}.${errEntry.operation}) not followed by recovery lookup`,
      );
    } else {
      result.dimensions.errorProtocol.evidence.push('E_NOT_FOUND followed by recovery lookup');
    }
  }

  const duplicateCreates = detectDuplicateCreates(sessionEntries);
  if (duplicateCreates > 0) {
    errorScore -= 5;
    result.flags.push(`${duplicateCreates} potentially duplicate task create(s) detected`);
  }

  if (notFoundErrors.length === 0 && duplicateCreates === 0) {
    result.dimensions.errorProtocol.evidence.push('No error protocol violations');
  }

  result.dimensions.errorProtocol.score = Math.max(0, errorScore);

  // -- Dimension 5: Progressive Disclosure Use (20pts) --
  const helpCalls = sessionEntries.filter(
    e =>
      (e.domain === 'admin' && e.operation === 'help') ||
      (e.domain === 'tools' && (e.operation === 'skill.show' || e.operation === 'skill.list')) ||
      (e.domain === 'skills' && (e.operation === 'list' || e.operation === 'show')),
  );
  // gateway is stored as 'query'/'mutate' (normalized) or legacy 'cleo_query'/'cleo_mutate'
  const mcpQueryCalls = sessionEntries.filter(
    e => e.metadata?.gateway === 'cleo_query' || e.metadata?.gateway === 'query',
  );

  let disclosureScore = 0;

  if (helpCalls.length > 0) {
    disclosureScore += 10;
    result.dimensions.disclosureUse.evidence.push(
      `Progressive disclosure used (${helpCalls.length}x)`,
    );
  } else {
    result.flags.push('No admin.help or skill lookup calls (load ct-cleo for guidance)');
  }

  if (mcpQueryCalls.length > 0) {
    disclosureScore += 10;
    result.dimensions.disclosureUse.evidence.push(
      `cleo_query (MCP) used ${mcpQueryCalls.length}x`,
    );
  } else {
    result.flags.push('No MCP query calls (prefer cleo_query over CLI for programmatic access)');
  }

  result.dimensions.disclosureUse.score = disclosureScore;

  // -- Total --
  result.totalScore = Object.values(result.dimensions).reduce((sum, d) => sum + d.score, 0);

  await appendGradeResult(result, cwd);
  return result;
}

/** Detect potentially duplicate task creates (same title within session). */
function detectDuplicateCreates(entries: AuditEntry[]): number {
  const creates = entries.filter(
    e => e.domain === 'tasks' && e.operation === 'add' && e.result.success,
  );
  const titles = creates
    .map(e => (e.params?.title as string)?.toLowerCase().trim())
    .filter(Boolean);
  const unique = new Set(titles);
  return titles.length - unique.size;
}

/** Append a grade result to .cleo/metrics/GRADES.jsonl */
async function appendGradeResult(result: GradeResult, cwd?: string): Promise<void> {
  try {
    const cleoDir = getCleoDirAbsolute(cwd);
    const metricsDir = join(cleoDir, 'metrics');
    await mkdir(metricsDir, { recursive: true });
    const gradesPath = join(metricsDir, 'GRADES.jsonl');
    const line = JSON.stringify({ ...result, evaluator: 'auto' }) + '\n';
    await appendFile(gradesPath, line, 'utf8');
  } catch {
    // Best-effort
  }
}

/** Read past grade results from .cleo/metrics/GRADES.jsonl */
export async function readGrades(sessionId?: string, cwd?: string): Promise<GradeResult[]> {
  try {
    const cleoDir = getCleoDirAbsolute(cwd);
    const gradesPath = join(cleoDir, 'metrics', 'GRADES.jsonl');
    if (!existsSync(gradesPath)) return [];
    const content = await readFile(gradesPath, 'utf8');
    const results = content
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as GradeResult);
    return sessionId ? results.filter(r => r.sessionId === sessionId) : results;
  } catch {
    return [];
  }
}
