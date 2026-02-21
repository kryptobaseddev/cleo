/**
 * System metrics aggregation core module.
 * @task T4783
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface SystemMetricsResult {
  tokens: {
    input: number;
    output: number;
    cache: number;
    total: number;
  };
  compliance: {
    total: number;
    passed: number;
    failed: number;
    score: number;
  };
  sessions: {
    total: number;
    active: number;
    completed: number;
  };
}

/** Get system metrics: token usage, compliance summary, session counts. */
export async function getSystemMetrics(
  projectRoot: string,
  opts?: { scope?: string; since?: string },
  accessor?: DataAccessor,
): Promise<SystemMetricsResult> {
  const cleoDir = join(projectRoot, '.cleo');

  // Compliance metrics
  const compliancePath = join(cleoDir, 'metrics', 'COMPLIANCE.jsonl');
  let complianceEntries: Record<string, unknown>[] = [];
  if (existsSync(compliancePath)) {
    try {
      const content = readFileSync(compliancePath, 'utf-8').trim();
      if (content) {
        complianceEntries = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      }
    } catch {
      // skip
    }
  }

  if (opts?.since) {
    complianceEntries = complianceEntries.filter(e => (e.timestamp as string) >= opts.since!);
  }

  const totalCompliance = complianceEntries.length;
  let passed = 0;
  let failed = 0;
  let scoreSum = 0;
  for (const e of complianceEntries) {
    const c = (e.compliance ?? {}) as Record<string, unknown>;
    const violations = (c.violation_count as number) ?? 0;
    if (violations === 0) passed++;
    else failed++;
    scoreSum += (c.compliance_pass_rate as number) ?? 0;
  }
  const avgScore = totalCompliance > 0 ? Math.round((scoreSum / totalCompliance) * 1000) / 1000 : 0;

  // Session metrics
  let sessionsTotal = 0;
  let sessionsActive = 0;
  let sessionsCompleted = 0;
  try {
    if (accessor) {
      const sessionsData = await accessor.loadSessions() as unknown as { sessions: Array<{ status: string }> };
      const sessions = sessionsData?.sessions ?? [];
      sessionsTotal = sessions.length;
      sessionsActive = sessions.filter(s => s.status === 'active').length;
      sessionsCompleted = sessions.filter(s => s.status === 'ended' || s.status === 'completed').length;
    } else {
      const sessionsPath = join(cleoDir, 'sessions.json');
      if (existsSync(sessionsPath)) {
        const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
        const sessions = sessionsData.sessions ?? [];
        sessionsTotal = sessions.length;
        sessionsActive = sessions.filter((s: { status: string }) => s.status === 'active').length;
        sessionsCompleted = sessions.filter((s: { status: string }) => s.status === 'ended' || s.status === 'completed').length;
      }
    }
  } catch {
    // skip
  }

  return {
    tokens: { input: 0, output: 0, cache: 0, total: 0 },
    compliance: { total: totalCompliance, passed, failed, score: avgScore },
    sessions: { total: sessionsTotal, active: sessionsActive, completed: sessionsCompleted },
  };
}
