/**
 * Shared metrics utilities - paths, timestamps, and compliance summaries.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';

/** Ensure metrics directory exists, returning its path. */
export async function ensureMetricsDir(metricsDir?: string): Promise<string> {
  const dir = metricsDir ?? join(getCleoDir(), 'metrics');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/** Get compliance log path. */
export function getCompliancePath(metricsDir?: string): string {
  return join(metricsDir ?? join(getCleoDir(), 'metrics'), 'COMPLIANCE.jsonl');
}

/** Get violations log path. */
export function getViolationsPath(metricsDir?: string): string {
  return join(metricsDir ?? join(getCleoDir(), 'metrics'), 'PROTOCOL_VIOLATIONS.jsonl');
}

/** Get sessions metrics log path. */
export function getSessionsMetricsPath(metricsDir?: string): string {
  return join(metricsDir ?? join(getCleoDir(), 'metrics'), 'SESSIONS.jsonl');
}

/** Generate ISO 8601 UTC timestamp. */
export function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Generate ISO 8601 date only. */
export function isoDate(): string {
  return new Date().toISOString().split('T')[0]!;
}

/** Read a JSONL file into an array of parsed objects. */
export function readJsonlFile(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/** Compliance summary shape. */
export interface ComplianceSummary {
  total: number;
  pass: number;
  fail: number;
  rate: number;
}

/** Get compliance summary from log file. */
export function getComplianceSummaryBase(compliancePath?: string): ComplianceSummary {
  const path = compliancePath ?? getCompliancePath();

  if (!existsSync(path)) {
    return { total: 0, pass: 0, fail: 0, rate: 0 };
  }

  const entries = readJsonlFile(path);
  const total = entries.length;
  const pass = entries.filter(
    e => (e as Record<string, unknown>).compliance_pass_rate === 1,
  ).length;
  const fail = total - pass;
  const rate = total > 0 ? Math.round((pass * 100) / total * 100) / 100 : 0;

  return { total, pass, fail, rate };
}
