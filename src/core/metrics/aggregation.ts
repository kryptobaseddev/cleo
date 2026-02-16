/**
 * Metrics aggregation - project-to-global sync and compliance summaries.
 *
 * Project metrics: .cleo/metrics/COMPLIANCE.jsonl
 * Global metrics:  ~/.cleo/metrics/GLOBAL.jsonl
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { getCleoDir } from '../paths.js';
import {
  getCompliancePath,
  getSessionsMetricsPath,
  readJsonlFile,
} from './common.js';

function getProjectMetricsDir(cwd?: string): string {
  return join(getCleoDir(cwd), 'metrics');
}

function getGlobalMetricsDir(): string {
  return join(homedir(), '.cleo', 'metrics');
}

function getGlobalPath(): string {
  return join(getGlobalMetricsDir(), 'GLOBAL.jsonl');
}

function getProjectName(): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (match) return match[1]!;
  } catch { /* not a git repo */ }
  return basename(process.cwd());
}

/** Sync project metrics to global aggregation file. */
export async function syncMetricsToGlobal(
  options: { force?: boolean } = {},
  cwd?: string,
): Promise<Record<string, unknown>> {
  const projectPath = getCompliancePath(join(getCleoDir(cwd), 'metrics'));
  if (!existsSync(projectPath)) {
    return { success: true, result: { synced: 0, skipped: 0, reason: 'No project metrics file' } };
  }

  const globalDir = getGlobalMetricsDir();
  await mkdir(globalDir, { recursive: true });

  const globalPath = getGlobalPath();
  const projectName = getProjectName();

  // Get existing entry keys for deduplication
  const existingKeys = new Set<string>();
  if (!options.force && existsSync(globalPath)) {
    for (const entry of readJsonlFile(globalPath)) {
      const ts = entry.timestamp as string;
      const srcId = entry.source_id as string;
      if (ts && srcId) existingKeys.add(`${ts}_${srcId}`);
    }
  }

  const projectEntries = readJsonlFile(projectPath);
  let synced = 0;
  let skipped = 0;

  for (const entry of projectEntries) {
    const ts = entry.timestamp as string;
    const srcId = entry.source_id as string;
    if (!ts || !srcId) { skipped++; continue; }

    const key = `${ts}_${srcId}`;
    if (!options.force && existingKeys.has(key)) { skipped++; continue; }

    const enriched = { ...entry, project: projectName };
    appendFileSync(globalPath, JSON.stringify(enriched) + '\n');
    synced++;
  }

  return {
    success: true,
    result: { project: projectName, synced, skipped, globalFile: '~/.cleo/metrics/GLOBAL.jsonl' },
  };
}

/** Compliance entry shape for aggregation queries. */
interface ComplianceEntry {
  timestamp?: string;
  source_id?: string;
  category?: string;
  project?: string;
  compliance?: {
    compliance_pass_rate?: number;
    rule_adherence_score?: number;
    violation_count?: number;
    violation_severity?: string;
  };
}

/** Get compliance summary for the current project. */
export function getProjectComplianceSummary(
  options: { since?: string; agent?: string; category?: string } = {},
  cwd?: string,
): Record<string, unknown> {
  const projectPath = getCompliancePath(join(getCleoDir(cwd), 'metrics'));
  const projectName = getProjectName();

  if (!existsSync(projectPath)) {
    return {
      success: true,
      result: {
        project: projectName,
        totalEntries: 0,
        averagePassRate: 0,
        averageAdherence: 0,
        totalViolations: 0,
        bySeverity: {},
        byAgent: {},
      },
    };
  }

  let entries = readJsonlFile(projectPath) as ComplianceEntry[];

  if (options.since) entries = entries.filter(e => (e.timestamp ?? '') >= options.since!);
  if (options.agent) entries = entries.filter(e => e.source_id === options.agent);
  if (options.category) entries = entries.filter(e => e.category === options.category);

  return {
    success: true,
    result: computeComplianceSummary(entries, projectName),
  };
}

/** Get compliance summary across all projects. */
export function getGlobalComplianceSummary(
  options: { since?: string; project?: string } = {},
): Record<string, unknown> {
  const globalPath = getGlobalPath();
  if (!existsSync(globalPath)) {
    return {
      success: true,
      result: {
        totalEntries: 0,
        totalProjects: 0,
        averagePassRate: 0,
        averageAdherence: 0,
        totalViolations: 0,
        byProject: {},
        bySeverity: {},
      },
    };
  }

  let entries = readJsonlFile(globalPath) as ComplianceEntry[];
  if (options.since) entries = entries.filter(e => (e.timestamp ?? '') >= options.since!);
  if (options.project) entries = entries.filter(e => e.project === options.project);

  const projects = new Set(entries.map(e => e.project ?? 'unknown'));
  const summary = computeComplianceSummary(entries);

  return {
    success: true,
    result: { ...summary, totalProjects: projects.size },
  };
}

