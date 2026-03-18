/**
 * Shared COMPLIANCE.jsonl storage helpers.
 *
 * Keeps file-path resolution and JSONL parsing in one place so all callers
 * read/write compliance entries consistently.
 *
 * @task T4801
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ComplianceJsonlEntry = Record<string, unknown>;

/** Resolve COMPLIANCE.jsonl path for a project root. */
export function getComplianceJsonlPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
}

/**
 * Read COMPLIANCE.jsonl entries.
 * Invalid JSON lines are skipped to preserve append-only log resilience.
 */
export function readComplianceJsonl(projectRoot: string): ComplianceJsonlEntry[] {
  const compliancePath = getComplianceJsonlPath(projectRoot);
  if (!existsSync(compliancePath)) {
    return [];
  }

  const content = readFileSync(compliancePath, 'utf-8');
  if (!content.trim()) {
    return [];
  }

  const entries: ComplianceJsonlEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as ComplianceJsonlEntry;
      entries.push(parsed);
    } catch {
      // Skip malformed rows and continue.
    }
  }

  return entries;
}

/** Append one entry to COMPLIANCE.jsonl, creating directories as needed. */
export function appendComplianceJsonl(projectRoot: string, entry: ComplianceJsonlEntry): void {
  const compliancePath = getComplianceJsonlPath(projectRoot);
  const metricsDir = dirname(compliancePath);
  if (!existsSync(metricsDir)) {
    mkdirSync(metricsDir, { recursive: true });
  }

  appendFileSync(compliancePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}
