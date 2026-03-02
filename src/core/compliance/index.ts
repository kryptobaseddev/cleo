/**
 * Compliance metrics core module.
 * @task T4535
 * @epic T4454
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getManifestPath as getManifestPathFromPaths } from '../paths.js';
import { atomicWriteJson } from '../../store/atomic.js';
import { readComplianceJsonl, getComplianceJsonlPath } from './store.js';
// CleoError and ExitCode available if needed for future error cases

/** Get compliance summary. */
export async function getComplianceSummary(opts: {
  since?: string;
  agent?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  let entries = readComplianceJsonl(opts.cwd ?? process.cwd());

  if (opts.since) {
    entries = entries.filter(e => (e.timestamp as string) >= opts.since!);
  }
  if (opts.agent) {
    entries = entries.filter(e => e.source_id === opts.agent);
  }

  const totalEntries = entries.length;
  const compliance = entries.map(e => (e.compliance ?? {}) as Record<string, unknown>);
  const avgPassRate = totalEntries > 0
    ? compliance.reduce((sum, c) => sum + ((c.compliance_pass_rate as number) ?? 0), 0) / totalEntries
    : 0;
  const avgAdherence = totalEntries > 0
    ? compliance.reduce((sum, c) => sum + ((c.rule_adherence_score as number) ?? 0), 0) / totalEntries
    : 0;
  const totalViolations = compliance.reduce(
    (sum, c) => sum + ((c.violation_count as number) ?? 0), 0,
  );

  return {
    totalEntries,
    averagePassRate: Math.round(avgPassRate * 1000) / 1000,
    averageAdherence: Math.round(avgAdherence * 1000) / 1000,
    totalViolations,
  };
}

/** List compliance violations. */
export async function listComplianceViolations(opts: {
  severity?: string;
  since?: string;
  agent?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  let entries = readComplianceJsonl(opts.cwd ?? process.cwd());

  entries = entries.filter(e => {
    const c = (e.compliance ?? {}) as Record<string, unknown>;
    return ((c.violation_count as number) ?? 0) > 0;
  });

  if (opts.severity) {
    entries = entries.filter(e => {
      const c = (e.compliance ?? {}) as Record<string, unknown>;
      return c.violation_severity === opts.severity;
    });
  }
  if (opts.since) {
    entries = entries.filter(e => (e.timestamp as string) >= opts.since!);
  }
  if (opts.agent) {
    entries = entries.filter(e => e.source_id === opts.agent);
  }

  const violations = entries.map(e => {
    const c = (e.compliance ?? {}) as Record<string, unknown>;
    const ctx = (e._context ?? {}) as Record<string, unknown>;
    return {
      timestamp: e.timestamp,
      agentId: e.source_id,
      taskId: ctx.task_id,
      violationCount: c.violation_count,
      severity: c.violation_severity,
      passRate: c.compliance_pass_rate,
    };
  });

  return { violations, totalCount: violations.length };
}

/** Get compliance trend. */
export async function getComplianceTrend(
  days: number = 7,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const entries = readComplianceJsonl(cwd ?? process.cwd());
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const filtered = entries.filter(e => (e.timestamp as string) >= cutoff);

  // Group by date
  const byDate: Record<string, Record<string, unknown>[]> = {};
  for (const e of filtered) {
    const date = (e.timestamp as string).split('T')[0]!;
    if (!byDate[date]) byDate[date] = [];
    byDate[date]!.push(e);
  }

  const dataPoints = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayEntries]) => {
      const compliance = dayEntries.map(e => (e.compliance ?? {}) as Record<string, unknown>);
      return {
        date,
        entries: dayEntries.length,
        avgPassRate: compliance.reduce((s, c) => s + ((c.compliance_pass_rate as number) ?? 0), 0) / dayEntries.length,
        avgAdherence: compliance.reduce((s, c) => s + ((c.rule_adherence_score as number) ?? 0), 0) / dayEntries.length,
        violations: compliance.reduce((s, c) => s + ((c.violation_count as number) ?? 0), 0),
      };
    });

  let trend = 'no_data';
  if (dataPoints.length >= 2) {
    const first = dataPoints[0]!.avgPassRate;
    const last = dataPoints[dataPoints.length - 1]!.avgPassRate;
    trend = last > first ? 'improving' : last < first ? 'declining' : 'stable';
  }

  return { days, trend, dataPoints };
}