/** Compute compliance summary from entries. */
function computeComplianceSummary(
  entries: ComplianceEntry[],
  projectName?: string,
): Record<string, unknown> {
  const total = entries.length;
  if (total === 0) {
    return {
      ...(projectName && { project: projectName }),
      totalEntries: 0,
      averagePassRate: 0,
      averageAdherence: 0,
      totalViolations: 0,
      bySeverity: {},
      byAgent: {},
    };
  }

  const avgPassRate = entries.reduce((s, e) => s + (e.compliance?.compliance_pass_rate ?? 0), 0) / total;
  const avgAdherence = entries.reduce((s, e) => s + (e.compliance?.rule_adherence_score ?? 0), 0) / total;
  const totalViolations = entries.reduce((s, e) => s + (e.compliance?.violation_count ?? 0), 0);

  // Group by severity
  const bySeverity: Record<string, number> = {};
  for (const e of entries) {
    const sev = e.compliance?.violation_severity ?? 'unknown';
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }

  // Group by agent
  const byAgent: Record<string, { count: number; avgPassRate: number; violations: number }> = {};
  for (const e of entries) {
    const agent = e.source_id ?? 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { count: 0, avgPassRate: 0, violations: 0 };
    byAgent[agent]!.count++;
    byAgent[agent]!.avgPassRate += e.compliance?.compliance_pass_rate ?? 0;
    byAgent[agent]!.violations += e.compliance?.violation_count ?? 0;
  }
  for (const agent of Object.keys(byAgent)) {
    byAgent[agent]!.avgPassRate /= byAgent[agent]!.count;
  }

  // Time range
  const timestamps = entries.map(e => e.timestamp ?? '').filter(Boolean).sort();

  return {
    ...(projectName && { project: projectName }),
    totalEntries: total,
    averagePassRate: avgPassRate,
    averageAdherence: avgAdherence,
    totalViolations,
    bySeverity,
    byAgent,
    timeRange: {
      oldest: timestamps[0] ?? null,
      newest: timestamps[timestamps.length - 1] ?? null,
    },
  };
}

/** Get compliance trend over time. */
export function getComplianceTrend(
  days: number = 7,
  options: { project?: string; global?: boolean } = {},
  cwd?: string,
): Record<string, unknown> {
  const metricsPath = options.global
    ? getGlobalPath()
    : getCompliancePath(join(getCleoDir(cwd), 'metrics'));

  if (!existsSync(metricsPath)) {
    return { success: true, result: { days, dataPoints: [], trend: 'no_data' } };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  let entries = readJsonlFile(metricsPath) as ComplianceEntry[];
  entries = entries.filter(e => (e.timestamp ?? '') >= cutoffStr);
  if (options.project) entries = entries.filter(e => e.project === options.project);

  // Group by date
  const byDate = new Map<string, ComplianceEntry[]>();
  for (const e of entries) {
    const date = (e.timestamp ?? '').split('T')[0]!;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(e);
  }

  const dataPoints = Array.from(byDate.entries())
    .map(([date, group]) => ({
      date,
      entries: group.length,
      avgPassRate: group.reduce((s, e) => s + (e.compliance?.compliance_pass_rate ?? 0), 0) / group.length,
      avgAdherence: group.reduce((s, e) => s + (e.compliance?.rule_adherence_score ?? 0), 0) / group.length,
      violations: group.reduce((s, e) => s + (e.compliance?.violation_count ?? 0), 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let trend = 'stable';
  if (dataPoints.length >= 2) {
    const diff = dataPoints[dataPoints.length - 1]!.avgPassRate - dataPoints[0]!.avgPassRate;
    if (diff > 0.05) trend = 'improving';
    else if (diff < -0.05) trend = 'declining';
  }

  return { success: true, result: { days, dataPoints, trend } };
}

/** Get reliability stats per skill/agent. */
export function getSkillReliability(
  options: { since?: string; global?: boolean } = {},
  cwd?: string,
): Record<string, unknown> {
  const metricsPath = options.global
    ? getGlobalPath()
    : getCompliancePath(join(getCleoDir(cwd), 'metrics'));

  if (!existsSync(metricsPath)) {
    return { success: true, result: { skills: [], summary: { totalSkills: 0, avgReliability: 0 } } };
  }

  let entries = readJsonlFile(metricsPath) as ComplianceEntry[];
  if (options.since) entries = entries.filter(e => (e.timestamp ?? '') >= options.since!);

  // Group by source_id (skill)
  const bySkill = new Map<string, ComplianceEntry[]>();
  for (const e of entries) {
    const skill = e.source_id ?? 'unknown';
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill)!.push(e);
  }

  const skills = Array.from(bySkill.entries()).map(([skill, group]) => {
    const avgPassRate = group.reduce((s, e) => s + (e.compliance?.compliance_pass_rate ?? 0), 0) / group.length;
    const avgAdherence = group.reduce((s, e) => s + (e.compliance?.rule_adherence_score ?? 0), 0) / group.length;
    const totalViolations = group.reduce((s, e) => s + (e.compliance?.violation_count ?? 0), 0);
    const reliability = avgPassRate * 0.6 + avgAdherence * 0.4;

    return {
      skill,
      invocations: group.length,
      avgPassRate,
      avgAdherence,
      totalViolations,
      reliability,
    };
  }).sort((a, b) => b.reliability - a.reliability);

  const totalSkills = skills.length;
  const avgReliability = totalSkills > 0
    ? skills.reduce((s, sk) => s + sk.reliability, 0) / totalSkills
    : 0;

  return {
    success: true,
    result: { skills, summary: { totalSkills, avgReliability } },
  };
}

/** Log session metrics to SESSIONS.jsonl. */
export async function logSessionMetrics(
  metricsJson: Record<string, unknown>,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const metricsDir = getProjectMetricsDir(cwd);
  await mkdir(metricsDir, { recursive: true });

  const sessionsPath = getSessionsMetricsPath(join(getCleoDir(cwd), 'metrics'));

  try {
    appendFileSync(sessionsPath, JSON.stringify(metricsJson) + '\n');
  } catch {
    return { success: false, error: { code: 'E_LOCK_FAILED', message: 'Failed to append session metrics' } };
  }

  const sessionId = (metricsJson.session_id as string) ?? 'unknown';
  return {
    success: true,
    result: { sessionsFile: sessionsPath, sessionId, action: 'appended' },
  };
}

/** Get summary of session metrics. */
export function getSessionMetricsSummary(
  options: { since?: string } = {},
  cwd?: string,
): Record<string, unknown> {
  const sessionsPath = getSessionsMetricsPath(join(getCleoDir(cwd), 'metrics'));

  if (!existsSync(sessionsPath)) {
    return {
      success: true,
      result: {
        totalSessions: 0,
        avgEfficiency: 0,
        avgInterventionRate: 0,
        totalTasksCompleted: 0,
        totalTokensConsumed: 0,
      },
    };
  }

  interface SessionMetricEntry {
    start_timestamp?: string;
    efficiency?: {
      session_efficiency_score?: number;
      human_intervention_rate?: number;
      context_utilization?: number;
    };
    stats?: { tasks_completed?: number };
    tokens?: { consumed?: number };
  }

  let entries = readJsonlFile(sessionsPath) as SessionMetricEntry[];
  if (options.since) {
    entries = entries.filter(e => (e.start_timestamp ?? '') >= options.since!);
  }

  const total = entries.length;
  if (total === 0) {
    return {
      success: true,
      result: {
        totalSessions: 0,
        avgEfficiency: 0,
        avgInterventionRate: 0,
        totalTasksCompleted: 0,
        totalTokensConsumed: 0,
      },
    };
  }

  const avgEfficiency = entries.reduce((s, e) => s + (e.efficiency?.session_efficiency_score ?? 0), 0) / total;
  const avgInterventionRate = entries.reduce((s, e) => s + (e.efficiency?.human_intervention_rate ?? 0), 0) / total;
  const avgContextUtil = entries.reduce((s, e) => s + (e.efficiency?.context_utilization ?? 0), 0) / total;
  const totalTasksCompleted = entries.reduce((s, e) => s + (e.stats?.tasks_completed ?? 0), 0);
  const totalTokensConsumed = entries.reduce((s, e) => s + (e.tokens?.consumed ?? 0), 0);

  return {
    success: true,
    result: {
      totalSessions: total,
      avgEfficiency,
      avgInterventionRate,
      avgContextUtilization: avgContextUtil,
      totalTasksCompleted,
      totalTokensConsumed,
      avgTasksPerSession: totalTasksCompleted / total,
      byContextUtilization: {
        low: entries.filter(e => (e.efficiency?.context_utilization ?? 0) < 0.3).length,
        medium: entries.filter(e => {
          const cu = e.efficiency?.context_utilization ?? 0;
          return cu >= 0.3 && cu < 0.7;
        }).length,
        high: entries.filter(e => (e.efficiency?.context_utilization ?? 0) >= 0.7).length,
      },
    },
  };
}