/** Audit epic compliance. */
export async function auditEpicCompliance(
  epicId: string,
  opts: { since?: string; cwd?: string },
): Promise<Record<string, unknown>> {
  const entries = readComplianceJsonl(opts.cwd ?? process.cwd());

  const epicEntries = entries.filter(e => {
    const ctx = (e._context ?? {}) as Record<string, unknown>;
    return ctx.epic_id === epicId || ctx.task_id === epicId;
  });

  const taskIds = [...new Set(epicEntries.map(e => {
    const ctx = (e._context ?? {}) as Record<string, unknown>;
    return ctx.task_id as string;
  }))];

  const compliance = epicEntries.map(e => (e.compliance ?? {}) as Record<string, unknown>);
  const avgPassRate = epicEntries.length > 0
    ? compliance.reduce((s, c) => s + ((c.compliance_pass_rate as number) ?? 0), 0) / epicEntries.length
    : 0;
  const totalViolations = compliance.reduce(
    (s, c) => s + ((c.violation_count as number) ?? 0), 0,
  );

  return {
    epicId,
    taskCount: taskIds.length,
    entriesAnalyzed: epicEntries.length,
    summary: { averagePassRate: avgPassRate, totalViolations },
  };
}

/** Sync compliance metrics to a summary file. */
export async function syncComplianceMetrics(opts: {
  force?: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const cwd = opts.cwd ?? process.cwd();
  const force = opts.force ?? false;
  const jsonlPath = getComplianceJsonlPath(cwd);
  const summaryPath = join(cwd, '.cleo', 'metrics', 'compliance-summary.json');

  // If JSONL doesn't exist, nothing to sync
  if (!existsSync(jsonlPath)) {
    return { synced: 0, skipped: 0, message: 'No compliance data found', timestamp: new Date().toISOString() };
  }

  // Skip re-syncing if summary is newer than JSONL (unless forced)
  if (!force && existsSync(summaryPath)) {
    const jsonlMtime = statSync(jsonlPath).mtimeMs;
    const summaryMtime = statSync(summaryPath).mtimeMs;
    if (summaryMtime > jsonlMtime) {
      const existing = JSON.parse(readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>;
      const totalEntries = (existing.totalEntries as number) ?? 0;
      return {
        synced: 0,
        skipped: totalEntries,
        message: `Summary up-to-date (${totalEntries} entries)`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  const entries = readComplianceJsonl(cwd);
  const totalEntries = entries.length;

  if (totalEntries === 0) {
    const summary = {
      totalEntries: 0,
      averagePassRate: 0,
      averageAdherence: 0,
      totalViolations: 0,
      entriesByType: {},
      generatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(summaryPath, summary);
    return { synced: 0, skipped: 0, message: 'No entries to sync', timestamp: summary.generatedAt };
  }

  // Compute aggregate statistics
  const compliance = entries.map(e => (e.compliance ?? {}) as Record<string, unknown>);
  const avgPassRate = compliance.reduce((sum, c) => sum + ((c.compliance_pass_rate as number) ?? 0), 0) / totalEntries;
  const avgAdherence = compliance.reduce((sum, c) => sum + ((c.rule_adherence_score as number) ?? 0), 0) / totalEntries;
  const totalViolations = compliance.reduce((sum, c) => sum + ((c.violation_count as number) ?? 0), 0);

  // Group entries by source_type
  const entriesByType: Record<string, number> = {};
  for (const e of entries) {
    const sourceType = (e.source_type as string) ?? 'unknown';
    entriesByType[sourceType] = (entriesByType[sourceType] ?? 0) + 1;
  }

  const generatedAt = new Date().toISOString();
  const globalStats = {
    totalEntries,
    averagePassRate: Math.round(avgPassRate * 1000) / 1000,
    averageAdherence: Math.round(avgAdherence * 1000) / 1000,
    totalViolations,
    entriesByType,
    generatedAt,
  };

  await atomicWriteJson(summaryPath, globalStats);

  return {
    synced: totalEntries,
    skipped: 0,
    message: `Synced ${totalEntries} compliance entries`,
    timestamp: generatedAt,
    globalStats,
  };
}

/** Get skill reliability stats. */
export async function getSkillReliability(opts: {
  global?: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const entries = readComplianceJsonl(opts.cwd ?? process.cwd());

  const byAgent: Record<string, { count: number; passRateSum: number; violations: number }> = {};
  for (const e of entries) {
    const agentId = (e.source_id as string) ?? 'unknown';
    if (!byAgent[agentId]) byAgent[agentId] = { count: 0, passRateSum: 0, violations: 0 };
    const stats = byAgent[agentId]!;
    const c = (e.compliance ?? {}) as Record<string, unknown>;
    stats.count++;
    stats.passRateSum += (c.compliance_pass_rate as number) ?? 0;
    stats.violations += (c.violation_count as number) ?? 0;
  }

  const skills = Object.entries(byAgent).map(([id, stats]) => ({
    agentId: id,
    totalChecks: stats.count,
    avgPassRate: stats.count > 0 ? Math.round((stats.passRateSum / stats.count) * 1000) / 1000 : 0,
    totalViolations: stats.violations,
  }));

  return { skills, total: skills.length };
}

/** Get value metrics (T2833). */
export async function getValueMetrics(
  days: number = 7,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const manifestPath = getManifestPathFromPaths(cwd);

  let manifestEntries = 0;
  if (existsSync(manifestPath)) {
    const content = readFileSync(manifestPath, 'utf-8').trim();
    manifestEntries = content ? content.split('\n').length : 0;
  }

  const manifestTokens = manifestEntries * 200;
  const fullFileTokens = manifestEntries * 2000;
  const tokenSavings = fullFileTokens - manifestTokens;
  const savingsPercent = fullFileTokens > 0
    ? Math.round((tokenSavings / fullFileTokens) * 100)
    : 0;

  let totalValidations = 0;
  let violationsCaught = 0;
  let realValidations = 0;

  const entries = readComplianceJsonl(cwd ?? process.cwd());
  totalValidations = entries.length;
  violationsCaught = entries.filter(e => {
    const c = (e.compliance ?? {}) as Record<string, unknown>;
    return ((c.violation_count as number) ?? 0) > 0;
  }).length;
  realValidations = entries.filter(e => {
    const ctx = (e._context ?? {}) as Record<string, unknown>;
    return ctx.validation_score !== undefined;
  }).length;

  const violationRate = totalValidations > 0
    ? Math.round((violationsCaught / totalValidations) * 100)
    : 0;

  const otelEnabled = process.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1';

  return {
    periodDays: days,
    tokenEfficiency: {
      manifestEntries,
      manifestTokens,
      fullFileEquivalent: fullFileTokens,
      tokensSaved: tokenSavings,
      savingsPercent,
      verdict: savingsPercent >= 80 ? 'Excellent'
        : savingsPercent >= 50 ? 'Good'
        : savingsPercent >= 20 ? 'Moderate'
        : 'Low',
    },
    validationImpact: {
      totalValidations,
      violationsCaught,
      violationRatePercent: violationRate,
      realValidations,
      status: realValidations > 0 ? 'Active' : 'Legacy (upgrade to real validation)',
    },
    telemetry: {
      otelEnabled,
      recommendation: otelEnabled
        ? 'Token tracking active'
        : 'Enable CLAUDE_CODE_ENABLE_TELEMETRY=1 for real token data',
    },
  };
}
